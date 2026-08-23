import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { countAssetDrafts } from './fixed-assets'
import { formatMoney } from './money'
import { isOverdue, listPeriods, toDateOnly } from './periods'
import { getSettings } from './settings'
import { isHmrcConfigured } from './hmrc/endpoints'
import { getConnection } from './hmrc/tokens'
import { listTransactions } from './transactions'
import { assembleBoxes, computeVatTotals, netVatDirection } from './vat-boxes'

// The overview. Everything a site owner wants to know before they click
// anything: where the VAT stands, when the next return is due, what is waiting
// on them, and what has moved lately.
//
// Each figure is one SQL statement, and nothing here writes anything. PgBouncer
// wraps every statement in its own round trips, so the whole screen costs a
// handful of them rather than one per number.

export type DashboardData = {
  environment: string
  hmrc: { configured: boolean; status: string }
  vat: {
    periodId: string
    start: string
    end: string
    due: string | null
    status: string
    overdue: boolean
    netVatDue: string
    direction: 'pay' | 'reclaim' | 'nil'
    box1: string
    box4: string
  } | null
  nextDue: {
    periodId: string
    start: string
    end: string
    due: string
    status: string
    overdue: boolean
    daysLeft: number
  } | null
  month: { from: string; income: string; expenses: string; profit: string }
  drafts: number
  /** Statement lines the bank has and the books do not, on live accounts. */
  unreconciled: number
  missingEvidence: number
  /** Assets raised off a ticked purchase line that nobody has finished off yet. */
  unfinishedAssets: number
  recent: {
    id: string
    date: string
    counterparty: string
    direction: string
    status: string
    gross: string
    locked: boolean
  }[]
}

/** Trading money in and out for a range, one statement, net of VAT. */
async function tradingTotals(
  from: Date,
  to: Date,
): Promise<{ income: Prisma.Decimal; expenses: Prisma.Decimal }> {
  const [row] = await prisma.$queryRaw<{ income: Prisma.Decimal; expenses: Prisma.Decimal }[]>`
    SELECT
      COALESCE(SUM(l."net_amount") FILTER (WHERE t."direction" = 'income'), 0)::numeric  AS income,
      COALESCE(SUM(l."net_amount") FILTER (WHERE t."direction" = 'expense'), 0)::numeric AS expenses
    FROM "bk_transaction_lines" l
    JOIN "bk_transactions" t ON t."id" = l."transaction_id"
    JOIN "bk_categories" c ON c."id" = l."category_id"
    WHERE t."status" = 'posted'
      AND c."is_trading" = TRUE AND l."is_capital" = FALSE
      AND t."tax_point_date" BETWEEN ${from}::date AND ${to}::date
  `
  const zero = new Prisma.Decimal(0)
  return { income: row?.income ?? zero, expenses: row?.expenses ?? zero }
}

export async function getDashboard(): Promise<DashboardData> {
  const settings = await getSettings()
  const connection = await getConnection()
  const periods = await listPeriods()

  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

  // The period today falls in, if the owner has laid periods out. The VAT
  // position figure is that period's boxes as they stand right now.
  const current =
    periods.find(
      (p) => p.status !== 'submitted' && p.start_date <= today && today <= p.end_date,
    ) ?? null

  let vat: DashboardData['vat'] = null
  if (current) {
    const totals = await computeVatTotals(current.start_date, current.end_date, current.scheme)
    const boxes = assembleBoxes(totals, settings.box_rounding)
    vat = {
      periodId: current.id,
      start: toDateOnly(current.start_date),
      end: toDateOnly(current.end_date),
      due: current.due_date ? toDateOnly(current.due_date) : null,
      status: current.status,
      overdue: isOverdue(current),
      netVatDue: boxes.netVatDue,
      direction: netVatDirection(boxes),
      box1: boxes.vatDueSales,
      box4: boxes.vatReclaimedCurrPeriod,
    }
  }

  const dueSoon = periods
    .filter((p) => p.status !== 'submitted' && p.due_date)
    .sort((a, b) => a.due_date!.getTime() - b.due_date!.getTime())[0]
  const nextDue: DashboardData['nextDue'] = dueSoon
    ? {
        periodId: dueSoon.id,
        start: toDateOnly(dueSoon.start_date),
        end: toDateOnly(dueSoon.end_date),
        due: toDateOnly(dueSoon.due_date!),
        status: dueSoon.status,
        overdue: isOverdue(dueSoon),
        daysLeft: Math.ceil(
          (dueSoon.due_date!.getTime() + 24 * 60 * 60 * 1000 - Date.now()) / (24 * 60 * 60 * 1000),
        ),
      }
    : null

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const month = await tradingTotals(monthStart, today)

  const [draftRow] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_transactions" WHERE "status" = 'draft'
  `
  // Statement lines nobody has matched yet. A different queue from the drafts
  // above - drafts are half-written entries, these are the bank's own version of
  // events with nothing in the books against them - and the overview said
  // nothing at all about them until it counted them here. Archived accounts are
  // left out: their leftovers are history, not a job.
  const [unreconciledRow] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "bk_bank_transactions" b
    JOIN "bk_bank_accounts" a ON a."id" = b."bank_account_id"
    WHERE b."status" = 'unreconciled' AND a."archived" = FALSE
  `
  const [evidenceRow] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_transactions" t
    WHERE t."status" = 'posted'
      -- The ones somebody has said will never have a receipt are not a job.
      -- Counting them for six years is how a genuinely missing one stops being
      -- noticeable.
      AND t."evidence_not_required" = FALSE
      AND NOT EXISTS (SELECT 1 FROM "bk_attachments" a WHERE a."transaction_id" = t."id")
  `
  // An asset nobody finished off claims no capital allowances, so the tax
  // computation is quietly short by it. Counted here because the overview is
  // where a thing gets noticed, and the asset register is not somewhere anyone
  // visits unprompted.
  const unfinishedAssets = await countAssetDrafts()

  const recentList = await listTransactions({ limit: 6 })

  return {
    environment: settings.hmrc_environment,
    hmrc: {
      configured: isHmrcConfigured(),
      status: connection.status,
    },
    vat,
    nextDue,
    month: {
      from: toDateOnly(monthStart),
      income: formatMoney(month.income),
      expenses: formatMoney(month.expenses),
      profit: formatMoney(month.income.minus(month.expenses)),
    },
    drafts: Number(draftRow?.count ?? 0n),
    unreconciled: Number(unreconciledRow?.count ?? 0n),
    missingEvidence: Number(evidenceRow?.count ?? 0n),
    unfinishedAssets,
    recent: recentList.rows.map((row) => ({
      id: row.id,
      date: toDateOnly(row.tax_point_date),
      counterparty: row.counterparty,
      direction: row.direction,
      status: row.status,
      gross: formatMoney(row.gross_total),
      locked: !!row.locked_period_id,
    })),
  }
}
