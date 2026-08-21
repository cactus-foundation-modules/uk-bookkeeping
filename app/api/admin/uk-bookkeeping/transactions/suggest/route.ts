import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import {
  listKnownCounterparties,
  suggestCategoryForCounterparty,
} from '@/modules/uk-bookkeeping/lib/transactions'

// Suggestions for the entry form: who this site has dealt with before, and -
// given a counterparty - which category their entries usually get filed under.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const counterparty = request.nextUrl.searchParams.get('counterparty')?.trim() ?? ''

  try {
    if (counterparty) {
      return NextResponse.json({
        categoryId: await suggestCategoryForCounterparty(counterparty),
      })
    }
    return NextResponse.json({ counterparties: await listKnownCounterparties() })
  } catch (error) {
    return toErrorResponse(error)
  }
}
