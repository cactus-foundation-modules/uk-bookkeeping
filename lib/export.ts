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
// still has to be able to produce its records.
//
// Streamed, not buffered. Every module route goes through the one core
// dispatcher pinned at maxDuration = 60, and six years of records assembled into
// a single string first would be both slower and heavier than it needs to be.

const CHUNK = 500

export type ExportKind = 'transactions' | 'lines' | 'attachments' | 'periods' | 'audit'

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
  audit: ['chain_index', 'at', 'action', 'entity_type', 'entity_id', 'summary', 'actor_email', 'row_hash'],
}

async function* pageRows(kind: ExportKind): AsyncGenerator<unknown[][]> {
  let offset = 0
  for (;;) {
    const rows = await fetchPage(kind, offset)
    if (rows.length === 0) return
    yield rows
    offset += CHUNK
    if (rows.length < CHUNK) return
  }
}

async function fetchPage(kind: ExportKind, offset: number): Promise<unknown[][]> {
  switch (kind) {
    case 'transactions': {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "entry_type", "direction", "tax_point_date", "settled_date", "counterparty",
               "description", "reference", "status", "source", "corrects_transaction_id",
               "correction_reason", "finalised_period_id", "locked_period_id", "created_at"
        FROM "bk_transactions" ORDER BY "tax_point_date" ASC, "id" ASC
        LIMIT ${CHUNK} OFFSET ${offset}
      `
      return rows.map((r) => HEADERS.transactions.map((h) => r[h]))
    }
    case 'lines': {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT l."id", l."transaction_id", l."position", c."code" AS category_code,
               c."name" AS category_name, l."description", l."vat_treatment", l."vat_rate_code",
               l."vat_rate_percent", l."net_amount", l."vat_amount", l."gross_amount", l."is_capital"
        FROM "bk_transaction_lines" l
        JOIN "bk_categories" c ON c."id" = l."category_id"
        ORDER BY l."transaction_id" ASC, l."position" ASC
        LIMIT ${CHUNK} OFFSET ${offset}
      `
      return rows.map((r) =>
        HEADERS.lines.map((h) =>
          r[h] instanceof Prisma.Decimal ? formatMoney(r[h] as Prisma.Decimal) : r[h],
        ),
      )
    }
    case 'attachments': {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "transaction_id", "name", "filename", "mime_type", "size", "sha256",
               "url", "created_at"
        FROM "bk_attachments" ORDER BY "created_at" ASC
        LIMIT ${CHUNK} OFFSET ${offset}
      `
      return rows.map((r) => HEADERS.attachments.map((h) => r[h]))
    }
    case 'periods': {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "id", "period_key", "start_date", "end_date", "due_date", "status", "scheme",
               "submitted_at", "submitted_externally", "hmrc_form_bundle_number", "hmrc_receipt_id"
        FROM "bk_vat_periods" ORDER BY "start_date" ASC
        LIMIT ${CHUNK} OFFSET ${offset}
      `
      return rows.map((r) => HEADERS.periods.map((h) => r[h]))
    }
    case 'audit': {
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT "chain_index", "at", "action", "entity_type", "entity_id", "summary",
               "actor_email", "row_hash"
        FROM "bk_audit_log" ORDER BY "chain_index" ASC
        LIMIT ${CHUNK} OFFSET ${offset}
      `
      return rows.map((r) =>
        HEADERS.audit.map((h) => (typeof r[h] === 'bigint' ? (r[h] as bigint).toString() : r[h])),
      )
    }
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
      audit: bigint
    }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM "bk_transactions")::bigint      AS transactions,
      (SELECT COUNT(*) FROM "bk_transaction_lines")::bigint AS lines,
      (SELECT COUNT(*) FROM "bk_attachments")::bigint       AS attachments,
      (SELECT COUNT(*) FROM "bk_vat_periods")::bigint       AS periods,
      (SELECT COUNT(*) FROM "bk_period_snapshots")::bigint  AS snapshots,
      (SELECT COUNT(*) FROM "bk_audit_log")::bigint         AS audit
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
      audit: Number(counts?.audit ?? 0n),
    },
  }
}
