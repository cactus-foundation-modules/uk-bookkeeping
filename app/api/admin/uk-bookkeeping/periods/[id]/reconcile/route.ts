import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { reconcileWithHmrc } from '@/modules/uk-bookkeeping/lib/hmrc/service'
import { HmrcCallBody } from '@/modules/uk-bookkeeping/lib/validation'

// "Check with HMRC", offered after a duplicate-submission refusal. Asks HMRC
// what it holds and completes the local record only if it matches what we froze.
// Nothing is ever sent again.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const { id } = await params
  const parsed = HmrcCallBody.safeParse(await request.json().catch(() => ({})))
  try {
    const result = await reconcileWithHmrc(id, {
      request,
      fraudBag: parsed.success ? (parsed.data.fraudBag ?? {}) : {},
      user: gate.user,
    })
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
