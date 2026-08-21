import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMoney, toMoney } from './money'
import type { StatementLine } from './statement'
import type { BankTransactionStatus, BkBankTransactionRow, Money } from './types'

// The bank's own version of events.
//
// These rows are never edited to make them agree with the books. That is the
// whole point of keeping them: if the statement and the books disagree, the
// interesting question is which one is wrong, and an import that quietly
// adjusted the bank's figures could never raise it.

type TxClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/**
 * A statement line's identity, for spotting one we already have.
 *
 * Date, amount and a heavily normalised form of the details. Normalised because
 * the same payment re-exported next month comes back with its whitespace
 * rearranged, its case changed, and sometimes with a card number masked
 * differently - and none of those make it a different payment.
 *
 * Not included: the running balance (it moves if an earlier line is amended) and
 * the transaction type (banks rename these). Scoped to one account by the unique
 * index rather than by being in the hash, so the same payment appearing on two
 * accounts stays two lines.
 */
export function fingerprintStatementLine(line: {
  date: string
  amount: string
  details: string
}): string {
  const normalised = line.details
    .toLowerCase()
    .replace(/[*x•]{2,}/g, '*')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return createHash('sha256')
    .update(`${line.date}|${formatMoney(line.amount)}|${normalised}`)
    .digest('hex')
    .slice(0, 32)
}

export type BankTransactionInsert = StatementLine & { fingerprint: string }

export function prepareStatementLines(lines: StatementLine[]): BankTransactionInsert[] {
  // A statement genuinely can print the same payment twice on the same day for
  // the same amount with the same description - two identical £1.20 charges from
  // one host, which is exactly what the statement this was written against does.
  // They are different payments, so the second one's fingerprint is salted with
  // its position among its twins rather than being folded into the first.
  const seen = new Map<string, number>()
  return lines.map((line) => {
    const base = fingerprintStatementLine(line)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return {
      ...line,
      fingerprint: count === 0 ? base : `${base}-${count}`,
    }
  })
}

/** Which of these fingerprints this account already holds. */
export async function findExistingFingerprints(
  bankAccountId: string,
  fingerprints: string[],
): Promise<Map<string, string>> {
  if (fingerprints.length === 0) return new Map()
  const rows = await prisma.$queryRaw<{ id: string; fingerprint: string }[]>`
    SELECT "id", "fingerprint" FROM "bk_bank_transactions"
    WHERE "bank_account_id" = ${bankAccountId}
      AND "fingerprint" = ANY(${fingerprints}::text[])
  `
  return new Map(rows.map((row) => [row.fingerprint, row.id]))
}

export async function insertBankTransactions(
  tx: TxClient,
  bankAccountId: string,
  statementId: string | null,
  lines: BankTransactionInsert[],
): Promise<string[]> {
  if (lines.length === 0) return []

  // One statement for the batch. PgBouncer wraps every statement in its own
  // BEGIN/DEALLOCATE ALL/COMMIT, so a loop here costs four network round trips
  // per line of a statement that might run to hundreds.
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "bk_bank_transactions" (
      "bank_account_id", "statement_id", "date", "details", "counterparty",
      "reference", "transaction_type", "amount", "statement_balance", "fingerprint"
    )
    SELECT
      ${bankAccountId}, ${statementId}, d."date"::date, d."details", d."counterparty",
      NULLIF(d."reference", ''), NULLIF(d."transaction_type", ''),
      d."amount"::numeric, NULLIF(d."balance", '')::numeric, d."fingerprint"
    FROM UNNEST(
      ${lines.map((l) => l.date)}::text[],
      ${lines.map((l) => l.details)}::text[],
      ${lines.map((l) => l.counterparty)}::text[],
      ${lines.map((l) => l.reference ?? '')}::text[],
      ${lines.map((l) => l.transactionType ?? '')}::text[],
      ${lines.map((l) => formatMoney(l.amount))}::text[],
      ${lines.map((l) => (l.balance ? formatMoney(l.balance) : ''))}::text[],
      ${lines.map((l) => l.fingerprint)}::text[]
    ) AS d("date", "details", "counterparty", "reference", "transaction_type", "amount", "balance", "fingerprint")
    -- Belt and braces against a second import racing the first: the unique index
    -- is what actually guarantees it, and this is what keeps that from being an
    -- error the reviewer has to read.
    ON CONFLICT ("bank_account_id", "fingerprint") DO NOTHING
    RETURNING "id"
  `
  return rows.map((row) => row.id)
}

export type BankTransactionFilter = {
  bankAccountId?: string | null
  status?: BankTransactionStatus | null
  from?: string | null
  to?: string | null
  search?: string | null
  limit?: number
  offset?: number
}

export type BankTransactionListRow = BkBankTransactionRow & {
  matched_total: Money
  match_count: number
}

export type BankTransactionList = {
  rows: BankTransactionListRow[]
  total: number
  unreconciledCount: number
  unreconciledTotal: string
}

export async function listBankTransactions(
  filter: BankTransactionFilter,
): Promise<BankTransactionList> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  const from = filter.from ? new Date(`${filter.from.slice(0, 10)}T00:00:00.000Z`) : null
  const to = filter.to ? new Date(`${filter.to.slice(0, 10)}T00:00:00.000Z`) : null
  const search = filter.search?.trim() ? `%${filter.search.trim().toLowerCase()}%` : null

  const where = Prisma.sql`
    WHERE (${filter.bankAccountId ?? null}::text IS NULL OR b."bank_account_id" = ${filter.bankAccountId ?? null})
      AND (${filter.status ?? null}::text IS NULL OR b."status" = ${filter.status ?? null})
      AND (${from}::date IS NULL OR b."date" >= ${from}::date)
      AND (${to}::date IS NULL OR b."date" <= ${to}::date)
      AND (${search}::text IS NULL
           OR lower(b."details") LIKE ${search}
           OR lower(b."counterparty") LIKE ${search})
  `

  const rows = await prisma.$queryRaw<BankTransactionListRow[]>`
    SELECT b.*,
      COALESCE(r."matched_total", 0)::numeric AS matched_total,
      COALESCE(r."match_count", 0)::int      AS match_count
    FROM "bk_bank_transactions" b
    LEFT JOIN LATERAL (
      SELECT SUM("amount") AS matched_total, COUNT(*) AS match_count
      FROM "bk_reconciliations" WHERE "bank_transaction_id" = b."id"
    ) r ON TRUE
    ${where}
    ORDER BY b."date" DESC, b."created_at" DESC
    LIMIT ${limit} OFFSET ${offset}
  `

  const [counted] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_bank_transactions" b ${where}
  `

  const [outstanding] = await prisma.$queryRaw<{ count: bigint; total: Prisma.Decimal }[]>`
    SELECT COUNT(*)::bigint AS count, COALESCE(SUM(b."amount"), 0)::numeric AS total
    FROM "bk_bank_transactions" b
    ${where}
    AND b."status" = 'unreconciled'
  `

  return {
    rows,
    total: Number(counted?.count ?? 0n),
    unreconciledCount: Number(outstanding?.count ?? 0n),
    unreconciledTotal: formatMoney(outstanding?.total ?? null),
  }
}

export async function getBankTransaction(id: string): Promise<BkBankTransactionRow | null> {
  const rows = await prisma.$queryRaw<BkBankTransactionRow[]>`
    SELECT * FROM "bk_bank_transactions" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Set a statement line aside without explaining it.
 *
 * For the ones that genuinely need no entry: a transfer between two accounts the
 * business owns, where the other side is already recorded, or a line the bank
 * itself printed twice and then corrected. It takes a reason, because "why is
 * this one ignored" is the question somebody will ask in a year.
 */
export async function setBankTransactionIgnored(
  id: string,
  ignored: boolean,
  reason: string | null,
): Promise<BkBankTransactionRow> {
  const rows = await prisma.$queryRaw<BkBankTransactionRow[]>`
    UPDATE "bk_bank_transactions"
    SET "status" = ${ignored ? 'ignored' : 'unreconciled'},
        "ignored_reason" = ${ignored ? (reason?.trim() || null) : null},
        "updated_at" = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  return rows[0]!
}

/**
 * How the account looks according to the bank, and according to the books.
 *
 * The two figures answer different questions and are meant to be read together:
 * the statement balance is what the bank last said, and the difference is what
 * has not been explained yet.
 */
export type BankAccountPosition = {
  bankAccountId: string
  openingBalance: string
  /** Opening balance plus every statement line we hold. */
  statementBalance: string
  lastStatementDate: string | null
  unreconciledCount: number
  unreconciledTotal: string
}

export async function getBankAccountPosition(bankAccountId: string): Promise<BankAccountPosition> {
  const [row] = await prisma.$queryRaw<
    {
      opening_balance: Prisma.Decimal
      movement: Prisma.Decimal
      last_date: Date | null
      unreconciled_count: bigint
      unreconciled_total: Prisma.Decimal
    }[]
  >`
    SELECT
      a."opening_balance",
      COALESCE((SELECT SUM("amount") FROM "bk_bank_transactions"
                WHERE "bank_account_id" = a."id"), 0)::numeric AS movement,
      (SELECT MAX("date") FROM "bk_bank_transactions"
       WHERE "bank_account_id" = a."id") AS last_date,
      (SELECT COUNT(*) FROM "bk_bank_transactions"
       WHERE "bank_account_id" = a."id" AND "status" = 'unreconciled')::bigint AS unreconciled_count,
      COALESCE((SELECT SUM("amount") FROM "bk_bank_transactions"
                WHERE "bank_account_id" = a."id" AND "status" = 'unreconciled'), 0)::numeric AS unreconciled_total
    FROM "bk_bank_accounts" a
    WHERE a."id" = ${bankAccountId}
  `

  return {
    bankAccountId,
    openingBalance: formatMoney(row?.opening_balance ?? null),
    statementBalance: formatMoney(toMoney(row?.opening_balance ?? null).plus(toMoney(row?.movement ?? null))),
    lastStatementDate: row?.last_date ? row.last_date.toISOString().slice(0, 10) : null,
    unreconciledCount: Number(row?.unreconciled_count ?? 0n),
    unreconciledTotal: formatMoney(row?.unreconciled_total ?? null),
  }
}
