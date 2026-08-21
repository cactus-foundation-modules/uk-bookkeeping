import { prisma } from '@/lib/db/prisma'
import { BookkeepingError, NotFoundError } from './errors'
import { formatMoney, isMoneyString } from './money'
import type { BankAccountKind, BkBankAccountRow } from './types'

// The accounts the money actually sits in. A statement is imported against one,
// and every statement line belongs to one, which is what stops two accounts'
// worth of payments being reconciled against each other.

export const BANK_ACCOUNT_KIND_LABELS: Record<BankAccountKind, string> = {
  bank: 'Bank account',
  card: 'Credit or charge card',
  cash: 'Cash',
}

export async function listBankAccounts(includeArchived = false): Promise<BkBankAccountRow[]> {
  return includeArchived
    ? prisma.$queryRaw<BkBankAccountRow[]>`
        SELECT * FROM "bk_bank_accounts" ORDER BY "position" ASC, "name" ASC
      `
    : prisma.$queryRaw<BkBankAccountRow[]>`
        SELECT * FROM "bk_bank_accounts" WHERE "archived" = FALSE
        ORDER BY "position" ASC, "name" ASC
      `
}

export async function getBankAccount(id: string): Promise<BkBankAccountRow | null> {
  const rows = await prisma.$queryRaw<BkBankAccountRow[]>`
    SELECT * FROM "bk_bank_accounts" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

export async function requireBankAccount(id: string): Promise<BkBankAccountRow> {
  const account = await getBankAccount(id)
  if (!account) throw new NotFoundError('That account')
  return account
}

export type BankAccountInput = {
  name: string
  kind?: BankAccountKind
  bankName?: string | null
  accountLast4?: string | null
  sortCode?: string | null
  openingBalance?: string | null
  openingDate?: string | null
  position?: number
}

/** Only ever the last four digits, whatever the caller sent. */
function lastFour(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? digits.slice(-4) : null
}

function tidySortCode(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '')
  if (digits.length !== 6) return null
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`
}

function validate(input: BankAccountInput): void {
  if (!input.name?.trim()) {
    throw new BookkeepingError('invalid', 'The account needs a name, so you can tell it from the others.')
  }
  if (input.openingBalance && !isMoneyString(input.openingBalance)) {
    throw new BookkeepingError('invalid', 'The opening balance is not an amount we can read.')
  }
}

export async function createBankAccount(input: BankAccountInput): Promise<BkBankAccountRow> {
  validate(input)
  const rows = await prisma.$queryRaw<BkBankAccountRow[]>`
    INSERT INTO "bk_bank_accounts"
      ("name", "kind", "bank_name", "account_last4", "sort_code", "opening_balance", "opening_date", "position")
    VALUES (
      ${input.name.trim()}, ${input.kind ?? 'bank'}, ${input.bankName?.trim() || null},
      ${lastFour(input.accountLast4)}, ${tidySortCode(input.sortCode)},
      ${formatMoney(input.openingBalance ?? '0.00')}::numeric,
      ${input.openingDate ? new Date(`${input.openingDate.slice(0, 10)}T00:00:00.000Z`) : null}::date,
      ${input.position ?? 100}
    )
    RETURNING *
  `
  return rows[0]!
}

export type BankAccountPatch = Partial<BankAccountInput> & { archived?: boolean }

export async function updateBankAccount(id: string, patch: BankAccountPatch): Promise<BkBankAccountRow> {
  const current = await requireBankAccount(id)
  if (patch.name !== undefined || patch.openingBalance !== undefined) {
    validate({ ...current, name: patch.name ?? current.name, openingBalance: patch.openingBalance })
  }

  const rows = await prisma.$queryRaw<BkBankAccountRow[]>`
    UPDATE "bk_bank_accounts" SET
      "name"            = ${patch.name?.trim() ?? current.name},
      "kind"            = ${patch.kind ?? current.kind},
      "bank_name"       = ${patch.bankName === undefined ? current.bank_name : (patch.bankName?.trim() || null)},
      "account_last4"   = ${patch.accountLast4 === undefined ? current.account_last4 : lastFour(patch.accountLast4)},
      "sort_code"       = ${patch.sortCode === undefined ? current.sort_code : tidySortCode(patch.sortCode)},
      "opening_balance" = ${patch.openingBalance === undefined ? formatMoney(current.opening_balance) : formatMoney(patch.openingBalance)}::numeric,
      "opening_date"    = ${
        patch.openingDate === undefined
          ? current.opening_date
          : patch.openingDate
            ? new Date(`${patch.openingDate.slice(0, 10)}T00:00:00.000Z`)
            : null
      }::date,
      "archived"        = ${patch.archived ?? current.archived},
      "position"        = ${patch.position ?? current.position},
      "updated_at"      = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  return rows[0]!
}

/**
 * Deletion, which mostly is not deletion.
 *
 * An account any statement was ever imported against is archived rather than
 * removed. The statement lines are the evidence behind reconciled entries, and
 * deleting the account they hang off would take the reconciliation with them.
 */
export async function deleteOrArchiveBankAccount(id: string): Promise<'deleted' | 'archived'> {
  await requireBankAccount(id)
  const [used] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_bank_transactions" WHERE "bank_account_id" = ${id}
  `
  if (used && used.count > 0n) {
    await updateBankAccount(id, { archived: true })
    return 'archived'
  }
  await prisma.$executeRaw`DELETE FROM "bk_bank_accounts" WHERE "id" = ${id}`
  return 'deleted'
}

/**
 * The account a statement most likely belongs to, from what it printed about
 * itself. Matching on the last four digits alone is enough here, and it is
 * offered as a suggestion rather than acted on.
 */
export async function matchBankAccount(
  accountLast4: string | null,
  sortCode: string | null,
): Promise<BkBankAccountRow | null> {
  if (!accountLast4 && !sortCode) return null
  const rows = await prisma.$queryRaw<BkBankAccountRow[]>`
    SELECT * FROM "bk_bank_accounts"
    WHERE "archived" = FALSE
      AND (
        (${accountLast4}::text IS NOT NULL AND "account_last4" = ${accountLast4})
        OR (${sortCode}::text IS NOT NULL AND "sort_code" = ${sortCode})
      )
    ORDER BY
      CASE WHEN "account_last4" = ${accountLast4} AND "sort_code" = ${sortCode} THEN 0 ELSE 1 END,
      "position" ASC
    LIMIT 1
  `
  return rows[0] ?? null
}
