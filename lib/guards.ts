import { prisma } from '@/lib/db/prisma'
import {
  BackdatedIntoClosedPeriodError,
  FinalisedRecordError,
  LockedRecordError,
  NotFoundError,
  PeriodStateError,
} from './errors'
import type { BkAccountingPeriodRow } from './types'

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
  // A closed financial year bites here too, and for the same reason: the
  // accounts for it have been drawn up and the profit taken to reserves, so
  // slipping another entry into it would restate a set of accounts that has
  // already been signed off and possibly filed. Same layer, same reasoning
  // about restores, so it lives behind the same call rather than being a second
  // thing every caller has to remember.
  await assertNotInClosedYear(taxPoint, settled)
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

/** The closed year a date falls in, if there is one. */
export async function findClosedYearFor(date: Date): Promise<BkAccountingPeriodRow | null> {
  const rows = await prisma.$queryRaw<BkAccountingPeriodRow[]>`
    SELECT * FROM "bk_accounting_periods"
    WHERE "status" = 'closed' AND ${date}::date BETWEEN "start_date" AND "end_date"
    LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Refuse to touch a closed year.
 *
 * APPLICATION LAYER ONLY, and it must stay that way for the same reason
 * assertDatesNotInClosedPeriod in lib/guards.ts does: lib/backup/restore.ts
 * truncates and re-inserts every row, closed years included, so a rule of this
 * shape written as a BEFORE INSERT trigger would reject most of a restore and
 * only ever fail during an actual disaster recovery.
 */
export async function assertNotInClosedYear(...dates: (Date | null | undefined)[]): Promise<void> {
  for (const date of dates) {
    if (!date) continue
    const year = await findClosedYearFor(date)
    if (year) {
      throw new PeriodStateError(
        `That date falls in ${year.name}, which has been closed off. Reopen the year first if it really belongs there, or date it in the current one.`,
      )
    }
  }
}
