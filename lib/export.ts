import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getChainHead, verifyAuditChain } from './audit'
import { csvDocument, csvRow } from './csv'
import { formatMoney } from './money'

// Everything out, in a form somebody else can read.
//
// This is what makes the uninstall decision workable: the module's teardown list
// drops its tables, so "export first" has to be a real option and not a promise.
// It is also the six-year answer - a business that stops using this software
// still has to be able to produce its records. Which is why the frozen filed
// figures (snapshots and their workings) and the HMRC call log are export kinds
// too, not just the live tables: they are exactly the records the module says it
// keeps as evidence.
//
// Streamed, not buffered. Every module route goes through the one core
// dispatcher pinned at maxDuration = 60, and six years of records assembled into
// a single string first would be both slower and heavier than it needs to be.
//
// Paged by KEY, not by offset. Each page is its own statement (PgBouncer,
// autocommit), so OFFSET paging over a table someone is writing to shifts the
// pages under the reader and silently drops or doubles rows - in the one file
// whose whole point is completeness. A `WHERE key > last` cursor cannot skip or
// repeat an existing row whatever happens alongside it.

const CHUNK = 500

export type ExportKind =
  | 'transactions'
  | 'lines'
  | 'attachments'
  | 'periods'
  | 'snapshots'
  | 'snapshot-lines'
  | 'hmrc-calls'
  | 'audit'

export const EXPORT_KINDS: ExportKind[] = [
  'transactions',
  'lines',
  'attachments',
  'periods',
  'snapshots',
  'snapshot-lines',
  'hmrc-calls',
  'audit',
]

const HEADERS: Record<ExportKind, string[]> = {
  transactions: [
    'id', 'entry_type', 'direction', 'tax_point_date', 'settled_date', 'counterparty',
    'description', 'reference', 'status', 'source', 'corrects_transaction_id',
    'correction_reason', 'finalised_period_id', 'locked_period_id', 'created_at',
  ],
  lines: [
    'id', 'transaction_id', 'position', 'category_code', 'category_name', 'description',
    'vat_treatment', 'vat_rate_code', 'vat_rate_percent', 'net_amount', 'vat_amount',
    'gross_amount', 'is_capital',
  ],
  attachments: [
    'id', 'transaction_id', 'name', 'filename', 'mime_type', 'size', 'sha256', 'url', 'created_at',
  ],
  periods: [
    'id', 'period_key', 'start_date', 'end_date', 'due_date', 'status', 'scheme',
    'submitted_at', 'submitted_externally', 'hmrc_form_bundle_number', 'hmrc_receipt_id',
  ],
  snapshots: [
    'id', 'period_id', 'kind', 'scheme', 'boxes', 'boxes_unrounded', 'vrn', 'created_at',
    'chain_index', 'prev_hash', 'row_hash',
  ],
  'snapshot-lines': [
    'id', 'snapshot_id', 'transaction_id', 'line_id', 'direction', 'vat_treatment',
    'vat_rate_code', 'net_amount', 'vat_amount', 'boxes',
  ],
  'hmrc-calls': [
    'id', 'at', 'environment', 'method', 'path', 'status_code', 'duration_ms',
    'correlation_id', 'receipt_id', 'error_code', 'fraud_headers',
  ],
  audit: ['chain_index', 'at', 'action', 'entity_type', 'entity_id', 'summary', 'actor_email', 'row_hash'],
}

function cell(value: unknown): unknown {
  if (value instanceof Prisma.Decimal) return formatMoney(value)
  if (typeof value === 'bigint') return value.toString()
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return JSON.stringify(value)
  }
  return value
}

function toRows(kind: ExportKind, rows: Record<string, unknown>[]): unknown[][] {
  return rows.map((r) => HEADERS[kind].map((h) => cell(r[h])))
}

type Page = { rows: Record<string, unknown>[]; next: string | bigint | null }

async function fetchPage(kind: ExportKind, cursor: string | bigint | null): Promise<Page> {
  switch (kind) {
    case 'transactions': {
      const after = (cursor as string | null) ?? ''
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "entry_type", "direction", "tax_point_date", "settled_date", "counterparty",
               "description", "reference", "status", "source", "corrects_transaction_id",
               "correction_reason", "finalised_period_id", "locked_period_id", "created_at"
        FROM "bk_transactions" WHERE "id" > ${after} ORDER BY "id" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.id as string | undefined) ?? null }
    }
    case 'lines': {
      const after = (cursor as string | null) ?? ''
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT l."id", l."transaction_id", l."position", c."code" AS category_code,
               c."name" AS category_name, l."description", l."vat_treatment", l."vat_rate_code",
               l."vat_rate_percent", l."net_amount", l."vat_amount", l."gross_amount", l."is_capital"
        FROM "bk_transaction_lines" l
        JOIN "bk_categories" c ON c."id" = l."category_id"
        WHERE l."id" > ${after} ORDER BY l."id" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.id as string | undefined) ?? null }
    }
    case 'attachments': {
      const after = (cursor as string | null) ?? ''
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "transaction_id", "name", "filename", "mime_type", "size", "sha256",
               "url", "created_at"
        FROM "bk_attachments" WHERE "id" > ${after} ORDER BY "id" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.id as string | undefined) ?? null }
    }
    case 'periods': {
      const after = (cursor as string | null) ?? ''
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "period_key", "start_date", "end_date", "due_date", "status", "scheme",
               "submitted_at", "submitted_externally", "hmrc_form_bundle_number", "hmrc_receipt_id"
        FROM "bk_vat_periods" WHERE "id" > ${after} ORDER BY "id" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.id as string | undefined) ?? null }
    }
    case 'snapshots': {
      const after = (cursor as bigint | null) ?? -1n
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "period_id", "kind", "scheme", "boxes", "boxes_unrounded", "vrn",
               "created_at", "chain_index", "prev_hash", "row_hash"
        FROM "bk_period_snapshots" WHERE "chain_index" > ${after}
        ORDER BY "chain_index" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.chain_index as bigint | undefined) ?? null }
    }
    case 'snapshot-lines': {
      const after = (cursor as string | null) ?? ''
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "snapshot_id", "transaction_id", "line_id", "direction", "vat_treatment",
               "vat_rate_code", "net_amount", "vat_amount", "boxes"
        FROM "bk_period_snapshot_lines" WHERE "id" > ${after} ORDER BY "id" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.id as string | undefined) ?? null }
    }
    case 'hmrc-calls': {
      const after = (cursor as string | null) ?? ''
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "at", "environment", "method", "path", "status_code", "duration_ms",
               "correlation_id", "receipt_id", "error_code", "fraud_headers"
        FROM "bk_hmrc_api_calls" WHERE "id" > ${after} ORDER BY "id" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.id as string | undefined) ?? null }
    }
    case 'audit': {
      const after = (cursor as bigint | null) ?? -1n
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "chain_index", "at", "action", "entity_type", "entity_id", "summary",
               "actor_email", "row_hash"
        FROM "bk_audit_log" WHERE "chain_index" > ${after}
        ORDER BY "chain_index" ASC LIMIT ${CHUNK}
      `
      return { rows, next: (rows.at(-1)?.chain_index as bigint | undefined) ?? null }
    }
  }
}

async function* pageRows(kind: ExportKind): AsyncGenerator<unknown[][]> {
  let cursor: string | bigint | null = null
  for (;;) {
    const page = await fetchPage(kind, cursor)
    if (page.rows.length === 0) return
    yield toRows(kind, page.rows)
    if (page.rows.length < CHUNK || page.next === null) return
    cursor = page.next
  }
}

export function csvExportResponse(kind: ExportKind, filename: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(csvDocument([csvRow(HEADERS[kind])]).replace(/\r\n$/, '\r\n')))
        for await (const page of pageRows(kind)) {
          controller.enqueue(encoder.encode(`${page.map(csvRow).join('\r\n')}\r\n`))
        }
      } catch (error) {
        // A failure mid-stream cannot become a clean 500 - the 200 has gone. So
        // the file says so in its own last line, which is at least something the
        // owner will notice rather than a file that is quietly short.
        controller.enqueue(
          encoder.encode(
            `\r\n"EXPORT INCOMPLETE - something went wrong part way through. Please try again."\r\n`,
          ),
        )
        console.error('[uk-bookkeeping] export failed mid-stream', error)
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

export type ExportBundle = {
  exportedAt: string
  recordsFingerprint: string | null
  chain: { rows: number; intact: boolean; brokenAtIndex: number | null }
  counts: Record<string, number>
}

/**
 * The summary that goes with an export, and the thing the uninstall flow checks.
 * The fingerprint is the same head hash that appears in every filing receipt, so
 * an export can be tied back to the mail the owner already has.
 */
export async function exportSummary(): Promise<ExportBundle> {
  const chain = await verifyAuditChain()
  const [counts] = await prisma.$queryRaw<
    {
      transactions: bigint
      lines: bigint
      attachments: bigint
      periods: bigint
      snapshots: bigint
      snapshot_lines: bigint
      hmrc_calls: bigint
      audit: bigint
    }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM "bk_transactions")::bigint          AS transactions,
      (SELECT COUNT(*) FROM "bk_transaction_lines")::bigint     AS lines,
      (SELECT COUNT(*) FROM "bk_attachments")::bigint           AS attachments,
      (SELECT COUNT(*) FROM "bk_vat_periods")::bigint           AS periods,
      (SELECT COUNT(*) FROM "bk_period_snapshots")::bigint      AS snapshots,
      (SELECT COUNT(*) FROM "bk_period_snapshot_lines")::bigint AS snapshot_lines,
      (SELECT COUNT(*) FROM "bk_hmrc_api_calls")::bigint        AS hmrc_calls,
      (SELECT COUNT(*) FROM "bk_audit_log")::bigint             AS audit
  `

  return {
    exportedAt: new Date().toISOString(),
    recordsFingerprint: await getChainHead(),
    chain: { rows: chain.rows, intact: chain.intact, brokenAtIndex: chain.brokenAtIndex },
    counts: {
      transactions: Number(counts?.transactions ?? 0n),
      lines: Number(counts?.lines ?? 0n),
      attachments: Number(counts?.attachments ?? 0n),
      periods: Number(counts?.periods ?? 0n),
      snapshots: Number(counts?.snapshots ?? 0n),
      snapshotLines: Number(counts?.snapshot_lines ?? 0n),
      hmrcCalls: Number(counts?.hmrc_calls ?? 0n),
      audit: Number(counts?.audit ?? 0n),
    },
  }
}
