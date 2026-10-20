import { NextRequest, NextResponse } from 'next/server'
import { allEntries } from '@/modules/uk-bookkeeping/lib/all-entries'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Every entry in the range with the category it was filed under. Capped for the
// screen; the spreadsheet download is not.
const SCREEN_LIMIT = 5000

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const query = request.nextUrl.searchParams
  const to = query.get('to') ? new Date(`${query.get('to')}T00:00:00.000Z`) : new Date()
  const from = query.get('from')
    ? new Date(`${query.get('from')}T00:00:00.000Z`)
    : new Date(Date.UTC(to.getUTCFullYear(), 0, 1))
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: 'That date range is not one we can read.' }, { status: 400 })
  }

  try {
    return NextResponse.json(await allEntries(from, to, { limit: SCREEN_LIMIT }))
  } catch (error) {
    return toErrorResponse(error)
  }
}
