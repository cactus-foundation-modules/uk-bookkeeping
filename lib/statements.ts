import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMoney } from './money'

// Every statement ever brought in, as a list somebody can read.
//
// Until now a statement row was write-only: the import wrote it and nothing
// ever showed it again. You could see the LINES on the reconciliation screen,
// and the files in the media library, but nowhere in the books answered "which
// months have I actually imported, and is anything missing". That is a question
// with an obvious wrong answer - a month nobody imported looks exactly like a
// month with no transactions in it.
//
// So each row carries three things that are not on the statement table: which
// account it belongs to (by name, not id), the stretch it really covers, and
// how far through explaining it you are. All three come from one query rather
// than a per-row lookup, because a site with three accounts and six years of
// statements is 216 rows and PgBouncer wraps every statement in its own
// round trip.

const MAX_PAGE = 200

export type StatementListRow = {
  id: string
  bankAccountId: string
  bankAccountName: string
  bankAccountLast4: string | null
  filename: string
  format: 'csv' | 'pdf'
  /** What the statement declared, where it declared anything. */
  periodStart: string | null
  periodEnd: string | null
  /** What it actually covers: the declared period, or its own first and last line. */
  coversFrom: string | null
  coversTo: string | null
  openingBalance: string | null
  closingBalance: string | null
  totalPaidIn: string | null
  totalPaidOut: string | null
  /** Lines this statement holds now. Not the same as the row count of the file:
   *  a line already brought in by an overlapping statement belongs to that one. */
  lineCount: number
  reconciledCount: number
  unreconciledCount: number
  ignoredCount: number
  /** Whether a copy of the file itself was kept. False for everything imported
   *  before the module started keeping them, and there is nothing to backfill. */
  hasFile: boolean
  mimeType: string | null
  size: number
  importedAt: string
  updatedAt: string
  updateCount: number
}

export type StatementFilter = {
  bankAccountId?: string | null
  /** Only the ones with no copy of the file kept. What the "missing" filter uses. */
  missingFileOnly?: boolean
  limit?: number
  offset?: number
}

export type StatementList = {
  rows: StatementListRow[]
  total: number
  /** How many statements in total have no file kept, whatever the filter says. */
  missingFiles: number
}

type StatementQueryRow = {
  id: string
  bank_account_id: string
  bank_account_name: string
  bank_account_last4: string | null
  filename: string
  format: 'csv' | 'pdf'
  period_start: Date | null
  period_end: Date | null
  covers_from: Date | null
  covers_to: Date | null
  opening_balance: Prisma.Decimal | null
  closing_balance: Prisma.Decimal | null
  total_paid_in: Prisma.Decimal | null
  total_paid_out: Prisma.Decimal | null
  line_count: number
  reconciled_count: number
  unreconciled_count: number
  ignored_count: number
  has_file: boolean
  mime_type: string | null
  size: number
  created_at: Date
  updated_at: Date
  update_count: number
}

/** A date column as a plain ISO day. A period is a day, never an instant. */
function isoDay(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null
}

/** Money as a two-decimal string, or null for "the statement did not print one" -
 *  which is a different thing from zero and must not become it. */
function money(value: Prisma.Decimal | null): string | null {
  return value === null ? null : formatMoney(value)
}

export async function listStatements(filter: StatementFilter = {}): Promise<StatementList> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_PAGE)
  const offset = Math.max(filter.offset ?? 0, 0)
  const account = filter.bankAccountId?.trim() || null
  const missingOnly = filter.missingFileOnly === true

  const where = Prisma.sql`
    WHERE (${account}::text IS NULL OR s."bank_account_id" = ${account}::text)
      AND (${missingOnly}::boolean IS NOT TRUE OR s."media_key" IS NULL)
  `

  // One lateral for the line figures. Counted rather than read off the
  // statement's own imported_count, because a line can be deleted from the
  // reconciliation screen afterwards and the stored figure would then be a
  // number that used to be true.
  const stats = Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::int                                                  AS line_count,
        COUNT(*) FILTER (WHERE b."status" = 'reconciled')::int          AS reconciled_count,
        COUNT(*) FILTER (WHERE b."status" = 'unreconciled')::int        AS unreconciled_count,
        COUNT(*) FILTER (WHERE b."status" = 'ignored')::int             AS ignored_count,
        MIN(b."date")                                                   AS first_date,
        MAX(b."date")                                                   AS last_date
      FROM "bk_bank_transactions" b WHERE b."statement_id" = s."id"
    ) r ON TRUE
  `

  const [rows, counted, missing] = await Promise.all([
    prisma.$queryRaw<StatementQueryRow[]>`
      SELECT
        s."id", s."bank_account_id",
        a."name"          AS bank_account_name,
        a."account_last4" AS bank_account_last4,
        s."filename", s."format", s."period_start", s."period_end",
        COALESCE(s."period_start", r."first_date") AS covers_from,
        COALESCE(s."period_end",   r."last_date")  AS covers_to,
        s."opening_balance", s."closing_balance", s."total_paid_in", s."total_paid_out",
        COALESCE(r."line_count", 0)         AS line_count,
        COALESCE(r."reconciled_count", 0)   AS reconciled_count,
        COALESCE(r."unreconciled_count", 0) AS unreconciled_count,
        COALESCE(r."ignored_count", 0)      AS ignored_count,
        (s."media_key" IS NOT NULL) AS has_file,
        s."mime_type", s."size", s."created_at", s."updated_at", s."update_count"
      FROM "bk_bank_statements" s
      JOIN "bk_bank_accounts" a ON a."id" = s."bank_account_id"
      ${stats}
      ${where}
      -- Newest period first, and the import date only to break a tie: two
      -- statements for one month should sit together whichever order they were
      -- brought in.
      ORDER BY COALESCE(s."period_end", r."last_date") DESC NULLS LAST, s."created_at" DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total
      FROM "bk_bank_statements" s
      JOIN "bk_bank_accounts" a ON a."id" = s."bank_account_id"
      ${stats}
      ${where}
    `,
    prisma.$queryRaw<{ total: bigint }[]>`
      SELECT COUNT(*)::bigint AS total FROM "bk_bank_statements" WHERE "media_key" IS NULL
    `,
  ])

  return {
    rows: rows.map((row) => ({
      id: row.id,
      bankAccountId: row.bank_account_id,
      bankAccountName: row.bank_account_name,
      bankAccountLast4: row.bank_account_last4,
      filename: row.filename,
      format: row.format,
      periodStart: isoDay(row.period_start),
      periodEnd: isoDay(row.period_end),
      coversFrom: isoDay(row.covers_from),
      coversTo: isoDay(row.covers_to),
      openingBalance: money(row.opening_balance),
      closingBalance: money(row.closing_balance),
      totalPaidIn: money(row.total_paid_in),
      totalPaidOut: money(row.total_paid_out),
      lineCount: row.line_count,
      reconciledCount: row.reconciled_count,
      unreconciledCount: row.unreconciled_count,
      ignoredCount: row.ignored_count,
      hasFile: row.has_file,
      mimeType: row.mime_type,
      size: row.size,
      importedAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      updateCount: row.update_count,
    })),
    total: Number(counted[0]?.total ?? 0),
    missingFiles: Number(missing[0]?.total ?? 0),
  }
}
