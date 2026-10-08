import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { viewFiledReturn } from '@/modules/uk-bookkeeping/lib/hmrc/service'
import { HmrcCallBody } from '@/modules/uk-bookkeeping/lib/validation'

// "See what HMRC holds" on a filed return. Asks HMRC for the figures they have
// and returns them beside ours. Read-only: nothing is sent and nothing changes.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const { id } = await params
  const parsed = HmrcCallBody.safeParse(await request.json().catch(() => ({})))
  try {
    const result = await viewFiledReturn(id, {
      request,
      fraudBag: parsed.success ? (parsed.data.fraudBag ?? {}) : {},
      user: gate.user,
    })
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
