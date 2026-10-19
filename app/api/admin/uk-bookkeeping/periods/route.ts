import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { listPaymentStatuses } from '@/modules/uk-bookkeeping/lib/hmrc/service'
import { generateLocalPeriods, isOverdue, listPeriods } from '@/modules/uk-bookkeeping/lib/periods'

export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const [periods, statuses] = await Promise.all([listPeriods(), listPaymentStatuses()])
  const byPeriod = new Map(statuses.map((s) => [s.period_id, s]))
  return NextResponse.json({
    periods: periods.map((p) => ({ ...p, overdue: isOverdue(p), payment: byPeriod.get(p.id) ?? null })),
  })
}

// Lay periods out from the scheme and frequency, for a site that has not
// connected to HMRC - or has not yet.
export async function POST(_request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error
  try {
    const periods = await generateLocalPeriods(gate.user)
    return NextResponse.json({ periods: periods.map((p) => ({ ...p, overdue: isOverdue(p) })) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
