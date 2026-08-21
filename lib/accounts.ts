import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { BookkeepingError, NotFoundError } from './errors'
import { formatMoney, toMoney } from './money'
import { INCREASES_ON_DEBIT, type AccountKind, type AccountSubtype, type BkAccountRow, type Money } from './types'

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

  const rows = await prisma.$queryRaw<BkAccountRow[]>`
    INSERT INTO "bk_accounts"
      ("code", "name", "kind", "subtype", "category_id", "bank_account_id", "person_name", "position")
    VALUES (
      ${code}, ${input.name.trim()}, ${input.kind}, ${input.subtype ?? 'other'},
      ${input.categoryId ?? null}, ${input.bankAccountId ?? null},
      ${input.personName?.trim() || null}, ${input.position ?? 500}
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

export type AccountBalance = {
  accountId: string
  code: string
  name: string
  kind: AccountKind
  subtype: AccountSubtype
  debits: string
  credits: string
  /** Signed the way the account reads: positive means "more of what this account is". */
  balance: string
}

/**
 * What every account holds, from the journals, as at a date.
 *
 * One statement. The sign convention lives in INCREASES_ON_DEBIT and is applied
 * once, here, rather than being repeated at every call site - which is how a
 * liability ends up displayed upside down on one screen and the right way up on
 * another.
 */
export async function accountBalances(asAt?: string | null): Promise<AccountBalance[]> {
  const asAtDate = asAt ? new Date(`${asAt.slice(0, 10)}T00:00:00.000Z`) : null

  const rows = await prisma.$queryRaw<
    {
      id: string
      code: string
      name: string
      kind: AccountKind
      subtype: AccountSubtype
      debits: Prisma.Decimal
      credits: Prisma.Decimal
    }[]
  >`
    SELECT a."id", a."code", a."name", a."kind", a."subtype",
           COALESCE(sums."debits", 0)::numeric  AS debits,
           COALESCE(sums."credits", 0)::numeric AS credits
    FROM "bk_accounts" a
    -- A lateral rather than a join and a GROUP BY: with the posted-only test in
    -- a join condition, an account holding nothing but DRAFT lines matches a row
    -- that then fails every WHERE written to keep the empty accounts, and the
    -- account disappears from the list altogether rather than showing as nil.
    LEFT JOIN LATERAL (
      SELECT SUM(l."debit") AS debits, SUM(l."credit") AS credits
      FROM "bk_journal_lines" l
      JOIN "bk_journals" j ON j."id" = l."journal_id"
      WHERE l."account_id" = a."id"
        AND j."status" = 'posted'
        AND (${asAtDate}::date IS NULL OR j."date" <= ${asAtDate}::date)
    ) sums ON TRUE
    ORDER BY a."position" ASC, a."name" ASC
  `

  return rows.map((row) => {
    const debits = toMoney(row.debits)
    const credits = toMoney(row.credits)
    const balance = INCREASES_ON_DEBIT[row.kind] ? debits.minus(credits) : credits.minus(debits)
    return {
      accountId: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      subtype: row.subtype,
      debits: formatMoney(debits),
      credits: formatMoney(credits),
      balance: formatMoney(balance),
    }
  })
}

/**
 * The trial balance: every account with a movement, and the two totals that
 * should agree. They always will, because the database refuses an unbalanced
 * posted journal - so a difference here means a guard has been interfered with,
 * which is worth showing rather than hiding.
 */
export type TrialBalance = {
  asAt: string | null
  rows: { code: string; name: string; kind: AccountKind; debit: string; credit: string }[]
  totalDebits: string
  totalCredits: string
  balanced: boolean
}

export async function trialBalance(asAt?: string | null): Promise<TrialBalance> {
  const balances = await accountBalances(asAt)
  let totalDebits: Money = toMoney('0.00')
  let totalCredits: Money = toMoney('0.00')

  const rows = balances
    .filter((row) => !toMoney(row.debits).isZero() || !toMoney(row.credits).isZero())
    .map((row) => {
      // A trial balance shows each account's NET position on one side or the
      // other, not its gross turnover on both. An account that took £900 in and
      // paid £900 out belongs on neither side.
      const net = toMoney(row.debits).minus(toMoney(row.credits))
      const debit = net.isPositive() ? net : toMoney('0.00')
      const credit = net.isNegative() ? net.negated() : toMoney('0.00')
      totalDebits = totalDebits.plus(debit)
      totalCredits = totalCredits.plus(credit)
      return {
        code: row.code,
        name: row.name,
        kind: row.kind,
        debit: formatMoney(debit),
        credit: formatMoney(credit),
      }
    })
    .filter((row) => row.debit !== '0.00' || row.credit !== '0.00')

  return {
    asAt: asAt ?? null,
    rows,
    totalDebits: formatMoney(totalDebits),
    totalCredits: formatMoney(totalCredits),
    balanced: totalDebits.equals(totalCredits),
  }
}
