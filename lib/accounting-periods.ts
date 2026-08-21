import type { SessionUser } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError, PeriodStateError } from './errors'
import { createJournal, deleteJournal, type JournalLineInput } from './journals'
import { accountBalances } from './ledger'
import { formatMoney, formatPounds, toMoney } from './money'
import { getSettings } from './settings'
import type { BkAccountingPeriodRow, Money } from './types'

// Financial years, and closing one.
//
// A VAT period and a financial year are different things and the module needs
// both. A VAT quarter decides what goes on a return; a financial year decides
// what goes on a set of accounts and on a corporation tax return. They do not
// line up, they are not meant to, and treating one as the other is how a company
// files a tax return for three months of trade.
//
// Closing a year does two things:
//
//   1. Posts a journal moving every profit and loss balance to retained
//      earnings. After it, the year's income and cost accounts read nil and the
//      profit is sitting in reserves where the balance sheet expects it.
//   2. Freezes the year. Nothing dated inside it can be added, changed or
//      removed until somebody reopens it.
//
// The freeze is enforced here rather than by a trigger, and the difference from
// the VAT lock matters. A filed VAT return is a statement made to HMRC and its
// rows get a hard database lock, because altering one makes the return false.
// A closed year is a bookkeeping decision the owner made and can unmake - the
// accountant finds something in March that belongs to the year to December, and
// reopening, posting and re-closing is the ordinary answer.

const iso = (date: Date): string => date.toISOString().slice(0, 10)
const parseDate = (value: string): Date => new Date(`${value.slice(0, 10)}T00:00:00.000Z`)

function requireDate(value: string, field: string): Date {
  const parsed = parseDate(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new BookkeepingError('invalid', `${field} is not a date we can read.`)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listAccountingPeriods(): Promise<BkAccountingPeriodRow[]> {
  return prisma.$queryRaw<BkAccountingPeriodRow[]>`
    SELECT * FROM "bk_accounting_periods" ORDER BY "start_date" DESC
  `
}

export async function getAccountingPeriod(id: string): Promise<BkAccountingPeriodRow | null> {
  const rows = await prisma.$queryRaw<BkAccountingPeriodRow[]>`
    SELECT * FROM "bk_accounting_periods" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

export async function requireAccountingPeriod(id: string): Promise<BkAccountingPeriodRow> {
  const period = await getAccountingPeriod(id)
  if (!period) throw new NotFoundError('That financial year')
  return period
}

// findClosedYearFor and assertNotInClosedYear live in lib/guards.ts, not here.
//
// They belong with the other refusals, and putting them there breaks what would
// otherwise be an import cycle: closing a year posts a journal, so this file
// needs lib/journals.ts, and journals need to refuse a date inside a closed
// year, so that file needs the check. guards.ts imports neither.
export { assertNotInClosedYear, findClosedYearFor } from './guards'

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export type AccountingPeriodInput = {
  name?: string
  startDate: string
  endDate: string
  notes?: string | null
}

function defaultName(end: Date): string {
  return `Year to ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
}

export async function createAccountingPeriod(
  input: AccountingPeriodInput,
  user: SessionUser | null,
): Promise<BkAccountingPeriodRow> {
  const start = requireDate(input.startDate, 'The start date')
  const end = requireDate(input.endDate, 'The end date')
  if (end.getTime() < start.getTime()) {
    throw new BookkeepingError('invalid', 'A financial year cannot end before it starts.')
  }
  // Eighteen months is the longest period of account Companies House will
  // accept. Anything past that is a typo, and a typo here would quietly split
  // into three corporation tax periods.
  const months = (end.getTime() - start.getTime()) / 86_400_000 / 30.4
  if (months > 18) {
    throw new BookkeepingError(
      'invalid',
      'A financial year cannot run longer than eighteen months. Check the two dates.',
    )
  }

  const [clash] = await prisma.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "bk_accounting_periods"
    WHERE ${start}::date <= "end_date" AND ${end}::date >= "start_date"
    LIMIT 1
  `
  if (clash) {
    throw new BookkeepingError(
      'duplicate',
      `Those dates overlap ${clash.name}. Financial years run one after another with no gaps and no overlaps.`,
    )
  }

  const rows = await prisma.$queryRaw<BkAccountingPeriodRow[]>`
    INSERT INTO "bk_accounting_periods" ("name", "start_date", "end_date", "notes")
    VALUES (${input.name?.trim() || defaultName(end)}, ${start}::date, ${end}::date,
            ${input.notes?.trim() || null})
    RETURNING *
  `
  const created = rows[0]!
  await appendAudit({
    action: 'accounting_period.created',
    entityType: 'accounting_period',
    entityId: created.id,
    summary: `Financial year added: ${created.name}`,
    detail: { after: { start: iso(start), end: iso(end) } },
    user,
  })
  return created
}

export async function updateAccountingPeriod(
  id: string,
  patch: { name?: string; notes?: string | null },
  user: SessionUser | null,
): Promise<BkAccountingPeriodRow> {
  const current = await requireAccountingPeriod(id)
  // The dates are deliberately not editable. Moving a year end after the year
  // has been worked on restates every report drawn for it, and the honest way
  // to do that is to delete the year and add it again while it is still open.
  const rows = await prisma.$queryRaw<BkAccountingPeriodRow[]>`
    UPDATE "bk_accounting_periods" SET
      "name"       = ${patch.name?.trim() || current.name},
      "notes"      = ${patch.notes === undefined ? current.notes : patch.notes?.trim() || null},
      "updated_at" = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  await appendAudit({
    action: 'accounting_period.updated',
    entityType: 'accounting_period',
    entityId: id,
    summary: `Financial year updated: ${rows[0]!.name}`,
    detail: { before: current, after: rows[0] },
    user,
  })
  return rows[0]!
}

export async function deleteAccountingPeriod(id: string, user: SessionUser | null): Promise<void> {
  const period = await requireAccountingPeriod(id)
  if (period.status === 'closed') {
    throw new PeriodStateError(
      `${period.name} has been closed off. Reopen it before removing it, so the closing journal goes with it.`,
    )
  }
  const [computation] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_ct_computations" WHERE "accounting_period_id" = ${id} LIMIT 1
  `
  if (computation) {
    throw new PeriodStateError(
      `${period.name} has a corporation tax computation attached to it. Remove that first.`,
    )
  }
  await prisma.$executeRaw`DELETE FROM "bk_accounting_periods" WHERE "id" = ${id}`
  await appendAudit({
    action: 'accounting_period.deleted',
    entityType: 'accounting_period',
    entityId: id,
    summary: `Financial year removed: ${period.name}`,
    detail: { before: period },
    user,
  })
}

/**
 * The year that comes next, worked out rather than typed.
 *
 * Follows on from the last year on the books if there is one. Otherwise it works
 * back from the year end in the settings, so a business setting this up for the
 * first time gets the year it is actually in rather than a blank form and a
 * question about dates it has to go and look up.
 */
export async function suggestNextPeriod(): Promise<{ startDate: string; endDate: string; name: string }> {
  const settings = await getSettings()
  const [last] = await prisma.$queryRaw<{ end_date: Date }[]>`
    SELECT "end_date" FROM "bk_accounting_periods" ORDER BY "end_date" DESC LIMIT 1
  `

  if (last) {
    const start = new Date(last.end_date.getTime() + 86_400_000)
    const end = yearEndOnOrAfter(start, settings.year_end_month, settings.year_end_day)
    return { startDate: iso(start), endDate: iso(end), name: defaultName(end) }
  }

  // Nothing on the books yet: run from the first thing that was ever recorded,
  // or from a year before the next year end if there is nothing at all.
  const [earliest] = await prisma.$queryRaw<{ first: Date | null }[]>`
    SELECT MIN(d)::date AS first FROM (
      SELECT MIN("tax_point_date") AS d FROM "bk_transactions" WHERE "status" = 'posted'
      UNION ALL
      SELECT MIN("date") FROM "bk_journals" WHERE "status" = 'posted'
      UNION ALL
      SELECT MIN("opening_date") FROM "bk_bank_accounts"
    ) t
  `
  const end = yearEndOnOrAfter(
    earliest?.first ?? new Date(),
    settings.year_end_month,
    settings.year_end_day,
  )
  const start =
    earliest?.first ??
    new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth(), end.getUTCDate() + 1))
  return { startDate: iso(start), endDate: iso(end), name: defaultName(end) }
}

/** The first year end falling on or after a date, coping with 29 February and 31 June. */
export function yearEndOnOrAfter(from: Date, month: number, day: number): Date {
  const build = (year: number): Date => {
    const candidate = new Date(Date.UTC(year, month - 1, day))
    // A 31st in a 30-day month, or 29 February in a common year, rolls over
    // into the next month. Pull it back to the last day that exists.
    if (candidate.getUTCMonth() !== month - 1) candidate.setUTCDate(0)
    return candidate
  }
  const thisYear = build(from.getUTCFullYear())
  return thisYear.getTime() >= from.getTime() ? thisYear : build(from.getUTCFullYear() + 1)
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

export type YearEndPreview = {
  period: BkAccountingPeriodRow
  lines: { accountId: string; code: string; name: string; debit: string; credit: string }[]
  totalIncome: string
  totalExpenses: string
  profit: string
  /** Where the profit goes. Named so the screen can say it out loud. */
  reservesAccount: { id: string; name: string } | null
  /** Reasons the close would be refused, in plain English. Empty means it would go through. */
  blockers: string[]
}

/**
 * What closing the year would post, before it posts it.
 *
 * The same function produces the preview and the journal, so what the screen
 * shows and what lands in the books cannot be two different things.
 */
export async function previewYearEnd(id: string): Promise<YearEndPreview> {
  const period = await requireAccountingPeriod(id)
  const balances = await accountBalances(iso(period.end_date), iso(period.start_date))

  const reserves = balances.find((row) => row.code === 'retained-earnings')
  const blockers: string[] = []
  if (period.status === 'closed') blockers.push(`${period.name} is already closed.`)
  if (!reserves) {
    blockers.push(
      'There is no retained profit account to move the profit into. Redeploy the site so the accounts are put back.',
    )
  }

  const [earlierOpen] = await prisma.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "bk_accounting_periods"
    WHERE "status" = 'open' AND "end_date" < ${period.start_date}::date
    ORDER BY "end_date" ASC LIMIT 1
  `
  if (earlierOpen) {
    blockers.push(
      `${earlierOpen.name} comes before this one and is still open. Years are closed oldest first, or the profit carried forward is wrong.`,
    )
  }

  let totalIncome: Money = toMoney('0.00')
  let totalExpenses: Money = toMoney('0.00')
  const lines: YearEndPreview['lines'] = []

  for (const row of balances) {
    if (row.kind !== 'income' && row.kind !== 'expense') continue
    const balance = toMoney(row.balance)
    if (balance.isZero()) continue
    if (row.kind === 'income') {
      totalIncome = totalIncome.plus(balance)
      // Income sits as a credit, so clearing it is a debit. A negative balance
      // (net credit notes) reverses, which is why both sides are worked out
      // from the sign rather than assumed from the kind.
      lines.push({
        accountId: row.accountId,
        code: row.code,
        name: row.name,
        debit: formatMoney(balance.isPositive() ? balance : toMoney('0.00')),
        credit: formatMoney(balance.isNegative() ? balance.negated() : toMoney('0.00')),
      })
    } else {
      totalExpenses = totalExpenses.plus(balance)
      lines.push({
        accountId: row.accountId,
        code: row.code,
        name: row.name,
        debit: formatMoney(balance.isNegative() ? balance.negated() : toMoney('0.00')),
        credit: formatMoney(balance.isPositive() ? balance : toMoney('0.00')),
      })
    }
  }

  const profit = totalIncome.minus(totalExpenses)
  if (reserves && !profit.isZero()) {
    lines.push({
      accountId: reserves.accountId,
      code: reserves.code,
      name: reserves.name,
      debit: formatMoney(profit.isNegative() ? profit.negated() : toMoney('0.00')),
      credit: formatMoney(profit.isPositive() ? profit : toMoney('0.00')),
    })
  }

  if (lines.length === 0) {
    blockers.push('There is nothing in that year to close off.')
  }

  return {
    period,
    lines,
    totalIncome: formatMoney(totalIncome),
    totalExpenses: formatMoney(totalExpenses),
    profit: formatMoney(profit),
    reservesAccount: reserves ? { id: reserves.accountId, name: reserves.name } : null,
    blockers,
  }
}

export async function closeYear(
  id: string,
  user: SessionUser | null,
): Promise<BkAccountingPeriodRow> {
  const preview = await previewYearEnd(id)
  if (preview.blockers.length > 0) throw new PeriodStateError(preview.blockers[0]!)

  const journalLines: JournalLineInput[] = preview.lines.map((line) => ({
    accountId: line.accountId,
    description: line.name,
    debit: line.debit === '0.00' ? null : line.debit,
    credit: line.credit === '0.00' ? null : line.credit,
  }))

  const journal = await createJournal(
    {
      date: iso(preview.period.end_date),
      reference: 'Year end',
      narrative: `${preview.period.name}: profit and loss balances taken to reserves (${formatPounds(preview.profit)}).`,
      status: 'posted',
      source: 'year_end',
      lines: journalLines,
    },
    user,
  )

  const rows = await prisma.$queryRaw<BkAccountingPeriodRow[]>`
    UPDATE "bk_accounting_periods" SET
      "status" = 'closed', "close_journal_id" = ${journal.id},
      "closed_at" = NOW(), "closed_by_user_id" = ${user?.id ?? null}, "updated_at" = NOW()
    WHERE "id" = ${id} AND "status" = 'open'
    RETURNING *
  `
  const closed = rows[0]
  if (!closed) {
    // Somebody else closed it between the preview and here, so this journal is
    // a duplicate of theirs. Take it straight back out with a plain statement
    // rather than through deleteJournal: the year is closed as of a moment ago,
    // and deleteJournal would rightly refuse to touch anything dated inside it.
    // The cascade takes the lines with it.
    await prisma.$executeRaw`DELETE FROM "bk_journals" WHERE "id" = ${journal.id}`
    throw new PeriodStateError('That year was closed by somebody else a moment ago.')
  }

  await appendAudit({
    action: 'accounting_period.closed',
    entityType: 'accounting_period',
    entityId: id,
    summary: `${closed.name} closed. Profit taken to reserves: ${formatPounds(preview.profit)}.`,
    detail: { journalId: journal.id, profit: preview.profit, lines: preview.lines },
    user,
  })
  return closed
}

export async function reopenYear(
  id: string,
  user: SessionUser | null,
): Promise<BkAccountingPeriodRow> {
  const period = await requireAccountingPeriod(id)
  if (period.status !== 'closed') {
    throw new PeriodStateError(`${period.name} is not closed.`)
  }

  const [laterClosed] = await prisma.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "bk_accounting_periods"
    WHERE "status" = 'closed' AND "start_date" > ${period.end_date}::date
    ORDER BY "start_date" ASC LIMIT 1
  `
  if (laterClosed) {
    throw new PeriodStateError(
      `${laterClosed.name} comes after this one and is still closed. Reopen the later years first, or the profit brought forward into them stops making sense.`,
    )
  }

  const [finalComputation] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_ct_computations"
    WHERE "accounting_period_id" = ${id} AND "status" = 'final' LIMIT 1
  `
  if (finalComputation) {
    throw new PeriodStateError(
      `${period.name} has a finished corporation tax computation on it. Put that back to a draft first - reopening the year underneath a computation that has been filed would leave the two disagreeing.`,
    )
  }

  // Reopen first, THEN remove the journal: the journal is dated inside the year
  // and deleting it while the year is still closed would trip the very guard
  // this function exists to lift.
  const rows = await prisma.$queryRaw<BkAccountingPeriodRow[]>`
    UPDATE "bk_accounting_periods" SET
      "status" = 'open', "close_journal_id" = NULL, "closed_at" = NULL,
      "closed_by_user_id" = NULL, "updated_at" = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  if (period.close_journal_id) {
    await deleteJournal(period.close_journal_id, user)
  }

  await appendAudit({
    action: 'accounting_period.reopened',
    entityType: 'accounting_period',
    entityId: id,
    summary: `${period.name} reopened. The closing journal has been taken back out.`,
    detail: { journalId: period.close_journal_id },
    user,
  })
  return rows[0]!
}
