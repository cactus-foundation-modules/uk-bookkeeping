import { describe, expect, it } from 'vitest'
import { purchaseLines } from './external-purchases'

// The rule that turns a publisher's invoice lines into ledger lines. Pure, so
// it can be read without a database - and every case here is one the books'
// own validator would refuse if this file got it wrong, which would lose the
// purchase rather than record it oddly.

const category = () => 'cat-default'

describe('purchaseLines', () => {
  it('keeps one line per line on the invoice', () => {
    const lines = purchaseLines(
      [
        { description: 'Desks', net: '100.00', tax: '20.00', ratePercent: '20', categoryId: 'cat-a' },
        { description: 'Chairs', net: '50.00', tax: '10.00', ratePercent: '20', categoryId: 'cat-b' },
      ],
      (line) => line.categoryId ?? 'cat-default',
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      categoryId: 'cat-a',
      netAmount: '100.00',
      vatAmount: '20.00',
      grossAmount: '120.00',
      vatRateCode: 'standard',
      vatTreatment: 'domestic',
    })
  })

  it('forces gross to net plus VAT, whatever arrived', () => {
    // The CHECK constraint and the validator both insist on it, and a publisher
    // that sends a stale gross must not take the whole entry down with it.
    const lines = purchaseLines(
      [{ description: 'A', net: '10.00', tax: '2.00', gross: '99.99', ratePercent: '20' }],
      category,
    )
    expect(lines[0]!.grossAmount).toBe('12.00')
  })

  it('negates every figure when asked, and never renders minus zero', () => {
    const lines = purchaseLines(
      [{ description: 'Returned desk', net: '100.00', tax: '0.00', ratePercent: '0' }],
      category,
      { negate: true },
    )
    expect(lines[0]).toMatchObject({ netAmount: '-100.00', vatAmount: '0.00', grossAmount: '-100.00' })
  })

  it('reads a rate this module has never heard of as the band it must be', () => {
    const lines = purchaseLines(
      [{ description: 'A', net: '100.00', tax: '5.00', ratePercent: '5', vatRateCode: 'nonsense' }],
      category,
    )
    expect(lines[0]!.vatRateCode).toBe('reduced')
  })

  it('never files a line that carries VAT as zero-rated', () => {
    const lines = purchaseLines(
      [{ description: 'A', net: '100.00', tax: '20.00', ratePercent: '20', vatRateCode: 'zero' }],
      category,
    )
    expect(lines[0]!.vatRateCode).toBe('standard')
  })

  it('keeps a reverse-charge line at its rate with no VAT on it', () => {
    // The return computes the notional VAT from the rate; the entry keeps what
    // was actually paid, which is nothing.
    const lines = purchaseLines(
      [
        {
          description: 'Scaffolding',
          net: '1000.00',
          tax: '0.00',
          ratePercent: '20',
          vatRateCode: 'standard',
          vatTreatment: 'domestic_reverse_charge',
        },
      ],
      category,
    )
    expect(lines[0]).toMatchObject({
      vatTreatment: 'domestic_reverse_charge',
      vatRateCode: 'standard',
      vatRatePercent: '20.00',
      vatAmount: '0.00',
      grossAmount: '1000.00',
    })
  })

  it('reads a treatment it has never heard of as an ordinary UK one', () => {
    const lines = purchaseLines(
      [{ description: 'A', net: '10.00', tax: '2.00', ratePercent: '20', vatTreatment: 'martian' }],
      category,
    )
    expect(lines[0]!.vatTreatment).toBe('domestic')
  })

  it('drops a line that contributed nothing', () => {
    const lines = purchaseLines(
      [
        { description: 'Nothing', net: '0.00', tax: '0.00', ratePercent: '20' },
        { description: 'Something', net: '5.00', tax: '0.00', ratePercent: '0' },
      ],
      category,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]!.description).toBe('Something')
  })

  it('trims a description long enough to bury the rest of the entry', () => {
    const lines = purchaseLines(
      [{ description: 'x'.repeat(400), net: '10.00', tax: '0.00', ratePercent: '0' }],
      category,
    )
    expect(lines[0]!.description!.length).toBe(200)
    expect(lines[0]!.description!.endsWith('…')).toBe(true)
  })
})
