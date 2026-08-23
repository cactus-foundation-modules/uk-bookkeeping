import { describe, expect, it } from 'vitest'
import { netForGross, resplitAtRate, vatForNet } from './format'

// Changing the VAT rate on a line that is already there.
//
// The bug this pins down: an entry raised from a bank statement carries the
// gross, because the gross is the money that left the account. Putting that line
// onto 20% used to hold the net and add the VAT on top, so a £20 statement line
// turned into a £24 receipt and the books stopped agreeing with the statement
// they were made from. Nothing failed, nothing warned; the total was simply
// wrong by the VAT.

const line = (net: string, vat: string, gross: string) => ({
  netAmount: net,
  vatAmount: vat,
  grossAmount: gross,
})

describe('resplitAtRate', () => {
  it('takes the VAT out of an imported total rather than adding it on', () => {
    // £20.00 off a bank statement, brought in as zero rated.
    expect(resplitAtRate(line('20.00', '0.00', '20.00'), '20.00', 'gross')).toEqual(
      line('16.67', '3.33', '20.00'),
    )
  })

  it('holds the total for a line nobody has typed into, which is every imported one', () => {
    expect(resplitAtRate(line('20.00', '0.00', '20.00'), '20.00', undefined).grossAmount).toBe('20.00')
  })

  it('puts the VAT on top when the net is the figure that was typed', () => {
    expect(resplitAtRate(line('100.00', '0.00', '100.00'), '20.00', 'net')).toEqual(
      line('100.00', '20.00', '120.00'),
    )
  })

  it('takes the VAT back off when a gross-anchored line goes to zero rated', () => {
    expect(resplitAtRate(line('16.67', '3.33', '20.00'), '0.00', 'gross')).toEqual(
      line('20.00', '0.00', '20.00'),
    )
  })

  it('always leaves gross equal to net plus VAT, to the penny', () => {
    // 5p at 20% is the awkward one: a second rounding would leave the two sides
    // a penny apart and the CHECK constraint on the line would refuse the save.
    for (const gross of ['0.05', '0.07', '9.99', '19.99', '1234.56']) {
      const split = resplitAtRate(line('0.00', '0.00', gross), '20.00', 'gross')
      const sum = (Number(split.netAmount) * 100 + Number(split.vatAmount) * 100).toFixed(0)
      expect(sum).toBe((Number(gross) * 100).toFixed(0))
    }
  })

  it('falls back to the net when there is no total to hold yet', () => {
    // A fresh line: gross is 0.00, so anchoring to it would keep it at zero
    // however much VAT the rate implies.
    expect(resplitAtRate(line('50.00', '0.00', '0.00'), '20.00', 'gross')).toEqual(
      line('50.00', '10.00', '60.00'),
    )
  })

  it('agrees with the split the bank-line importer uses', () => {
    // reconcile-actions.ts splitGross() does net = netFromGross(gross, rate),
    // VAT = the remainder. Coding a line on the reconcile screen and coding the
    // same line by opening the entry must not produce two different receipts.
    const gross = '20.00'
    const net = netForGross(gross, '20.00')
    expect(resplitAtRate(line('0.00', '0.00', gross), '20.00', 'gross')).toEqual(
      line(net, '3.33', gross),
    )
  })

  it('still computes VAT from the net the ordinary way', () => {
    expect(vatForNet('100.00', '5.00')).toBe('5.00')
  })
})
