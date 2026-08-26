import { Prisma } from '@prisma/client'
import { PdfError } from './pdf/document'
import { extractPdfText, type PdfText, type PdfTextItem, type PdfTextRow } from './pdf/text'
import { parseStatementDate } from './statement'
import { normaliseAlias } from './counterparty-aliases'
import { allWordsPresent, significantWords, DOCUMENT_STOP_WORDS } from './name-matching'
import type { VatRateCode } from './types'

// Reading an invoice or a receipt.
//
// PDFs only, and on purpose. lib/pdf already lifts positioned text out of a PDF
// for bank statements, which costs nothing, runs in milliseconds, needs no key
// and no outside service, and works the same on every install. A photograph of a
// receipt has no text in it at all: reading one means OCR, which means somebody
// else's server, an account and a bill per receipt. So a photograph is accepted,
// stored and filed like anything else - it simply arrives with no guess against
// it, and the screen says so rather than showing an empty box that looks broken.
//
// Everything here is a GUESS. Nothing it produces is written to the books; it
// pre-fills a form that a person then reads and presses Save on. That is the
// whole safety argument, and it is why this file is allowed to be heuristic
// where the rest of the module is not.
//
// Pure functions throughout, taking what they know as an argument rather than
// reading the database. That is what makes the awkward cases testable without a
// database, and there are a great many awkward cases - see
// document-reading.test.ts.

/** Enough text to re-guess from later without turning the backup into a corpus. */
export const MAX_EXTRACTED_TEXT = 20_000

/** NUMERIC(10,2). A figure past this is a misread, not a large invoice. */
const MAX_MONEY = new Prisma.Decimal('99999999.99')

export type CounterpartySource =
  | 'vat_number'
  | 'known'
  | 'alias'
  | 'letterhead'
  | 'domain'
  | 'filename'

export type DocumentReading = {
  scanStatus: 'read' | 'no_text' | 'unreadable'
  /** Why we could not read it, in a sentence for the person looking at the list. */
  scanNote: string | null
  counterparty: string | null
  /** 0 to 100. Orders a list and decides whether the screen says "is" or "might be". */
  counterpartyConfidence: number
  counterpartySource: CounterpartySource | null
  direction: 'income' | 'expense' | null
  /** ISO, or null when the document did not print a date we could read. */
  documentDate: string | null
  documentNumber: string | null
  /** Decimal strings, or null for "not found on the document" - never a stand-in zero. */
  net: string | null
  vat: string | null
  total: string | null
  vatRateCode: VatRateCode | null
  vatNumber: string | null
  text: string | null
}

export type ReadingContext = {
  /** Counterparties the books already know, most used first. */
  knownCounterparties: string[]
  /** Normalised alias to the counterparty it means. */
  aliases: Map<string, string>
  /** VAT registration number to the supplier it belongs to, from documents already read. */
  vatNumberOwners: Map<string, string>
  /** This business's own name and VAT number, so its own letterhead is not read as a supplier. */
  ownBusinessName: string | null
  ownVatNumber: string | null
}

export const EMPTY_READING: DocumentReading = {
  scanStatus: 'no_text',
  scanNote: null,
  counterparty: null,
  counterpartyConfidence: 0,
  counterpartySource: null,
  direction: null,
  documentDate: null,
  documentNumber: null,
  net: null,
  vat: null,
  total: null,
  vatRateCode: null,
  vatNumber: null,
  text: null,
}

// ---------------------------------------------------------------------------
// Money on a document
// ---------------------------------------------------------------------------

/**
 * A money figure as an invoice prints one.
 *
 * Two decimal places are REQUIRED, which is the single most useful restriction
 * in this file: it is what stops "Invoice 12345", "20%", "Unit 4" and a phone
 * number being read as amounts. The whole-pound case is handled separately and
 * only where a currency symbol vouches for it.
 */
const MONEY_TOKEN = /(?:[-(]\s*)?[£$€]?\s*\d{1,3}(?:,\d{3})*\.\d{2}\)?|(?:[-(]\s*)?[£$€]?\s*\d+\.\d{2}\)?/g
const WHOLE_POUNDS_TOKEN = /(?:[-(]\s*)?[£$€]\s*\d{1,3}(?:,\d{3})*(?![\d.])\)?/g

function toDecimal(raw: string): Prisma.Decimal | null {
  const negative = /^[-(]/.test(raw.trim()) || /\)$/.test(raw.trim())
  const cleaned = raw.replace(/[()£$€,\s-]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const decimal = new Prisma.Decimal(cleaned).toDecimalPlaces(2)
  if (decimal.greaterThan(MAX_MONEY)) return null
  return negative ? decimal.negated() : decimal
}

type LabelKind = 'total' | 'net' | 'vat'

/**
 * The words invoices put beside each of the three figures.
 *
 * Matched longest first, which is the only thing that keeps them apart: "Total
 * VAT" has to reach the VAT rule before the shorter "total" claims it, and
 * "Total including VAT" has to reach the total rule before the shorter "vat"
 * claims that. Sorting by length does both without a pile of special cases.
 *
 * "Amount paid" is deliberately absent from the total list. On a receipt it
 * means the total; on a part-paid invoice it means something else entirely, and
 * a rule that is right half the time is worse here than no rule.
 */
const LABEL_LIST: { text: string; kind: LabelKind }[] = [
  { text: 'total amount payable', kind: 'total' },
  { text: 'total amount due', kind: 'total' },
  { text: 'total including vat', kind: 'total' },
  { text: 'total incl vat', kind: 'total' },
  { text: 'total inc vat', kind: 'total' },
  { text: 'amount payable', kind: 'total' },
  { text: 'invoice total', kind: 'total' },
  { text: 'balance due', kind: 'total' },
  { text: 'amount due', kind: 'total' },
  { text: 'total to pay', kind: 'total' },
  { text: 'grand total', kind: 'total' },
  { text: 'total due', kind: 'total' },
  { text: 'total gbp', kind: 'total' },
  { text: 'total', kind: 'total' },

  { text: 'total excluding vat', kind: 'net' },
  { text: 'total excl vat', kind: 'net' },
  { text: 'total exc vat', kind: 'net' },
  { text: 'total ex vat', kind: 'net' },
  { text: 'goods total', kind: 'net' },
  { text: 'net total', kind: 'net' },
  { text: 'total net', kind: 'net' },
  { text: 'net amount', kind: 'net' },
  { text: 'sub total', kind: 'net' },
  { text: 'subtotal', kind: 'net' },
  { text: 'net', kind: 'net' },

  { text: 'value added tax', kind: 'vat' },
  { text: 'total vat', kind: 'vat' },
  { text: 'vat total', kind: 'vat' },
  { text: 'vat amount', kind: 'vat' },
  { text: 'vat', kind: 'vat' },
]

/** Longest first, which is the whole of how the three kinds are kept apart. */
const LABELS = [...LABEL_LIST].sort((a, b) => b.text.length - a.text.length)

/**
 * A label, reduced to the words that identify it.
 *
 * The rate is taken out rather than left in, because "VAT @ 20%" and "VAT at
 * 20.0 %" and "VAT (20%)" are one label written three ways, and a list of
 * synonyms that has to include every rate anybody might charge is a list that
 * will be wrong the week a rate changes.
 */
function normaliseLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(\s*(gbp|£|\$|€)\s*\)/g, ' ')
    .replace(/[@(]?\s*(at\s+)?\d+(\.\d+)?\s*%\s*\)?/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function labelKind(label: string): LabelKind | null {
  const normalised = normaliseLabel(label)
  if (!normalised) return null
  for (const entry of LABELS) {
    if (normalised === entry.text) return entry.kind
    // Word-boundary endsWith, so "invoice total" reaches the total rule but
    // "subtotal" is never read as ending in "total".
    if (normalised.endsWith(` ${entry.text}`)) return entry.kind
  }
  return null
}

/**
 * The labelled figures on one row of the document.
 *
 * A row is used rather than a line of plain text because that is how an invoice
 * lays its totals out: the words on the left of the page and the figure on the
 * right, with a gulf between them that only the coordinates know about. The
 * LAST figure on the row wins - a row reading "VAT @ 20% 61.70 12.34" is a
 * three-column table whose answer is in the last column.
 */
function readLabelledRow(row: PdfTextRow): { kind: LabelKind; amount: Prisma.Decimal } | null {
  const text = row.cells.map((cell) => cell.text).join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return null

  let matches = [...text.matchAll(MONEY_TOKEN)]
  if (matches.length === 0) matches = [...text.matchAll(WHOLE_POUNDS_TOKEN)]
  const last = matches[matches.length - 1]
  if (!last || last.index === undefined) return null

  const amount = toDecimal(last[0])
  if (amount === null) return null

  const kind = labelKind(text.slice(0, last.index))
  return kind ? { kind, amount } : null
}

type Totals = { net: Prisma.Decimal | null; vat: Prisma.Decimal | null; total: Prisma.Decimal | null }

/**
 * The three figures, reconciled.
 *
 * Later rows win, because an invoice prints its per-page carry-forwards before
 * its payable total and the one at the bottom is the one that matters. Then
 * whichever of the three is missing is worked out from the other two, and a set
 * of three that does not add up is resolved by trusting the total and the net -
 * those are printed in bigger type and misread less often than a VAT line that
 * may have been split across two rates.
 */
function reconcileTotals(rows: PdfTextRow[]): Totals {
  const found: Totals = { net: null, vat: null, total: null }
  for (const row of rows) {
    const read = readLabelledRow(row)
    if (read) found[read.kind] = read.amount.abs()
  }

  const { net, vat, total } = found
  if (total && net && vat) {
    return net.plus(vat).equals(total) ? found : { net, total, vat: total.minus(net) }
  }
  if (total && vat && !net) return { total, vat, net: total.minus(vat) }
  if (total && net && !vat) return { total, net, vat: total.minus(net) }
  if (net && vat && !total) return { net, vat, total: net.plus(vat) }
  return found
}

/**
 * Which rate the VAT figure implies, from the arithmetic and never from wording.
 *
 * Null where the ratio is none of the UK rates, which usually means the document
 * carries two rates at once. Half a guess about VAT is worse than none: it lands
 * in a box that goes to HMRC.
 */
function rateCodeFor(net: Prisma.Decimal | null, vat: Prisma.Decimal | null): VatRateCode | null {
  if (!vat) return null
  if (vat.isZero()) return 'zero'
  if (!net || net.isZero()) return null
  const percent = vat.dividedBy(net).times(100)
  if (percent.minus(20).abs().lessThanOrEqualTo('0.5')) return 'standard'
  if (percent.minus(5).abs().lessThanOrEqualTo('0.5')) return 'reduced'
  return null
}

// ---------------------------------------------------------------------------
// VAT registration numbers
// ---------------------------------------------------------------------------

/**
 * HMRC's modulus-97 check on a nine-digit VAT number.
 *
 * Worth doing rather than trusting any nine digits near the word VAT: a company
 * registration number, a phone number and an account number all sit near it on a
 * letterhead, and a wrong VAT number here would go on to claim the wrong
 * supplier for every later document.
 *
 * Both the original scheme and the "9755" scheme HMRC added when it ran out of
 * numbers are accepted, which is what the published algorithm says to do.
 */
export function isValidVatNumber(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false
  const weights = [8, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 7; i += 1) sum += Number(digits[i]) * weights[i]!
  const check = Number(digits.slice(7))
  return (sum + check) % 97 === 0 || (sum + check + 55) % 97 === 0
}

const VAT_NUMBER_LABEL = /(?:vat|v\.a\.t\.?)[^\n]{0,24}?(?:reg(?:istration)?|no\.?|number|#)?[^\n]{0,12}?/i

/**
 * The supplier's VAT number, normalised to GB999999999.
 *
 * Accepted only with a GB prefix or a VAT label in front of it, AND only when it
 * passes the checksum. A three-digit branch suffix is dropped: the registration
 * is the nine digits, and keeping the branch would make two invoices from the
 * same company look like two companies.
 */
export function findVatNumber(text: string): string | null {
  // The optional trailing group is the branch suffix, and it has to be MATCHED
  // rather than merely allowed: \b after the ninth digit cannot succeed when a
  // tenth digit follows it, so without this a twelve-digit number was read as no
  // number at all.
  const withPrefix = /\bGB\s*(\d{3})\s*(\d{4})\s*(\d{2})(?:\s*\d{3})?\b/gi
  for (const match of text.matchAll(withPrefix)) {
    const digits = `${match[1]}${match[2]}${match[3]}`
    if (isValidVatNumber(digits)) return `GB${digits}`
  }

  const labelled = new RegExp(
    `${VAT_NUMBER_LABEL.source}(\\d{3}[\\s-]?\\d{4}[\\s-]?\\d{2})(?:[\\s-]?\\d{3})?\\b`,
    'gi',
  )
  for (const match of text.matchAll(labelled)) {
    const digits = match[1]!.replace(/[\s-]/g, '')
    if (isValidVatNumber(digits)) return `GB${digits}`
  }
  return null
}

// ---------------------------------------------------------------------------
// Dates and document numbers
// ---------------------------------------------------------------------------

const DATE_TOKEN =
  /\b(\d{1,2}(?:st|nd|rd|th)?[\s\-/.]+(?:\d{1,2}|[A-Za-z]{3,9})\.?[\s\-/.,]+\d{2,4}|\d{4}-\d{1,2}-\d{1,2}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4})\b/g

/** Labels that introduce the date we want, best first. "Due date" is not one of them. */
const DATE_LABELS = [
  'tax point',
  'date of issue',
  'invoice date',
  'receipt date',
  'document date',
  'issue date',
  'date issued',
  'date of supply',
  'dated',
  'date',
]

function parseDateToken(raw: string): string | null {
  // parseStatementDate is anchored, so an ordinal suffix has to go first or
  // "1st Sep 2026" never reaches the named-month branch.
  return parseStatementDate(raw.replace(/(\d{1,2})(st|nd|rd|th)/i, '$1'))
}

/**
 * Sensible for an invoice date. Anything outside this is a misread - a serial
 * number that happened to look like a date, or a page footer's copyright year.
 */
function plausibleDocumentDate(iso: string, today: string): boolean {
  if (iso < '2000-01-01') return false
  const limit = new Date(`${today}T00:00:00Z`)
  limit.setUTCFullYear(limit.getUTCFullYear() + 1)
  return iso <= limit.toISOString().slice(0, 10)
}

export function findDocumentDate(text: string, today: string): string | null {
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()

  for (const label of DATE_LABELS) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(label, from)
      if (at === -1) break
      from = at + label.length
      // "Due date" and "Delivery date" both end in "date" and neither is the
      // date we want, so a label only counts when a word boundary precedes it.
      const before = at === 0 ? ' ' : lower[at - 1]!
      const preceding = lower.slice(Math.max(0, at - 12), at)
      if (!/[\s:(\-]/.test(before) || /\b(due|deliver\w*|order|payment|paid|period)\s$/.test(preceding)) {
        continue
      }
      const window = flat.slice(from, from + 40)
      const match = DATE_TOKEN.exec(window)
      DATE_TOKEN.lastIndex = 0
      if (!match) continue
      const iso = parseDateToken(match[1]!)
      if (iso && plausibleDocumentDate(iso, today)) return iso
    }
  }

  // Nothing labelled. The first readable date on the page is very nearly always
  // the invoice date, because that is where invoices put it.
  for (const match of flat.matchAll(DATE_TOKEN)) {
    const iso = parseDateToken(match[1]!)
    if (iso && plausibleDocumentDate(iso, today)) return iso
  }
  return null
}

/** Labels that introduce the number we want, best first. */
const NUMBER_LABELS = [
  'tax invoice no',
  'vat invoice no',
  'invoice number',
  'invoice no',
  'invoice ref',
  'invoice id',
  'invoice #',
  'invoice',
  'receipt number',
  'receipt no',
  'receipt #',
  'credit note no',
  'document no',
  'our ref',
  'order number',
  'order no',
  'reference no',
]

/** Words that follow a label but are plainly not a number. */
const NOT_A_NUMBER = /^(date|dated|to|for|from|no|number|ref|reference|total|due|of|is|and|the)$/i

export function findDocumentNumber(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()

  for (const label of NUMBER_LABELS) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(label, from)
      if (at === -1) break
      from = at + label.length
      const before = at === 0 ? ' ' : lower[at - 1]!
      if (!/[\s:(\-]/.test(before)) continue

      const window = flat.slice(from, from + 40)
      const match = /^[\s:.#-]*([A-Za-z0-9][A-Za-z0-9/\-_.]{1,29})/.exec(window)
      if (!match) continue
      const candidate = match[1]!.replace(/[.,;:]+$/, '')
      if (!candidate || NOT_A_NUMBER.test(candidate)) continue
      // "Invoice Date 04/09/2026" would otherwise hand back the date.
      if (parseDateToken(candidate)) continue
      // A number with no digit in it at all is a word we misread as a label's value.
      if (!/\d/.test(candidate)) continue
      return candidate
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Who it is from
// ---------------------------------------------------------------------------

/** Words on a letterhead that are the document's own title, not anybody's name. */
const TITLE_PHRASES = new Set([
  'invoice', 'tax invoice', 'vat invoice', 'receipt', 'vat receipt', 'sales invoice',
  'purchase invoice', 'credit note', 'statement', 'statement of account', 'remittance',
  'remittance advice', 'delivery note', 'purchase order', 'order confirmation', 'quotation',
  'quote', 'estimate', 'proforma', 'pro forma', 'pro forma invoice', 'bill', 'payment receipt',
  'bill to', 'billed to', 'invoice to', 'sold to', 'ship to', 'deliver to', 'customer',
  'account', 'date', 'description', 'page', 'your reference', 'our reference', 'from', 'to',
])

/**
 * The top of page one, where a letterhead lives.
 *
 * The page height is not something lib/pdf exposes, and it does not need to be:
 * the highest and lowest text on the page bound it perfectly well, and a
 * fraction of that range is what "the top" means on a page of any size.
 */
function headerItems(items: PdfTextItem[]): PdfTextItem[] {
  const page = items.filter((item) => item.page === 0)
  if (page.length === 0) return []
  const ys = page.map((item) => item.y)
  const top = Math.max(...ys)
  const bottom = Math.min(...ys)
  // A fraction of the range, with a floor. On a full invoice the fraction is
  // what matters; on a three-line receipt the range is forty points and 45% of
  // it is one row, which excluded the supplier's own name from the very band it
  // was meant to be found in.
  const cutoff = top - Math.max((top - bottom) * 0.45, 120)
  return page.filter((item) => item.y >= cutoff)
}

/**
 * The biggest thing written at the top of the page that is not the document's
 * own title and not us.
 *
 * This is what a person does when they glance at an invoice, and it is right
 * more often than anything cleverer. It is also the weakest source here, so it
 * scores accordingly and gives way to anything the books already recognise.
 */
function letterheadName(items: PdfTextItem[], ownName: string | null): string | null {
  const header = headerItems(items)
  if (header.length === 0) return null

  const own = ownName ? normaliseAlias(ownName) : null
  const candidates = header
    .map((item) => ({ item, text: item.text.replace(/\s+/g, ' ').trim() }))
    .filter(({ text }) => {
      if (text.length < 3 || text.length > 60) return false
      if (!/[A-Za-z]{3}/.test(text)) return false
      if (TITLE_PHRASES.has(text.toLowerCase().replace(/[^a-z ]/g, '').trim())) return false
      // An address line, a phone number or a VAT line is not the name.
      if (/^[\d\s+()-]+$/.test(text)) return false
      if (/@|www\.|https?:/i.test(text)) return false
      // Nor is a figure, nor the word in front of one. On a short receipt the
      // header band reaches the totals block, and "Total" is otherwise a
      // perfectly good-looking company name in the biggest type on the page.
      if (/\d[\d,]*\.\d{2}/.test(text)) return false
      if (labelKind(text) !== null) return false
      if (own && normaliseAlias(text) === own) return false
      return true
    })

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.item.size - a.item.size || b.item.y - a.item.y)
  return candidates[0]!.text
}

/** A supplier's name off their own web address, when nothing else offers one. */
function domainName(text: string, ownName: string | null): string | null {
  const match = /(?:https?:\/\/|www\.|@)([a-z0-9][a-z0-9-]{1,60})\.(?:co\.uk|org\.uk|ltd\.uk|uk|com|net|org|io|shop|store)\b/i.exec(
    text,
  )
  if (!match) return null
  const raw = match[1]!.replace(/-/g, ' ')
  // Mail providers say nothing about who sent the invoice.
  if (/^(gmail|googlemail|outlook|hotmail|yahoo|icloud|live|btinternet|aol|me|mail)$/i.test(raw)) {
    return null
  }
  const name = raw.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
  if (ownName && normaliseAlias(name) === normaliseAlias(ownName)) return null
  return name
}

/** The filename, as a last resort. "Acme Ltd invoice 42.pdf" is not nothing. */
function filenameName(filename: string): string | null {
  const stem = filename
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(invoice|receipt|inv|rcpt|bill|statement|scan|img|doc|copy|final)\b/gi, ' ')
    .replace(/\d{4,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stem.length >= 3 && /[A-Za-z]{3}/.test(stem) ? stem : null
}

type NameGuess = {
  counterparty: string
  confidence: number
  source: CounterpartySource
}

/**
 * Who the document is from, best answer first.
 *
 * The order is the order of how much each source actually knows. A VAT number
 * matched to a supplier we have seen before is a fact; a name the books already
 * hold, found written on the page, is nearly one; a name learned from a
 * correction is as good as whoever made the correction; and the letterhead, the
 * web address and the filename are three grades of educated guess.
 *
 * Every source resolves through to the spelling the BOOKS use where it can, so
 * filing under it matches what is already there instead of growing a second
 * supplier with the same name and different punctuation.
 */
export function guessCounterparty(
  input: { plain: string; items: PdfTextItem[]; filename: string; vatNumber: string | null },
  context: ReadingContext,
): NameGuess | null {
  const { plain, items, filename, vatNumber } = input

  if (vatNumber) {
    const owner = context.vatNumberOwners.get(vatNumber)
    if (owner) return { counterparty: owner, confidence: 96, source: 'vat_number' }
  }

  const header = headerItems(items)
    .map((item) => item.text)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
  const whole = plain.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  const ownKey = context.ownBusinessName ? normaliseAlias(context.ownBusinessName) : null

  // A name the books already hold, written on the page. Longest name first: if
  // both "Acme" and "Acme Building Supplies" are known and both appear, the more
  // specific one is the one the document means.
  const known = [...context.knownCounterparties]
    .filter((name) => !ownKey || normaliseAlias(name) !== ownKey)
    .sort((a, b) => significantWords(b, DOCUMENT_STOP_WORDS).size - significantWords(a, DOCUMENT_STOP_WORDS).size)
  for (const name of known) {
    if (allWordsPresent(name, header)) return { counterparty: name, confidence: 90, source: 'known' }
  }
  for (const name of known) {
    if (allWordsPresent(name, whole)) return { counterparty: name, confidence: 78, source: 'known' }
  }

  // Something learned from a correction somebody made earlier.
  const aliases = [...context.aliases.entries()].sort((a, b) => b[0].length - a[0].length)
  for (const [alias, counterparty] of aliases) {
    if (ownKey && alias === ownKey) continue
    if (allWordsPresent(alias, header) || allWordsPresent(alias, whole)) {
      return { counterparty, confidence: 82, source: 'alias' }
    }
  }

  const letterhead = letterheadName(items, context.ownBusinessName)
  if (letterhead) {
    const resolved = context.aliases.get(normaliseAlias(letterhead))
    if (resolved) return { counterparty: resolved, confidence: 80, source: 'alias' }
    return { counterparty: letterhead, confidence: 55, source: 'letterhead' }
  }

  const domain = domainName(plain, context.ownBusinessName)
  if (domain) {
    const resolved = context.aliases.get(normaliseAlias(domain))
    return resolved
      ? { counterparty: resolved, confidence: 76, source: 'alias' }
      : { counterparty: domain, confidence: 40, source: 'domain' }
  }

  const fromFilename = filenameName(filename)
  if (fromFilename) {
    const resolved = context.aliases.get(normaliseAlias(fromFilename))
    return resolved
      ? { counterparty: resolved, confidence: 70, source: 'alias' }
      : { counterparty: fromFilename, confidence: 20, source: 'filename' }
  }

  return null
}

// ---------------------------------------------------------------------------
// The whole job
// ---------------------------------------------------------------------------

function moneyOrNull(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toFixed(2)
}

/** The reading, given text already lifted out of a PDF. Pure, and where the tests bite. */
export function readExtractedText(
  pdf: Pick<PdfText, 'plain' | 'rows' | 'items'>,
  filename: string,
  context: ReadingContext,
  today: string,
): DocumentReading {
  const vatNumber = findVatNumber(pdf.plain)
  const totals = reconcileTotals(pdf.rows)
  const guess = guessCounterparty(
    { plain: pdf.plain, items: pdf.items, filename, vatNumber },
    context,
  )

  // Our own VAT number on the document means we WROTE it, so it is a sale.
  // Anything else is a purchase, which is what an inbox of receipts is made of.
  const own = context.ownVatNumber?.replace(/[^0-9]/g, '') ?? null
  const isOurs = !!(vatNumber && own && vatNumber.slice(2) === own)

  return {
    scanStatus: 'read',
    scanNote: null,
    counterparty: guess?.counterparty ?? null,
    counterpartyConfidence: guess?.confidence ?? 0,
    counterpartySource: guess?.source ?? null,
    direction: isOurs ? 'income' : 'expense',
    documentDate: findDocumentDate(pdf.plain, today),
    documentNumber: findDocumentNumber(pdf.plain),
    net: moneyOrNull(totals.net),
    vat: moneyOrNull(totals.vat),
    total: moneyOrNull(totals.total),
    vatRateCode: rateCodeFor(totals.net, totals.vat),
    // Never our own number in the supplier's column - it would go on to claim
    // every later document for us.
    vatNumber: isOurs ? null : vatNumber,
    text: pdf.plain.slice(0, MAX_EXTRACTED_TEXT),
  }
}

const NO_TEXT_NOTE =
  'There is no text in this one to read - it is a photo or a scan. Fill in who it was with and it will be remembered for next time.'

/**
 * Read a file, whatever it turns out to be.
 *
 * Never throws. A document that cannot be read still has to upload, still has to
 * be filed against an entry, and still counts as evidence: refusing the upload
 * because our reader had a bad day would be the module losing a receipt on a
 * technicality.
 */
export function readDocument(
  input: { bytes: Buffer; mimeType: string; filename: string },
  context: ReadingContext,
  today: string = new Date().toISOString().slice(0, 10),
): DocumentReading {
  if (input.mimeType !== 'application/pdf') {
    return { ...EMPTY_READING, scanStatus: 'no_text', scanNote: NO_TEXT_NOTE }
  }

  let pdf: PdfText
  try {
    pdf = extractPdfText(input.bytes)
  } catch (error) {
    // "No readable text" is the scanned-page case and is not a fault. Anything
    // else means the file itself would not parse.
    if (error instanceof PdfError && /no readable text/i.test(error.message)) {
      return { ...EMPTY_READING, scanStatus: 'no_text', scanNote: NO_TEXT_NOTE }
    }
    return {
      ...EMPTY_READING,
      scanStatus: 'unreadable',
      scanNote: 'This PDF could not be opened, so nothing has been read off it. It is still saved.',
    }
  }

  try {
    return readExtractedText(pdf, input.filename, context, today)
  } catch {
    return {
      ...EMPTY_READING,
      scanStatus: 'unreadable',
      scanNote: 'We could not make sense of this one. It is still saved, and you can fill it in yourself.',
      text: pdf.plain.slice(0, MAX_EXTRACTED_TEXT),
    }
  }
}
