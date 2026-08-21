import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { creditLines, planSaleRemoval, reversalLines } from '@/modules/uk-bookkeeping/lib/external-sales'
import type { BkTransactionLineRow } from '@/modules/uk-bookkeeping/lib/types'

// A voided invoice that the books never hear about leaves VAT standing on a sale
// that did not happen, and nobody finds out until the return is due. These two
// rules are the whole of how it is taken back out, so they are pinned here where
// they can be read without a database.

function line(overrides: Partial<BkTransactionLineRow> = {}): BkTransactionLineRow {
  return {
    id: 'ln_1',
    transaction_id: 'tx_1',
    position: 0,
    category_id: 'cat_sales',
    description: 'Shop order DW000080, invoice OSR-000001 (20%)',
    vat_treatment: 'domestic',
    vat_rate_code: 'standard',
    vat_rate_percent: new Prisma.Decimal('20.00'),
    net_amount: new Prisma.Decimal('3061.00'),
    vat_amount: new Prisma.Decimal('612.20'),
    gross_amount: new Prisma.Decimal('3673.20'),
    is_capital: false,
    locked_period_id: null,
    ...overrides,
  } as BkTransactionLineRow
}

describe('planSaleRemoval', () => {
  it('deletes an entry nothing has happened to', () => {
    expect(planSaleRemoval({ locked: false, finalised: false, reconciled: false, corrected: false })).toBe('delete')
  })

  it('reverses one inside a filed return', () => {
    expect(planSaleRemoval({ locked: true, finalised: false, reconciled: false, corrected: false })).toBe('reverse')
  })

  it('reverses one inside a finalised return', () => {
    expect(planSaleRemoval({ locked: false, finalised: true, reconciled: false, corrected: false })).toBe('reverse')
  })

  it('reverses one matched to a bank line, rather than breaking the match', () => {
    expect(planSaleRemoval({ locked: false, finalised: false, reconciled: true, corrected: false })).toBe('reverse')
  })

  it('reverses one something else already corrects', () => {
    expect(planSaleRemoval({ locked: false, finalised: false, reconciled: false, corrected: true })).toBe('reverse')
  })
})

describe('reversalLines', () => {
  it('negates the money and keeps everything else', () => {
    expect(reversalLines([line()])).toEqual([
      {
        categoryId: 'cat_sales',
        description: 'Shop order DW000080, invoice OSR-000001 (20%)',
        vatTreatment: 'domestic',
        vatRateCode: 'standard',
        vatRatePercent: '20.00',
        netAmount: '-3061.00',
        vatAmount: '-612.20',
        grossAmount: '-3673.20',
        isCapital: false,
      },
    ])
  })

  it('keeps gross equal to net plus VAT, which the CHECK constraint insists on', () => {
    const [reversed] = reversalLines([line()])
    expect(Number(reversed!.grossAmount)).toBeCloseTo(Number(reversed!.netAmount) + Number(reversed!.vatAmount), 2)
  })

  it('does not write minus zero on a zero-rated line', () => {
    const zero = line({
      vat_rate_code: 'zero',
      vat_rate_percent: new Prisma.Decimal('0.00'),
      vat_amount: new Prisma.Decimal('0.00'),
      net_amount: new Prisma.Decimal('50.00'),
      gross_amount: new Prisma.Decimal('50.00'),
    })
    const [reversed] = reversalLines([zero])
    expect(reversed!.vatAmount).toBe('0.00')
    expect(reversed!.netAmount).toBe('-50.00')
  })

  it('reverses every line of a mixed-rate sale', () => {
    const reduced = line({ id: 'ln_2', vat_rate_code: 'reduced', vat_rate_percent: new Prisma.Decimal('5.00'), net_amount: new Prisma.Decimal('100.00'), vat_amount: new Prisma.Decimal('5.00'), gross_amount: new Prisma.Decimal('105.00') })
    expect(reversalLines([line(), reduced]).map((row) => row.grossAmount)).toEqual(['-3673.20', '-105.00'])
  })
})

// A refund the books never hear about is the commoner fault and the dearer one:
// the shop goes on paying HMRC VAT on money it handed back, quarter after
// quarter, with nothing on any screen to say so. What arrives is the publisher's
// own rate rows, positive, and the whole job here is turning them into ledger
// lines the right way up.
describe('creditLines', () => {
  it('negates the money the publisher handed over', () => {
    const lines = creditLines([{ ratePercent: '20', net: '218.00', tax: '43.60', gross: '261.60' }], 'cat-1', 'Credit note CN-000001')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.netAmount).toBe('-218.00')
    expect(lines[0]!.vatAmount).toBe('-43.60')
    expect(lines[0]!.grossAmount).toBe('-261.60')
    expect(lines[0]!.categoryId).toBe('cat-1')
    expect(lines[0]!.vatRateCode).toBe('standard')
    expect(lines[0]!.description).toBe('Credit note CN-000001 (20%)')
  })

  it('keeps gross equal to net plus VAT, which the CHECK constraint insists on', () => {
    const lines = creditLines([{ ratePercent: '20', net: '218.00', tax: '43.60', gross: '261.60' }], 'cat-1', 'x')
    const line = lines[0]!
    expect(Number(line.grossAmount)).toBeCloseTo(Number(line.netAmount) + Number(line.vatAmount), 2)
  })

  it('does not write minus zero on a zero-rated line', () => {
    const lines = creditLines([{ ratePercent: '0', net: '100.00', tax: '0.00', gross: '100.00' }], 'cat-1', 'x')
    expect(lines[0]!.vatAmount).toBe('0.00')
    expect(lines[0]!.vatRateCode).toBe('zero')
    // No rate in the description: "(0%)" beside a zero-rated line says nothing.
    expect(lines[0]!.description).toBe('x')
  })

  it('credits each rate of a mixed basket at its own rate', () => {
    // The part that cannot be got by scaling the original sale: handing back the
    // zero-rated half and the standard-rated half are the same money and
    // completely different VAT.
    const lines = creditLines(
      [
        { ratePercent: '20', net: '100.00', tax: '20.00', gross: '120.00' },
        { ratePercent: '0', net: '50.00', tax: '0.00', gross: '50.00' },
      ],
      'cat-1',
      'x',
    )
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.vatRateCode)).toEqual(['standard', 'zero'])
    expect(lines.reduce((sum, l) => sum + Number(l.grossAmount), 0)).toBeCloseTo(-170, 2)
    expect(lines.reduce((sum, l) => sum + Number(l.vatAmount), 0)).toBeCloseTo(-20, 2)
  })

  it('drops a rate that contributed nothing rather than filing an empty line', () => {
    const lines = creditLines(
      [
        { ratePercent: '20', net: '100.00', tax: '20.00', gross: '120.00' },
        { ratePercent: '5', net: '0.00', tax: '0.00', gross: '0.00' },
      ],
      'cat-1',
      'x',
    )
    expect(lines).toHaveLength(1)
  })
})
