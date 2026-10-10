import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { nominalLedger, type NominalEntry } from './ledger'
import { formatMoney, formatPounds, isMoneyString, toMoney } from './money'
import { requireBankAccount } from './bank-accounts'

// Checking a cash account against a balance somebody read off a screen.
//
// For a prepaid balance with no statement to import. The books' figure is the
// ledger's, as at the date given - never the statement balance, which for an
// account like this is simply absent. The difference is stated minus books, so
// a positive number means "the supplier says there is more than we have".

export type BalanceCheck = {
  id: string
  bankAccountId: string
  asAt: string
  booksBalance: string
  statedBalance: string
  difference: string
  note: string | null
  checkedAt: string
}

export type BalancePosition = {
  bankAccountId: string
  asAt: string
  booksBalance: string
  /** The latest movements up to that date, newest last, so a gap can be spotted. */
  recent: NominalEntry[]
  latest: BalanceCheck | null
}

type CheckRow = {
  id: string
  bank_account_id: string
  as_at: Date
  books_balance: Prisma.Decimal
  stated_balance: Prisma.Decimal
  difference: Prisma.Decimal
  note: string | null
  created_at: Date
}

function toCheck(row: CheckRow): BalanceCheck {
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    asAt: row.as_at.toISOString().slice(0, 10),
    booksBalance: formatMoney(row.books_balance),
    statedBalance: formatMoney(row.stated_balance),
    difference: formatMoney(row.difference),
    note: row.note,
    checkedAt: row.created_at.toISOString(),
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function cleanDate(value: string | null | undefined): string {
  const date = (value ?? '').slice(0, 10)
  if (!date) return today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new BookkeepingError('invalid', 'That date is not one we can read.')
  }
  return date
}

/** Only a cash account is checked this way; a bank or card has a statement. */
async function requireCashAccount(bankAccountId: string) {
  const account = await requireBankAccount(bankAccountId)
  if (account.kind !== 'cash') {
    throw new BookkeepingError(
      'invalid',
      `${account.name} is a bank or card account, so it is checked against its statement rather than a typed balance.`,
    )
  }
  return account
}

async function latestCheck(bankAccountId: string): Promise<BalanceCheck | null> {
  const [row] = await prisma.$queryRaw<CheckRow[]>`
    SELECT * FROM "bk_balance_checks"
    WHERE "bank_account_id" = ${bankAccountId}
    ORDER BY "as_at" DESC, "created_at" DESC
    LIMIT 1
  `
  return row ? toCheck(row) : null
}

async function booksPosition(bankAccountId: string, asAt: string) {
  const [ledgerAccount] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_accounts"
    WHERE "bank_account_id" = ${bankAccountId}
    ORDER BY "is_system" DESC, "created_at" ASC
    LIMIT 1
  `
  if (!ledgerAccount) {
    throw new BookkeepingError('invalid', 'That account has no ledger account behind it yet, so there is no balance to compare.')
  }
  const ledger = await nominalLedger(ledgerAccount.id, { to: asAt })
  if (!ledger) throw new NotFoundError('That account')
  return ledger
}

export async function getBalancePosition(
  bankAccountId: string,
  asAt?: string | null,
): Promise<BalancePosition> {
  await requireCashAccount(bankAccountId)
  const date = cleanDate(asAt)
  const ledger = await booksPosition(bankAccountId, date)
  return {
    bankAccountId,
    asAt: date,
    booksBalance: ledger.closing,
    recent: ledger.entries.slice(-8),
    latest: await latestCheck(bankAccountId),
  }
}

export async function saveBalanceCheck(
  input: { bankAccountId: string; asAt?: string | null; statedBalance: string; note?: string | null },
  user: SessionUser | null,
): Promise<BalanceCheck> {
  const account = await requireCashAccount(input.bankAccountId)
  if (!isMoneyString(input.statedBalance)) {
    throw new BookkeepingError('invalid', 'The balance is not an amount we can read. Type it as a number, like 12.34.')
  }
  const date = cleanDate(input.asAt)
  // Worked out here, on save, and never taken from the browser: the figure the
  // check records has to be the one the ledger actually gave.
  const books = toMoney((await booksPosition(input.bankAccountId, date)).closing)
  const stated = toMoney(input.statedBalance)
  const difference = stated.minus(books)
  const note = input.note?.trim() || null

  const [row] = await prisma.$queryRaw<CheckRow[]>`
    INSERT INTO "bk_balance_checks"
      ("bank_account_id", "as_at", "books_balance", "stated_balance", "difference", "note", "checked_by_user_id")
    VALUES (
      ${input.bankAccountId}, ${new Date(`${date}T00:00:00.000Z`)}::date,
      ${formatMoney(books)}::numeric, ${formatMoney(stated)}::numeric, ${formatMoney(difference)}::numeric,
      ${note}, ${user?.id ?? null}
    )
    RETURNING *
  `
  const saved = toCheck(row!)

  await appendAudit({
    action: 'balance-check.saved',
    entityType: 'bank_account',
    entityId: input.bankAccountId,
    summary: difference.isZero()
      ? `${account.name} agreed at ${formatPounds(stated)} on ${date}`
      : `${account.name} checked on ${date}: books ${formatPounds(books)}, stated ${formatPounds(stated)}, out by ${formatPounds(difference)}`,
    detail: { after: saved },
    user,
  })

  return saved
}
