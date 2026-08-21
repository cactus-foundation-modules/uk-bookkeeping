import { Prisma } from '@prisma/client'
import type { SessionUser } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { getAccountByCode } from './accounts'
import { assertNotInClosedYear } from './accounting-periods'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { createJournal, deleteJournal, type JournalLineInput } from './journals'
import { formatMoney, formatPounds, toMoney } from './money'
import type {
  BkDepreciationChargeRow,
  BkFixedAssetRow,
  CapitalAllowancePool,
  DepreciationMethod,
  Money,
} from './types'

// The fixed asset register.
//
// It does two jobs that look like one and are not:
//
//   THE ACCOUNTS want the cost of a van spread over the years it is useful for.
//   That is depreciation. Straight line or reducing balance, the owner's
//   choice, and it is a journal like any other so it shows up on the profit and
//   loss account, the trial balance and the balance sheet without anything
//   special being written for it.
//
//   THE TAX ignores depreciation completely - adds it back in full - and gives
//   capital allowances instead, on HMRC's rules. That is not the module being
//   pedantic: it is the single biggest reason taxable profit is not accounting
//   profit, and a computation that leaves it out is wrong by the cost of every
//   asset the business has ever bought.
//
// One row answers both, because it is one asset. Keeping them in one place is
// what stops the two drifting apart, which is the classic failure of a
// spreadsheet kept alongside a bookkeeping package.

const iso = (date: Date): string => date.toISOString().slice(0, 10)
const DAY = 86_400_000

function parseDate(value: string, field: string): Date {
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new BookkeepingError('invalid', `${field} is not a date we can read.`)
  }
  return parsed
}

/** Days in a range, both ends included. The unit everything here pro-rates by. */
export function daysInclusive(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY) + 1
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type FixedAssetWithState = BkFixedAssetRow & {
  /** What has been charged against it so far, from bk_depreciation_charges. */
  accumulated_depreciation: Money
  /** Cost less accumulated depreciation. What the balance sheet says it is worth. */
  net_book_value: Money
  asset_account_name: string
  expense_account_name: string
}

const ASSET_SELECT = Prisma.sql`
  SELECT f.*,
         COALESCE(charged.total, 0)::numeric AS accumulated_depreciation,
         (f."cost" - COALESCE(charged.total, 0))::numeric AS net_book_value,
         aa."name" AS asset_account_name,
         ea."name" AS expense_account_name
  FROM "bk_fixed_assets" f
  LEFT JOIN LATERAL (
    SELECT SUM(c."amount") AS total
    FROM "bk_depreciation_charges" c WHERE c."asset_id" = f."id"
  ) charged ON TRUE
  LEFT JOIN "bk_accounts" aa ON aa."id" = f."asset_account_id"
  LEFT JOIN "bk_accounts" ea ON ea."id" = f."expense_account_id"
`

export async function listFixedAssets(
  options: { includeDisposed?: boolean; includeArchived?: boolean } = {},
): Promise<FixedAssetWithState[]> {
  return prisma.$queryRaw<FixedAssetWithState[]>(Prisma.sql`
    ${ASSET_SELECT}
    WHERE (${options.includeArchived ?? false} OR f."archived" = FALSE)
      AND (${options.includeDisposed ?? true} OR f."disposed_date" IS NULL)
    ORDER BY f."acquired_date" DESC, f."description" ASC
  `)
}

export async function getFixedAsset(id: string): Promise<FixedAssetWithState | null> {
  const rows = await prisma.$queryRaw<FixedAssetWithState[]>(Prisma.sql`
    ${ASSET_SELECT} WHERE f."id" = ${id} LIMIT 1
  `)
  return rows[0] ?? null
}

export async function requireFixedAsset(id: string): Promise<FixedAssetWithState> {
  const asset = await getFixedAsset(id)
  if (!asset) throw new NotFoundError('That asset')
  return asset
}

export async function listChargesFor(assetId: string): Promise<BkDepreciationChargeRow[]> {
  return prisma.$queryRaw<BkDepreciationChargeRow[]>`
    SELECT * FROM "bk_depreciation_charges" WHERE "asset_id" = ${assetId}
    ORDER BY "period_end" ASC
  `
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

export type FixedAssetInput = {
  description: string
  reference?: string | null
  acquiredDate: string
  cost: string
  transactionId?: string | null
  assetAccountId?: string | null
  depreciationAccountId?: string | null
  expenseAccountId?: string | null
  depreciationMethod?: DepreciationMethod
  depreciationRate?: string
  residualValue?: string
  caPool?: CapitalAllowancePool
  notes?: string | null
}

/**
 * The three accounts an asset posts to, defaulted from the seeded chart.
 *
 * Asked for rather than demanded: a business with one equipment account and one
 * depreciation account - which is most of them - should never see these fields,
 * and one that has split its fixed assets into buildings and vehicles can set
 * them per asset.
 */
async function resolveAccounts(input: FixedAssetInput): Promise<{
  assetAccountId: string
  depreciationAccountId: string
  expenseAccountId: string
}> {
  const fallback = async (given: string | null | undefined, code: string, what: string) => {
    if (given) return given
    const account = await getAccountByCode(code)
    if (!account) {
      throw new BookkeepingError(
        'invalid',
        `There is no ${what} account on the books to post this to. Redeploy the site so the accounts are put back, or choose one yourself.`,
      )
    }
    return account.id
  }
  return {
    assetAccountId: await fallback(input.assetAccountId, 'fixed-assets', 'fixed assets'),
    depreciationAccountId: await fallback(
      input.depreciationAccountId,
      'accumulated-depreciation',
      'depreciation to date',
    ),
    expenseAccountId: await fallback(input.expenseAccountId, 'pl-depreciation', 'depreciation'),
  }
}

function checkRate(method: DepreciationMethod, rate: string | undefined): string {
  const value = toMoney(rate ?? '0')
  if (method !== 'none' && (value.isZero() || value.isNegative())) {
    throw new BookkeepingError(
      'invalid',
      'An asset that is being depreciated needs a rate. 25% a year over four years is the usual sort of thing for equipment.',
    )
  }
  if (value.greaterThan(100)) {
    throw new BookkeepingError('invalid', 'A depreciation rate cannot be more than 100% a year.')
  }
  return formatMoney(value)
}

export async function createFixedAsset(
  input: FixedAssetInput,
  user: SessionUser | null,
): Promise<FixedAssetWithState> {
  if (!input.description?.trim()) {
    throw new BookkeepingError('invalid', 'An asset needs describing, or nobody will know what it is.')
  }
  const acquired = parseDate(input.acquiredDate, 'The date it was bought')
  const cost = toMoney(input.cost)
  if (cost.isNegative()) {
    throw new BookkeepingError('invalid', 'An asset cannot cost less than nothing.')
  }
  const method = input.depreciationMethod ?? 'straight_line'
  const rate = checkRate(method, input.depreciationRate)
  const residual = toMoney(input.residualValue ?? '0')
  if (residual.greaterThan(cost)) {
    throw new BookkeepingError(
      'invalid',
      'What it will be worth at the end cannot be more than what it cost.',
    )
  }
  const accounts = await resolveAccounts(input)

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "bk_fixed_assets" (
      "description", "reference", "acquired_date", "cost", "transaction_id",
      "asset_account_id", "depreciation_account_id", "expense_account_id",
      "depreciation_method", "depreciation_rate", "residual_value", "ca_pool",
      "notes", "created_by_user_id"
    ) VALUES (
      ${input.description.trim()}, ${input.reference?.trim() || null}, ${acquired}::date,
      ${formatMoney(cost)}::numeric, ${input.transactionId || null},
      ${accounts.assetAccountId}, ${accounts.depreciationAccountId}, ${accounts.expenseAccountId},
      ${method}, ${rate}::numeric, ${formatMoney(residual)}::numeric,
      ${input.caPool ?? 'aia'}, ${input.notes?.trim() || null}, ${user?.id ?? null}
    )
    RETURNING "id"
  `
  const id = rows[0]!.id
  await appendAudit({
    action: 'fixed_asset.created',
    entityType: 'fixed_asset',
    entityId: id,
    summary: `Asset added: ${input.description.trim()} at ${formatPounds(cost)}`,
    detail: { after: input },
    user,
  })
  return requireFixedAsset(id)
}

export async function updateFixedAsset(
  id: string,
  patch: Partial<FixedAssetInput> & { archived?: boolean },
  user: SessionUser | null,
): Promise<FixedAssetWithState> {
  const current = await requireFixedAsset(id)
  const charges = await listChargesFor(id)

  // The cost and the date are what every charge already posted was worked out
  // from. Changing them under those charges would leave the register saying one
  // thing and the ledger another, which is the exact drift this table exists to
  // prevent.
  if (charges.length > 0) {
    const costChanged = patch.cost !== undefined && !toMoney(patch.cost).equals(current.cost)
    const dateChanged =
      patch.acquiredDate !== undefined && patch.acquiredDate.slice(0, 10) !== iso(current.acquired_date)
    if (costChanged || dateChanged) {
      throw new BookkeepingError(
        'invalid',
        'Depreciation has already been charged on this asset, so its cost and purchase date are fixed. Undo the depreciation runs first if one of them is genuinely wrong.',
      )
    }
  }

  const method = patch.depreciationMethod ?? current.depreciation_method
  const rate =
    patch.depreciationRate !== undefined
      ? checkRate(method, patch.depreciationRate)
      : formatMoney(current.depreciation_rate)

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "bk_fixed_assets" SET
      "description"         = ${patch.description?.trim() ?? current.description},
      "reference"           = ${patch.reference === undefined ? current.reference : patch.reference?.trim() || null},
      "acquired_date"       = ${patch.acquiredDate ? parseDate(patch.acquiredDate, 'The date it was bought') : current.acquired_date}::date,
      "cost"                = ${patch.cost !== undefined ? formatMoney(patch.cost) : formatMoney(current.cost)}::numeric,
      "asset_account_id"    = ${patch.assetAccountId ?? current.asset_account_id},
      "depreciation_account_id" = ${patch.depreciationAccountId ?? current.depreciation_account_id},
      "expense_account_id"  = ${patch.expenseAccountId ?? current.expense_account_id},
      "depreciation_method" = ${method},
      "depreciation_rate"   = ${rate}::numeric,
      "residual_value"      = ${patch.residualValue !== undefined ? formatMoney(patch.residualValue) : formatMoney(current.residual_value)}::numeric,
      "ca_pool"             = ${patch.caPool ?? current.ca_pool},
      "notes"               = ${patch.notes === undefined ? current.notes : patch.notes?.trim() || null},
      "archived"            = ${patch.archived ?? current.archived},
      "updated_at"          = NOW()
    WHERE "id" = ${id}
    RETURNING "id"
  `
  if (!rows[0]) throw new NotFoundError('That asset')
  await appendAudit({
    action: 'fixed_asset.updated',
    entityType: 'fixed_asset',
    entityId: id,
    summary: `Asset updated: ${patch.description?.trim() ?? current.description}`,
    detail: { before: current, after: patch },
    user,
  })
  return requireFixedAsset(id)
}

export async function deleteFixedAsset(id: string, user: SessionUser | null): Promise<void> {
  const asset = await requireFixedAsset(id)
  const charges = await listChargesFor(id)
  if (charges.length > 0) {
    throw new BookkeepingError(
      'invalid',
      'Depreciation has been charged on this asset and posted to the books, so it cannot simply be deleted. Undo the depreciation runs first, or archive it.',
    )
  }
  await prisma.$executeRaw`DELETE FROM "bk_fixed_assets" WHERE "id" = ${id}`
  await appendAudit({
    action: 'fixed_asset.deleted',
    entityType: 'fixed_asset',
    entityId: id,
    summary: `Asset removed: ${asset.description}`,
    detail: { before: asset },
    user,
  })
}

export async function disposeFixedAsset(
  id: string,
  input: { disposedDate: string; proceeds: string; transactionId?: string | null },
  user: SessionUser | null,
): Promise<FixedAssetWithState> {
  const asset = await requireFixedAsset(id)
  const date = parseDate(input.disposedDate, 'The date it was sold')
  if (date.getTime() < asset.acquired_date.getTime()) {
    throw new BookkeepingError('invalid', 'An asset cannot be sold before it was bought.')
  }
  const proceeds = toMoney(input.proceeds)
  if (proceeds.isNegative()) {
    throw new BookkeepingError('invalid', 'Sale proceeds cannot be less than nothing.')
  }
  await assertNotInClosedYear(date)

  await prisma.$executeRaw`
    UPDATE "bk_fixed_assets" SET
      "disposed_date" = ${date}::date,
      "disposal_proceeds" = ${formatMoney(proceeds)}::numeric,
      "disposal_transaction_id" = ${input.transactionId || null},
      "updated_at" = NOW()
    WHERE "id" = ${id}
  `
  await appendAudit({
    action: 'fixed_asset.disposed',
    entityType: 'fixed_asset',
    entityId: id,
    summary: `Asset sold: ${asset.description} for ${formatPounds(proceeds)}`,
    detail: { disposedDate: iso(date), proceeds: formatMoney(proceeds) },
    user,
  })
  return requireFixedAsset(id)
}

/** Undo a disposal, for the usual reason: it was entered against the wrong asset. */
export async function undoDisposal(id: string, user: SessionUser | null): Promise<FixedAssetWithState> {
  const asset = await requireFixedAsset(id)
  if (!asset.disposed_date) throw new BookkeepingError('invalid', 'That asset has not been sold.')
  await prisma.$executeRaw`
    UPDATE "bk_fixed_assets" SET
      "disposed_date" = NULL, "disposal_proceeds" = NULL,
      "disposal_transaction_id" = NULL, "updated_at" = NOW()
    WHERE "id" = ${id}
  `
  await appendAudit({
    action: 'fixed_asset.disposal_undone',
    entityType: 'fixed_asset',
    entityId: id,
    summary: `Sale removed from ${asset.description}`,
    detail: { before: { disposedDate: iso(asset.disposed_date), proceeds: formatMoney(asset.disposal_proceeds) } },
    user,
  })
  return requireFixedAsset(id)
}

// ---------------------------------------------------------------------------
// Depreciation
// ---------------------------------------------------------------------------

export type DepreciationLine = {
  assetId: string
  description: string
  cost: string
  /** Charged before this run. */
  broughtForward: string
  /** What this run would charge. */
  charge: string
  /** Cost less everything charged, after this run. */
  netBookValue: string
  expenseAccountId: string
  depreciationAccountId: string
  /** Why the charge is what it is, in a sentence, for the screen and the audit. */
  basis: string
}

export type DepreciationRun = {
  from: string
  to: string
  lines: DepreciationLine[]
  total: string
  /** Assets skipped, and why. Shown rather than silently dropped. */
  skipped: { assetId: string; description: string; reason: string }[]
  /** True when this exact period has already been run, so the screen can say so. */
  alreadyRun: boolean
}

/**
 * What depreciation would be charged for a period.
 *
 * Pro-rated by days, both for an asset bought part way through and for a period
 * that is not a year. A van bought on the last day of the year gets one day's
 * depreciation, not a full year's, which is both right and the thing every
 * spreadsheet gets wrong.
 *
 * Straight line takes (cost less residual) at the rate. Reducing balance takes
 * the rate off what is left, so it never quite reaches nothing - which is the
 * point of it, and why it stops at the residual value rather than at zero.
 *
 * Charges never take an asset below its residual value, and never charge an
 * asset that was sold before the period started.
 */
export async function previewDepreciation(from: Date, to: Date): Promise<DepreciationRun> {
  const assets = await listFixedAssets({ includeDisposed: true })
  const periodDays = daysInclusive(from, to)
  const lines: DepreciationLine[] = []
  const skipped: DepreciationRun['skipped'] = []

  const existing = await prisma.$queryRaw<{ asset_id: string }[]>`
    SELECT "asset_id" FROM "bk_depreciation_charges"
    WHERE "period_start" = ${from}::date AND "period_end" = ${to}::date
  `
  const alreadyCharged = new Set(existing.map((row) => row.asset_id))

  for (const asset of assets) {
    const skip = (reason: string) =>
      skipped.push({ assetId: asset.id, description: asset.description, reason })

    if (alreadyCharged.has(asset.id)) {
      skip('Already charged for this period.')
      continue
    }
    if (asset.depreciation_method === 'none') {
      skip('Set not to be depreciated.')
      continue
    }
    if (asset.acquired_date.getTime() > to.getTime()) {
      skip('Bought after this period ended.')
      continue
    }
    if (asset.disposed_date && asset.disposed_date.getTime() < from.getTime()) {
      skip('Sold before this period started.')
      continue
    }

    // Only the part of the period the business actually owned it for.
    const ownedFrom = asset.acquired_date.getTime() > from.getTime() ? asset.acquired_date : from
    const ownedTo =
      asset.disposed_date && asset.disposed_date.getTime() < to.getTime() ? asset.disposed_date : to
    const ownedDays = daysInclusive(ownedFrom, ownedTo)
    if (ownedDays <= 0) {
      skip('Not owned during this period.')
      continue
    }

    const cost = toMoney(asset.cost)
    const residual = toMoney(asset.residual_value)
    const alreadyDone = toMoney(asset.accumulated_depreciation)
    const remaining = cost.minus(residual).minus(alreadyDone)
    if (remaining.lessThanOrEqualTo(0)) {
      skip('Already fully written down.')
      continue
    }

    const rate = toMoney(asset.depreciation_rate).dividedBy(100)
    const base =
      asset.depreciation_method === 'reducing_balance' ? cost.minus(alreadyDone) : cost.minus(residual)
    let charge = base
      .times(rate)
      .times(ownedDays)
      .dividedBy(365)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)

    // Never past the residual value. The last year of a straight line asset is
    // whatever is left, not a full instalment.
    if (charge.greaterThan(remaining)) charge = remaining
    if (charge.lessThanOrEqualTo(0)) {
      skip('Nothing left to write off.')
      continue
    }

    const proRated = ownedDays !== periodDays || periodDays !== 365
    lines.push({
      assetId: asset.id,
      description: asset.description,
      cost: formatMoney(cost),
      broughtForward: formatMoney(alreadyDone),
      charge: formatMoney(charge),
      netBookValue: formatMoney(cost.minus(alreadyDone).minus(charge)),
      expenseAccountId: asset.expense_account_id,
      depreciationAccountId: asset.depreciation_account_id,
      basis:
        `${formatMoney(asset.depreciation_rate)}% ${
          asset.depreciation_method === 'reducing_balance' ? 'of what is left' : 'of cost'
        }` + (proRated ? `, for ${ownedDays} days of the year` : ''),
    })
  }

  return {
    from: iso(from),
    to: iso(to),
    lines,
    total: formatMoney(
      lines.reduce<Money>((running, line) => running.plus(toMoney(line.charge)), toMoney('0.00')),
    ),
    skipped,
    alreadyRun: alreadyCharged.size > 0,
  }
}

/**
 * Post the depreciation for a period.
 *
 * One journal for the lot, with a line per asset on each side, so the ledger
 * shows one dated event rather than forty. The charges table records what each
 * asset got, which is what makes a second run for the same period a no-op
 * rather than a double charge.
 */
export async function runDepreciation(
  from: Date,
  to: Date,
  user: SessionUser | null,
): Promise<{ journalId: string | null; run: DepreciationRun }> {
  await assertNotInClosedYear(to)
  const run = await previewDepreciation(from, to)
  if (run.lines.length === 0) return { journalId: null, run }

  const journalLines: JournalLineInput[] = []
  for (const line of run.lines) {
    journalLines.push({
      accountId: line.expenseAccountId,
      description: `${line.description} - ${line.basis}`,
      debit: line.charge,
    })
    journalLines.push({
      accountId: line.depreciationAccountId,
      description: line.description,
      credit: line.charge,
    })
  }

  const journal = await createJournal(
    {
      date: iso(to),
      reference: 'Depreciation',
      narrative: `Depreciation for ${iso(from)} to ${iso(to)}: ${run.lines.length} asset${run.lines.length === 1 ? '' : 's'}, ${formatPounds(run.total)}.`,
      status: 'posted',
      source: 'template',
      lines: journalLines,
    },
    user,
  )

  await prisma.$executeRaw`
    INSERT INTO "bk_depreciation_charges" ("asset_id", "period_start", "period_end", "amount", "journal_id")
    SELECT d."asset_id", ${from}::date, ${to}::date, d."amount"::numeric, ${journal.id}
    FROM UNNEST(
      ${run.lines.map((line) => line.assetId)}::text[],
      ${run.lines.map((line) => line.charge)}::text[]
    ) AS d("asset_id", "amount")
    ON CONFLICT ("asset_id", "period_start", "period_end") DO NOTHING
  `

  await appendAudit({
    action: 'depreciation.posted',
    entityType: 'journal',
    entityId: journal.id,
    summary: `Depreciation posted for ${iso(from)} to ${iso(to)}: ${formatPounds(run.total)}`,
    detail: { from: iso(from), to: iso(to), lines: run.lines },
    user,
  })

  return { journalId: journal.id, run }
}

/** Take a depreciation run back out: the journal and the charges it recorded. */
export async function undoDepreciation(
  journalId: string,
  user: SessionUser | null,
): Promise<void> {
  const [charge] = await prisma.$queryRaw<{ period_start: Date; period_end: Date }[]>`
    SELECT "period_start", "period_end" FROM "bk_depreciation_charges"
    WHERE "journal_id" = ${journalId} LIMIT 1
  `
  if (!charge) throw new NotFoundError('That depreciation run')
  await assertNotInClosedYear(charge.period_end)
  // The charges go with it: bk_depreciation_charges cascades on the journal.
  await deleteJournal(journalId, user)
  await appendAudit({
    action: 'depreciation.undone',
    entityType: 'journal',
    entityId: journalId,
    summary: `Depreciation for ${iso(charge.period_start)} to ${iso(charge.period_end)} taken back out`,
    detail: { journalId },
    user,
  })
}
