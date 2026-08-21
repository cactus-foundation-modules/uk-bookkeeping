import { NextResponse } from 'next/server'
import { getDashboard } from '@/modules/uk-bookkeeping/lib/dashboard'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// The overview figures. Read-only, one call for the whole screen.
export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  try {
    return NextResponse.json(await getDashboard())
  } catch (error) {
    return toErrorResponse(error)
  }
}
