import { describe, expect, it } from 'vitest'
import {
  extensionSuffix,
  filingBaseName,
  filingFilename,
  filingFolderNames,
  kindForDocument,
  kindForTransaction,
} from './filing'

// The filing cabinet's layout, which is worth pinning down precisely: every one
// of these answers becomes a folder somebody browses and a filename somebody
// searches for, and the sweep in lib/refiling.ts moves real files to match.

const AUGUST = new Date(Date.UTC(2026, 7, 14))

describe('filingFolderNames', () => {
  it('pads the month to two digits', () => {
    expect(filingFolderNames(new Date(Date.UTC(2026, 0, 3)), 'sales-invoice')).toEqual([
      'Bookkeeping',
      '2026',
      '01',
      'Customer Invoices',
    ])
  })

  it('names each kind its own folder', () => {
    expect(filingFolderNames(AUGUST, 'sales-credit-note')[3]).toBe('Customer Credit Notes')
    expect(filingFolderNames(AUGUST, 'purchase-receipt')[3]).toBe('Purchase Receipts')
    expect(filingFolderNames(AUGUST, 'bank-statement')[3]).toBe('Bank Statements')
  })

  it('stops at the month when nothing knows what the document is', () => {
    // Not a fallback into one of the four. A photograph of a receipt that has
    // not been read yet is neither a sale nor a purchase, and filing it into a
    // drawer confidently would be worse than leaving it in the tray.
    expect(filingFolderNames(AUGUST, null)).toEqual(['Bookkeeping', '2026', '08'])
  })

  it('reads the month in UTC, so a late-evening upload does not slip a month', () => {
    expect(filingFolderNames(new Date('2026-08-31T23:30:00Z'), null)[2]).toBe('08')
  })
})

describe('filingBaseName', () => {
  it('names a sales document after its own number', () => {
    expect(filingBaseName('sales-invoice', { documentNumber: 'INV-1042' })).toBe('INV-1042')
    expect(filingBaseName('sales-credit-note', { documentNumber: 'CN-0007' })).toBe('CN-0007')
  })

  it('ignores the customer on a sales document', () => {
    // The number is unique and the customer is not, so an invoice is filed by
    // the thing that identifies it.
    expect(
      filingBaseName('sales-invoice', { documentNumber: 'INV-1042', counterparty: 'Acme Ltd' }),
    ).toBe('INV-1042')
  })

  it('names a purchase receipt supplier first, number second', () => {
    expect(
      filingBaseName('purchase-receipt', { counterparty: 'Screwfix', documentNumber: '8817342' }),
    ).toBe('Screwfix-8817342')
  })

  it('keeps a purchase receipt that has a supplier but no number', () => {
    // Till receipts routinely carry no number at all, and "Screwfix.pdf" is a
    // great deal more use than "-.pdf".
    expect(filingBaseName('purchase-receipt', { counterparty: 'Screwfix' })).toBe('Screwfix')
  })

  it('names a statement after the account', () => {
    expect(filingBaseName('bank-statement', { accountName: 'Tide Current Account' })).toBe(
      'Tide Current Account',
    )
  })

  it('gives up rather than inventing a name', () => {
    expect(filingBaseName('sales-invoice', {})).toBeNull()
    expect(filingBaseName('purchase-receipt', { counterparty: '   ' })).toBeNull()
    expect(filingBaseName('bank-statement', {})).toBeNull()
  })

  it('takes the slashes out of an invoice number', () => {
    // "2026/0042" is an ordinary way to number invoices and a folder nobody
    // asked for once it reaches a storage key.
    expect(filingBaseName('sales-invoice', { documentNumber: '2026/0042' })).toBe('2026-0042')
  })

  it('refuses to start a name with a dot', () => {
    expect(filingBaseName('sales-invoice', { documentNumber: '..INV-9' })).toBe('INV-9')
  })

  it('collapses the whitespace a reader picks up off a letterhead', () => {
    expect(
      filingBaseName('purchase-receipt', { counterparty: '  Acme   Office \n Supplies ' }),
    ).toBe('Acme Office Supplies')
  })
})

describe('filingFilename', () => {
  it('keeps the extension the file arrived with', () => {
    expect(filingFilename('purchase-receipt', { counterparty: 'Screwfix' }, 'photo.JPG')).toBe(
      'Screwfix.jpg',
    )
    expect(filingFilename('bank-statement', { accountName: 'Tide' }, 'export-9912.csv')).toBe(
      'Tide.csv',
    )
  })

  it('leaves the name alone when there is nothing to build one from', () => {
    expect(filingFilename('sales-invoice', {}, 'scan.pdf')).toBeNull()
  })
})

describe('extensionSuffix', () => {
  it('finds the ordinary ones', () => {
    expect(extensionSuffix('statement.pdf')).toBe('.pdf')
    expect(extensionSuffix('a.b.c.webp')).toBe('.webp')
  })

  it('is empty when there is nothing usable', () => {
    expect(extensionSuffix('statement')).toBe('')
    expect(extensionSuffix('.gitignore')).toBe('')
    expect(extensionSuffix('statement.')).toBe('')
    // Not an extension: a date in the name, not a file type.
    expect(extensionSuffix('statement.2026-08-31')).toBe('')
  })
})

describe('kindForDocument', () => {
  it('maps what the reader can actually tell', () => {
    expect(kindForDocument('income')).toBe('sales-invoice')
    expect(kindForDocument('income', true)).toBe('sales-credit-note')
    expect(kindForDocument('expense')).toBe('purchase-receipt')
  })

  it('says nothing when the reading said nothing', () => {
    expect(kindForDocument(null)).toBeNull()
    expect(kindForDocument(undefined)).toBeNull()
  })
})

describe('kindForTransaction', () => {
  it('reads an income adjustment against another entry as a credit note', () => {
    expect(
      kindForTransaction({
        direction: 'income',
        entry_type: 'adjustment',
        corrects_transaction_id: 'tx-1',
      }),
    ).toBe('sales-credit-note')
  })

  it('needs both halves before it calls something a credit note', () => {
    // An adjustment that corrects nothing is a correction to the books, not a
    // document handed to a customer.
    expect(
      kindForTransaction({ direction: 'income', entry_type: 'adjustment', corrects_transaction_id: null }),
    ).toBe('sales-invoice')
    expect(
      kindForTransaction({ direction: 'income', entry_type: 'normal', corrects_transaction_id: 'tx-1' }),
    ).toBe('sales-invoice')
  })

  it('files everything going out as a purchase receipt', () => {
    expect(
      kindForTransaction({
        direction: 'expense',
        entry_type: 'adjustment',
        corrects_transaction_id: 'tx-1',
      }),
    ).toBe('purchase-receipt')
  })
})
