import { NextRequest, NextResponse } from 'next/server'
import {
  createAccountingPeriod,
  listAccountingPeriods,
  suggestNextPeriod,
} from '@/modules/uk-bookkeeping/lib/accounting-periods'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Financial years. The suggestion rides along with the list so the "add a year"
// form arrives already filled in - a business should not have to go and look up
// its own year end to use this screen.
export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  try {
    const [periods, suggestion] = await Promise.all([listAccountingPeriods(), suggestNextPeriod()])
    return NextResponse.json({ periods, suggestion })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ period: await createAccountingPeriod(body, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
