import { NextRequest, NextResponse } from 'next/server'
import {
  finaliseComputation,
  unfinaliseComputation,
} from '@/modules/uk-bookkeeping/lib/corporation-tax'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Marking a computation finished freezes its workings, the same way finalising
// a VAT return freezes the boxes. It does not file anything - nothing here can
// - and the screen says so plainly.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    return NextResponse.json({ row: await finaliseComputation(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    return NextResponse.json({ row: await unfinaliseComputation(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
