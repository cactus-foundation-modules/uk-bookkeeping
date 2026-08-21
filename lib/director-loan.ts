import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { NotFoundError } from './errors'
import { formatMoney, formatPounds, toMoney } from './money'
import { getSettings } from './settings'
import { requireAccount } from './accounts'
import type { BkAccountRow, Money } from './types'

// The director's loan account.
//
// It is a liability account like any other, and the only reason it gets its own
// screen is that it is the one balance sheet account a small limited company has
// to keep an eye on all year rather than at the year end - because being
// overdrawn on it at the year end has a tax consequence, and by the time an
// accountant points that out it is usually too late to do anything about it.
//
// Two things feed it, and the screen has to show both or the balance is a lie:
//   - journals with a line on the loan account
//   - cashbook entries coded to the director's loan category, which is how a
//     transfer to or from the director on a bank statement gets recorded
//
// Sign convention, stated once: this is a LIABILITY, so a credit balance means
// the company owes the director, and a debit balance means the director owes the
// company. The second one is the one with the tax consequence, and the screen
// says so in those words rather than in accounting ones.

export type DirectorLoanMovement = {
  kind: 'journal' | 'transaction'
  id: string
  date: string
  narrative: string
  reference: string | null
  /**
   * Signed the way the account reads: positive puts the company further into
   * debt to the director, negative takes it the other way.
   */
  amount: string
  /** The balance after this movement, same convention. */
  balance: string
}

export type DirectorLoanStatement = {
  account: BkAccountRow
  movements: DirectorLoanMovement[]
  /**
   * Where the account stands NOW - not where the filtered rows leave it.
   *
   * These are two different numbers the moment a date range is set, and showing
   * the second one under the words "the company owes you" would be a plain lie
   * on any screen with a filter on it.
   */
  balance: string
  overdrawn: boolean
  /** What the account held before the first movement shown, when a range is set. */
  broughtForward: string
  yearEnd: DirectorLoanYearEnd | null
}

/**
 * Where the loan account stood at the last year end that has passed, and where
 * it stands now.
 *
 * Deliberately not a tax computation. Being overdrawn at a year end can mean a
 * section 455 charge and can mean a benefit in kind, and both depend on things
 * this module does not know - whether it was repaid within nine months, whether
 * interest was charged, what else the director has had. So this reports the
 * position and the questions, and links out. Working out somebody's tax from
 * half the facts would be worse than not working it out at all.
 */
export type DirectorLoanYearEnd = {
  date: string
  balance: string
  overdrawn: boolean
  /** Nine months and a day after the year end: the section 455 date. */
  repayBy: string
  /** Plain-English notes, in the order they matter. */
  notes: string[]
}

/** The last accounting year end on or before a date. */
export function lastYearEndBefore(asAt: Date, month: number, day: number): Date {
  const candidate = new Date(Date.UTC(asAt.getUTCFullYear(), month - 1, day))
  // A 29 February year end in a common year, or a 31st in a 30-day month, rolls
  // over into the next month. Pull it back to the last day that exists.
  if (candidate.getUTCMonth() !== month - 1) candidate.setUTCDate(0)
  if (candidate > asAt) {
    const previous = new Date(Date.UTC(asAt.getUTCFullYear() - 1, month - 1, day))
    if (previous.getUTCMonth() !== month - 1) previous.setUTCDate(0)
    return previous
  }
  return candidate
}

/** Nine months and one day after a year end - when a section 455 charge falls due. */
export function section455DueDate(yearEnd: Date): Date {
  const due = new Date(yearEnd)
  due.setUTCMonth(due.getUTCMonth() + 9)
  due.setUTCDate(due.getUTCDate() + 1)
  return due
}

const LONG_DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
})

/**
 * Every movement on a director's loan account, oldest first, with a running
 * balance.
 *
 * One query, not two plus a merge in JavaScript: the two sources are unioned in
 * SQL and the running total is a window function, so the arithmetic is exact
 * decimal throughout and the whole thing is a single round trip.
 */
export async function getDirectorLoanStatement(
  accountId: string,
  options: { from?: string | null; to?: string | null } = {},
): Promise<DirectorLoanStatement> {
  const account = await requireAccount(accountId)
  if (account.subtype !== 'director_loan') {
    throw new NotFoundError('That director’s loan account')
  }

  const from = options.from ? new Date(`${options.from.slice(0, 10)}T00:00:00.000Z`) : null
  const to = options.to ? new Date(`${options.to.slice(0, 10)}T00:00:00.000Z`) : null

  // What the account held the day before the range starts. Without it a filtered
  // statement's running balance restarts from zero, which reads as though the
  // director's loan began on whatever date happened to be typed into the filter.
  const broughtForward = from
    ? await balanceAt(accountId, new Date(from.getTime() - 86_400_000))
    : toMoney('0.00')

  const rows = await prisma.$queryRaw<
    {
      kind: 'journal' | 'transaction'
      id: string
      date: Date
      narrative: string
      reference: string | null
      amount: Prisma.Decimal
      running: Prisma.Decimal
    }[]
  >`
    WITH movements AS (
      -- Journals with a line on this account. A credit increases what the
      -- company owes the director, which is the positive direction here.
      SELECT
        'journal'::text AS kind,
        j."id"          AS id,
        j."date"        AS date,
        j."narrative"   AS narrative,
        j."reference"   AS reference,
        SUM(l."credit" - l."debit")::numeric AS amount,
        j."created_at"  AS created_at
      FROM "bk_journals" j
      JOIN "bk_journal_lines" l ON l."journal_id" = j."id"
      WHERE l."account_id" = ${accountId} AND j."status" = 'posted'
      GROUP BY j."id"
      HAVING SUM(l."credit" - l."debit") <> 0

      UNION ALL

      -- Cashbook entries coded to the loan category. Money IN to the business
      -- from the director is the company borrowing, so it increases the balance;
      -- money out repays it.
      SELECT
        'transaction'::text AS kind,
        t."id"              AS id,
        t."tax_point_date"  AS date,
        CASE WHEN t."description" <> '' THEN t."counterparty" || ' - ' || t."description"
             ELSE t."counterparty" END AS narrative,
        t."reference"       AS reference,
        (CASE WHEN t."direction" = 'income' THEN 1 ELSE -1 END
          * COALESCE(SUM(l."gross_amount"), 0))::numeric AS amount,
        t."created_at"      AS created_at
      FROM "bk_transactions" t
      JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
      JOIN "bk_accounts" a ON a."category_id" = l."category_id"
      WHERE a."id" = ${accountId} AND t."status" = 'posted'
      GROUP BY t."id"
    )
    SELECT kind, id, date, narrative, reference, amount,
           SUM(amount) OVER (ORDER BY date ASC, created_at ASC, id ASC
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::numeric AS running
    FROM movements
    WHERE (${from}::date IS NULL OR date >= ${from}::date)
      AND (${to}::date IS NULL OR date <= ${to}::date)
    ORDER BY date ASC, created_at ASC, id ASC
  `

  const movements: DirectorLoanMovement[] = rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    date: row.date.toISOString().slice(0, 10),
    narrative: row.narrative,
    reference: row.reference,
    amount: formatMoney(row.amount),
    balance: formatMoney(broughtForward.plus(toMoney(row.running))),
  }))

  // The position today, whatever the filter says. A range that ends last March
  // must not make the screen announce last March's balance as the current one.
  const balance: Money = await balanceAt(accountId, new Date())

  return {
    account,
    movements,
    balance: formatMoney(balance),
    overdrawn: balance.isNegative(),
    broughtForward: formatMoney(broughtForward),
    yearEnd: await yearEndPosition(accountId),
  }
}

/** The balance on the loan account as at a date, from both sources. */
export async function balanceAt(accountId: string, asAt: Date): Promise<Money> {
  const [row] = await prisma.$queryRaw<{ total: Prisma.Decimal }[]>`
    SELECT COALESCE((
      SELECT SUM(l."credit" - l."debit")
      FROM "bk_journal_lines" l
      JOIN "bk_journals" j ON j."id" = l."journal_id"
      WHERE l."account_id" = ${accountId} AND j."status" = 'posted' AND j."date" <= ${asAt}::date
    ), 0)
    + COALESCE((
      SELECT SUM(CASE WHEN t."direction" = 'income' THEN l."gross_amount" ELSE -l."gross_amount" END)
      FROM "bk_transaction_lines" l
      JOIN "bk_transactions" t ON t."id" = l."transaction_id"
      JOIN "bk_accounts" a ON a."category_id" = l."category_id"
      WHERE a."id" = ${accountId} AND t."status" = 'posted' AND t."tax_point_date" <= ${asAt}::date
    ), 0)::numeric AS total
  `
  return toMoney(row?.total ?? null)
}

export async function yearEndPosition(accountId: string): Promise<DirectorLoanYearEnd | null> {
  const settings = await getSettings()
  const now = new Date()
  const yearEnd = lastYearEndBefore(now, settings.year_end_month, settings.year_end_day)
  const balance = await balanceAt(accountId, yearEnd)
  const overdrawn = balance.isNegative()
  const repayBy = section455DueDate(yearEnd)

  const notes: string[] = []
  if (overdrawn) {
    notes.push(
      `At ${LONG_DATE.format(yearEnd)} the director owed the company ${formatPounds(balance.abs())}.`,
    )
    notes.push(
      `If that is not repaid by ${LONG_DATE.format(repayBy)}, the company has to pay tax on it under section 455, and gets it back only once the loan is repaid.`,
    )
    notes.push(
      'An overdrawn loan of more than £10,000 at any point in the year is also a benefit in kind unless the company charges interest at the official rate, and that has to go on a P11D.',
    )
    notes.push(
      'Whether either applies depends on things this module does not know, so check it with your accountant rather than taking this as the answer.',
    )
  } else if (balance.isZero()) {
    notes.push(`At ${LONG_DATE.format(yearEnd)} the loan account was clear.`)
  } else {
    notes.push(
      `At ${LONG_DATE.format(yearEnd)} the company owed the director ${formatPounds(balance)}. That way round there is nothing to pay - the company can repay it whenever it has the money.`,
    )
  }

  return {
    date: yearEnd.toISOString().slice(0, 10),
    balance: formatMoney(balance),
    overdrawn,
    repayBy: repayBy.toISOString().slice(0, 10),
    notes,
  }
}

/** The one-line position for the dashboard, for every loan account there is. */
export type DirectorLoanSummary = {
  accountId: string
  name: string
  personName: string | null
  balance: string
  overdrawn: boolean
}

export async function summariseDirectorLoans(): Promise<DirectorLoanSummary[]> {
  const rows = await prisma.$queryRaw<
    { id: string; name: string; person_name: string | null; total: Prisma.Decimal }[]
  >`
    SELECT a."id", a."name", a."person_name",
      (COALESCE((
        SELECT SUM(l."credit" - l."debit") FROM "bk_journal_lines" l
        JOIN "bk_journals" j ON j."id" = l."journal_id"
        WHERE l."account_id" = a."id" AND j."status" = 'posted'
      ), 0)
      + COALESCE((
        SELECT SUM(CASE WHEN t."direction" = 'income' THEN tl."gross_amount" ELSE -tl."gross_amount" END)
        FROM "bk_transaction_lines" tl
        JOIN "bk_transactions" t ON t."id" = tl."transaction_id"
        WHERE tl."category_id" = a."category_id" AND t."status" = 'posted'
      ), 0))::numeric AS total
    FROM "bk_accounts" a
    WHERE a."subtype" = 'director_loan' AND a."archived" = FALSE
    ORDER BY a."position" ASC, a."name" ASC
  `

  return rows.map((row) => ({
    accountId: row.id,
    name: row.name,
    personName: row.person_name,
    balance: formatMoney(row.total),
    overdrawn: toMoney(row.total).isNegative(),
  }))
}
