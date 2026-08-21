import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { fetchLiabilities } from '@/modules/uk-bookkeeping/lib/hmrc/service'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { HmrcCallBody } from '@/modules/uk-bookkeeping/lib/validation'

// What HMRC says is owed, and what it says has been paid. Read-only, and shown
// beside the module's own figures rather than reconciled against them: a
// difference between the two is a conversation with HMRC, not something for
// software to quietly resolve.
export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const parsed = HmrcCallBody.safeParse(body)
  const from = typeof body.from === 'string' ? body.from : null
  const to = typeof body.to === 'string' ? body.to : null
  if (!from || !to) {
    return NextResponse.json({ error: 'A date range is needed.' }, { status: 400 })
  }

  try {
    const inputs = {
      request,
      fraudBag: parsed.success ? (parsed.data.fraudBag ?? {}) : {},
      user: gate.user,
    }
    return NextResponse.json({ liabilities: await fetchLiabilities(inputs, from, to) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
