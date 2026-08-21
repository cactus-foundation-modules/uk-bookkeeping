import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { creditLines, ledgerLines, planSaleRemoval, reversalLines } from '@/modules/uk-bookkeeping/lib/external-sales'
import type { ExternalSaleItem } from '@/modules/uk-bookkeeping/lib/external-sales'
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

// Itemising an entry is worth having, and it is worth nothing at all if the
// entry stops coming to what the invoice came to. Every case below is really
// the same question: when do the publisher's items get used, and what happens
// the moment they stop adding up.

const BREAKDOWN = [{ ratePercent: '20', net: '1000.00', tax: '200.00', gross: '1200.00' }]

const ITEMS: ExternalSaleItem[] = [
  { description: 'Oak desk (DSK-1)', ratePercent: '20', net: '800.00', tax: '160.00', gross: '960.00' },
  { description: 'Delivery', ratePercent: '20', net: '200.00', tax: '40.00', gross: '240.00' },
]

describe('ledgerLines', () => {
  it('files one line per rate when the publisher sent no items', () => {
    const lines = ledgerLines(BREAKDOWN, undefined, 'cat-1', 'Invoice INV-1')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.description).toBe('Invoice INV-1 (20%)')
  })

  it('files one line per item when it did, each saying what it was for', () => {
    const lines = ledgerLines(BREAKDOWN, ITEMS, 'cat-1', 'Invoice INV-1')
    expect(lines.map((l) => l.description)).toEqual(['Oak desk (DSK-1)', 'Delivery'])
    expect(lines.every((l) => l.categoryId === 'cat-1')).toBe(true)
    expect(lines.every((l) => l.vatRateCode === 'standard')).toBe(true)
  })

  it('comes to exactly what the rate summary comes to', () => {
    const lines = ledgerLines(BREAKDOWN, ITEMS, 'cat-1', 'Invoice INV-1')
    expect(lines.reduce((sum, l) => sum + Number(l.netAmount), 0)).toBeCloseTo(1000, 2)
    expect(lines.reduce((sum, l) => sum + Number(l.vatAmount), 0)).toBeCloseTo(200, 2)
    expect(lines.reduce((sum, l) => sum + Number(l.grossAmount), 0)).toBeCloseTo(1200, 2)
  })

  it('falls back to the rate summary when the items do not add up to it', () => {
    // The whole safety net. A publisher that leaves an item off must not be able
    // to shrink a VAT return by doing so, so a set of items that disagrees with
    // the summary by a penny is not used at all.
    const short: ExternalSaleItem[] = [
      { description: 'Oak desk', ratePercent: '20', net: '999.99', tax: '200.00', gross: '1199.99' },
    ]
    const lines = ledgerLines(BREAKDOWN, short, 'cat-1', 'Invoice INV-1')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.description).toBe('Invoice INV-1 (20%)')
    expect(lines[0]!.grossAmount).toBe('1200.00')
  })

  it('falls back on an empty item list rather than filing an empty entry', () => {
    const lines = ledgerLines(BREAKDOWN, [], 'cat-1', 'Invoice INV-1')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.grossAmount).toBe('1200.00')
  })

  it('keeps each item on its own VAT rate', () => {
    const breakdown = [
      { ratePercent: '20', net: '100.00', tax: '20.00', gross: '120.00' },
      { ratePercent: '0', net: '50.00', tax: '0.00', gross: '50.00' },
    ]
    const items: ExternalSaleItem[] = [
      { description: 'Desk', ratePercent: '20', net: '100.00', tax: '20.00', gross: '120.00' },
      { description: 'Book', ratePercent: '0', net: '50.00', tax: '0.00', gross: '50.00' },
    ]
    const lines = ledgerLines(breakdown, items, 'cat-1', 'x')
    expect(lines.map((l) => l.vatRateCode)).toEqual(['standard', 'zero'])
  })

  it('keeps gross equal to net plus VAT on every itemised line', () => {
    for (const line of ledgerLines(BREAKDOWN, ITEMS, 'cat-1', 'x')) {
      expect(Number(line.grossAmount)).toBeCloseTo(Number(line.netAmount) + Number(line.vatAmount), 2)
    }
  })

  it('trims a description too long to read in a table', () => {
    const long = 'A'.repeat(400)
    const items: ExternalSaleItem[] = [{ description: long, ratePercent: '20', net: '1000.00', tax: '200.00', gross: '1200.00' }]
    const lines = ledgerLines(BREAKDOWN, items, 'cat-1', 'x')
    expect(lines[0]!.description).toHaveLength(200)
    expect(lines[0]!.description!.endsWith('\u2026')).toBe(true)
  })
})

describe('creditLines - itemised', () => {
  it('negates each item and still comes to the credited total', () => {
    const lines = creditLines(BREAKDOWN, 'cat-1', 'Credit note CN-1', ITEMS)
    expect(lines.map((l) => l.description)).toEqual(['Oak desk (DSK-1)', 'Delivery'])
    expect(lines.map((l) => l.grossAmount)).toEqual(['-960.00', '-240.00'])
    expect(lines.reduce((sum, l) => sum + Number(l.grossAmount), 0)).toBeCloseTo(-1200, 2)
  })

  it('still falls back to one line per rate when the items do not tie', () => {
    const short: ExternalSaleItem[] = [
      { description: 'Oak desk', ratePercent: '20', net: '500.00', tax: '100.00', gross: '600.00' },
    ]
    const lines = creditLines(BREAKDOWN, 'cat-1', 'Credit note CN-1', short)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.grossAmount).toBe('-1200.00')
  })

  it('does not write minus zero on a zero-rated item', () => {
    const breakdown = [{ ratePercent: '0', net: '100.00', tax: '0.00', gross: '100.00' }]
    const items: ExternalSaleItem[] = [{ description: 'Book', ratePercent: '0', net: '100.00', tax: '0.00', gross: '100.00' }]
    expect(creditLines(breakdown, 'cat-1', 'x', items)[0]!.vatAmount).toBe('0.00')
  })
})
