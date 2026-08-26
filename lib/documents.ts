import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { aliasMap, learnAlias, normaliseAlias } from './counterparty-aliases'
import {
  readDocument,
  type DocumentReading,
  type ReadingContext,
} from './document-reading'
import { BookkeepingError, NotFoundError } from './errors'
import { assertTransactionMutable } from './guards'
import { formatMoney, isMoneyString } from './money'
import { getSettings } from './settings'
import { listKnownCounterparties } from './transactions'
import type { BkAttachmentRow, Direction, VatRateCode } from './types'

// The document inbox: evidence that arrived before the entry did.
//
// A row in bk_attachments with no transaction_id is a document nobody has filed
// yet. That is the whole of the data model - there is no second table, because
// the download route, the media-usage provider, the media-reference rewriter,
// the backup serialiser and the six-year retention promise all already work on
// bk_attachments and none of them should have to learn a second one.
//
// Filing a document is therefore an UPDATE and not an upload, which matters more
// than it sounds: the bytes are already in storage, already in the media
// library, already hashed, and already counted as in-use. Filing cannot fail
// halfway and leave a receipt nobody can find.

export type BkDocumentRow = BkAttachmentRow

const MAX_PAGE = 200

// ---------------------------------------------------------------------------
// What the reader needs to know
// ---------------------------------------------------------------------------

/**
 * Everything the reader is allowed to know about this site, gathered once.
 *
 * Assembled here rather than looked up inside the reader so the reader stays a
 * pure function: the awkward cases in document-reading.test.ts are awkward
 * enough without a database in the way.
 */
export async function buildReadingContext(): Promise<ReadingContext> {
  const [settings, knownCounterparties, aliases, vatOwners] = await Promise.all([
    getSettings(),
    listKnownCounterparties(300),
    aliasMap(),
    // Which supplier a VAT registration number belongs to, learned from
    // documents already read. A filed document outranks an unfiled one and a
    // recent one outranks an old one, so the first row per number wins.
    prisma.$queryRaw<{ vat_number: string; counterparty: string }[]>`
      SELECT DISTINCT ON (a."guessed_vat_number")
             a."guessed_vat_number" AS vat_number,
             COALESCE(t."counterparty", a."guessed_counterparty") AS counterparty
      FROM "bk_attachments" a
      LEFT JOIN "bk_transactions" t ON t."id" = a."transaction_id"
      WHERE a."guessed_vat_number" IS NOT NULL
        AND (
          t."counterparty" IS NOT NULL
          OR (a."reading_confirmed" AND a."guessed_counterparty" IS NOT NULL)
        )
      ORDER BY a."guessed_vat_number",
               (t."counterparty" IS NOT NULL) DESC,
               a."reading_confirmed" DESC,
               a."created_at" DESC
    `,
  ])

  return {
    knownCounterparties,
    aliases,
    vatNumberOwners: new Map(vatOwners.map((row) => [row.vat_number, row.counterparty])),
    ownBusinessName: settings.business_name,
    ownVatNumber: settings.vrn,
  }
}

// ---------------------------------------------------------------------------
// Reading the pile
// ---------------------------------------------------------------------------

export type DocumentFilter = {
  /** Only what is still unfiled. The default, because that is what the screen is for. */
  unfiled?: boolean
  search?: string | null
  from?: string | null
  to?: string | null
  limit?: number
  offset?: number
}

export type DocumentList = { rows: BkDocumentRow[]; total: number }

export async function listDocuments(filter: DocumentFilter = {}): Promise<DocumentList> {
  const unfiled = filter.unfiled !== false
  const search = filter.search?.trim() || null
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), MAX_PAGE)
  const offset = Math.max(filter.offset ?? 0, 0)

  const where = Prisma.sql`
    WHERE (${unfiled}::boolean IS NOT TRUE OR a."transaction_id" IS NULL)
      AND (${filter.from ?? null}::date IS NULL OR a."guessed_document_date" >= ${filter.from ?? null}::date)
      AND (${filter.to ?? null}::date IS NULL OR a."guessed_document_date" <= ${filter.to ?? null}::date)
      AND (
        ${search}::text IS NULL
        OR a."name" ILIKE '%' || ${search}::text || '%'
        OR a."filename" ILIKE '%' || ${search}::text || '%'
        OR a."guessed_counterparty" ILIKE '%' || ${search}::text || '%'
        OR a."guessed_document_number" ILIKE '%' || ${search}::text || '%'
      )
  `

  const [rows, counted] = await Promise.all([
    prisma.$queryRaw<BkDocumentRow[]>`
      SELECT a.* FROM "bk_attachments" a
      ${where}
      ORDER BY a."created_at" DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total FROM "bk_attachments" a ${where}
    `,
  ])

  return { rows, total: Number(counted[0]?.total ?? 0) }
}

export async function getDocument(id: string): Promise<BkDocumentRow | null> {
  const rows = await prisma.$queryRaw<BkDocumentRow[]>`
    SELECT * FROM "bk_attachments" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

/** How many receipts are sitting in the inbox. Feeds the badge on the tab. */
export async function countUnfiledDocuments(): Promise<number> {
  const rows = await prisma.$queryRaw<{ total: bigint }[]>`
    SELECT COUNT(*)::bigint AS total FROM "bk_attachments" WHERE "transaction_id" IS NULL
  `
  return Number(rows[0]?.total ?? 0)
}

// ---------------------------------------------------------------------------
// Writing what we read
// ---------------------------------------------------------------------------

/**
 * Store a reading against a document.
 *
 * One UPDATE with every column named, rather than a patch: a half-applied
 * reading - last month's total beside this month's supplier - is worse than
 * either a whole one or none.
 */
export async function saveReading(id: string, reading: DocumentReading): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "bk_attachments" SET
      "scan_status"             = ${reading.scanStatus},
      "scanned_at"              = NOW(),
      "guessed_counterparty"    = ${reading.counterparty},
      "counterparty_confidence" = ${reading.counterpartyConfidence}::int,
      "guessed_direction"       = ${reading.direction},
      "guessed_document_date"   = ${reading.documentDate}::date,
      "guessed_document_number" = ${reading.documentNumber},
      "guessed_net"             = ${reading.net}::numeric,
      "guessed_vat"             = ${reading.vat}::numeric,
      "guessed_total"           = ${reading.total}::numeric,
      "guessed_vat_rate_code"   = ${reading.vatRateCode},
      "guessed_vat_number"      = ${reading.vatNumber},
      "extracted_text"          = ${reading.text}
    WHERE "id" = ${id}
  `
}

/**
 * Read a file and remember what it said, in one go.
 *
 * Never throws on a bad document: readDocument returns a "could not read this"
 * reading rather than an error, because a receipt that will not parse still has
 * to be kept.
 */
export async function scanDocument(
  id: string,
  bytes: Buffer,
  mimeType: string,
  filename: string,
  context?: ReadingContext,
): Promise<DocumentReading> {
  const reading = readDocument({ bytes, mimeType, filename }, context ?? (await buildReadingContext()))
  await saveReading(id, reading)
  return reading
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

/**
 * Never learn our own name as a supplier's alias.
 *
 * Our name is on every document we receive, under "Bill To". If the reader ever
 * picks it up as the letterhead, learning it would map "us" to whichever
 * supplier happened to be corrected first and then claim every later document
 * for them.
 */
export async function learnFromDocumentFiling(
  wording: string | null,
  counterparty: string,
  user: SessionUser | null,
): Promise<void> {
  if (!wording?.trim()) return
  const settings = await getSettings()
  const ownKey = settings.business_name ? normaliseAlias(settings.business_name) : null
  if (ownKey && normaliseAlias(wording) === ownKey) return
  await learnAlias(wording, counterparty, user)
}

/**
 * Give a document an entry to belong to.
 *
 * The bytes do not move: this is an UPDATE of one column, plus the position it
 * takes among that entry's evidence. Which means filing cannot half-happen and
 * leave a receipt nobody can find, and it means a document can be unfiled again
 * without re-uploading anything.
 */
export async function attachDocument(
  id: string,
  transactionId: string,
  user: SessionUser | null,
): Promise<BkDocumentRow> {
  const document = await getDocument(id)
  if (!document) throw new NotFoundError('That document')
  if (document.locked_period_id) {
    throw new BookkeepingError(
      'locked',
      'That document is evidence for a VAT return that has been filed, so it stays where it is.',
      409,
    )
  }
  if (document.transaction_id && document.transaction_id !== transactionId) {
    throw new BookkeepingError(
      'already_filed',
      'That document is already filed against another entry. Take it off that one first.',
      409,
    )
  }
  await assertTransactionMutable(transactionId)

  const [target] = await prisma.$queryRaw<{ counterparty: string }[]>`
    SELECT "counterparty" FROM "bk_transactions" WHERE "id" = ${transactionId} LIMIT 1
  `
  if (!target) throw new NotFoundError('That entry')

  const [next] = await prisma.$queryRaw<{ position: number }[]>`
    SELECT COALESCE(MAX("position") + 1, 0)::int AS position
    FROM "bk_attachments" WHERE "transaction_id" = ${transactionId}
  `

  await prisma.$executeRaw`
    UPDATE "bk_attachments"
    SET "transaction_id" = ${transactionId}, "position" = ${next?.position ?? 0}::int
    WHERE "id" = ${id}
  `

  // The one moment the connection between the document's wording and the books'
  // spelling is known for certain, because a human just made it. Taken quietly:
  // nobody filing a receipt wants to be asked about it.
  await learnFromDocumentFiling(document.guessed_counterparty, target.counterparty, user)

  await appendAudit({
    action: 'attachment.filed',
    entityType: 'transaction',
    entityId: transactionId,
    summary: `Document “${document.name}” filed against this entry`,
    detail: { attachmentId: id, filename: document.filename },
    user,
  })

  return (await getDocument(id))!
}

/** Take a document back off its entry and put it in the inbox. */
export async function detachDocument(id: string, user: SessionUser | null): Promise<BkDocumentRow> {
  const document = await getDocument(id)
  if (!document) throw new NotFoundError('That document')
  if (!document.transaction_id) return document
  if (document.locked_period_id) {
    throw new BookkeepingError(
      'locked',
      'That document is evidence for a VAT return that has been filed, so it stays where it is.',
      409,
    )
  }
  await assertTransactionMutable(document.transaction_id)

  await prisma.$executeRaw`
    UPDATE "bk_attachments" SET "transaction_id" = NULL, "position" = 0 WHERE "id" = ${id}
  `

  await appendAudit({
    action: 'attachment.unfiled',
    entityType: 'transaction',
    entityId: document.transaction_id,
    summary: `Document “${document.name}” taken off this entry and put back in the inbox`,
    detail: { attachmentId: id, filename: document.filename },
    user,
  })

  return (await getDocument(id))!
}

// ---------------------------------------------------------------------------
// Correcting a reading
// ---------------------------------------------------------------------------

export type ReadingPatch = {
  counterparty?: string | null
  direction?: Direction | null
  documentDate?: string | null
  documentNumber?: string | null
  net?: string | null
  vat?: string | null
  total?: string | null
  vatRateCode?: VatRateCode | null
}

const RATE_CODES: VatRateCode[] = ['standard', 'reduced', 'zero', 'exempt', 'outside_scope']

function checkMoney(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!isMoneyString(value)) {
    throw new BookkeepingError('invalid', `${field} has to be an amount, like 124.50.`)
  }
  return value.trim()
}

function checkDate(value: string | null | undefined, field: string): string | null {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new BookkeepingError('invalid', `${field} has to be a real date.`)
  }
  return value
}

/**
 * A human's correction to what we read.
 *
 * From here on the document is confirmed: nothing re-guesses over the top of it,
 * and the confidence is 100 because a person said so, which is the only thing
 * that number was ever meant to stand in for.
 */
export async function updateDocumentReading(
  id: string,
  patch: ReadingPatch,
  user: SessionUser | null,
): Promise<BkDocumentRow> {
  const document = await getDocument(id)
  if (!document) throw new NotFoundError('That document')
  if (document.locked_period_id) {
    throw new BookkeepingError(
      'locked',
      'That document is evidence for a VAT return that has been filed, so what it says about it is frozen too.',
      409,
    )
  }

  const counterparty = patch.counterparty?.trim() || null
  const direction = patch.direction ?? null
  if (direction && direction !== 'income' && direction !== 'expense') {
    throw new BookkeepingError('invalid', 'A document is either money in or money out.')
  }
  const rateCode = patch.vatRateCode ?? null
  if (rateCode && !RATE_CODES.includes(rateCode)) {
    throw new BookkeepingError('invalid', 'That is not a VAT rate this module knows about.')
  }

  const net = checkMoney(patch.net, 'The net amount')
  const vat = checkMoney(patch.vat, 'The VAT')
  const total = checkMoney(patch.total, 'The total')
  const date = checkDate(patch.documentDate, 'The invoice date')

  await prisma.$executeRaw`
    UPDATE "bk_attachments" SET
      "guessed_counterparty"    = ${counterparty},
      "counterparty_confidence" = ${counterparty ? 100 : 0}::int,
      "guessed_direction"       = ${direction},
      "guessed_document_date"   = ${date}::date,
      "guessed_document_number" = ${patch.documentNumber?.trim() || null},
      "guessed_net"             = ${net}::numeric,
      "guessed_vat"             = ${vat}::numeric,
      "guessed_total"           = ${total}::numeric,
      "guessed_vat_rate_code"   = ${rateCode},
      "reading_confirmed"       = TRUE
    WHERE "id" = ${id}
  `

  // What the reader thought it said, mapped to what it actually says. The next
  // document laid out the same way gets it right first time.
  if (counterparty && document.guessed_counterparty && document.guessed_counterparty !== counterparty) {
    await learnFromDocumentFiling(document.guessed_counterparty, counterparty, user)
  }

  await appendAudit({
    action: 'attachment.reading-corrected',
    entityType: 'attachment',
    entityId: id,
    summary: `What “${document.name}” says was corrected by hand`,
    detail: {
      before: {
        counterparty: document.guessed_counterparty,
        documentNumber: document.guessed_document_number,
      },
      after: { counterparty, documentNumber: patch.documentNumber?.trim() || null },
    },
    user,
  })

  return (await getDocument(id))!
}

/**
 * Read a document again.
 *
 * Refused on one a human has already confirmed, unless they ask for it twice:
 * the point of confirming is that nothing overwrites it afterwards, and a
 * re-read that quietly undid somebody's correction would make the confirmation
 * worthless.
 */
export async function rescanDocument(
  id: string,
  bytes: Buffer,
  user: SessionUser | null,
  force = false,
): Promise<DocumentReading> {
  const document = await getDocument(id)
  if (!document) throw new NotFoundError('That document')
  if (document.locked_period_id) {
    throw new BookkeepingError(
      'locked',
      'That document is evidence for a VAT return that has been filed, so what it says about it is frozen too.',
      409,
    )
  }
  if (document.reading_confirmed && !force) {
    throw new BookkeepingError(
      'confirmed',
      'Somebody has already checked this one by hand. Reading it again would undo that, so it is left alone.',
      409,
    )
  }

  const reading = await scanDocument(id, bytes, document.mime_type, document.filename)
  await prisma.$executeRaw`
    UPDATE "bk_attachments" SET "reading_confirmed" = FALSE WHERE "id" = ${id}
  `

  await appendAudit({
    action: 'attachment.reread',
    entityType: 'attachment',
    entityId: id,
    summary: `“${document.name}” was read again`,
    detail: { counterparty: reading.counterparty, total: reading.total, status: reading.scanStatus },
    user,
  })

  return reading
}

// ---------------------------------------------------------------------------
// What the browser gets
// ---------------------------------------------------------------------------

export type DocumentPayload = {
  id: string
  name: string
  filename: string
  mime_type: string
  size: number
  created_at: string
  transaction_id: string | null
  scan_status: BkDocumentRow['scan_status']
  guessed_counterparty: string | null
  counterparty_confidence: number
  guessed_direction: Direction | null
  guessed_document_date: string | null
  guessed_document_number: string | null
  guessed_net: string | null
  guessed_vat: string | null
  guessed_total: string | null
  guessed_vat_rate_code: VatRateCode | null
  guessed_vat_number: string | null
  reading_confirmed: boolean
}

/**
 * A document row, ready to send.
 *
 * Money goes over the wire as a two-decimal STRING and never as whatever
 * Decimal's toJSON felt like producing - "124.5" reaching a form that then
 * writes it back is how a hundred and twenty-four pounds fifty becomes a
 * hundred and twenty-four pounds five. Dates go as plain ISO days, because a
 * tax point is a day and not an instant, and a timestamp would invite a
 * timezone into a question that has none.
 */
export function toDocumentPayload(row: BkDocumentRow): DocumentPayload {
  return {
    id: row.id,
    name: row.name,
    filename: row.filename,
    mime_type: row.mime_type,
    size: row.size,
    created_at: row.created_at.toISOString(),
    transaction_id: row.transaction_id,
    scan_status: row.scan_status,
    guessed_counterparty: row.guessed_counterparty,
    counterparty_confidence: row.counterparty_confidence,
    guessed_direction: row.guessed_direction,
    guessed_document_date: row.guessed_document_date?.toISOString().slice(0, 10) ?? null,
    guessed_document_number: row.guessed_document_number,
    guessed_net: row.guessed_net === null ? null : formatMoney(row.guessed_net),
    guessed_vat: row.guessed_vat === null ? null : formatMoney(row.guessed_vat),
    guessed_total: row.guessed_total === null ? null : formatMoney(row.guessed_total),
    guessed_vat_rate_code: row.guessed_vat_rate_code,
    guessed_vat_number: row.guessed_vat_number,
    reading_confirmed: row.reading_confirmed,
  }
}
