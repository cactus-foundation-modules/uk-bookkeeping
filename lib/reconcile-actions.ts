import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { assertDatesNotClosed, loadClosedRanges } from './guards'
import { formatMoney, formatPounds, netFromGross, ZERO } from './money'
import { confidentMatch, refreshBankTransactionStatuses, suggestMatchesForLines } from './reconciliation'
import { insertTransactionRows, type BulkOutcome } from './transactions'
import { VAT_RATE_PERCENTS, type Money, type TransactionStatus, type VatRateCode } from './types'

// Explaining statement lines, one at a time or forty at a time.
//
// This is the other half of the change that took the coding out of the import.
// Import keeps the bank's lines and stops; everything that says what a line WAS
// happens here, on the reconciliation screen, where the work can be done in any
// order and where lines that are alike can be dealt with together. Selecting
// nine director's loan repayments and coding the lot in one go is the case this
// was written for, and it is the case that made a line-by-line import review
// unbearable.
//
// Three rules hold throughout:
//
//   1. A line is explained for what is LEFT of it, not for its face value. A
//      line half accounted for by an entry already matched to it takes an entry
//      for the other half, and never for the whole.
//   2. One bad line never strands the rest. Everything that can be checked is
//      checked before anything is written, per line, and a line that fails comes
//      back as a sentence beside its own row.
//   3. Everything that survives that is written in ONE database transaction. A
//      bulk action that half happened is worse than one that did not.

type TxClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/** How many lines one bulk action may carry. Sized for the sixty-second route cap. */
export const MAX_BULK_LINES = 200

type BankLineRow = {
  id: string
  bank_account_id: string
  statement_id: string | null
  date: Date
  details: string
  counterparty: string
  reference: string | null
  amount: Prisma.Decimal
  status: 'unreconciled' | 'reconciled' | 'ignored'
  matched: Prisma.Decimal
}

async function loadBankLines(ids: string[]): Promise<Map<string, BankLineRow>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.$queryRaw<BankLineRow[]>`
    SELECT b."id", b."bank_account_id", b."statement_id", b."date", b."details",
           b."counterparty", b."reference", b."amount", b."status",
           COALESCE((SELECT SUM(r."amount") FROM "bk_reconciliations" r
                     WHERE r."bank_transaction_id" = b."id"), 0)::numeric AS matched
    FROM "bk_bank_transactions" b
    WHERE b."id" = ANY(${ids}::text[])
  `
  return new Map(rows.map((row) => [row.id, row]))
}

function assertBatchSize(ids: string[]): void {
  if (ids.length === 0) {
    throw new BookkeepingError('invalid', 'No statement lines were chosen.')
  }
  if (ids.length > MAX_BULK_LINES) {
    throw new BookkeepingError(
      'too_large',
      `That is ${ids.length} lines at once. Do up to ${MAX_BULK_LINES} at a time.`,
    )
  }
}

/**
 * The net and VAT behind a gross figure at a rate.
 *
 * Zero rated, exempt and outside the scope carry no VAT at all - inventing some
 * here would put a figure in box 4 that nothing downstream would ever question.
 * VAT is the remainder rather than a second rounding, so gross always equals net
 * plus VAT to the penny and the CHECK constraint on the line never has to catch
 * us out.
 */
function splitGross(gross: Money, rateCode: VatRateCode): { net: Money; vat: Money; percent: string } {
  if (rateCode !== 'standard' && rateCode !== 'reduced') {
    return { net: gross, vat: ZERO, percent: '0.00' }
  }
  const percent = VAT_RATE_PERCENTS[rateCode]
  const net = netFromGross(gross, percent)
  return { net, vat: gross.minus(net), percent }
}

// ---------------------------------------------------------------------------
// Recording entries from statement lines
// ---------------------------------------------------------------------------

export type RecordEntriesInput = {
  categoryId: string
  vatRateCode: VatRateCode
  /** Record it properly, or leave it as a draft for review. */
  status: TransactionStatus
}

export type RecordEntriesOutcome = BulkOutcome & { transactionIds: string[] }

/**
 * Turn statement lines into entries in the books, coded the same way.
 *
 * The counterparty, the date, the reference and the amount all come from the
 * bank's own line, so the only thing a human supplies is what it was for - which
 * is the only thing the bank never knew.
 */
export async function recordEntriesFromBankLines(
  ids: string[],
  input: RecordEntriesInput,
  user: SessionUser | null,
): Promise<RecordEntriesOutcome> {
  assertBatchSize(ids)

  const [category] = await prisma.$queryRaw<
    { id: string; name: string; direction: string; archived: boolean }[]
  >`
    SELECT "id", "name", "direction", "archived" FROM "bk_categories" WHERE "id" = ${input.categoryId} LIMIT 1
  `
  if (!category) throw new NotFoundError('That category')
  if (category.archived) {
    throw new BookkeepingError('invalid', `${category.name} has been archived, so nothing new can be filed under it.`)
  }

  const lines = await loadBankLines(ids)
  // Only read when it can bite: a draft is allowed to sit anywhere while it
  // waits for review, so a batch left for review needs none of this.
  const closed = input.status === 'posted' ? await loadClosedRanges() : null

  type Planned = { line: BankLineRow; remaining: Money }
  const planned: Planned[] = []
  const failed: BulkOutcome['failed'] = []

  for (const id of ids) {
    const line = lines.get(id)
    if (!line) {
      failed.push({ id, error: 'That statement line could not be found.' })
      continue
    }
    if (line.status === 'ignored') {
      failed.push({ id, error: 'That line has been set aside. Put it back first if it needs an entry.' })
      continue
    }

    const remaining = line.amount.minus(line.matched)
    if (remaining.isZero()) {
      failed.push({ id, error: 'That line is already explained in full.' })
      continue
    }

    const direction = remaining.isPositive() ? 'income' : 'expense'
    if (category.direction !== 'both' && category.direction !== direction) {
      failed.push({
        id,
        error: `${category.name} is for ${category.direction === 'income' ? 'money in' : 'money out'}, and this line is money ${direction === 'income' ? 'in' : 'out'}.`,
      })
      continue
    }

    if (closed) {
      try {
        assertDatesNotClosed(closed, line.date, line.date)
      } catch (error) {
        failed.push({ id, error: error instanceof Error ? error.message : 'That date cannot be used.' })
        continue
      }
    }

    planned.push({ line, remaining })
  }

  if (planned.length === 0) return { done: 0, failed, transactionIds: [] }

  const transactionIds = await prisma.$transaction(async (tx) => {
    const created: string[] = []
    for (const { line, remaining } of planned) {
      const gross = remaining.abs()
      const { net, vat, percent } = splitGross(gross, input.vatRateCode)
      const date = line.date.toISOString().slice(0, 10)
      const counterparty = line.counterparty.trim() || line.details.trim() || 'Unnamed'

      created.push(
        await insertTransactionRows(
          tx,
          {
            direction: remaining.isPositive() ? 'income' : 'expense',
            taxPointDate: date,
            settledDate: date,
            counterparty,
            description: line.details.trim() === counterparty ? '' : line.details.trim(),
            reference: line.reference,
            status: input.status,
            source: 'reconcile',
            sourceRef: line.id,
            bankAccountId: line.bank_account_id,
            statementId: line.statement_id,
            lines: [
              {
                categoryId: input.categoryId,
                vatTreatment: input.vatRateCode === 'outside_scope' ? 'outside_scope' : 'domestic',
                vatRateCode: input.vatRateCode,
                vatRatePercent: percent,
                netAmount: formatMoney(net),
                vatAmount: formatMoney(vat),
                grossAmount: formatMoney(gross),
              },
            ],
          },
          user,
        ),
      )
    }

    await insertReconciliations(
      tx,
      planned.map((item, index) => ({
        bankTransactionId: item.line.id,
        transactionId: created[index]!,
        amount: item.remaining,
      })),
      'manual',
      user,
    )
    await refreshBankTransactionStatuses(tx, planned.map((item) => item.line.id))
    return created
  })

  await appendAudit({
    action: 'reconciliation.recorded',
    entityType: 'bank_transaction',
    entityId: planned[0]!.line.id,
    summary: `${planned.length} statement line${planned.length === 1 ? '' : 's'} recorded as ${category.name}${input.status === 'draft' ? ', left as drafts for review' : ''}`,
    detail: {
      category: category.name,
      vatRateCode: input.vatRateCode,
      status: input.status,
      bankTransactionIds: planned.map((item) => item.line.id),
      transactionIds,
      total: formatMoney(planned.reduce((sum, item) => sum.plus(item.remaining), ZERO)),
    },
    user,
  })

  return { done: planned.length, failed, transactionIds }
}

/** One INSERT for a whole batch of matches, rather than one per pair. */
async function insertReconciliations(
  tx: TxClient,
  pairs: { bankTransactionId: string; transactionId: string; amount: Money }[],
  method: 'manual' | 'suggested',
  user: SessionUser | null,
): Promise<void> {
  if (pairs.length === 0) return
  await tx.$executeRaw`
    INSERT INTO "bk_reconciliations"
      ("bank_transaction_id", "transaction_id", "amount", "match_method", "created_by_user_id")
    SELECT d."bank_id", d."transaction_id", d."amount"::numeric, ${method}, ${user?.id ?? null}
    FROM UNNEST(
      ${pairs.map((pair) => pair.bankTransactionId)}::text[],
      ${pairs.map((pair) => pair.transactionId)}::text[],
      ${pairs.map((pair) => formatMoney(pair.amount))}::text[]
    ) AS d("bank_id", "transaction_id", "amount")
    ON CONFLICT ("bank_transaction_id", "transaction_id") DO UPDATE
      SET "amount" = EXCLUDED."amount", "match_method" = EXCLUDED."match_method"
  `
}

// ---------------------------------------------------------------------------
// Accepting the matcher's guesses
// ---------------------------------------------------------------------------

/**
 * Tick off the lines the matcher is sure about, in one go.
 *
 * "Sure about" is confidentMatch's definition and nothing looser: same amount to
 * the penny, close enough in date, and no runner-up anywhere near it. A wrong
 * match is worse than no match, because it looks explained and nobody looks
 * again - so a line with two plausible candidates is left alone for a human to
 * settle, and says so.
 */
export async function acceptSuggestedMatches(
  ids: string[],
  user: SessionUser | null,
): Promise<BulkOutcome> {
  assertBatchSize(ids)

  const lines = await loadBankLines(ids)
  const failed: BulkOutcome['failed'] = []
  const open: BankLineRow[] = []

  for (const id of ids) {
    const line = lines.get(id)
    if (!line) {
      failed.push({ id, error: 'That statement line could not be found.' })
      continue
    }
    if (line.status !== 'unreconciled') {
      failed.push({ id, error: line.status === 'ignored' ? 'That line has been set aside.' : 'That line is already ticked off.' })
      continue
    }
    if (!line.matched.isZero()) {
      failed.push({ id, error: 'Part of that line is already matched, so it needs settling by hand.' })
      continue
    }
    open.push(line)
  }

  if (open.length === 0) return { done: 0, failed }

  const suggestions = await suggestMatchesForLines(
    open.map((line) => ({
      date: line.date.toISOString().slice(0, 10),
      amount: formatMoney(line.amount),
      counterparty: line.counterparty,
      details: line.details,
      reference: line.reference,
    })),
  )

  type Pair = { line: BankLineRow; transactionId: string }
  const pairs: Pair[] = []
  // One entry cannot settle two lines here. Two identical payments a week apart
  // and one invoice is exactly the case where the machine should stand back.
  const claimed = new Set<string>()

  open.forEach((line, index) => {
    const best = confidentMatch(suggestions.get(index) ?? [])
    // Nothing sure enough is not a refusal, so it is not reported as one: on a
    // selection of a hundred lines that would bury the handful that ARE worth
    // reading under eighty-odd rows saying nothing happened. The screen says how
    // many were left instead.
    if (!best) return
    if (claimed.has(best.transactionId)) {
      failed.push({ id: line.id, error: 'The entry that fits this one is already being used by another line in this batch.' })
      return
    }
    claimed.add(best.transactionId)
    pairs.push({ line, transactionId: best.transactionId })
  })

  if (pairs.length === 0) return { done: 0, failed }

  // The candidate query never looked at locks or at part-matched entries, so the
  // chosen entries are checked properly before anything is written.
  const checks = await prisma.$queryRaw<
    { id: string; gross: Prisma.Decimal; matched: Prisma.Decimal; locked_period_id: string | null }[]
  >`
    SELECT t."id", t."locked_period_id",
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross,
           COALESCE((SELECT SUM(ABS(r."amount")) FROM "bk_reconciliations" r
                     WHERE r."transaction_id" = t."id"), 0)::numeric AS matched
    FROM "bk_transactions" t
    LEFT JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE t."id" = ANY(${pairs.map((pair) => pair.transactionId)}::text[])
    GROUP BY t."id"
  `
  const byId = new Map(checks.map((row) => [row.id, row]))

  const good: Pair[] = []
  for (const pair of pairs) {
    const entry = byId.get(pair.transactionId)
    if (!entry) {
      failed.push({ id: pair.line.id, error: 'The entry that fitted it has since gone.' })
      continue
    }
    if (entry.locked_period_id) {
      failed.push({ id: pair.line.id, error: 'The entry that fits it is in a filed VAT return, so it cannot be matched now.' })
      continue
    }
    const free = entry.gross.minus(entry.matched)
    if (!free.equals(pair.line.amount.abs())) {
      failed.push({
        id: pair.line.id,
        error: `The entry that fitted it has only ${formatPounds(free)} left to account for.`,
      })
      continue
    }
    good.push(pair)
  }

  if (good.length === 0) return { done: 0, failed }

  await prisma.$transaction(async (tx) => {
    await insertReconciliations(
      tx,
      good.map((pair) => ({
        bankTransactionId: pair.line.id,
        transactionId: pair.transactionId,
        // Signed from the statement line, never from anything the browser sent:
        // a money-out line accounts for a negative amount whatever was asked for.
        amount: pair.line.amount,
      })),
      'suggested',
      user,
    )
    // The entry now knows which account it went through, which is what makes a
    // per-account report possible without walking the reconciliations.
    await tx.$executeRaw`
      UPDATE "bk_transactions" t
      SET "bank_account_id" = b."bank_account_id", "updated_at" = NOW()
      FROM "bk_bank_transactions" b, UNNEST(
        ${good.map((pair) => pair.line.id)}::text[],
        ${good.map((pair) => pair.transactionId)}::text[]
      ) AS d("bank_id", "transaction_id")
      WHERE b."id" = d."bank_id"
        AND t."id" = d."transaction_id"
        AND t."bank_account_id" IS NULL
        AND t."locked_period_id" IS NULL
    `
    await refreshBankTransactionStatuses(tx, good.map((pair) => pair.line.id))
  })

  await appendAudit({
    action: 'reconciliation.matched',
    entityType: 'bank_transaction',
    entityId: good[0]!.line.id,
    summary: `${good.length} statement line${good.length === 1 ? '' : 's'} ticked off against entries already in the books`,
    detail: {
      pairs: good.map((pair) => ({ bankTransactionId: pair.line.id, transactionId: pair.transactionId })),
      method: 'suggested',
    },
    user,
  })

  return { done: good.length, failed }
}

// ---------------------------------------------------------------------------
// Setting lines aside
// ---------------------------------------------------------------------------

/**
 * Set a batch aside, or put a batch back.
 *
 * A line that is already ticked off is left alone rather than quietly untied
 * from its entry, which is what setting it aside would otherwise amount to.
 */
export async function setBankLinesIgnored(
  ids: string[],
  ignored: boolean,
  reason: string | null,
  user: SessionUser | null,
): Promise<BulkOutcome> {
  assertBatchSize(ids)

  const lines = await loadBankLines(ids)
  const failed: BulkOutcome['failed'] = []
  const usable: string[] = []

  for (const id of ids) {
    const line = lines.get(id)
    if (!line) {
      failed.push({ id, error: 'That statement line could not be found.' })
      continue
    }
    if (ignored && line.status === 'reconciled') {
      failed.push({ id, error: 'That line is ticked off against an entry. Take the match off first.' })
      continue
    }
    if (ignored === (line.status === 'ignored')) continue
    usable.push(id)
  }

  if (usable.length === 0) return { done: 0, failed }

  await prisma.$transaction(async (tx) => {
    if (ignored) {
      await tx.$executeRaw`
        UPDATE "bk_bank_transactions"
        SET "status" = 'ignored', "ignored_reason" = ${reason?.trim() || null}, "updated_at" = NOW()
        WHERE "id" = ANY(${usable}::text[])
      `
    } else {
      await tx.$executeRaw`
        UPDATE "bk_bank_transactions"
        SET "status" = 'unreconciled', "ignored_reason" = NULL, "updated_at" = NOW()
        WHERE "id" = ANY(${usable}::text[])
      `
      // Back in play, so its status has to be worked out again from what is
      // actually matched to it rather than assumed to be unexplained.
      await refreshBankTransactionStatuses(tx, usable)
    }
  })

  await appendAudit({
    action: ignored ? 'reconciliation.set-aside' : 'reconciliation.put-back',
    entityType: 'bank_transaction',
    entityId: usable[0]!,
    summary: ignored
      ? `${usable.length} statement line${usable.length === 1 ? '' : 's'} set aside${reason?.trim() ? `: ${reason.trim()}` : ''}`
      : `${usable.length} statement line${usable.length === 1 ? '' : 's'} put back to be explained`,
    detail: { bankTransactionIds: usable, reason: reason?.trim() || null },
    user,
  })

  return { done: usable.length, failed }
}

// ---------------------------------------------------------------------------
// Settling one bank line against several entries, less the fees
// ---------------------------------------------------------------------------
//
// A card processor does not pay you what you invoiced. GoCardless and Square
// batch a day's takings into one payout and take their cut out of the middle of
// it, so a single bank line of £487.32 is six invoices totalling £495.00, less
// £7.68 of fees, and possibly less a refund they netted off as well. Nothing
// about that line matches anything to the penny, which is why the ordinary
// matcher offers nothing at all for it.
//
// The arithmetic that makes it work is already in the schema: bk_reconciliations
// is many-to-many with a SIGNED amount, and a line is reconciled when what is
// matched to it SUMS to the line. So:
//
//     six invoices        +495.00
//     a refund             -24.00
//     the fees              -7.68  <- created here, coded to bank charges
//     -----------------------------
//     the bank line       +463.32
//
// The fee entry is not a fudge to make the line go green. It is the expense it
// actually is, on the right category, deductible, and visible in the accounts -
// which is the whole reason for doing it this way rather than matching the
// invoice at the wrong amount and losing the difference.

export type SettlementCandidate = {
  transactionId: string
  counterparty: string
  date: string
  reference: string | null
  status: TransactionStatus
  direction: 'income' | 'expense'
  /** What is still unaccounted for on this entry, unsigned. */
  outstanding: string
  /** The same figure signed the way the bank sees it: money in positive. */
  contribution: string
}

export type SettlementView = {
  bankTransactionId: string
  /** What is left of the line to explain, signed. */
  remaining: string
  candidates: SettlementCandidate[]
}

/** How far back to look for entries a payout might be settling. */
const SETTLEMENT_WINDOW_BEFORE = 60
const SETTLEMENT_WINDOW_AFTER = 14

/**
 * Entries that could be part of what this bank line paid.
 *
 * Deliberately not scored or ranked: working out which six of forty invoices
 * make up a payout is a subset-sum problem, and a machine guessing at it would
 * be confidently wrong often enough to be worse than useless. What helps is
 * seeing the outstanding ones in date order with a running total, so that is
 * what this returns.
 *
 * Both directions come back. A payout with a refund netted off it is ordinary,
 * and an expense entry contributes NEGATIVELY to a money-in line, which is
 * exactly how the bank saw it.
 */
export async function listSettlementCandidates(
  bankTransactionId: string,
  options: { search?: string | null; limit?: number } = {},
): Promise<SettlementView> {
  const line = (await loadBankLines([bankTransactionId])).get(bankTransactionId)
  if (!line) throw new NotFoundError('That statement line')

  const search = options.search?.trim() ? `%${options.search.trim().toLowerCase()}%` : null
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)

  const rows = await prisma.$queryRaw<
    {
      id: string
      counterparty: string
      tax_point_date: Date
      reference: string | null
      status: TransactionStatus
      direction: 'income' | 'expense'
      outstanding: Prisma.Decimal
    }[]
  >`
    SELECT t."id", t."counterparty", t."tax_point_date", t."reference", t."status", t."direction",
           (COALESCE(SUM(l."gross_amount"), 0)
            - COALESCE((SELECT SUM(ABS(r."amount")) FROM "bk_reconciliations" r
                        WHERE r."transaction_id" = t."id"), 0))::numeric AS outstanding
    FROM "bk_transactions" t
    JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE t."locked_period_id" IS NULL
      -- Every day count is cast to int: Prisma sends a JavaScript number as
      -- int8, and Postgres has "date - integer" but no "date - bigint".
      AND (
        t."tax_point_date" BETWEEN ${line.date}::date - ${SETTLEMENT_WINDOW_BEFORE}::int
                              AND ${line.date}::date + ${SETTLEMENT_WINDOW_AFTER}::int
        OR t."settled_date" BETWEEN ${line.date}::date - ${SETTLEMENT_WINDOW_BEFORE}::int
                               AND ${line.date}::date + ${SETTLEMENT_WINDOW_AFTER}::int
      )
      -- Already tied to THIS line, so picking it again would double-count it.
      AND NOT EXISTS (
        SELECT 1 FROM "bk_reconciliations" r2
        WHERE r2."transaction_id" = t."id" AND r2."bank_transaction_id" = ${bankTransactionId}
      )
      AND (${search}::text IS NULL
           OR lower(t."counterparty") LIKE ${search}
           OR lower(COALESCE(t."reference", '')) LIKE ${search})
    GROUP BY t."id"
    HAVING COALESCE(SUM(l."gross_amount"), 0)
           > COALESCE((SELECT SUM(ABS(r."amount")) FROM "bk_reconciliations" r
                       WHERE r."transaction_id" = t."id"), 0)
    ORDER BY t."tax_point_date" ASC, t."counterparty" ASC
    LIMIT ${limit}
  `

  return {
    bankTransactionId,
    remaining: formatMoney(line.amount.minus(line.matched)),
    candidates: rows.map((row) => ({
      transactionId: row.id,
      counterparty: row.counterparty,
      date: row.tax_point_date.toISOString().slice(0, 10),
      reference: row.reference,
      status: row.status,
      direction: row.direction,
      outstanding: formatMoney(row.outstanding),
      contribution: formatMoney(row.direction === 'income' ? row.outstanding : row.outstanding.negated()),
    })),
  }
}

export type SettleInput = {
  transactionIds: string[]
  /** Where the difference goes. Only needed when there is one. */
  differenceCategoryId?: string | null
  differenceVatRateCode?: VatRateCode
  /** Leave the fee entry as a draft rather than recording it. */
  leaveForReview?: boolean
}

export type SettleOutcome = {
  matched: number
  /** Signed: negative is money the processor kept. */
  difference: string
  differenceTransactionId: string | null
}

/**
 * Tie a set of entries to one bank line, and record the difference as what it is.
 *
 * All or nothing, unlike the bulk actions: this is one line's arithmetic, and a
 * settlement that half happened would leave a line matched to four of its six
 * invoices with no fee entry and no sign that anything was missing. So anything
 * wrong with any entry refuses the lot, by name.
 */
export async function settleBankLine(
  bankTransactionId: string,
  input: SettleInput,
  user: SessionUser | null,
): Promise<SettleOutcome> {
  const chosen = [...new Set(input.transactionIds)]
  if (chosen.length === 0) {
    throw new BookkeepingError('invalid', 'Choose at least one entry this line paid for.')
  }
  if (chosen.length > MAX_BULK_LINES) {
    throw new BookkeepingError(
      'too_large',
      `That is ${chosen.length} entries against one line. Do up to ${MAX_BULK_LINES} at a time.`,
    )
  }

  const line = (await loadBankLines([bankTransactionId])).get(bankTransactionId)
  if (!line) throw new NotFoundError('That statement line')
  if (line.status === 'ignored') {
    throw new BookkeepingError('invalid', 'That line has been set aside. Put it back first.')
  }
  const remaining = line.amount.minus(line.matched)
  if (remaining.isZero()) {
    throw new BookkeepingError('invalid', 'That line is already explained in full.')
  }

  const entries = await prisma.$queryRaw<
    {
      id: string
      counterparty: string
      direction: 'income' | 'expense'
      locked_period_id: string | null
      gross: Prisma.Decimal
      matched: Prisma.Decimal
      on_this_line: bigint
    }[]
  >`
    SELECT t."id", t."counterparty", t."direction", t."locked_period_id",
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross,
           COALESCE((SELECT SUM(ABS(r."amount")) FROM "bk_reconciliations" r
                     WHERE r."transaction_id" = t."id"), 0)::numeric AS matched,
           (SELECT COUNT(*) FROM "bk_reconciliations" r2
            WHERE r2."transaction_id" = t."id"
              AND r2."bank_transaction_id" = ${bankTransactionId})::bigint AS on_this_line
    FROM "bk_transactions" t
    LEFT JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE t."id" = ANY(${chosen}::text[])
    GROUP BY t."id"
  `
  const byId = new Map(entries.map((row) => [row.id, row]))

  const pairs: { transactionId: string; amount: Money }[] = []
  let picked: Money = ZERO

  for (const id of chosen) {
    const entry = byId.get(id)
    if (!entry) throw new NotFoundError('One of the entries you picked')
    if (entry.locked_period_id) {
      throw new BookkeepingError(
        'locked',
        `The entry for ${entry.counterparty} is in a VAT return that has been filed, so it cannot be matched now.`,
        409,
      )
    }
    if (entry.on_this_line > 0n) {
      throw new BookkeepingError(
        'invalid',
        `The entry for ${entry.counterparty} is already tied to this line, so picking it again would count it twice.`,
      )
    }
    const outstanding = entry.gross.minus(entry.matched)
    if (outstanding.lessThanOrEqualTo(0)) {
      throw new BookkeepingError(
        'invalid',
        `The entry for ${entry.counterparty} is already accounted for in full.`,
      )
    }
    // Signed the way the bank saw it, so a refund netted off a payout pulls the
    // total down instead of pushing it up.
    pairs.push({
      transactionId: id,
      amount: entry.direction === 'income' ? outstanding : outstanding.negated(),
    })
    picked = picked.plus(pairs[pairs.length - 1]!.amount)
  }

  // What the entries come to, against what actually arrived. Positive means the
  // bank is short of them - the processor kept it, and it is a cost.
  const shortfall = picked.minus(remaining)
  let differenceTransactionId: string | null = null

  if (!shortfall.isZero()) {
    if (!input.differenceCategoryId) {
      throw new BookkeepingError(
        'invalid',
        `Those entries come to ${formatPounds(picked)} and ${formatPounds(remaining)} arrived, so ${formatPounds(shortfall.abs())} is unaccounted for. Say what that difference was - card fees, most likely - before this can be settled.`,
      )
    }
  }

  const status: TransactionStatus = input.leaveForReview === true ? 'draft' : 'posted'

  const result = await prisma.$transaction(async (tx) => {
    let differenceId: string | null = null
    // A local copy: the callback must not mutate `pairs`, or a retried
    // transaction would push the difference entry on to it a second time.
    const allPairs = [...pairs]

    if (!shortfall.isZero()) {
      const direction = shortfall.isPositive() ? 'expense' : 'income'
      const gross = shortfall.abs()
      const rateCode = input.differenceVatRateCode ?? 'exempt'
      const { net, vat, percent } = splitGross(gross, rateCode)
      const date = line.date.toISOString().slice(0, 10)

      differenceId = await insertTransactionRows(
        tx,
        {
          direction,
          taxPointDate: date,
          settledDate: date,
          counterparty: line.counterparty.trim() || line.details.trim() || 'Unnamed',
          description:
            direction === 'expense'
              ? 'Charges kept out of the payout'
              : 'Extra received with the payout',
          reference: line.reference,
          status,
          source: 'reconcile',
          sourceRef: line.id,
          bankAccountId: line.bank_account_id,
          statementId: line.statement_id,
          lines: [
            {
              categoryId: input.differenceCategoryId!,
              vatTreatment: rateCode === 'outside_scope' ? 'outside_scope' : 'domestic',
              vatRateCode: rateCode,
              vatRatePercent: percent,
              netAmount: formatMoney(net),
              vatAmount: formatMoney(vat),
              grossAmount: formatMoney(gross),
            },
          ],
        },
        user,
      )
      allPairs.push({ transactionId: differenceId, amount: shortfall.negated() })
    }

    await insertReconciliations(
      tx,
      allPairs.map((pair) => ({ ...pair, bankTransactionId })),
      'manual',
      user,
    )
    await refreshBankTransactionStatuses(tx, [bankTransactionId])

    // The invariant, checked rather than assumed. If the signs or the
    // arithmetic are wrong the line will not have gone green, and a settlement
    // that leaves the line half explained is worse than one that refused - so
    // this throws, and the whole transaction goes back.
    const [after] = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "bk_bank_transactions" WHERE "id" = ${bankTransactionId}
    `
    if (after?.status !== 'reconciled') {
      throw new BookkeepingError(
        'invalid',
        'Those entries and that difference do not add up to this line, so nothing has been matched.',
      )
    }
    return differenceId
  })

  differenceTransactionId = result

  await appendAudit({
    action: 'reconciliation.settled',
    entityType: 'bank_transaction',
    entityId: bankTransactionId,
    summary: `${chosen.length} entr${chosen.length === 1 ? 'y' : 'ies'} settled against one statement line of ${formatPounds(line.amount)}${shortfall.isZero() ? '' : `, with ${formatPounds(shortfall.abs())} of difference recorded`}`,
    detail: {
      transactionIds: chosen,
      picked: formatMoney(picked),
      arrived: formatMoney(remaining),
      difference: formatMoney(shortfall.negated()),
      differenceTransactionId,
      differenceCategoryId: input.differenceCategoryId ?? null,
      differenceVatRateCode: input.differenceVatRateCode ?? null,
      status,
    },
    user,
  })

  return {
    matched: chosen.length,
    difference: formatMoney(shortfall.negated()),
    differenceTransactionId,
  }
}
