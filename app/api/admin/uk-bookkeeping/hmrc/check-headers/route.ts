import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { checkFraudHeaders } from '@/modules/uk-bookkeeping/lib/hmrc/service'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { HmrcCallBody } from '@/modules/uk-bookkeeping/lib/validation'

// HMRC marking our own homework: sends a real request carrying the real fraud
// prevention headers to their validator and reports back what they said.
//
// Worth having because sending these correctly is a precondition of production
// approval, and the alternative way to find out is ten working days into the
// application. Sandbox only - HMRC do not publish the validator on production.
export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const parsed = HmrcCallBody.safeParse(await request.json().catch(() => ({})))
  try {
    const verdict = await checkFraudHeaders({
      request,
      fraudBag: parsed.success ? (parsed.data.fraudBag ?? {}) : {},
      user: gate.user,
    })
    return NextResponse.json(verdict)
  } catch (error) {
    return toErrorResponse(error)
  }
}
