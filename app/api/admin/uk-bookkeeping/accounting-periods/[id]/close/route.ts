import { NextRequest, NextResponse } from 'next/server'
import { closeYear, reopenYear } from '@/modules/uk-bookkeeping/lib/accounting-periods'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Closing a year and reopening it. Both need the filing permission rather than
// the recording one: closing a year is the point at which a set of accounts
// becomes a set of accounts, and it is not a thing to hand to everybody who can
// type in a receipt.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    return NextResponse.json({ period: await closeYear(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    return NextResponse.json({ period: await reopenYear(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
