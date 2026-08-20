import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { syncObligations } from '@/modules/uk-bookkeeping/lib/hmrc/service'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { isOverdue, listPeriods } from '@/modules/uk-bookkeeping/lib/periods'
import { HmrcCallBody } from '@/modules/uk-bookkeeping/lib/validation'

// Ask HMRC what it expects, and match it onto the local periods by date range.
export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const parsed = HmrcCallBody.safeParse(await request.json().catch(() => ({})))
  try {
    const result = await syncObligations({
      request,
      fraudBag: parsed.success ? (parsed.data.fraudBag ?? {}) : {},
      user: gate.user,
    })
    const periods = await listPeriods()
    return NextResponse.json({
      ...result,
      periods: periods.map((p) => ({ ...p, overdue: isOverdue(p) })),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
