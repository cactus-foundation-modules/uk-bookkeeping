import { Prisma } from '@prisma/client'

// What a bank statement says, in one shape, whether it arrived as a CSV or as a
// PDF. Both readers produce this and everything downstream - duplicate
// detection, matching, the review screen - works from it and never from the
// file.

export type StatementLine = {
  /** ISO date, yyyy-mm-dd. */
  date: string
  /** Everything the statement printed for this line, wrapped lines joined up. */
  details: string
  /** Our reading of who it was with. */
  counterparty: string
  reference: string | null
  /** 'Card Transaction', 'Direct Debit', 'Faster Payment' - whatever the bank called it. */
  transactionType: string | null
  /** Signed: positive is money in, negative is money out. Two decimal places. */
  amount: string
  /** The running balance the statement printed on this line, where it printed one. */
  balance: string | null
}

export type StatementMeta = {
  bank: string | null
  accountLast4: string | null
  sortCode: string | null
  periodStart: string | null
  periodEnd: string | null
  openingBalance: string | null
  closingBalance: string | null
  totalPaidIn: string | null
  totalPaidOut: string | null
}

export type ParsedStatement = {
  lines: StatementLine[]
  meta: StatementMeta
  /** How the file was read, kept so a wrong reading can be explained later. */
  mapping: Record<string, unknown>
  /** Things worth telling the reviewer that are not errors. */
  warnings: string[]
}

export const EMPTY_META: StatementMeta = {
  bank: null,
  accountLast4: null,
  sortCode: null,
  periodStart: null,
  periodEnd: null,
  openingBalance: null,
  closingBalance: null,
  totalPaidIn: null,
  totalPaidOut: null,
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * A money figure off a statement, or null if the text is not one.
 *
 * Copes with a currency symbol, thousands separators, a parenthesised minus, a
 * trailing minus, and the CR/DR suffixes some banks still print. Deliberately
 * strict about what it will accept: a description that happens to contain a
 * number must not be read as an amount, or a reference number becomes a payment.
 */
export function parseStatementAmount(value: string): Prisma.Decimal | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '-' || trimmed === '–') return null

  const parenthesised = /^\(.*\)$/.test(trimmed)
  const suffix = /\b(CR|DR)\b\.?$/i.exec(trimmed)
  const trailingMinus = /-\s*$/.test(trimmed)

  const cleaned = trimmed
    .replace(/\b(CR|DR)\b\.?$/i, '')
    .replace(/[()£$€,\s]/g, '')
    .replace(/-\s*$/, '')

  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null

  let decimal = new Prisma.Decimal(cleaned).toDecimalPlaces(2)
  if (parenthesised || trailingMinus) decimal = decimal.negated()
  if (suffix && suffix[1]!.toUpperCase() === 'DR') decimal = decimal.abs().negated()
  return decimal
}

/** True when the text is nothing but a money figure. Used to spot amount columns. */
export function looksLikeAmount(value: string): boolean {
  return parseStatementAmount(value) !== null
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

function isoFrom(year: number, month: number, day: number): string | null {
  if (!year || !month || !day || month > 12 || day > 31) return null
  const full = year < 100 ? 2000 + year : year
  const date = new Date(Date.UTC(full, month - 1, day))
  // Date.UTC rolls an impossible date over - 30 February becomes 2 March - which
  // would turn a misread statement date into a plausibly wrong record rather
  // than into an error somebody can see.
  if (
    date.getUTCFullYear() !== full ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date.toISOString().slice(0, 10)
}

/**
 * A date as a statement prints one.
 *
 * Numeric dates are read day-first. Every bank writing to a UK business account
 * writes them that way, and the alternative is a silent one-in-three chance of
 * filing March's rent in April.
 */
export function parseStatementDate(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  // 29 Jul 2026 · 29 July 2026 · 29-Jul-2026 · Jul 29 2026
  const named = /^(\d{1,2})[\s\-/]*([A-Za-z]{3,9})\.?[\s\-/]*(\d{2,4})/.exec(trimmed)
  if (named) {
    const month = MONTHS[named[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[named[2]!.slice(0, 3).toLowerCase()]
    if (month) return isoFrom(Number(named[3]), month, Number(named[1]))
  }
  const namedFirst = /^([A-Za-z]{3,9})\.?[\s\-/]*(\d{1,2}),?[\s\-/]*(\d{2,4})/.exec(trimmed)
  if (namedFirst) {
    const month = MONTHS[namedFirst[1]!.slice(0, 4).toLowerCase()] ?? MONTHS[namedFirst[1]!.slice(0, 3).toLowerCase()]
    if (month) return isoFrom(Number(namedFirst[3]), month, Number(namedFirst[2]))
  }

  // 2026-07-29
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(trimmed)
  if (iso) return isoFrom(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  // 29/07/2026
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(trimmed)
  if (numeric) return isoFrom(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]))

  return null
}

// ---------------------------------------------------------------------------
// Reading a description
// ---------------------------------------------------------------------------

/**
 * Noise a statement prints alongside the description that is not part of who the
 * payment was with. Kept in `details` - it is what the bank said - but taken out
 * of the counterparty, where it would make every Amazon purchase a different
 * supplier and defeat the "what did I file this under last time" suggestion.
 */
const NOISE_PATTERNS: RegExp[] = [
  /\bFee\s*\(£\)\s*:\s*[\d.,]+/gi,
  /\bTide Card\s*:\s*[*\s\d]+/gi,
  /\bCard\s*(?:no\.?|number)?\s*:?\s*(?:\*{4}[\s*]*){2,}\d{4}/gi,
  /\bOn\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/gi,
  /\bRef(?:erence)?\s*:?\s*/gi,
]

const TRAILING_JUNK = /[\s,;:\-–/|]+$/

/**
 * Who a statement line was with, and any reference it carried.
 *
 * The shape banks converge on is "WHO - where they are", or "WHO / ref: what
 * it was for". Both are split here; anything else is left whole, because a
 * counterparty that has been over-trimmed is worse than one that is too long.
 */
export function readCounterparty(details: string): { counterparty: string; reference: string | null } {
  const collapsed = details.replace(/\s+/g, ' ').trim()

  let reference: string | null = null
  const referenceMatch = /\bref(?:erence)?\s*:?\s*([^,/|]+)/i.exec(collapsed)
  if (referenceMatch) reference = referenceMatch[1]!.trim().replace(TRAILING_JUNK, '') || null

  let who = collapsed
  // Take the part before the first separator that introduces an address or a
  // reference, whichever comes first.
  const cut = /\s(?:-|–|\/)\s/.exec(who)
  if (cut && cut.index > 2) who = who.slice(0, cut.index)

  for (const pattern of NOISE_PATTERNS) who = who.replace(pattern, ' ')
  who = who.replace(/\s+/g, ' ').replace(TRAILING_JUNK, '').trim()

  return { counterparty: who || collapsed.slice(0, 120), reference }
}

/** Strip the noise a bank prints inside a description, for display. */
export function tidyDetails(details: string): string {
  return details.replace(/\s+/g, ' ').trim()
}
