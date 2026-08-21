import { prisma } from '@/lib/db/prisma'
import { BookkeepingError, NotFoundError } from './errors'
import type { AccountKind, AccountSubtype, BkAccountRow } from './types'

// The ledger accounts a journal can reach.
//
// There is one list, not two. The profit and loss accounts mirror the categories
// the cashbook already uses, so a depreciation journal and a receipt coded to
// "Depreciation" land in the same place on a report; the balance sheet accounts
// are the ones a cashbook has no way to express at all, which is what journals
// were added for.

export async function listAccounts(includeArchived = false): Promise<BkAccountRow[]> {
  return includeArchived
    ? prisma.$queryRaw<BkAccountRow[]>`
        SELECT * FROM "bk_accounts" ORDER BY "position" ASC, "name" ASC
      `
    : prisma.$queryRaw<BkAccountRow[]>`
        SELECT * FROM "bk_accounts" WHERE "archived" = FALSE
        ORDER BY "position" ASC, "name" ASC
      `
}

export async function getAccount(id: string): Promise<BkAccountRow | null> {
  const rows = await prisma.$queryRaw<BkAccountRow[]>`
    SELECT * FROM "bk_accounts" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

export async function getAccountByCode(code: string): Promise<BkAccountRow | null> {
  const rows = await prisma.$queryRaw<BkAccountRow[]>`
    SELECT * FROM "bk_accounts" WHERE "code" = ${code} LIMIT 1
  `
  return rows[0] ?? null
}

export async function requireAccount(id: string): Promise<BkAccountRow> {
  const account = await getAccount(id)
  if (!account) throw new NotFoundError('That account')
  return account
}

/** Every director's loan account on the books, in order. */
export async function listDirectorLoanAccounts(): Promise<BkAccountRow[]> {
  return prisma.$queryRaw<BkAccountRow[]>`
    SELECT * FROM "bk_accounts"
    WHERE "subtype" = 'director_loan' AND "archived" = FALSE
    ORDER BY "position" ASC, "name" ASC
  `
}

export type AccountInput = {
  code?: string
  name: string
  kind: AccountKind
  subtype?: AccountSubtype
  categoryId?: string | null
  bankAccountId?: string | null
  personName?: string | null
  position?: number
  /** Which line of the profit and loss account this prints on. */
  reportGroup?: string | null
  /** Which line of the balance sheet this prints on. */
  bsGroup?: string | null
  /** How much of what lands here the taxman will not allow, 0 to 100. */
  disallowablePercent?: string
}

/**
 * Where an account of this sort belongs on a balance sheet, when nobody says.
 *
 * Mirrors the backfill in 009_ledger_mapping.sql, and deliberately never
 * returns null for a balance sheet account: one that prints nowhere is one the
 * balance sheet is silently out by.
 */
export function defaultBsGroup(kind: AccountKind, subtype?: AccountSubtype): string | null {
  if (kind === 'income' || kind === 'expense') return null
  switch (subtype) {
    case 'fixed_assets':
    case 'depreciation':
      return 'fixed_assets'
    case 'intangibles':
      return 'intangible_assets'
    case 'stock':
      return 'current_assets_stock'
    case 'debtors':
      return 'current_assets_debtors'
    case 'bank':
    case 'cash':
      return 'current_assets_cash'
    case 'vat_deferred':
      return 'creditors_short'
    case 'provisions':
      return 'provisions'
    case 'share_capital':
      return 'share_capital'
    case 'reserves':
      return 'reserves'
    default:
      return kind === 'asset'
        ? 'current_assets_debtors'
        : kind === 'liability'
          ? 'creditors_short'
          : 'reserves'
  }
}

function normaliseCode(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function createAccount(input: AccountInput): Promise<BkAccountRow> {
  const code = normaliseCode(input.code || input.name)
  if (!code) throw new BookkeepingError('invalid', 'An account needs a name.')
  if (await getAccountByCode(code)) {
    throw new BookkeepingError('duplicate', `There is already an account with the code "${code}".`)
  }
  if (input.subtype === 'director_loan' && !input.personName?.trim()) {
    throw new BookkeepingError('invalid', 'A director’s loan account needs to say whose it is.')
  }

  // Defaulted rather than demanded. An owner adding "Subscriptions" should not
  // have to answer a question about statutory formats to get on with their day,
  // and the fallback puts it somewhere sensible and visible.
  const reportGroup =
    input.reportGroup === undefined
      ? input.kind === 'income'
        ? 'other-income'
        : input.kind === 'expense'
          ? 'admin-expenses'
          : null
      : input.reportGroup
  const bsGroup = input.bsGroup === undefined ? defaultBsGroup(input.kind, input.subtype) : input.bsGroup

  const rows = await prisma.$queryRaw<BkAccountRow[]>`
    INSERT INTO "bk_accounts"
      ("code", "name", "kind", "subtype", "category_id", "bank_account_id", "person_name",
       "position", "report_group", "bs_group", "disallowable_percent")
    VALUES (
      ${code}, ${input.name.trim()}, ${input.kind}, ${input.subtype ?? 'other'},
      ${input.categoryId ?? null}, ${input.bankAccountId ?? null},
      ${input.personName?.trim() || null}, ${input.position ?? 500},
      ${reportGroup}, ${bsGroup}, ${input.disallowablePercent ?? '0'}::numeric
    )
    RETURNING *
  `
  return rows[0]!
}

export type AccountPatch = Partial<AccountInput> & { archived?: boolean }

export async function updateAccount(id: string, patch: AccountPatch): Promise<BkAccountRow> {
  const current = await requireAccount(id)
  // The kind decides which side of the account an increase falls on, and every
  // balance already worked out from it was worked out on the old answer.
  // Changing it on an account that has been used would silently restate history.
  if (patch.kind && patch.kind !== current.kind) {
    const [used] = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "bk_journal_lines" WHERE "account_id" = ${id}
    `
    if (used && used.count > 0n) {
      throw new BookkeepingError(
        'invalid',
        'That account has already been used in a journal, so what sort of account it is cannot be changed. Archive it and make a new one.',
      )
    }
  }

  const rows = await prisma.$queryRaw<BkAccountRow[]>`
    UPDATE "bk_accounts" SET
      "name"        = ${patch.name?.trim() ?? current.name},
      "kind"        = ${patch.kind ?? current.kind},
      "subtype"     = ${patch.subtype ?? current.subtype},
      "category_id" = ${patch.categoryId === undefined ? current.category_id : patch.categoryId},
      "bank_account_id" = ${patch.bankAccountId === undefined ? current.bank_account_id : patch.bankAccountId},
      "person_name" = ${patch.personName === undefined ? current.person_name : (patch.personName?.trim() || null)},
      "position"    = ${patch.position ?? current.position},
      "report_group" = ${patch.reportGroup === undefined ? current.report_group : patch.reportGroup},
      "bs_group"     = ${patch.bsGroup === undefined ? current.bs_group : patch.bsGroup},
      "disallowable_percent" = ${
        patch.disallowablePercent ?? current.disallowable_percent.toFixed(2)
      }::numeric,
      "archived"    = ${patch.archived ?? current.archived},
      "updated_at"  = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  return rows[0]!
}

/**
 * Deletion, which mostly is not deletion - the same rule the categories follow,
 * and for the same reason: a journal from 2019 can only explain itself in 2026
 * if the accounts its lines point at are still there.
 */
export async function deleteOrArchiveAccount(id: string): Promise<'deleted' | 'archived'> {
  const account = await requireAccount(id)
  const [used] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_journal_lines" WHERE "account_id" = ${id}
  `
  if (account.is_system || (used && used.count > 0n)) {
    await updateAccount(id, { archived: true })
    return 'archived'
  }
  await prisma.$executeRaw`DELETE FROM "bk_accounts" WHERE "id" = ${id}`
  return 'deleted'
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------
// These used to be worked out here, from the journals alone, which meant the
// trial balance showed the year-end adjustments and nothing else. They now come
// from lib/ledger.ts, which projects the cashbook into postings and unions it
// with the journals, so there is one set of books and one answer. Re-exported
// from here because that is where every caller already looks for them.
export {
  accountBalances,
  trialBalance,
  nominalLedger,
  type AccountBalance,
  type TrialBalance,
  type NominalEntry,
  type NominalLedger,
} from './ledger'
