import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { formatMoney, formatPounds, toMoney } from './money'
import { nameSimilarity } from './name-matching'
import type { MatchMethod, Money } from './types'

// Reconciliation: tying what the bank says to what the books say.
//
// The rule the whole file turns on is that a statement line is reconciled when
// the entries matched to it account for ALL of it, to the penny. Not most of it,
// not near enough. A partially matched line is still an open question, and the
// screen says so, because "£2 of this is unexplained" is exactly the kind of
// thing that turns out to be a £2,000 typo.

type TxClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

export type MatchCandidate = {
  transactionId: string
  counterparty: string
  date: string
  reference: string | null
  status: 'draft' | 'posted'
  gross: string
  /** Higher is a better match. Ordering only; the number itself means nothing. */
  score: number
  /** Why it was suggested, in words, so the reviewer can judge it. */
  reasons: string[]
}

/** How far either side of the statement date an entry may sit and still be the same payment. */
const DATE_WINDOW_DAYS = 10

// Name comparison moved to lib/name-matching.ts when the document inbox needed
// the same arithmetic. Same word list, same rule, one copy - three private
// versions that drifted apart would show up as a receipt matching a statement
// line on one screen and not on another.

/** What a statement line looks like to the matcher, whether or not it is saved yet. */
export type MatchableLine = {
  date: string
  /** Signed, as the statement has it. */
  amount: string
  counterparty: string
  details: string
  reference: string | null
}

type CandidateEntry = {
  id: string
  counterparty: string
  tax_point_date: Date
  settled_date: Date | null
  reference: string | null
  status: 'draft' | 'posted'
  gross: Prisma.Decimal
  direction: 'income' | 'expense'
}

/**
 * Entries that could be any of these statement lines, in one query.
 *
 * One query rather than one per line, deliberately. A statement can carry
 * hundreds of lines, every module route is capped at sixty seconds by the core
 * dispatcher, and PgBouncer's transaction pooling puts four network round trips
 * behind each statement - so a per-line lookup is how an import of a busy month
 * times out. The scoring afterwards is arithmetic on rows already in hand.
 */
async function findCandidateEntries(lines: MatchableLine[]): Promise<CandidateEntry[]> {
  if (lines.length === 0) return []

  const dates = lines.map((line) => line.date).sort()
  const amounts = [...new Set(lines.map((line) => formatMoney(toMoney(line.amount).abs())))]

  return prisma.$queryRaw<CandidateEntry[]>`
    SELECT t."id", t."counterparty", t."tax_point_date", t."settled_date", t."reference",
           t."status", t."direction",
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross
    FROM "bk_transactions" t
    JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    -- Every day count is cast to int. Prisma sends a JavaScript number as int8,
    -- and Postgres has "date - integer" but no "date - bigint" - so without the
    -- cast this whole query fails at the database with a type error, which is
    -- exactly what it did the first time a statement was imported.
    WHERE (
        t."tax_point_date" BETWEEN ${dates[0]}::date - ${DATE_WINDOW_DAYS}::int
                              AND ${dates[dates.length - 1]}::date + ${DATE_WINDOW_DAYS}::int
        OR t."settled_date" BETWEEN ${dates[0]}::date - ${DATE_WINDOW_DAYS}::int
                               AND ${dates[dates.length - 1]}::date + ${DATE_WINDOW_DAYS}::int
      )
      -- Not already fully accounted for by some other statement line.
      AND COALESCE((
        SELECT SUM(ABS(r."amount")) FROM "bk_reconciliations" r WHERE r."transaction_id" = t."id"
      ), 0) < (
        SELECT COALESCE(SUM(l2."gross_amount"), 0)
        FROM "bk_transaction_lines" l2 WHERE l2."transaction_id" = t."id"
      )
    GROUP BY t."id"
    -- The amount has to agree exactly. An entry for a different amount is a
    -- different payment, and a matcher willing to be approximate about money
    -- will eventually tie a £95 invoice to a £59 one.
    HAVING COALESCE(SUM(l."gross_amount"), 0) = ANY(${amounts}::numeric[])
    LIMIT 2000
  `
}

/** Score the entries that could be this one line, best first. */
function scoreCandidates(line: MatchableLine, entries: CandidateEntry[], limit: number): MatchCandidate[] {
  const amount = toMoney(line.amount)
  const direction = amount.isPositive() ? 'income' : 'expense'
  const gross = amount.abs()
  const lineDate = new Date(`${line.date}T00:00:00.000Z`).getTime()

  const candidates: MatchCandidate[] = []
  for (const entry of entries) {
    if (entry.direction !== direction) continue
    if (!entry.gross.equals(gross)) continue

    const gaps = [entry.tax_point_date, entry.settled_date]
      .filter((date): date is Date => date !== null)
      .map((date) => Math.round(Math.abs(date.getTime() - lineDate) / 86_400_000))
    const dayGap = gaps.length > 0 ? Math.min(...gaps) : 9999
    if (dayGap > DATE_WINDOW_DAYS) continue

    const reasons: string[] = ['the amount is the same']
    let score = 100

    if (dayGap === 0) {
      score += 40
      reasons.push('the date is the same')
    } else {
      score += Math.max(0, 30 - dayGap * 3)
      reasons.push(`${dayGap} day${dayGap === 1 ? '' : 's'} apart`)
    }

    const similarity = Math.max(
      nameSimilarity(line.counterparty, entry.counterparty),
      nameSimilarity(line.details, entry.counterparty),
    )
    if (similarity >= 0.99) {
      score += 50
      reasons.push('the name is the same')
    } else if (similarity > 0) {
      score += Math.round(similarity * 40)
      reasons.push('the name is similar')
    }

    if (
      entry.reference &&
      line.reference &&
      entry.reference.trim().toLowerCase() === line.reference.trim().toLowerCase()
    ) {
      score += 45
      reasons.push('the reference is the same')
    }
    if (entry.status === 'draft') reasons.push('still waiting for review')

    candidates.push({
      transactionId: entry.id,
      counterparty: entry.counterparty,
      date: entry.tax_point_date.toISOString().slice(0, 10),
      reference: entry.reference,
      status: entry.status,
      gross: formatMoney(entry.gross),
      score,
      reasons,
    })
  }

  candidates.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))
  return candidates.slice(0, limit)
}

/**
 * A suggestion is only offered on its own when it is the only plausible one.
 *
 * Two entries for the same amount within a few days of each other are exactly
 * the case where guessing does damage, and a wrong match is worse than no match:
 * it looks explained, so nobody looks again.
 */
export const CONFIDENT_MARGIN = 30

export function confidentMatch(candidates: MatchCandidate[]): MatchCandidate | null {
  const best = candidates[0]
  if (!best || best.score < 140) return null
  const runnerUp = candidates[1]
  if (runnerUp && best.score - runnerUp.score < CONFIDENT_MARGIN) return null
  return best
}

/** Suggestions for every line of a statement, keyed by the line's position. */
export async function suggestMatchesForLines(
  lines: MatchableLine[],
  limit = 5,
): Promise<Map<number, MatchCandidate[]>> {
  const entries = await findCandidateEntries(lines)
  const suggestions = new Map<number, MatchCandidate[]>()
  lines.forEach((line, index) => {
    suggestions.set(index, scoreCandidates(line, entries, limit))
  })
  return suggestions
}

/** Entries that might be what this saved statement line is. */
export async function suggestMatches(bankTransactionId: string, limit = 8): Promise<MatchCandidate[]> {
  const [line] = await prisma.$queryRaw<
    { date: Date; amount: Prisma.Decimal; counterparty: string; details: string; reference: string | null }[]
  >`
    SELECT "date", "amount", "counterparty", "details", "reference"
    FROM "bk_bank_transactions" WHERE "id" = ${bankTransactionId} LIMIT 1
  `
  if (!line) throw new NotFoundError('That statement line')

  const matchable: MatchableLine = {
    date: line.date.toISOString().slice(0, 10),
    amount: formatMoney(line.amount),
    counterparty: line.counterparty,
    details: line.details,
    reference: line.reference,
  }
  return scoreCandidates(matchable, await findCandidateEntries([matchable]), limit)
}

/**
 * How much of a statement line is accounted for, and what that makes its status.
 *
 * Run inside the same transaction as whatever changed the matches, so the status
 * a screen reads is never a stale answer to a question somebody else has since
 * changed.
 */
export async function refreshBankTransactionStatus(tx: TxClient, bankTransactionId: string): Promise<void> {
  await refreshBankTransactionStatuses(tx, [bankTransactionId])
}

/**
 * The same, for a batch, in one statement.
 *
 * Coding forty statement lines in one go would otherwise be forty UPDATEs, and
 * PgBouncer puts four round trips behind each of them.
 */
export async function refreshBankTransactionStatuses(
  tx: TxClient,
  bankTransactionIds: string[],
): Promise<void> {
  if (bankTransactionIds.length === 0) return
  await tx.$executeRaw`
    UPDATE "bk_bank_transactions" b
    SET "status" = CASE
          WHEN b."status" = 'ignored' THEN 'ignored'
          WHEN COALESCE(m."matched", 0) = b."amount" THEN 'reconciled'
          ELSE 'unreconciled'
        END,
        "updated_at" = NOW()
    FROM (
      SELECT b2."id", COALESCE(SUM(r."amount"), 0) AS matched
      FROM "bk_bank_transactions" b2
      LEFT JOIN "bk_reconciliations" r ON r."bank_transaction_id" = b2."id"
      WHERE b2."id" = ANY(${bankTransactionIds}::text[])
      GROUP BY b2."id"
    ) m
    WHERE b."id" = m."id"
  `
}

/**
 * What a match tells the entry about itself.
 *
 * Tying an entry to a statement line settles two things the entry may not have
 * known: WHICH account the money moved through, and WHEN. Both are filled in
 * here, and only where the entry has no answer of its own - a date somebody
 * typed is a statement of fact and a match must never overwrite it.
 *
 * The date matters more than it looks. lib/ledger.ts posts the money side of an
 * entry at its settled date and nowhere else, so an invoice matched to the bank
 * with no settled date stays sitting in creditors, with the bank never showing
 * the payment - the statement line goes green and the books still say the
 * supplier is owed. On cash accounting it is worse than untidy: the VAT is not
 * reclaimable until the entry is paid, so an unstamped date keeps the VAT out
 * of every return there is.
 *
 * Locked entries are skipped rather than refused: a filed return is not to be
 * rewritten, and a match against one is legitimate.
 */
export async function stampSettlementFromLines(
  tx: TxClient,
  pairs: { bankTransactionId: string; transactionId: string }[],
): Promise<void> {
  if (pairs.length === 0) return
  await tx.$executeRaw`
    UPDATE "bk_transactions" t
    SET "settled_date"    = COALESCE(t."settled_date", b."date"),
        "bank_account_id" = COALESCE(t."bank_account_id", b."bank_account_id"),
        "updated_at"      = NOW()
    FROM UNNEST(
      ${pairs.map((pair) => pair.bankTransactionId)}::text[],
      ${pairs.map((pair) => pair.transactionId)}::text[]
    ) AS d("bank_id", "transaction_id")
    JOIN "bk_bank_transactions" b ON b."id" = d."bank_id"
    WHERE t."id" = d."transaction_id"
      AND t."locked_period_id" IS NULL
      AND (t."settled_date" IS NULL OR t."bank_account_id" IS NULL)
  `
}

export type MatchInput = {
  bankTransactionId: string
  transactionId: string
  /** How much of the entry this line accounts for. Defaults to the whole of it. */
  amount?: string | null
  method?: MatchMethod
}

/**
 * Tie an entry to a statement line.
 *
 * The signed amount is taken from the statement line, not from the caller: a
 * money-out line accounts for a negative amount however the request phrased it,
 * and letting the browser decide the sign would let a refund be recorded as a
 * payment by anybody who could edit a form field.
 */
export async function matchTransaction(input: MatchInput, user: SessionUser | null): Promise<void> {
  const [line] = await prisma.$queryRaw<{ id: string; amount: Prisma.Decimal; status: string; counterparty: string }[]>`
    SELECT "id", "amount", "status", "counterparty" FROM "bk_bank_transactions"
    WHERE "id" = ${input.bankTransactionId} LIMIT 1
  `
  if (!line) throw new NotFoundError('That statement line')

  const [entry] = await prisma.$queryRaw<
    {
      id: string
      counterparty: string
      direction: 'income' | 'expense'
      locked_period_id: string | null
      gross: Prisma.Decimal
      matched: Prisma.Decimal
    }[]
  >`
    SELECT t."id", t."counterparty", t."direction", t."locked_period_id",
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross,
           COALESCE((SELECT SUM(ABS(r."amount")) FROM "bk_reconciliations" r
                     WHERE r."transaction_id" = t."id"), 0)::numeric AS matched
    FROM "bk_transactions" t
    LEFT JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE t."id" = ${input.transactionId}
    GROUP BY t."id"
  `
  if (!entry) throw new NotFoundError('That entry')
  if (entry.locked_period_id) {
    throw new BookkeepingError(
      'locked',
      'That entry was included in a submitted VAT return, so how it is matched to the bank can no longer be changed.',
      409,
    )
  }

  const requested = input.amount ? toMoney(input.amount).abs() : line.amount.abs()
  if (requested.isZero()) {
    throw new BookkeepingError('invalid', 'A match has to be for an amount.')
  }

  const alreadyOnLine = await sumMatched('bank_transaction_id', input.bankTransactionId)
  const remainingOnLine = line.amount.abs().minus(alreadyOnLine.abs())
  if (requested.greaterThan(remainingOnLine)) {
    throw new BookkeepingError(
      'invalid',
      `That statement line has only ${formatPounds(remainingOnLine)} left to explain, and this would use ${formatPounds(requested)}.`,
    )
  }

  const remainingOnEntry = entry.gross.minus(entry.matched)
  if (requested.greaterThan(remainingOnEntry)) {
    throw new BookkeepingError(
      'invalid',
      `That entry is for ${formatPounds(entry.gross)} and ${formatPounds(entry.matched)} of it is already matched, so only ${formatPounds(remainingOnEntry)} is left.`,
    )
  }

  // Signed by the ENTRY, not by the line. They agree for the ordinary case - an
  // expense settled by a money-out line - but a refund netted off a money-in
  // payout is an expense against a positive line, and taking the sign from the
  // line there would add the refund to what the line explained instead of taking
  // it off. The browser never gets a say either way.
  const signed = entry.direction === 'income' ? requested : requested.negated()

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "bk_reconciliations"
        ("bank_transaction_id", "transaction_id", "amount", "match_method", "created_by_user_id")
      VALUES (${input.bankTransactionId}, ${input.transactionId}, ${formatMoney(signed)}::numeric,
              ${input.method ?? 'manual'}, ${user?.id ?? null})
      ON CONFLICT ("bank_transaction_id", "transaction_id") DO UPDATE
        SET "amount" = EXCLUDED."amount", "match_method" = EXCLUDED."match_method"
    `
    // The entry now knows which account it was paid from and when, which is
    // what makes a per-account report possible without walking the
    // reconciliations every time - and what keeps a matched invoice from
    // sitting in creditors for ever.
    await stampSettlementFromLines(tx, [
      { bankTransactionId: input.bankTransactionId, transactionId: input.transactionId },
    ])
    await refreshBankTransactionStatus(tx, input.bankTransactionId)
  })

  await appendAudit({
    action: 'reconciliation.matched',
    entityType: 'bank_transaction',
    entityId: input.bankTransactionId,
    summary: `${formatPounds(signed)} on the statement matched to the entry for ${entry.counterparty}`,
    detail: { transactionId: input.transactionId, amount: formatMoney(signed), method: input.method ?? 'manual' },
    user,
  })
}

async function sumMatched(column: 'bank_transaction_id' | 'transaction_id', id: string): Promise<Money> {
  const [row] = await prisma.$queryRaw<{ total: Prisma.Decimal }[]>`
    SELECT COALESCE(SUM("amount"), 0)::numeric AS total
    FROM "bk_reconciliations"
    WHERE ${column === 'bank_transaction_id' ? Prisma.sql`"bank_transaction_id"` : Prisma.sql`"transaction_id"`} = ${id}
  `
  return toMoney(row?.total ?? null)
}

export async function unmatch(
  bankTransactionId: string,
  transactionId: string,
  user: SessionUser | null,
): Promise<void> {
  const [existing] = await prisma.$queryRaw<{ id: string; amount: Prisma.Decimal }[]>`
    SELECT "id", "amount" FROM "bk_reconciliations"
    WHERE "bank_transaction_id" = ${bankTransactionId} AND "transaction_id" = ${transactionId}
    LIMIT 1
  `
  if (!existing) throw new NotFoundError('That match')

  await prisma.$transaction(async (tx) => {
    // The trigger in 007 refuses this outright when the entry is in a filed
    // return, and says why in a sentence.
    await tx.$executeRaw`DELETE FROM "bk_reconciliations" WHERE "id" = ${existing.id}`
    await refreshBankTransactionStatus(tx, bankTransactionId)
  })

  await appendAudit({
    action: 'reconciliation.unmatched',
    entityType: 'bank_transaction',
    entityId: bankTransactionId,
    summary: `A match of ${formatPounds(existing.amount)} was taken off a statement line`,
    detail: { transactionId },
    user,
  })
}

export type MatchedEntry = {
  transactionId: string
  counterparty: string
  date: string
  amount: string
  method: MatchMethod
  locked: boolean
}

export async function listMatches(bankTransactionId: string): Promise<MatchedEntry[]> {
  const rows = await prisma.$queryRaw<
    {
      transaction_id: string
      counterparty: string
      tax_point_date: Date
      amount: Prisma.Decimal
      match_method: MatchMethod
      locked_period_id: string | null
    }[]
  >`
    SELECT r."transaction_id", r."amount", r."match_method",
           t."counterparty", t."tax_point_date", t."locked_period_id"
    FROM "bk_reconciliations" r
    JOIN "bk_transactions" t ON t."id" = r."transaction_id"
    WHERE r."bank_transaction_id" = ${bankTransactionId}
    ORDER BY r."created_at" ASC
  `
  return rows.map((row) => ({
    transactionId: row.transaction_id,
    counterparty: row.counterparty,
    date: row.tax_point_date.toISOString().slice(0, 10),
    amount: formatMoney(row.amount),
    method: row.match_method,
    locked: row.locked_period_id !== null,
  }))
}

/**
 * The reconciliation report for one account over a date range.
 *
 * Written to answer the only question that matters at a year end: does the
 * balance in the books agree with the balance on the statement, and if not, what
 * exactly is in between. Every figure here is summed in Postgres.
 */
export type ReconciliationSummary = {
  bankAccountId: string
  from: string | null
  to: string | null
  statementLines: number
  reconciledLines: number
  ignoredLines: number
  unreconciledLines: number
  statementTotal: string
  reconciledTotal: string
  unreconciledTotal: string
  /** Entries in the books with no statement line behind them at all. */
  unmatchedEntryCount: number
  unmatchedEntryTotal: string
}

export async function summariseReconciliation(
  bankAccountId: string,
  from: string | null,
  to: string | null,
): Promise<ReconciliationSummary> {
  const fromDate = from ? new Date(`${from.slice(0, 10)}T00:00:00.000Z`) : null
  const toDate = to ? new Date(`${to.slice(0, 10)}T00:00:00.000Z`) : null

  const [row] = await prisma.$queryRaw<
    {
      statement_lines: bigint
      reconciled_lines: bigint
      ignored_lines: bigint
      unreconciled_lines: bigint
      statement_total: Prisma.Decimal
      reconciled_total: Prisma.Decimal
      unreconciled_total: Prisma.Decimal
    }[]
  >`
    SELECT
      COUNT(*)::bigint AS statement_lines,
      COUNT(*) FILTER (WHERE "status" = 'reconciled')::bigint   AS reconciled_lines,
      COUNT(*) FILTER (WHERE "status" = 'ignored')::bigint      AS ignored_lines,
      COUNT(*) FILTER (WHERE "status" = 'unreconciled')::bigint AS unreconciled_lines,
      COALESCE(SUM("amount"), 0)::numeric AS statement_total,
      COALESCE(SUM("amount") FILTER (WHERE "status" = 'reconciled'), 0)::numeric   AS reconciled_total,
      COALESCE(SUM("amount") FILTER (WHERE "status" = 'unreconciled'), 0)::numeric AS unreconciled_total
    FROM "bk_bank_transactions"
    WHERE "bank_account_id" = ${bankAccountId}
      AND (${fromDate}::date IS NULL OR "date" >= ${fromDate}::date)
      AND (${toDate}::date IS NULL OR "date" <= ${toDate}::date)
  `

  const [entries] = await prisma.$queryRaw<{ count: bigint; total: Prisma.Decimal }[]>`
    SELECT COUNT(*)::bigint AS count, COALESCE(SUM(g."gross"), 0)::numeric AS total
    FROM (
      SELECT t."id", COALESCE(SUM(l."gross_amount"), 0) AS gross
      FROM "bk_transactions" t
      JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
      WHERE t."status" = 'posted'
        AND (t."bank_account_id" = ${bankAccountId} OR t."bank_account_id" IS NULL)
        AND (${fromDate}::date IS NULL OR t."tax_point_date" >= ${fromDate}::date)
        AND (${toDate}::date IS NULL OR t."tax_point_date" <= ${toDate}::date)
        AND NOT EXISTS (SELECT 1 FROM "bk_reconciliations" r WHERE r."transaction_id" = t."id")
      GROUP BY t."id"
    ) g
  `

  return {
    bankAccountId,
    from,
    to,
    statementLines: Number(row?.statement_lines ?? 0n),
    reconciledLines: Number(row?.reconciled_lines ?? 0n),
    ignoredLines: Number(row?.ignored_lines ?? 0n),
    unreconciledLines: Number(row?.unreconciled_lines ?? 0n),
    statementTotal: formatMoney(row?.statement_total ?? null),
    reconciledTotal: formatMoney(row?.reconciled_total ?? null),
    unreconciledTotal: formatMoney(row?.unreconciled_total ?? null),
    unmatchedEntryCount: Number(entries?.count ?? 0n),
    unmatchedEntryTotal: formatMoney(entries?.total ?? null),
  }
}
