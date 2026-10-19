import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { refreshPaymentStatuses } from '@/modules/uk-bookkeeping/lib/hmrc/service'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { HmrcCallBody } from '@/modules/uk-bookkeeping/lib/validation'

// Asks HMRC whether the returns filed from here have been paid. Called when the
// VAT page opens, and it keeps asking about a return until HMRC's liability for
// it shows nothing outstanding - after which that return is never asked about
// again, and a page with nothing left to ask about makes no call to HMRC at all.
export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = HmrcCallBody.safeParse(body)

  try {
    const result = await refreshPaymentStatuses(
      { request, fraudBag: parsed.success ? (parsed.data.fraudBag ?? {}) : {}, user: gate.user },
      { force: body.force === true },
    )
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
