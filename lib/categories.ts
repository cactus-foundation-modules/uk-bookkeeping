import { prisma } from '@/lib/db/prisma'
import { BookkeepingError, NotFoundError } from './errors'
import type { BkCategoryRow } from './types'

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
}

function normaliseCode(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function createCategory(input: CategoryInput): Promise<BkCategoryRow> {
  const code = normaliseCode(input.code || input.name)
  if (!code) throw new BookkeepingError('invalid', 'A category needs a name.')
  if (await getCategoryByCode(code)) {
    throw new BookkeepingError('duplicate', `There is already a category with the code "${code}".`)
  }

  const rows = await prisma.$queryRaw<BkCategoryRow[]>`
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
  return rows[0]!
}

export type CategoryPatch = {
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
