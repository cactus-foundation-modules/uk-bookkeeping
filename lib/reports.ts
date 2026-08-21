import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { accountBalances, LEDGER_SQL, type AccountBalance } from './ledger'
import { formatMoney, toMoney } from './money'
import { getSettings } from './settings'
import type { Money } from './types'

// The reports.
//
// All of them now read the ledger (lib/ledger.ts), which is the cashbook and
// the journals projected into one set of postings. That is the whole change,
// and it is the difference between a profit and loss account that omits the
// depreciation and one that does not.
//
// Reports are drawn on the ACCRUALS basis - the tax point, not the settlement
// date - whatever VAT scheme the business is on. A profit and loss account is
// about when the trade happened; cash accounting is a VAT arrangement rather
// than a way of keeping accounts. The one thing the scheme changes is where the
// VAT waits in the meantime, and lib/ledger.ts handles that.
//
// Every figure here is a Prisma.Decimal until the last moment and a two-place
// STRING after it. No Number(), anywhere, ever.

// ---------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------

/**
 * The order the sections print in, what they are called, and whether they add
 * to the profit or take from it.
 *
 * This is the Companies Act Format 1 shape in plain English: turnover less cost
 * of sales gives gross profit, less the overheads gives operating profit, then
 * the things that are not trading, then the tax. A small company's accounts
 * look like this, and a set that does not is a set an accountant has to redo.
 */
const PL_SECTIONS: { key: string; label: string; sign: 1 | -1 }[] = [
  { key: 'turnover', label: 'Turnover', sign: 1 },
  { key: 'cost-of-sales', label: 'Cost of sales', sign: -1 },
  { key: 'other-income', label: 'Other operating income', sign: 1 },
  { key: 'staff-costs', label: 'Staff costs', sign: -1 },
  { key: 'admin-expenses', label: 'Administrative expenses', sign: -1 },
  { key: 'depreciation', label: 'Depreciation and amounts written off assets', sign: -1 },
  { key: 'non-trade-income', label: 'Interest receivable and similar income', sign: 1 },
  { key: 'property-income', label: 'Income from property', sign: 1 },
  { key: 'finance-costs', label: 'Interest payable and similar charges', sign: -1 },
  { key: 'tax', label: 'Tax on profit', sign: -1 },
]

const PL_SECTION_KEYS = new Set(PL_SECTIONS.map((section) => section.key))

/** Where an account with an unrecognised grouping goes, so nothing is lost. */
function fallbackGroup(kind: string): string {
  return kind === 'income' ? 'other-income' : 'admin-expenses'
}

export type PlLine = {
  accountId: string
  code: string
  name: string
  amount: string
  priorAmount: string | null
}

export type PlSection = {
  key: string
  label: string
  /** 1 adds to profit, -1 takes from it. The renderer needs to know; the maths already does. */
  sign: 1 | -1
  lines: PlLine[]
  total: string
  priorTotal: string | null
}

export type PlSubtotal = {
  key: string
  label: string
  amount: string
  priorAmount: string | null
  /** Set on the bottom line, which is the one that gets emphasis. */
  emphasis?: boolean
}

export type ProfitAndLoss = {
  from: string
  to: string
  priorFrom: string | null
  priorTo: string | null
  sections: PlSection[]
  subtotals: PlSubtotal[]
  /** The bottom line, repeated where callers want it without hunting the array. */
  profit: string
  businessType: 'ltd' | 'sole_trader'
}

/**
 * A profit and loss account for the range, with last time alongside it.
 *
 * The comparative is the period of the same length immediately before this one,
 * which is what "is that good?" actually means and what a set of accounts is
 * required to show. It is worked out from the same ledger by the same code, so
 * there is no chance of the two columns disagreeing about method.
 *
 * Net of VAT throughout, because a VAT-registered business's VAT is neither its
 * income nor its cost. Capital purchases, drawings, dividends and money
 * introduced do not appear at all - they are not profit and loss items, and the
 * ledger already puts them where they belong on the balance sheet instead of
 * quietly inflating "other expenses" the way the old category report did.
 */
export async function profitAndLoss(
  from: Date,
  to: Date,
  options: { comparative?: boolean } = {},
): Promise<ProfitAndLoss> {
  const settings = await getSettings()
  const wantsPrior = options.comparative !== false

  // Same length, ending the day before this one starts.
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1)
  const priorTo = new Date(from.getTime() - 86_400_000)
  const priorFrom = new Date(priorTo.getTime() - (days - 1) * 86_400_000)

  const [current, prior] = await Promise.all([
    accountBalances(iso(to), iso(from)),
    wantsPrior ? accountBalances(iso(priorTo), iso(priorFrom)) : Promise.resolve([]),
  ])

  const priorById = new Map(prior.map((row) => [row.accountId, row]))
  const byGroup = new Map<string, PlLine[]>()

  for (const row of current) {
    if (row.kind !== 'income' && row.kind !== 'expense') continue
    const priorRow = priorById.get(row.accountId)
    const amount = toMoney(row.balance)
    const priorAmount = priorRow ? toMoney(priorRow.balance) : toMoney('0.00')
    // An account with nothing in it either period is noise on a report.
    if (amount.isZero() && priorAmount.isZero()) continue

    const group =
      row.reportGroup && PL_SECTION_KEYS.has(row.reportGroup)
        ? row.reportGroup
        : fallbackGroup(row.kind)
    const lines = byGroup.get(group) ?? []
    lines.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      amount: formatMoney(amount),
      priorAmount: wantsPrior ? formatMoney(priorAmount) : null,
    })
    byGroup.set(group, lines)
  }

  const sections: PlSection[] = PL_SECTIONS.map((section) => {
    const lines = byGroup.get(section.key) ?? []
    return {
      key: section.key,
      label: section.label,
      sign: section.sign,
      lines,
      total: formatMoney(sum(lines.map((line) => line.amount))),
      priorTotal: wantsPrior ? formatMoney(sum(lines.map((line) => line.priorAmount ?? '0'))) : null,
    }
  }).filter((section) => section.lines.length > 0)

  const total = (key: string, which: 'total' | 'priorTotal') =>
    toMoney(sections.find((section) => section.key === key)?.[which] ?? '0')

  const build = (which: 'total' | 'priorTotal') => {
    const grossProfit = total('turnover', which).minus(total('cost-of-sales', which))
    const operatingProfit = grossProfit
      .plus(total('other-income', which))
      .minus(total('staff-costs', which))
      .minus(total('admin-expenses', which))
      .minus(total('depreciation', which))
    const profitBeforeTax = operatingProfit
      .plus(total('non-trade-income', which))
      .plus(total('property-income', which))
      .minus(total('finance-costs', which))
    const profitAfterTax = profitBeforeTax.minus(total('tax', which))
    return { grossProfit, operatingProfit, profitBeforeTax, profitAfterTax }
  }

  const now = build('total')
  const then = wantsPrior ? build('priorTotal') : null

  const subtotals: PlSubtotal[] = [
    { key: 'gross-profit', label: 'Gross profit', amount: formatMoney(now.grossProfit), priorAmount: then ? formatMoney(then.grossProfit) : null },
    { key: 'operating-profit', label: 'Operating profit', amount: formatMoney(now.operatingProfit), priorAmount: then ? formatMoney(then.operatingProfit) : null },
    { key: 'profit-before-tax', label: 'Profit before tax', amount: formatMoney(now.profitBeforeTax), priorAmount: then ? formatMoney(then.profitBeforeTax) : null },
    { key: 'profit-after-tax', label: 'Profit for the period', amount: formatMoney(now.profitAfterTax), priorAmount: then ? formatMoney(then.profitAfterTax) : null, emphasis: true },
  ]

  return {
    from: iso(from),
    to: iso(to),
    priorFrom: wantsPrior ? iso(priorFrom) : null,
    priorTo: wantsPrior ? iso(priorTo) : null,
    sections,
    subtotals,
    profit: formatMoney(now.profitAfterTax),
    businessType: settings.business_type,
  }
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

/**
 * The order the balance sheet prints in, and which way each section reads.
 *
 * `sign` is presentation only: a creditor is listed as a positive number under a
 * heading that says the business owes it, and subtracted when the totals are
 * worked out. Printing "-4,200" under "money the business owes" is the sort of
 * thing that has people phoning their accountant.
 */
const BS_SECTIONS: { key: string; label: string; sign: 1 | -1 }[] = [
  { key: 'intangible_assets', label: 'Intangible assets', sign: 1 },
  { key: 'fixed_assets', label: 'Tangible fixed assets', sign: 1 },
  { key: 'current_assets_stock', label: 'Stock', sign: 1 },
  { key: 'current_assets_debtors', label: 'Debtors and prepayments', sign: 1 },
  { key: 'current_assets_cash', label: 'Cash at bank and in hand', sign: 1 },
  { key: 'creditors_short', label: 'Creditors: amounts falling due within one year', sign: -1 },
  { key: 'creditors_long', label: 'Creditors: amounts falling due after more than one year', sign: -1 },
  { key: 'provisions', label: 'Provisions for liabilities', sign: -1 },
  { key: 'share_capital', label: 'Called up share capital', sign: 1 },
  { key: 'reserves', label: 'Profit and loss account and reserves', sign: 1 },
]

const BS_SECTION_KEYS = new Set(BS_SECTIONS.map((section) => section.key))

export type BsLine = {
  accountId: string
  code: string
  name: string
  amount: string
  priorAmount: string | null
}

export type BsSection = {
  key: string
  label: string
  sign: 1 | -1
  lines: BsLine[]
  total: string
  priorTotal: string | null
}

export type BalanceSheet = {
  asAt: string
  priorAsAt: string | null
  sections: BsSection[]
  subtotals: PlSubtotal[]
  netAssets: string
  totalEquity: string
  /** Net assets and total equity should be the same figure. When they are not, say so. */
  balanced: boolean
  difference: string
}

/**
 * The balance sheet as at a date. What the business owns, what it owes, and
 * what is left.
 *
 * The profit for the year to date is added to reserves as a line of its own
 * rather than being buried, because until the year is closed it is genuinely
 * not in retained earnings yet, and a balance sheet that leaves it out is out
 * by exactly the profit. After a year-end close the closed years net to nil of
 * their own accord - the closing journal moved them - so this figure is always
 * "since the last close" without anybody having to work out when that was.
 *
 * `balanced` is not decoration. Both sides are drawn from the same double-entry
 * projection, so they cannot disagree unless something is wrong: a control
 * account deleted, a guard interfered with. Showing a balance sheet that is out
 * without saying so is the one thing this report must never do.
 */
export async function balanceSheet(
  asAt: Date,
  options: { comparative?: boolean; priorAsAt?: Date | null } = {},
): Promise<BalanceSheet> {
  const wantsPrior = options.comparative !== false
  // A year before, unless the caller knows better (it usually does: the
  // previous accounting period's end date).
  const priorDate =
    options.priorAsAt ??
    new Date(Date.UTC(asAt.getUTCFullYear() - 1, asAt.getUTCMonth(), asAt.getUTCDate()))

  const [current, prior] = await Promise.all([
    accountBalances(iso(asAt)),
    wantsPrior ? accountBalances(iso(priorDate)) : Promise.resolve([]),
  ])

  const priorById = new Map(prior.map((row) => [row.accountId, row]))
  const byGroup = new Map<string, BsLine[]>()

  // The profit that has not been taken to reserves yet, both columns.
  const retained = (rows: AccountBalance[]): Money =>
    rows.reduce((running, row) => {
      if (row.kind === 'income') return running.plus(toMoney(row.balance))
      if (row.kind === 'expense') return running.minus(toMoney(row.balance))
      return running
    }, toMoney('0.00'))

  for (const row of current) {
    if (row.kind === 'income' || row.kind === 'expense') continue
    const priorRow = priorById.get(row.accountId)
    const amount = toMoney(row.balance)
    const priorAmount = priorRow ? toMoney(priorRow.balance) : toMoney('0.00')
    if (amount.isZero() && priorAmount.isZero()) continue

    const group =
      row.bsGroup && BS_SECTION_KEYS.has(row.bsGroup)
        ? row.bsGroup
        : row.kind === 'asset'
          ? 'current_assets_debtors'
          : row.kind === 'liability'
            ? 'creditors_short'
            : 'reserves'
    const lines = byGroup.get(group) ?? []
    lines.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      amount: formatMoney(amount),
      priorAmount: wantsPrior ? formatMoney(priorAmount) : null,
    })
    byGroup.set(group, lines)
  }

  const profitNow = retained(current)
  const profitThen = retained(prior)
  if (!profitNow.isZero() || !profitThen.isZero()) {
    const lines = byGroup.get('reserves') ?? []
    lines.push({
      accountId: 'profit-for-period',
      code: 'profit',
      name: 'Profit since the last year end',
      amount: formatMoney(profitNow),
      priorAmount: wantsPrior ? formatMoney(profitThen) : null,
    })
    byGroup.set('reserves', lines)
  }

  const sections: BsSection[] = BS_SECTIONS.map((section) => {
    const lines = byGroup.get(section.key) ?? []
    return {
      key: section.key,
      label: section.label,
      sign: section.sign,
      lines,
      total: formatMoney(sum(lines.map((line) => line.amount))),
      priorTotal: wantsPrior ? formatMoney(sum(lines.map((line) => line.priorAmount ?? '0'))) : null,
    }
  }).filter((section) => section.lines.length > 0)

  const total = (key: string, which: 'total' | 'priorTotal') =>
    toMoney(sections.find((section) => section.key === key)?.[which] ?? '0')

  const build = (which: 'total' | 'priorTotal') => {
    const fixedAssets = total('intangible_assets', which).plus(total('fixed_assets', which))
    const currentAssets = total('current_assets_stock', which)
      .plus(total('current_assets_debtors', which))
      .plus(total('current_assets_cash', which))
    const shortCreditors = total('creditors_short', which)
    const netCurrentAssets = currentAssets.minus(shortCreditors)
    const totalLessCurrent = fixedAssets.plus(netCurrentAssets)
    const netAssets = totalLessCurrent
      .minus(total('creditors_long', which))
      .minus(total('provisions', which))
    const equity = total('share_capital', which).plus(total('reserves', which))
    return { fixedAssets, currentAssets, netCurrentAssets, totalLessCurrent, netAssets, equity }
  }

  const now = build('total')
  const then = wantsPrior ? build('priorTotal') : null

  const subtotals: PlSubtotal[] = [
    { key: 'fixed-assets', label: 'Total fixed assets', amount: formatMoney(now.fixedAssets), priorAmount: then ? formatMoney(then.fixedAssets) : null },
    { key: 'current-assets', label: 'Total current assets', amount: formatMoney(now.currentAssets), priorAmount: then ? formatMoney(then.currentAssets) : null },
    { key: 'net-current-assets', label: 'Net current assets', amount: formatMoney(now.netCurrentAssets), priorAmount: then ? formatMoney(then.netCurrentAssets) : null },
    { key: 'total-less-current', label: 'Total assets less current liabilities', amount: formatMoney(now.totalLessCurrent), priorAmount: then ? formatMoney(then.totalLessCurrent) : null },
    { key: 'net-assets', label: 'Net assets', amount: formatMoney(now.netAssets), priorAmount: then ? formatMoney(then.netAssets) : null, emphasis: true },
    { key: 'equity', label: 'Total shareholders’ funds', amount: formatMoney(now.equity), priorAmount: then ? formatMoney(then.equity) : null, emphasis: true },
  ]

  return {
    asAt: iso(asAt),
    priorAsAt: wantsPrior ? iso(priorDate) : null,
    sections,
    subtotals,
    netAssets: formatMoney(now.netAssets),
    totalEquity: formatMoney(now.equity),
    balanced: now.netAssets.equals(now.equity),
    difference: formatMoney(now.netAssets.minus(now.equity)),
  }
}

// ---------------------------------------------------------------------------
// Aged debtors and creditors
// ---------------------------------------------------------------------------

export type AgedRow = {
  counterparty: string
  current: string
  days30: string
  days60: string
  days90: string
  older: string
  total: string
  oldest: string | null
}

export type AgedAnalysis = {
  asAt: string
  direction: 'income' | 'expense'
  rows: AgedRow[]
  totals: Omit<AgedRow, 'counterparty' | 'oldest'>
}

/**
 * Who owes the business money, and how long they have owed it - or the same for
 * the other way round.
 *
 * Read straight off the unsettled entries, which is why it agrees with the
 * debtors and creditors totals on the balance sheet rather than being a second
 * opinion about them: the same rows produce both. An entry with no settled date
 * is outstanding, and that is the whole test.
 *
 * One statement, buckets and all. Ageing is from the tax point, which is the
 * invoice date, because that is the date the customer is late from.
 */
export async function agedAnalysis(
  direction: 'income' | 'expense',
  asAt: Date,
): Promise<AgedAnalysis> {
  const rows = await prisma.$queryRaw<
    {
      counterparty: string
      current: Prisma.Decimal
      days30: Prisma.Decimal
      days60: Prisma.Decimal
      days90: Prisma.Decimal
      older: Prisma.Decimal
      total: Prisma.Decimal
      oldest: Date
    }[]
  >`
    WITH outstanding AS (
      SELECT t."counterparty",
             t."tax_point_date",
             (${asAt}::date - t."tax_point_date") AS age,
             COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross
      FROM "bk_transactions" t
      JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
      WHERE t."status" = 'posted'
        AND t."direction" = ${direction}
        AND t."settled_date" IS NULL
        AND t."tax_point_date" <= ${asAt}::date
      GROUP BY t."id", t."counterparty", t."tax_point_date"
    )
    SELECT "counterparty",
           COALESCE(SUM(gross) FILTER (WHERE age <= 30), 0)::numeric              AS current,
           COALESCE(SUM(gross) FILTER (WHERE age > 30 AND age <= 60), 0)::numeric AS days30,
           COALESCE(SUM(gross) FILTER (WHERE age > 60 AND age <= 90), 0)::numeric AS days60,
           COALESCE(SUM(gross) FILTER (WHERE age > 90 AND age <= 120), 0)::numeric AS days90,
           COALESCE(SUM(gross) FILTER (WHERE age > 120), 0)::numeric              AS older,
           COALESCE(SUM(gross), 0)::numeric                                       AS total,
           MIN("tax_point_date")                                                  AS oldest
    FROM outstanding
    GROUP BY "counterparty"
    HAVING SUM(gross) <> 0
    ORDER BY SUM(gross) DESC
  `

  const totals = {
    current: sum(rows.map((row) => row.current)),
    days30: sum(rows.map((row) => row.days30)),
    days60: sum(rows.map((row) => row.days60)),
    days90: sum(rows.map((row) => row.days90)),
    older: sum(rows.map((row) => row.older)),
    total: sum(rows.map((row) => row.total)),
  }

  return {
    asAt: iso(asAt),
    direction,
    rows: rows.map((row) => ({
      counterparty: row.counterparty,
      current: formatMoney(row.current),
      days30: formatMoney(row.days30),
      days60: formatMoney(row.days60),
      days90: formatMoney(row.days90),
      older: formatMoney(row.older),
      total: formatMoney(row.total),
      oldest: row.oldest ? row.oldest.toISOString().slice(0, 10) : null,
    })),
    totals: {
      current: formatMoney(totals.current),
      days30: formatMoney(totals.days30),
      days60: formatMoney(totals.days60),
      days90: formatMoney(totals.days90),
      older: formatMoney(totals.older),
      total: formatMoney(totals.total),
    },
  }
}

// ---------------------------------------------------------------------------
// Month by month
// ---------------------------------------------------------------------------

export type MonthlyRow = {
  /** First day of the month, YYYY-MM-DD. */
  month: string
  income: string
  expenses: string
  profit: string
  vat: string
  entries: number
}

/**
 * The trading picture month by month.
 *
 * Off the ledger, so a depreciation journal shows up in the month it was
 * charged rather than nowhere. The VAT column is the month's net position -
 * charged less reclaimable - taken from the movement on the VAT accounts, which
 * is the same figure the balance sheet shows and not a separate tally that
 * could drift from it.
 */
export async function monthlyBreakdown(from: Date, to: Date): Promise<MonthlyRow[]> {
  const rows = await prisma.$queryRaw<
    {
      month: Date
      income: Prisma.Decimal
      expenses: Prisma.Decimal
      vat: Prisma.Decimal
      entries: bigint
    }[]
  >(Prisma.sql`
    WITH ledger AS (${LEDGER_SQL})
    SELECT
      date_trunc('month', e."entry_date")::date AS month,
      COALESCE(SUM(e."credit" - e."debit") FILTER (WHERE a."kind" = 'income'), 0)::numeric  AS income,
      COALESCE(SUM(e."debit" - e."credit") FILTER (WHERE a."kind" = 'expense'), 0)::numeric AS expenses,
      COALESCE(SUM(e."credit" - e."debit") FILTER (WHERE a."subtype" = 'vat_control'), 0)::numeric AS vat,
      COUNT(DISTINCT e."source_id")::bigint AS entries
    FROM ledger e
    JOIN "bk_accounts" a ON a."id" = e."account_id"
    WHERE e."entry_date" BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1
    ORDER BY 1 ASC
  `)
  return rows.map((r) => ({
    month: r.month.toISOString().slice(0, 10),
    income: formatMoney(r.income),
    expenses: formatMoney(r.expenses),
    profit: formatMoney(r.income.minus(r.expenses)),
    vat: formatMoney(r.vat),
    entries: Number(r.entries),
  }))
}

// ---------------------------------------------------------------------------
// Category summary, and the self-assessment grouping built on it
// ---------------------------------------------------------------------------

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

/**
 * What went through each category, with its VAT.
 *
 * Kept as it was, and deliberately still reading the cashbook rather than the
 * ledger: this answers "what did I code where, and what VAT was on it", which
 * is a question about the cashbook. The profit and loss account above answers
 * the other question. Journals carry no VAT and no category, so there is
 * nothing here for them to be missing from.
 */
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

export type GroupedTotal = { key: string; label: string; net: string }

/**
 * SA103F box totals for a sole trader.
 *
 * A company's figures no longer come from here - there is a proper corporation
 * tax computation in lib/corporation-tax.ts, which does add-backs, capital
 * allowances and the rates, none of which a category total can do. This stays
 * for the sole trader, whose self-assessment pages genuinely are a list of
 * category totals.
 */
export function groupForTaxReturn(
  summary: CategorySummaryRow[],
  businessType: 'ltd' | 'sole_trader',
): GroupedTotal[] {
  const totals = new Map<string, Money>()
  for (const row of summary) {
    const key = businessType === 'sole_trader' ? row.sa103Box : row.ct600Group
    if (!key) continue
    totals.set(key, (totals.get(key) ?? toMoney('0.00')).plus(toMoney(row.net)))
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, net]) => ({
      key,
      label: businessType === 'sole_trader' ? `Box ${key.replace('SA103F.', '')}` : titleCase(key),
      net: formatMoney(net),
    }))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sum(values: (string | Prisma.Decimal | null | undefined)[]): Money {
  return values.reduce<Money>((running, value) => running.plus(toMoney(value)), toMoney('0.00'))
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function titleCase(value: string): string {
  return value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
