import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { nominalLedger } from '@/modules/uk-bookkeeping/lib/ledger'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Everything that has hit one account, oldest first, with a running balance.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  const accountId = params.get('accountId')
  if (!accountId) {
    return NextResponse.json({ error: 'Which account?' }, { status: 400 })
  }

  try {
    const ledger = await nominalLedger(accountId, {
      from: params.get('from'),
      to: params.get('to'),
    })
    if (!ledger) return NextResponse.json({ error: 'That account could not be found.' }, { status: 404 })
    return NextResponse.json(ledger)
  } catch (error) {
    return toErrorResponse(error)
  }
}
