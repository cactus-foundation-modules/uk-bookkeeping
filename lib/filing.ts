import type { Direction } from './types'

// Where a piece of paperwork lives in the media library, and what it is called
// when it gets there.
//
// One file, on purpose. Four places decide where a document is filed - the
// inbox, evidence dropped on an entry, the shop handing over an invoice or a
// credit note, and a bank statement being imported - and a fifth walks the
// existing pile and moves it to match. Five copies of "Bookkeeping / year /
// month / kind" would drift, and the one that drifted would be the one nobody
// looked in.
//
// The shape is a filing cabinet somebody could work with by hand, because
// eventually somebody will:
//
//   Bookkeeping / 2026 / 09 / Customer Invoices      / INV-1042.pdf
//   Bookkeeping / 2026 / 09 / Customer Credit Notes  / CN-0007.pdf
//   Bookkeeping / 2026 / 09 / Purchase Receipts      / Screwfix-8817342.pdf
//   Bookkeeping / 2026 / 09 / Bank Statements        / Tide Current Account.pdf
//
// Nothing here touches storage or the database. It is the layout and only the
// layout, so the awkward cases - a receipt with no supplier on it, an invoice
// number with a slash in it - are answerable in a test without either.

export type FilingKind =
  | 'sales-invoice'
  | 'sales-credit-note'
  | 'purchase-receipt'
  | 'bank-statement'

/** The top of the tree. Everything this module files sits under it. */
export const FILING_ROOT = 'Bookkeeping'

/** The folder each kind of document belongs in, inside its month. */
export const FILING_FOLDERS: Record<FilingKind, string> = {
  'sales-invoice': 'Customer Invoices',
  'sales-credit-note': 'Customer Credit Notes',
  'purchase-receipt': 'Purchase Receipts',
  'bank-statement': 'Bank Statements',
}

export const FILING_LABELS: Record<FilingKind, string> = {
  'sales-invoice': 'a customer invoice',
  'sales-credit-note': 'a customer credit note',
  'purchase-receipt': 'a purchase receipt',
  'bank-statement': 'a bank statement',
}

/**
 * The folder names, root first, a document of this kind belongs in.
 *
 * `kind` is allowed to be null and that is not a failure: a photograph of a
 * receipt has no text in it, so nothing knows yet whether it is a sale or a
 * purchase. Those wait in the month folder itself rather than being guessed into
 * one of the four, and land in the right one the moment somebody says what they
 * are.
 */
export function filingFolderNames(date: Date, kind: FilingKind | null): string[] {
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const names = [FILING_ROOT, year, month]
  if (kind) names.push(FILING_FOLDERS[kind])
  return names
}

/**
 * A name that will survive being a filename, or empty if there is nothing left
 * of it.
 *
 * Slashes are the one that matters - an invoice number written "2026/0042" is
 * ordinary, and a slash in a storage key is a folder somebody did not ask for.
 */
function tidyNamePart(value: string | null | undefined): string {
  // Control characters go by code point rather than by a regex - clearer, and
  // the one form eslint's no-control-regex has no quarrel with.
  const printable = Array.from(value ?? '')
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 0x20 && code !== 0x7f
    })
    .join('')

  return printable
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    // A leading dot is a hidden file on every system that has ever had one, and
    // a trailing one is a filename half the world refuses to write.
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\-\s]+$/, '')
    .slice(0, 80)
    .trim()
}

export type FilingNameParts = {
  /** Who the document is with. Only used by purchase receipts. */
  counterparty?: string | null
  /** The number printed on it: an invoice number, a credit note number. */
  documentNumber?: string | null
  /** The bank account a statement belongs to. */
  accountName?: string | null
}

/**
 * What the file should be called, without an extension - or null when the parts
 * needed for this kind are not there.
 *
 * Null means "leave the name alone", never "make something up". A purchase
 * receipt whose supplier we could not read is better filed under the name the
 * person uploaded than under a lone hyphen, and a folder of files called
 * "-.pdf" would be worse than no scheme at all.
 */
export function filingBaseName(kind: FilingKind, parts: FilingNameParts): string | null {
  const number = tidyNamePart(parts.documentNumber)
  const who = tidyNamePart(parts.counterparty)

  switch (kind) {
    case 'sales-invoice':
    case 'sales-credit-note':
      return number || null
    case 'purchase-receipt':
      // Supplier first, because a receipts folder is read supplier by supplier.
      // The number is what tells two of theirs apart, so it comes second and is
      // allowed to be missing - plenty of till receipts carry no number at all.
      if (who && number) return `${who}-${number}`
      return who || number || null
    case 'bank-statement':
      return tidyNamePart(parts.accountName) || null
  }
}

/** The extension off a filename, lower-cased, dot included. Empty if it has none. */
export function extensionSuffix(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot <= 0 || dot === filename.length - 1) return ''
  const extension = filename.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(extension) ? `.${extension}` : ''
}

/**
 * The filing name for a document, keeping the extension the file arrived with.
 *
 * The extension is not forced to .pdf. A receipt photographed on a phone is a
 * JPEG, a statement exported from a bank is often a CSV, and calling either of
 * them .pdf would leave a file no program will open.
 */
export function filingFilename(
  kind: FilingKind,
  parts: FilingNameParts,
  originalFilename: string,
): string | null {
  const base = filingBaseName(kind, parts)
  if (!base) return null
  return `${base}${extensionSuffix(originalFilename)}`
}

/**
 * Which of the four a document we have read is.
 *
 * The reader only ever says income or expense, so a customer credit note among
 * uploaded paperwork is filed as an invoice until somebody says otherwise. The
 * shop knows the difference at the moment it raises one and says so outright -
 * see recordExternalCredit - which is the only place the distinction is
 * genuinely known rather than guessed.
 */
export function kindForDocument(
  direction: Direction | null | undefined,
  isCreditNote = false,
): FilingKind | null {
  if (direction === 'income') return isCreditNote ? 'sales-credit-note' : 'sales-invoice'
  if (direction === 'expense') return 'purchase-receipt'
  return null
}

/**
 * Which of the four the evidence on an entry is, from the entry itself.
 *
 * The entry is a fact and the reading of the paper is a guess, so where both
 * exist the entry wins. An income adjustment that corrects an earlier entry is
 * a credit note: that is exactly the shape recordExternalCredit writes, and the
 * shape somebody typing one by hand is asked for.
 */
export function kindForTransaction(transaction: {
  direction: Direction
  entry_type?: string | null
  corrects_transaction_id?: string | null
}): FilingKind {
  if (transaction.direction === 'income') {
    const credits =
      transaction.entry_type === 'adjustment' && !!transaction.corrects_transaction_id
    return credits ? 'sales-credit-note' : 'sales-invoice'
  }
  return 'purchase-receipt'
}
