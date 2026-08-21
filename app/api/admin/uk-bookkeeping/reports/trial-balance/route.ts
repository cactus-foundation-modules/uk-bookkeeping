import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { ledgerHealth, trialBalance } from '@/modules/uk-bookkeeping/lib/ledger'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// The trial balance, and whether the books can be trusted to add up.
//
// The health check rides along rather than being a second request: a trial
// balance that does not balance needs its reason on the same screen, and the
// reason is almost always one of the things ledgerHealth names.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const asAt = request.nextUrl.searchParams.get('asAt')
  try {
    const [rows, health] = await Promise.all([trialBalance(asAt), ledgerHealth()])
    return NextResponse.json({ trialBalance: rows, health })
  } catch (error) {
    return toErrorResponse(error)
  }
}
