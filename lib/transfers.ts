import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, LockedRecordError, NotFoundError } from './errors'
import { assertNotInClosedYear } from './guards'
import {
  checkAccountsExist,
  checkLines,
  insertLines,
  parseJournalDate,
  requireJournal,
  type JournalWithLines,
} from './journals'
import { formatMoney, formatPounds, toMoney } from './money'
import { refreshBankTransactionStatuses } from './reconciliation'
import type { JournalStatus, Money } from './types'

// Transfers: money moved between two accounts the business already owns.
//
// Not income, not a cost, no category, no VAT, and no effect on profit. What it
// does change is where the money is, which is why it cannot simply be ignored:
// leave it out and both accounts' balances are wrong by the amount, in opposite
// directions, for ever.
//
// Underneath it is a journal - debit the account that received it, credit the
// account it came from - and 020_transfers.sql explains at length why it is not
// a third value of bk_transactions.direction. This file is the thin layer that
// keeps such a journal well formed: two sides, two real bank accounts, one
// amount, and the pair of bank account ids on the journal itself so a screen can
// say "Current → Savings" without a join back through the nominals.

export type TransferInput = {
  date: string
  amount: string
  fromBankAccountId: string
  toBankAccountId: string
  reference?: string | null
  description?: string | null
  status?: JournalStatus
}

export type TransferView = JournalWithLines & {
  from_bank_account_id: string
  to_bank_account_id: string
  from_bank_name: string
  to_bank_name: string
  amount: string
}

const LARGEST = new Prisma.Decimal('99999999.99')

/**
 * The nominal account that stands for a bank account on the balance sheet.
 *
 * Created alongside the bank account itself (lib/bank-accounts.ts), so a missing
 * one means a bank account that predates that wiring. Refuse rather than invent:
 * posting a transfer to a made-up account would balance and still be wrong.
 */
async function nominalsFor(
  bankAccountIds: string[],
): Promise<Map<string, { accountId: string; name: string }>> {
  const rows = await prisma.$queryRaw<
    { bank_account_id: string; account_id: string; bank_name: string; archived: boolean }[]
  >`
    SELECT DISTINCT ON (b."id")
           b."id" AS bank_account_id, a."id" AS account_id,
           b."name" AS bank_name, b."archived"
    FROM "bk_bank_accounts" b
    JOIN "bk_accounts" a ON a."bank_account_id" = b."id"
    WHERE b."id" = ANY(${bankAccountIds}::text[])
    ORDER BY b."id", a."is_system" DESC, a."position" ASC, a."id" ASC
  `
  const found = new Map<string, { accountId: string; name: string }>()
  for (const row of rows) {
    if (row.archived) {
      throw new BookkeepingError(
        'invalid',
        `"${row.bank_name}" has been archived, so nothing new can be moved in or out of it.`,
      )
    }
    found.set(row.bank_account_id, { accountId: row.account_id, name: row.bank_name })
  }
  for (const id of bankAccountIds) {
    if (!found.has(id)) {
      throw new BookkeepingError(
        'invalid',
        'One of those accounts has no place on the balance sheet yet. Open it in Bank accounts and save it once, then try again.',
      )
    }
  }
  return found
}

type CheckedTransfer = {
  date: Date
  amount: Money
  from: { bankAccountId: string; accountId: string; name: string }
  to: { bankAccountId: string; accountId: string; name: string }
  narrative: string
  reference: string | null
  status: JournalStatus
}

async function check(input: TransferInput): Promise<CheckedTransfer> {
  if (!input.fromBankAccountId || !input.toBankAccountId) {
    throw new BookkeepingError('invalid', 'A transfer needs an account it came from and one it went into.')
  }
  if (input.fromBankAccountId === input.toBankAccountId) {
    throw new BookkeepingError(
      'invalid',
      'Those are the same account. A transfer needs two different ones, or nothing has actually moved.',
    )
  }

  const amount = toMoney(input.amount)
  if (amount.isNegative() || amount.isZero()) {
    throw new BookkeepingError(
      'invalid',
      'A transfer needs an amount above nothing. To send it the other way, swap the two accounts over.',
    )
  }
  if (amount.greaterThan(LARGEST)) {
    throw new BookkeepingError('invalid', 'That is larger than these books can hold (amounts run to 99,999,999.99).')
  }

  const nominals = await nominalsFor([input.fromBankAccountId, input.toBankAccountId])
  const from = nominals.get(input.fromBankAccountId)!
  const to = nominals.get(input.toBankAccountId)!

  const date = parseJournalDate(input.date, 'The transfer date')
  const typed = input.description?.trim()

  return {
    date,
    amount,
    from: { bankAccountId: input.fromBankAccountId, ...from },
    to: { bankAccountId: input.toBankAccountId, ...to },
    // The narrative column is NOT NULL with a length check on it, and a transfer
    // is the one journal where a sensible one can be written without asking.
    narrative: typed || `Transfer from ${from.name} to ${to.name}`,
    reference: input.reference?.trim() || null,
    status: input.status ?? 'posted',
  }
}

/** The two sides, in the order they read: what came in, then what went out. */
function sidesOf(checked: CheckedTransfer) {
  const amount = formatMoney(checked.amount)
  return checkLines(
    [
      { accountId: checked.to.accountId, description: `From ${checked.from.name}`, debit: amount },
      { accountId: checked.from.accountId, description: `To ${checked.to.name}`, credit: amount },
    ],
    checked.status === 'posted',
  )
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTransfer(id: string): Promise<TransferView | null> {
  const journal = await requireJournal(id).catch(() => null)
  if (!journal || journal.kind !== 'transfer') return null

  const names = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT "id", "name" FROM "bk_bank_accounts"
    WHERE "id" = ANY(${[journal.from_bank_account_id, journal.to_bank_account_id].filter(
      (value): value is string => value !== null,
    )}::text[])
  `
  const byId = new Map(names.map((row) => [row.id, row.name]))

  return {
    ...journal,
    from_bank_account_id: journal.from_bank_account_id!,
    to_bank_account_id: journal.to_bank_account_id!,
    from_bank_name: byId.get(journal.from_bank_account_id!) ?? 'an account since removed',
    to_bank_name: byId.get(journal.to_bank_account_id!) ?? 'an account since removed',
    amount: journal.total_debits,
  }
}

export async function requireTransfer(id: string): Promise<TransferView> {
  const transfer = await getTransfer(id)
  if (!transfer) throw new NotFoundError('That transfer')
  return transfer
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function assertTransferMutable(id: string): Promise<{ date: Date }> {
  const [row] = await prisma.$queryRaw<{ id: string; date: Date; kind: string; locked_period_id: string | null }[]>`
    SELECT "id", "date", "kind", "locked_period_id" FROM "bk_journals" WHERE "id" = ${id} LIMIT 1
  `
  if (!row || row.kind !== 'transfer') throw new NotFoundError('That transfer')
  if (row.locked_period_id) throw new LockedRecordError(id, row.locked_period_id)
  return { date: row.date }
}

export async function createTransfer(input: TransferInput, user: SessionUser | null): Promise<TransferView> {
  const checked = await check(input)
  const lines = sidesOf(checked)
  await checkAccountsExist(lines.map((line) => line.accountId))
  await assertNotInClosedYear(checked.date)

  const id = await prisma.$transaction(async (tx) => {
    const [created] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "bk_journals"
        ("date", "reference", "narrative", "status", "source", "kind",
         "from_bank_account_id", "to_bank_account_id",
         "created_by_user_id", "updated_by_user_id")
      VALUES (
        ${checked.date}::date, ${checked.reference}, ${checked.narrative},
        ${checked.status}, 'transfer', 'transfer',
        ${checked.from.bankAccountId}, ${checked.to.bankAccountId},
        ${user?.id ?? null}, ${user?.id ?? null}
      )
      RETURNING "id"
    `
    await insertLines(tx, created!.id, lines)
    return created!.id
  })

  await appendAudit({
    action: 'transfer.created',
    entityType: 'journal',
    entityId: id,
    summary: `${formatPounds(checked.amount)} moved from ${checked.from.name} to ${checked.to.name}`,
    detail: { after: input },
    user,
  })

  return requireTransfer(id)
}

export async function updateTransfer(
  id: string,
  input: TransferInput,
  user: SessionUser | null,
): Promise<TransferView> {
  const existing = await assertTransferMutable(id)
  const before = await requireTransfer(id)

  // Statement lines already tied to this one. Changing the amount or either
  // account underneath them would leave a line saying it is fully explained by
  // something that is now for a different sum, out of a different account - the
  // one failure this whole screen exists to catch, produced by the screen
  // itself. Take the matches off first and it can be changed freely.
  const [matched] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_reconciliations" WHERE "journal_id" = ${id}
  `
  if (Number(matched?.count ?? 0n) > 0) {
    throw new BookkeepingError(
      'referenced',
      'Statement lines are ticked off against that transfer, so changing it now would leave them explained by something that no longer matches. Take those off on the Reconcile screen first.',
      409,
    )
  }
  const checked = await check({ ...input, status: input.status ?? before.status })
  const lines = sidesOf(checked)
  await checkAccountsExist(lines.map((line) => line.accountId))
  // Both dates, the same as an ordinary journal: one stops it being moved into a
  // closed year, the other stops it being dragged out of one.
  await assertNotInClosedYear(checked.date, existing.date)

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "bk_journals" SET
        "date"      = ${checked.date}::date,
        "reference" = ${checked.reference},
        "narrative" = ${checked.narrative},
        "status"    = ${checked.status},
        "from_bank_account_id" = ${checked.from.bankAccountId},
        "to_bank_account_id"   = ${checked.to.bankAccountId},
        "updated_by_user_id"   = ${user?.id ?? null},
        "updated_at" = NOW()
      WHERE "id" = ${id}
    `
    await tx.$executeRaw`DELETE FROM "bk_journal_lines" WHERE "journal_id" = ${id}`
    await insertLines(tx, id, lines)
  })

  await appendAudit({
    action: 'transfer.updated',
    entityType: 'journal',
    entityId: id,
    summary: `Transfer changed: ${formatPounds(checked.amount)} from ${checked.from.name} to ${checked.to.name}`,
    detail: {
      before: { date: before.date, amount: before.amount, narrative: before.narrative },
      after: input,
    },
    user,
  })

  return requireTransfer(id)
}

export async function deleteTransfer(id: string, user: SessionUser | null): Promise<void> {
  const existing = await assertTransferMutable(id)
  const before = await requireTransfer(id)
  await assertNotInClosedYear(existing.date)

  // The reconciliation rows go with it - ON DELETE CASCADE in 020 - so the
  // statement lines they explained have to be asked again what they are.
  const covered = await prisma.$queryRaw<{ bank_transaction_id: string }[]>`
    SELECT DISTINCT "bank_transaction_id" FROM "bk_reconciliations" WHERE "journal_id" = ${id}
  `

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "bk_journals" WHERE "id" = ${id}`
    await refreshBankTransactionStatuses(
      tx,
      covered.map((row) => row.bank_transaction_id),
    )
  })

  await appendAudit({
    action: 'transfer.deleted',
    entityType: 'journal',
    entityId: id,
    summary: `Transfer deleted: ${before.amount} from ${before.from_bank_name} to ${before.to_bank_name}`,
    detail: { before: { date: before.date, amount: before.amount } },
    user,
  })
}

// ---------------------------------------------------------------------------
// What the reconcile screen needs
// ---------------------------------------------------------------------------

export type TransferCandidate = {
  journalId: string
  date: string
  narrative: string
  reference: string | null
  amount: string
  fromBankName: string
  toBankName: string
  /** Which end of the transfer this statement line is: the money out, or the money in. */
  side: 'out' | 'in'
  /** How far the transfer's date is from the statement line's, for ordering. */
  daysApart: number
}

/** How far either side of the statement date a transfer may sit and still be the same movement. */
const DATE_WINDOW_DAYS = 10

/** A statement line as the transfer matcher needs to see it. */
export type MatchableTransferLine = {
  id: string
  bankAccountId: string
  /** ISO date, as the statement has it. */
  date: string
  /** Signed: negative is money out. */
  amount: string
}

type TransferRow = {
  id: string
  date: Date
  narrative: string
  reference: string | null
  amount: Prisma.Decimal
  from_bank_account_id: string
  to_bank_account_id: string
  from_bank_name: string
  to_bank_name: string
  matched_accounts: string[]
}

/**
 * Transfers that could explain each of these statement lines, in one query.
 *
 * One query rather than one per line, for the same reason the entry matcher does
 * it that way: every module route is capped at sixty seconds and PgBouncer puts
 * four round trips behind each statement, so a per-line lookup is how a busy
 * month times out. The pairing afterwards is arithmetic on rows already in hand.
 *
 * A money-out line can only be the "from" end of a transfer and a money-in line
 * only the "to" end, which is what stops both legs of one transfer being offered
 * against the same statement line.
 */
export async function findTransferCandidatesForLines(
  lines: MatchableTransferLine[],
): Promise<Map<string, TransferCandidate[]>> {
  const found = new Map<string, TransferCandidate[]>()
  if (lines.length === 0) return found

  const dates = lines.map((line) => line.date).sort()
  const accounts = [...new Set(lines.map((line) => line.bankAccountId))]

  const rows = await prisma.$queryRaw<TransferRow[]>`
    SELECT j."id", j."date", j."narrative", j."reference",
           j."from_bank_account_id", j."to_bank_account_id",
           COALESCE(SUM(l."debit"), 0)::numeric AS amount,
           f."name" AS from_bank_name, t."name" AS to_bank_name,
           COALESCE(m."accounts", ARRAY[]::text[]) AS matched_accounts
    FROM "bk_journals" j
    JOIN "bk_journal_lines" l ON l."journal_id" = j."id"
    JOIN "bk_bank_accounts" f ON f."id" = j."from_bank_account_id"
    JOIN "bk_bank_accounts" t ON t."id" = j."to_bank_account_id"
    -- Which ends of this transfer are already accounted for. One transfer takes
    -- exactly two statement lines, one from each account, so an end already
    -- taken must not be offered again.
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT b."bank_account_id") AS accounts
      FROM "bk_reconciliations" r
      JOIN "bk_bank_transactions" b ON b."id" = r."bank_transaction_id"
      WHERE r."journal_id" = j."id"
    ) m ON TRUE
    WHERE j."kind" = 'transfer'
      AND j."status" = 'posted'
      AND (j."from_bank_account_id" = ANY(${accounts}::text[])
           OR j."to_bank_account_id" = ANY(${accounts}::text[]))
      -- Every day count is cast to int: Prisma sends a JavaScript number as
      -- int8, and Postgres has "date - integer" but no "date - bigint".
      AND j."date" BETWEEN ${dates[0]}::date - ${DATE_WINDOW_DAYS}::int
                       AND ${dates[dates.length - 1]}::date + ${DATE_WINDOW_DAYS}::int
    GROUP BY j."id", f."name", t."name", m."accounts"
    LIMIT 2000
  `

  for (const line of lines) {
    const signed = toMoney(line.amount)
    if (signed.isZero()) continue
    const side: 'out' | 'in' = signed.isNegative() ? 'out' : 'in'
    const gross = signed.abs()
    const lineDate = new Date(`${line.date}T00:00:00.000Z`).getTime()

    const matches: TransferCandidate[] = []
    for (const row of rows) {
      // Which end of this transfer the line's account is, if either.
      const rowSide =
        row.from_bank_account_id === line.bankAccountId
          ? 'out'
          : row.to_bank_account_id === line.bankAccountId
            ? 'in'
            : null
      if (rowSide !== side) continue
      // The amount has to agree exactly. A transfer for a different amount is a
      // different movement, and a matcher willing to be approximate about money
      // will eventually tie a £95 movement to a £59 one.
      if (!row.amount.equals(gross)) continue
      if (row.matched_accounts.includes(line.bankAccountId)) continue

      const days = Math.abs(row.date.getTime() - lineDate) / 86_400_000
      if (days > DATE_WINDOW_DAYS) continue

      matches.push({
        journalId: row.id,
        date: row.date.toISOString().slice(0, 10),
        narrative: row.narrative,
        reference: row.reference,
        amount: formatMoney(row.amount),
        fromBankName: row.from_bank_name,
        toBankName: row.to_bank_name,
        side,
        daysApart: Math.round(days),
      })
    }

    matches.sort((a, b) => a.daysApart - b.daysApart)
    if (matches.length > 0) found.set(line.id, matches.slice(0, 10))
  }

  return found
}

/** The same, for the one line being worked on. */
export async function findTransferCandidates(
  line: MatchableTransferLine,
): Promise<TransferCandidate[]> {
  return (await findTransferCandidatesForLines([line])).get(line.id) ?? []
}
