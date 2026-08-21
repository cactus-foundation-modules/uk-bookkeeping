import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { listSettlementCandidates } from '@/modules/uk-bookkeeping/lib/reconcile-actions'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// The entries a payout might be settling: everything still unaccounted for
// around this line's date, in date order, with what is left of each. Kept off
// the main list read because it is only wanted on the one line being worked on,
// and asking for it per row would be a query per row.

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    return NextResponse.json(
      await listSettlementCandidates(id, { search: request.nextUrl.searchParams.get('search') }),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
