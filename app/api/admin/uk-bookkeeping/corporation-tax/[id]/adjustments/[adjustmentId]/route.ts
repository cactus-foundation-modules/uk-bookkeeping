import { NextRequest, NextResponse } from 'next/server'
import { deleteAdjustment, refreshComputation } from '@/modules/uk-bookkeeping/lib/corporation-tax'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; adjustmentId: string }> },
) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id, adjustmentId } = await params

  try {
    await deleteAdjustment(adjustmentId, gate.user)
    return NextResponse.json({ computation: await refreshComputation(id) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
