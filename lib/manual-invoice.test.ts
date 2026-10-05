import { describe, expect, it } from 'vitest'
import { Prisma } from '@prisma/client'
import { formatInvoiceNumber, renderInvoiceHtml, wantsManualInvoice } from './manual-invoice'
import type { TransactionWithLines } from './transactions'

const entry = (over: Partial<TransactionWithLines> = {}): TransactionWithLines =>
  ({
    id: 't1',
    entry_type: 'normal',
    direction: 'income',
    tax_point_date: new Date('2026-10-02T00:00:00Z'),
    settled_date: null,
    counterparty: 'Philo <Marsh> & Co',
    description: 'Failed delivery charge',
    reference: null,
    status: 'posted',
    source: 'manual',
    invoice_number: null,
    lines: [
      {
        description: 'Failed delivery charge Order DW000199',
        vat_rate_code: 'standard',
        vat_rate_percent: new Prisma.Decimal('20.00'),
        net_amount: new Prisma.Decimal('40.00'),
        vat_amount: new Prisma.Decimal('8.00'),
        gross_amount: new Prisma.Decimal('48.00'),
      },
    ],
    attachments: [],
    category_names: {},
    ...over,
  }) as unknown as TransactionWithLines

describe('manual invoices', () => {
  it('pads the counter onto the prefix', () => {
    expect(formatInvoiceNumber('INV-', 7)).toBe('INV-000007')
    expect(formatInvoiceNumber(' ', 12)).toBe('000012')
  })

  it('only wants money in that a person recorded', () => {
    expect(wantsManualInvoice(entry())).toBe(true)
    expect(wantsManualInvoice(entry({ direction: 'expense' }))).toBe(false)
    expect(wantsManualInvoice(entry({ source: 'shop' }))).toBe(false)
    expect(wantsManualInvoice(entry({ entry_type: 'adjustment' }))).toBe(false)
    expect(wantsManualInvoice(entry({ status: 'draft' }))).toBe(false)
  })

  it('prints the number, the figures and escapes what a person typed', () => {
    const html = renderInvoiceHtml(entry(), 'INV-000007', {
      business_name: 'Deskwell',
      business_address: '1 High St\nLeeds',
      vrn: '841969097',
    })
    expect(html).toContain('INV-000007')
    expect(html).toContain('VAT invoice')
    expect(html).toContain('£48.00')
    expect(html).toContain('£8.00')
    expect(html).toContain('Philo &lt;Marsh&gt; &amp; Co')
    expect(html).toContain('VAT number 841969097')
    expect(html).toContain('Leeds')
  })
})
