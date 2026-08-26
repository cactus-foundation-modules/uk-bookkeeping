// The shape an unfiled document takes on the screen, and the sentences that go
// with it.
//
// Shared by the Receipts tab, the picker on the entry form and the suggestions
// on the reconciliation screen, so all three describe the same document the same
// way. A receipt that reads "Probably Acme Ltd" on one screen and "Acme Ltd" on
// another is the software disagreeing with itself in front of the person who has
// to decide.

export type UnfiledDocument = {
  id: string
  name: string
  filename: string
  mime_type: string
  size: number
  created_at: string
  transaction_id: string | null
  scan_status: 'not_scanned' | 'read' | 'no_text' | 'unreadable'
  guessed_counterparty: string | null
  counterparty_confidence: number
  guessed_direction: 'income' | 'expense' | null
  guessed_document_date: string | null
  guessed_document_number: string | null
  guessed_net: string | null
  guessed_vat: string | null
  guessed_total: string | null
  guessed_vat_rate_code: string | null
  guessed_vat_treatment: string | null
  guessed_vat_number: string | null
  reading_confirmed: boolean
}

/**
 * How the VAT works, in the words a site owner would use. The same seven the
 * entry form offers, so a document and the entry it becomes describe themselves
 * the same way.
 */
export const TREATMENT_LABELS: Record<string, string> = {
  domestic: 'UK, VAT charged as normal',
  reverse_charge_services: 'Bought from overseas - reverse charge',
  domestic_reverse_charge: 'UK construction - reverse charge',
  import_pva: 'Imported goods (postponed VAT accounting)',
  ni_eu_acquisition: 'Goods into Northern Ireland from the EU',
  ni_eu_dispatch: 'Goods from Northern Ireland to the EU',
  outside_scope: 'Outside the scope of VAT',
}

/** The ones where the supplier charges nothing and you account for it yourself. */
export const REVERSE_CHARGE_TREATMENTS = ['reverse_charge_services', 'domestic_reverse_charge']

export const RATE_LABELS: Record<string, string> = {
  standard: 'Standard rate (20%)',
  reduced: 'Reduced rate (5%)',
  zero: 'No VAT',
  exempt: 'Exempt',
  outside_scope: 'Outside the scope of VAT',
}

/**
 * How sure we are, in words rather than in a number.
 *
 * A percentage would invite somebody to treat it as a probability, which it is
 * not - it is an ordering. Three bands is as much as it can honestly carry.
 */
export function confidenceWording(document: UnfiledDocument): string | null {
  if (!document.guessed_counterparty) return null
  if (document.reading_confirmed) return 'checked by hand'
  if (document.counterparty_confidence >= 85) return null
  if (document.counterparty_confidence >= 55) return 'probably'
  return 'a guess'
}

/** What to say about a document nothing could be read off. */
export function scanWording(document: UnfiledDocument): string | null {
  switch (document.scan_status) {
    case 'no_text':
      return 'No text in this one - it is a photo or a scan, so nothing could be read off it.'
    case 'unreadable':
      return 'This one would not open, so nothing could be read off it. The file itself is safe.'
    case 'not_scanned':
      return 'Not read yet.'
    default:
      return null
  }
}

/** True when the document knows enough to fill an entry in on its own. */
export function isUsable(document: UnfiledDocument): boolean {
  return !!document.guessed_total || !!document.guessed_counterparty
}

export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
