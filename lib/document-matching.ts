import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMoney, formatPounds, toMoney } from './money'
import { nameSimilarity } from './name-matching'
import { normaliseAlias } from './counterparty-aliases'
import type { AttachmentScanStatus, Direction, VatRateCode } from './types'

// Offering an unfiled receipt against a payment.
//
// The same job the entry matcher does in lib/reconciliation.ts, one step
// earlier: that one asks "which entry already in the books explains this
// statement line", this one asks "which piece of paperwork nobody has typed up
// yet is what this payment was for". Confirming one of these is what turns a
// statement line, a PDF and thirty seconds into a finished entry with its
// evidence already attached.
//
// The rule the entry matcher keeps is kept here too: the AMOUNT has to agree to
// the penny, or the name has to be a strong match, and never neither. A matcher
// willing to be approximate about money will eventually tie a £95 invoice to a
// £59 one, and the damage is not that it is wrong - it is that it LOOKS
// explained, so nobody ever looks again.

/** How far apart a document's date and its payment may sensibly be. */
const DATE_WINDOW_DAYS = 60

/**
 * The unfiled pile, in full.
 *
 * Reading the lot rather than querying per line, same reasoning as the entry
 * matcher: a statement page carries a hundred lines, every module route is
 * capped at sixty seconds by the core dispatcher, and PgBouncer puts four
 * network round trips behind each query. The unfiled pile is small by its
 * nature - it is the paperwork not yet dealt with, which is weeks of it, not
 * years. The cap is a backstop and the caller is told when it bites.
 */
const MAX_POOL = 500

export type DocumentCandidate = {
  documentId: string
  name: string
  filename: string
  mimeType: string
  scanStatus: AttachmentScanStatus
  counterparty: string | null
  counterpartyConfidence: number
  documentDate: string | null
  documentNumber: string | null
  net: string | null
  vat: string | null
  total: string | null
  vatRateCode: VatRateCode | null
  direction: Direction | null
  score: number
  reasons: string[]
}

export type DocumentMatchLine = {
  date: string
  /** Signed, as the statement has it. */
  amount: string
  counterparty: string
  details: string
  reference: string | null
}

export type PoolRow = {
  id: string
  name: string
  filename: string
  mime_type: string
  scan_status: AttachmentScanStatus
  guessed_counterparty: string | null
  counterparty_confidence: number
  guessed_document_date: Date | null
  guessed_document_number: string | null
  guessed_net: Prisma.Decimal | null
  guessed_vat: Prisma.Decimal | null
  guessed_total: Prisma.Decimal | null
  guessed_vat_rate_code: VatRateCode | null
  guessed_direction: Direction | null
}

async function loadPool(): Promise<PoolRow[]> {
  return prisma.$queryRaw<PoolRow[]>`
    SELECT "id", "name", "filename", "mime_type", "scan_status",
           "guessed_counterparty", "counterparty_confidence", "guessed_document_date",
           "guessed_document_number", "guessed_net", "guessed_vat", "guessed_total",
           "guessed_vat_rate_code", "guessed_direction"
    FROM "bk_attachments"
    WHERE "transaction_id" IS NULL
    ORDER BY "created_at" DESC
    LIMIT ${MAX_POOL}
  `
}

function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00Z`)
  const right = Date.parse(`${b}T00:00:00Z`)
  return Math.round(Math.abs(left - right) / 86_400_000)
}

function toCandidate(row: PoolRow, score: number, reasons: string[]): DocumentCandidate {
  return {
    documentId: row.id,
    name: row.name,
    filename: row.filename,
    mimeType: row.mime_type,
    scanStatus: row.scan_status,
    counterparty: row.guessed_counterparty,
    counterpartyConfidence: row.counterparty_confidence,
    documentDate: row.guessed_document_date?.toISOString().slice(0, 10) ?? null,
    documentNumber: row.guessed_document_number,
    net: row.guessed_net === null ? null : formatMoney(row.guessed_net),
    vat: row.guessed_vat === null ? null : formatMoney(row.guessed_vat),
    total: row.guessed_total === null ? null : formatMoney(row.guessed_total),
    vatRateCode: row.guessed_vat_rate_code,
    direction: row.guessed_direction,
    score,
    reasons,
  }
}

/**
 * Score one document against one statement line.
 *
 * Returns null when the document is disqualified rather than merely unlikely,
 * which is the case that matters: a document whose total is a DIFFERENT amount
 * is not a weak match, it is the wrong document, and it must never appear in a
 * list somebody is going to click through quickly.
 */
export function scoreDocumentAgainstLine(
  line: DocumentMatchLine,
  row: PoolRow,
  aliases: Map<string, string>,
): { score: number; reasons: string[] } | null {
  const lineAmount = toMoney(line.amount)
  const gross = lineAmount.abs()
  const reasons: string[] = []
  let total = 0

  const documentTotal = row.guessed_total
  if (documentTotal !== null) {
    if (!documentTotal.abs().equals(gross)) return null
    total += 55
    reasons.push(`${formatPounds(gross)}, to the penny`)
  }

  // Who it is with. The document's supplier read through what the site has
  // learned, so "SQ *THE COFFEE SHOP" on the statement finds "The Coffee Shop
  // Limited" on the invoice.
  const documentName = row.guessed_counterparty
  let similarity = 0
  if (documentName) {
    const resolved = aliases.get(normaliseAlias(line.counterparty)) ?? line.counterparty
    similarity = Math.max(
      nameSimilarity(resolved, documentName),
      nameSimilarity(line.counterparty, documentName),
      nameSimilarity(line.details, documentName),
    )
    if (similarity >= 0.99) {
      total += 30
      reasons.push(documentName)
    } else if (similarity >= 0.5) {
      total += Math.round(similarity * 24)
      reasons.push(`looks like ${documentName}`)
    }
  }

  // Nothing agrees on the amount and nothing agrees on the name. Whatever this
  // is, it is not evidence that this is the one.
  if (documentTotal === null && similarity < 0.6) return null

  const documentDate = row.guessed_document_date?.toISOString().slice(0, 10) ?? null
  if (documentDate) {
    const gap = daysBetween(documentDate, line.date)
    if (gap > DATE_WINDOW_DAYS) return null
    if (gap === 0) {
      total += 15
      reasons.push('same day')
    } else if (gap <= 7) {
      total += 12
      reasons.push(`${gap} day${gap === 1 ? '' : 's'} apart`)
    } else if (gap <= 31) {
      total += 6
      reasons.push(`${gap} days apart`)
    }
  }

  // A reference on the statement line that carries the invoice number is about
  // as certain as this gets outside of a matching amount.
  const documentNumber = row.guessed_document_number
  if (documentNumber && documentNumber.length >= 4) {
    const haystack = `${line.reference ?? ''} ${line.details}`.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (haystack.includes(documentNumber.toLowerCase().replace(/[^a-z0-9]/g, ''))) {
      total += 30
      reasons.push(`reference ${documentNumber}`)
    }
  }

  // Money out wants a purchase invoice, money in wants a sales one.
  if (row.guessed_direction) {
    const wanted: Direction = lineAmount.isNegative() ? 'expense' : 'income'
    if (row.guessed_direction === wanted) total += 4
    else total -= 20
  }

  // Deliberately NOT capped at a hundred. The score orders a list and is never
  // shown, and a ceiling threw away the ordering exactly where it was worth
  // most: an invoice matching on amount, name, date AND carrying its number on
  // the statement line scored the same as one that merely matched on three of
  // them.
  return total > 0 ? { score: total, reasons } : null
}

export type DocumentSuggestions = {
  /** Keyed by the caller's own index into the lines it handed over. */
  byLine: Map<number, DocumentCandidate[]>
  /** True when the unfiled pile was bigger than we were willing to read. */
  truncated: boolean
}

/**
 * Unfiled documents that might explain each of these statement lines.
 *
 * One read of the pile and then arithmetic on rows already in hand - never a
 * query per line.
 */
export async function suggestDocumentsForLines(
  lines: DocumentMatchLine[],
  aliases: Map<string, string>,
  limit = 4,
): Promise<DocumentSuggestions> {
  const byLine = new Map<number, DocumentCandidate[]>()
  if (lines.length === 0) return { byLine, truncated: false }

  const pool = await loadPool()
  if (pool.length === 0) return { byLine, truncated: false }

  lines.forEach((line, index) => {
    const scored: DocumentCandidate[] = []
    for (const row of pool) {
      const result = scoreDocumentAgainstLine(line, row, aliases)
      if (result) scored.push(toCandidate(row, result.score, result.reasons))
    }
    scored.sort((a, b) => b.score - a.score || b.counterpartyConfidence - a.counterpartyConfidence)
    if (scored.length > 0) byLine.set(index, scored.slice(0, limit))
  })

  return { byLine, truncated: pool.length >= MAX_POOL }
}
