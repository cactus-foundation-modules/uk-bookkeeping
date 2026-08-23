import { prisma } from '@/lib/db/prisma'
import { accountShapeForCategory, createAccount, type AccountTemplate } from './accounts'
import { BookkeepingError, NotFoundError } from './errors'
import type { BkAccountRow, BkCategoryRow } from './types'

type TxClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

// Categories and the accounts they post to.
//
// Every category needs an account. lib/ledger.ts turns a cashbook line into
// debits and credits by looking up the account its category points at, and a
// category pointing at nothing puts the analysis side of the entry into
// Suspense - a trial balance that no longer agrees with itself, and books
// ledgerHealth() calls unhealthy. So a category is never created on its own:
// either it is pointed at an account somebody chose, or one is made for it in
// the same transaction. 014_category_accounts.sql catches up the ones added
// before that was true.

export async function listCategories(includeArchived = false): Promise<BkCategoryRow[]> {
  return includeArchived
    ? prisma.$queryRaw<BkCategoryRow[]>`
        SELECT * FROM "bk_categories" ORDER BY "position" ASC, "name" ASC
      `
    : prisma.$queryRaw<BkCategoryRow[]>`
        SELECT * FROM "bk_categories" WHERE "archived" = FALSE
        ORDER BY "position" ASC, "name" ASC
      `
}

export async function getCategory(id: string): Promise<BkCategoryRow | null> {
  const rows = await prisma.$queryRaw<BkCategoryRow[]>`
    SELECT * FROM "bk_categories" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

export async function getCategoryByCode(code: string): Promise<BkCategoryRow | null> {
  const rows = await prisma.$queryRaw<BkCategoryRow[]>`
    SELECT * FROM "bk_categories" WHERE "code" = ${code} LIMIT 1
  `
  return rows[0] ?? null
}

export type CategoryInput = {
  code: string
  name: string
  direction: 'income' | 'expense' | 'both'
  sa103Box?: string | null
  ct600Group?: string | null
  isTrading?: boolean
  isCapital?: boolean
  position?: number
  /**
   * Post to this account rather than to a new one. For the categories whose
   * other side is a balance sheet account somebody already has - a prepaid
   * balance held with a supplier, a second director's drawings.
   */
  accountId?: string | null
  /**
   * File it like this seeded category. The settings screen already asks the
   * question in those terms ("Phone, stationery and office costs"), so the
   * account that category posts to is the best available answer to what shape
   * of account this one needs.
   */
  likeCategoryCode?: string | null
}

function normaliseCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Point an account at a category, and no other account at that category.
 *
 * Two accounts naming one category is not an error the database refuses - the
 * column is on the account - but the projection then has to pick one of them,
 * and half the entries would report against an account nobody expected.
 * ledgerHealth() calls it a duplicate mapping; this stops it happening.
 */
async function pointAccountAtCategory(accountId: string, categoryId: string, db: TxClient): Promise<void> {
  const [account] = await db.$queryRaw<BkAccountRow[]>`
    SELECT * FROM "bk_accounts" WHERE "id" = ${accountId} LIMIT 1
  `
  if (!account) throw new NotFoundError('That account')
  if (account.archived) {
    throw new BookkeepingError(
      'invalid',
      `"${account.name}" has been archived, so nothing new can be posted to it.`,
    )
  }
  if (account.category_id && account.category_id !== categoryId) {
    const [other] = await db.$queryRaw<{ name: string }[]>`
      SELECT "name" FROM "bk_categories" WHERE "id" = ${account.category_id} LIMIT 1
    `
    throw new BookkeepingError(
      'invalid',
      other
        ? `"${account.name}" already posts for "${other.name}". An account can only stand for one category.`
        : `"${account.name}" already stands for another category.`,
    )
  }

  await db.$executeRaw`
    UPDATE "bk_accounts" SET "category_id" = NULL, "updated_at" = NOW()
    WHERE "category_id" = ${categoryId} AND "id" <> ${accountId}
  `
  await db.$executeRaw`
    UPDATE "bk_accounts" SET "category_id" = ${categoryId}, "updated_at" = NOW()
    WHERE "id" = ${accountId}
  `
}

/** The account a seeded category posts to, as a shape to copy. */
async function templateFromCategoryCode(code: string, db: TxClient): Promise<AccountTemplate | null> {
  const [row] = await db.$queryRaw<BkAccountRow[]>`
    SELECT a.* FROM "bk_accounts" a
    JOIN "bk_categories" c ON c."id" = a."category_id"
    WHERE c."code" = ${code} AND a."archived" = FALSE
    ORDER BY a."is_system" DESC, a."position" ASC, a."id" ASC
    LIMIT 1
  `
  if (!row) return null
  return {
    kind: row.kind,
    subtype: row.subtype,
    reportGroup: row.report_group,
    bsGroup: row.bs_group,
    disallowablePercent: row.disallowable_percent.toFixed(2),
    position: row.position,
  }
}

/**
 * An account code nobody is using.
 *
 * Categories and accounts have separate code spaces, so "pl-insurance" can be
 * free while a category called insurance is not, and an archived account from
 * years ago still holds its code. The suffix is the category's own id, which
 * makes the fallback stable rather than a race.
 */
async function freeAccountCode(base: string, categoryId: string, db: TxClient): Promise<string> {
  const [taken] = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_accounts" WHERE "code" = ${base} LIMIT 1
  `
  if (!taken) return base
  return `${base}-${categoryId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`
}

export async function createCategory(input: CategoryInput): Promise<BkCategoryRow> {
  const code = normaliseCode(input.code || input.name)
  if (!code) throw new BookkeepingError('invalid', 'A category needs a name.')
  if (await getCategoryByCode(code)) {
    throw new BookkeepingError('duplicate', `There is already a category with the code "${code}".`)
  }

  // One transaction, because a category without an account is the defect this
  // whole path exists to prevent. Either both rows arrive or neither does.
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<BkCategoryRow[]>`
      INSERT INTO "bk_categories"
        ("code", "name", "direction", "sa103_box", "ct600_group", "is_trading", "is_capital", "position")
      VALUES (
        ${code}, ${input.name.trim()}, ${input.direction},
        ${input.sa103Box ?? null}, ${input.ct600Group ?? null},
        ${input.isTrading ?? true}, ${input.isCapital ?? false},
        ${input.position ?? 1000}
      )
      RETURNING *
    `
    const category = rows[0]!

    if (input.accountId) {
      await pointAccountAtCategory(input.accountId, category.id, tx)
      return category
    }

    const template = input.likeCategoryCode
      ? await templateFromCategoryCode(input.likeCategoryCode, tx)
      : null
    const shape = accountShapeForCategory(
      {
        code: category.code,
        direction: category.direction,
        ct600Group: category.ct600_group,
        position: category.position,
      },
      template,
    )
    await createAccount(
      {
        code: await freeAccountCode(shape.code, category.id, tx),
        name: category.name,
        kind: shape.kind,
        subtype: shape.subtype,
        categoryId: category.id,
        reportGroup: shape.reportGroup,
        bsGroup: shape.bsGroup,
        disallowablePercent: shape.disallowablePercent,
        position: shape.position,
      },
      tx,
    )
    return category
  })
}

export type CategoryPatch = {
  /** Post to this account instead of the one it posts to now. */
  accountId?: string | null
  name?: string
  direction?: 'income' | 'expense' | 'both'
  sa103Box?: string | null
  ct600Group?: string | null
  isTrading?: boolean
  isCapital?: boolean
  position?: number
  archived?: boolean
}

export async function updateCategory(id: string, patch: CategoryPatch): Promise<BkCategoryRow> {
  const current = await getCategory(id)
  if (!current) throw new NotFoundError('That category')

  if (patch.accountId) {
    await prisma.$transaction(async (tx) => {
      await pointAccountAtCategory(patch.accountId!, id, tx)
    })
  }

  const rows = await prisma.$queryRaw<BkCategoryRow[]>`
    UPDATE "bk_categories" SET
      "name"        = ${patch.name?.trim() ?? current.name},
      "direction"   = ${patch.direction ?? current.direction},
      "sa103_box"   = ${patch.sa103Box === undefined ? current.sa103_box : patch.sa103Box},
      "ct600_group" = ${patch.ct600Group === undefined ? current.ct600_group : patch.ct600Group},
      "is_trading"  = ${patch.isTrading ?? current.is_trading},
      "is_capital"  = ${patch.isCapital ?? current.is_capital},
      "position"    = ${patch.position ?? current.position},
      "archived"    = ${patch.archived ?? current.archived},
      "updated_at"  = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  return rows[0]!
}

/**
 * Deletion, which mostly is not deletion.
 *
 * A seeded category, or one any transaction has ever pointed at, is archived
 * instead. HMRC expects records kept six years, and a 2019 return can only
 * explain itself in 2026 if the categories its lines point at are still there.
 * Only a category nobody ever used, and that we did not ship, actually goes.
 */
export async function deleteOrArchiveCategory(id: string): Promise<'deleted' | 'archived'> {
  const category = await getCategory(id)
  if (!category) throw new NotFoundError('That category')

  const [used] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_transaction_lines" WHERE "category_id" = ${id}
  `
  if (category.is_system || (used && used.count > 0n)) {
    await updateCategory(id, { archived: true })
    return 'archived'
  }

  await prisma.$executeRaw`DELETE FROM "bk_categories" WHERE "id" = ${id}`
  return 'deleted'
}
