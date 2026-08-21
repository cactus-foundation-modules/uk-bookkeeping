import { NextRequest, NextResponse } from 'next/server'
import { listAccountingPeriods } from '@/modules/uk-bookkeeping/lib/accounting-periods'
import {
  createComputationsForPeriod,
  listComputations,
  listRates,
} from '@/modules/uk-bookkeeping/lib/corporation-tax'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Every computation on the books, the years they could be drawn for, and the
// rates in force. The rates go out with the list because the screen shows them:
// a small company's owner rarely knows what the thresholds are this year, and
// showing them is most of the explanation for the bill.
export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  try {
    const [computations, periods, rates] = await Promise.all([
      listComputations(),
      listAccountingPeriods(),
      listRates(),
    ])
    return NextResponse.json({ computations, periods, rates })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  if (!body?.accountingPeriodId) {
    return NextResponse.json({ error: 'Which financial year?' }, { status: 400 })
  }

  try {
    return NextResponse.json({
      computations: await createComputationsForPeriod(body.accountingPeriodId, gate.user),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
