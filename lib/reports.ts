import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMoney } from './money'
import { getSettings } from './settings'

// Reports: a category summary for a date range, and a profit and loss built from
// it. Both are one statement each - PgBouncer wraps every statement in its own
// BEGIN/DEALLOCATE ALL/COMMIT, so a report assembled row by row would be four
// network round trips per category.
//
// Reports read the tax point, not the settlement date, whatever VAT scheme the
// site is on: a profit and loss account is about when the trade happened, and
// cash accounting is a VAT arrangement rather than a way of keeping accounts.

export type CategorySummaryRow = {
  categoryId: string
  code: string
  name: string
  direction: 'income' | 'expense' | 'both'
  sa103Box: string | null
  ct600Group: string | null
  isTrading: boolean
  isCapital: boolean
  net: string
  vat: string
  gross: string
  entries: number
}

export async function categorySummary(from: Date, to: Date): Promise<CategorySummaryRow[]> {
  const rows = await prisma.$queryRaw<
    {
      category_id: string
      code: string
      name: string
      direction: 'income' | 'expense' | 'both'
      sa103_box: string | null
      ct600_group: string | null
      is_trading: boolean
      is_capital: boolean
      net: Prisma.Decimal
      vat: Prisma.Decimal
      gross: Prisma.Decimal
      entries: bigint
    }[]
  >`
    SELECT c."id" AS category_id, c."code", c."name", c."direction",
           c."sa103_box", c."ct600_group", c."is_trading", c."is_capital",
           COALESCE(SUM(l."net_amount"), 0)::numeric   AS net,
           COALESCE(SUM(l."vat_amount"), 0)::numeric   AS vat,
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross,
           COUNT(DISTINCT t."id")::bigint              AS entries
    FROM "bk_categories" c
    LEFT JOIN "bk_transaction_lines" l ON l."category_id" = c."id"
    LEFT JOIN "bk_transactions" t
      ON t."id" = l."transaction_id"
     AND t."status" = 'posted'
     AND t."tax_point_date" BETWEEN ${from}::date AND ${to}::date
    WHERE l."id" IS NULL OR t."id" IS NOT NULL
    GROUP BY c."id", c."code", c."name", c."direction", c."sa103_box",
             c."ct600_group", c."is_trading", c."is_capital", c."position"
    HAVING COUNT(DISTINCT t."id") > 0
    ORDER BY c."position" ASC, c."name" ASC
  `

  return rows.map((r) => ({
    categoryId: r.category_id,
    code: r.code,
    name: r.name,
    direction: r.direction,
    sa103Box: r.sa103_box,
    ct600Group: r.ct600_group,
    isTrading: r.is_trading,
    isCapital: r.is_capital,
    net: formatMoney(r.net),
    vat: formatMoney(r.vat),
    gross: formatMoney(r.gross),
    entries: Number(r.entries),
  }))
}

export type ProfitAndLoss = {
  income: CategorySummaryRow[]
  expenses: CategorySummaryRow[]
  excluded: CategorySummaryRow[]
  totalIncome: string
  totalExpenses: string
  profit: string
  /** Which set of groupings the screen should show. */
  businessType: 'ltd' | 'sole_trader'
}

/**
 * A profit and loss account for the range.
 *
 * Net of VAT throughout, because a VAT-registered business's VAT is not income
 * and not a cost. Capital purchases and the non-trading categories (drawings,
 * dividends, money introduced, VAT and tax payments) are shown separately rather
 * than dropped: leaving them out only means they get filed under "other
 * expenses" by somebody, which quietly wrecks the account.
 */
export async function profitAndLoss(from: Date, to: Date): Promise<ProfitAndLoss> {
  const settings = await getSettings()
  const summary = await categorySummary(from, to)

  const trading = summary.filter((row) => row.isTrading && !row.isCapital)
  const income = trading.filter((row) => row.direction === 'income')
  const expenses = trading.filter((row) => row.direction !== 'income')
  const excluded = summary.filter((row) => !row.isTrading || row.isCapital)

  const sum = (rows: CategorySummaryRow[]) =>
    rows.reduce((total, row) => total.plus(new Prisma.Decimal(row.net)), new Prisma.Decimal(0))

  const totalIncome = sum(income)
  const totalExpenses = sum(expenses)

  return {
    income,
    expenses,
    excluded,
    totalIncome: formatMoney(totalIncome),
    totalExpenses: formatMoney(totalExpenses),
    profit: formatMoney(totalIncome.minus(totalExpenses)),
    businessType: settings.business_type,
  }
}

export type GroupedTotal = { key: string; label: string; net: string }

/** SA103F box totals for a sole trader, or the coarse CT600 grouping for a company. */
export function groupForTaxReturn(
  summary: CategorySummaryRow[],
  businessType: 'ltd' | 'sole_trader',
): GroupedTotal[] {
  const totals = new Map<string, Prisma.Decimal>()
  for (const row of summary) {
    const key = businessType === 'sole_trader' ? row.sa103Box : row.ct600Group
    if (!key) continue
    totals.set(key, (totals.get(key) ?? new Prisma.Decimal(0)).plus(new Prisma.Decimal(row.net)))
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, net]) => ({
      key,
      label: businessType === 'sole_trader' ? `Box ${key.replace('SA103F.', '')}` : titleCase(key),
      net: formatMoney(net),
    }))
}

function titleCase(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
