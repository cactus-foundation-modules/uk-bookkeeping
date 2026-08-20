import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { finalisePeriod, unfinalisePeriod } from '@/modules/uk-bookkeeping/lib/periods'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    return NextResponse.json({ period: await finalisePeriod(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

// Reopening. The snapshot stays - it is append-only, and it is now the evidence
// of what the figures were before somebody changed their mind.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    return NextResponse.json({ period: await unfinalisePeriod(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
