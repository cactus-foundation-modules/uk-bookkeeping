import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { agedAnalysis } from '@/modules/uk-bookkeeping/lib/reports'

// Who owes the business money and how long they have owed it, or the same the
// other way round. Both directions in one response: they are read side by side
// and two requests would only mean two chances of them being as at different
// dates.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const raw = request.nextUrl.searchParams.get('asAt')
  const asAt = raw ? new Date(`${raw}T00:00:00.000Z`) : new Date()
  if (Number.isNaN(asAt.getTime())) {
    return NextResponse.json({ error: 'That date is not one we can read.' }, { status: 400 })
  }

  try {
    const [owedToUs, weOwe] = await Promise.all([
      agedAnalysis('income', asAt),
      agedAnalysis('expense', asAt),
    ])
    return NextResponse.json({ owedToUs, weOwe })
  } catch (error) {
    return toErrorResponse(error)
  }
}
