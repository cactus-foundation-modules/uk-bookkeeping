import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { planSaleRemoval, reversalLines } from '@/modules/uk-bookkeeping/lib/external-sales'
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
