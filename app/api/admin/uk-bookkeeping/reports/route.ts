import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import {
  balanceSheet,
  categorySummary,
  groupForTaxReturn,
  monthlyBreakdown,
  profitAndLoss,
} from '@/modules/uk-bookkeeping/lib/reports'
import { exportSummary } from '@/modules/uk-bookkeeping/lib/export'

function parseRange(query: URLSearchParams): { from: Date; to: Date } {
  const to = query.get('to') ? new Date(`${query.get('to')}T00:00:00.000Z`) : new Date()
  const from = query.get('from')
    ? new Date(`${query.get('from')}T00:00:00.000Z`)
    : new Date(Date.UTC(to.getUTCFullYear(), 0, 1))
  return { from, to }
}

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { from, to } = parseRange(request.nextUrl.searchParams)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: 'That date range is not one we can read.' }, { status: 400 })
  }

  try {
    const [summary, pl, bs, monthly, exported] = await Promise.all([
      categorySummary(from, to),
      profitAndLoss(from, to),
      // As at the end of the range, so the two reports on the screen are the
      // two halves of one set of accounts rather than two different dates.
      balanceSheet(to),
      monthlyBreakdown(from, to),
      exportSummary(),
    ])
    return NextResponse.json({
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      summary,
      profitAndLoss: pl,
      balanceSheet: bs,
      monthly,
      taxGrouping: groupForTaxReturn(summary, pl.businessType),
      records: exported,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
