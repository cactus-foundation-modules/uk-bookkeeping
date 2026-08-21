import { prisma } from '@/lib/db/prisma'
import {
  BackdatedIntoClosedPeriodError,
  FinalisedRecordError,
  LockedRecordError,
  NotFoundError,
} from './errors'

// Layer two of the three that keep a filed return unchangeable. Layer one is the
// UI (no controls, a padlock, and a "post a correction" button instead); layer
// three is the triggers in migrations/002_immutability.sql.
//
// Every mutating service function goes through here first, so the refusal
// carries a sentence rather than arriving as a raw Postgres exception.

export async function assertTransactionMutable(id: string): Promise<void> {
  const rows = await prisma.$queryRaw<
    { locked_period_id: string | null; finalised_period_id: string | null }[]
  >`
    SELECT "locked_period_id", "finalised_period_id"
    FROM "bk_transactions" WHERE "id" = ${id}
  `
  const row = rows[0]
  if (!row) throw new NotFoundError(`Transaction ${id}`)
  if (row.locked_period_id) throw new LockedRecordError(id, row.locked_period_id)
  if (row.finalised_period_id) throw new FinalisedRecordError(id, row.finalised_period_id)
}

/**
 * Backdating into a period that has been finalised or filed.
 *
 * APPLICATION LAYER ONLY. This must never become a BEFORE INSERT trigger.
 * lib/backup/restore.ts truncates and re-inserts every row, including
 * transactions dated inside long-submitted periods, so a rule of the form
 * "reject if the date falls in a closed period" would reject most of a restore -
 * and the failure would only surface during an actual disaster recovery, which
 * is the worst possible moment to discover it.
 *
 * Backdating is a policy about what a human may type today, not a property of
 * the data. It belongs here.
 *
 * Which date matters depends on each period's OWN scheme: an accrual period
 * claims a transaction by its tax point, a cash period by when the money moved.
 * Checking only the tax point let a cash-scheme entry settle inside a filed
 * return - joining a period that will never be recomputed, so its VAT would
 * simply never reach HMRC - and refused entries dated in a closed cash period
 * that legitimately belong, by settlement, to the open one.
 */
export async function assertDatesNotInClosedPeriod(
  taxPoint: Date,
  settled: Date | null,
): Promise<void> {
  const row = await findClosedPeriodForDates(taxPoint, settled)
  if (row) throw new BackdatedIntoClosedPeriodError(row)
}

/** The closed period these dates would land in, if any. Used to offer the correction route. */
export async function findClosedPeriodForDates(
  taxPoint: Date,
  settled: Date | null,
): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_vat_periods"
    WHERE "status" IN ('finalised', 'submitted')
      AND (
        ("scheme" = 'accrual' AND ${taxPoint}::date BETWEEN "start_date" AND "end_date")
        OR ("scheme" = 'cash' AND ${settled}::date IS NOT NULL
            AND ${settled}::date BETWEEN "start_date" AND "end_date")
      )
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

/** The open period a correction should be recorded in, if one exists. */
export async function findCurrentOpenPeriod(): Promise<{ id: string; start_date: Date; end_date: Date } | null> {
  const rows = await prisma.$queryRaw<{ id: string; start_date: Date; end_date: Date }[]>`
    SELECT "id", "start_date", "end_date" FROM "bk_vat_periods"
    WHERE "status" = 'open'
    ORDER BY "start_date" ASC LIMIT 1
  `
  return rows[0] ?? null
}
