import { NextRequest, NextResponse } from 'next/server'
import {
  deleteComputation,
  listAdjustments,
  refreshComputation,
  requireComputation,
  updateComputation,
} from '@/modules/uk-bookkeeping/lib/corporation-tax'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

/**
 * One computation, worked out fresh.
 *
 * A DRAFT is recomputed on every view and the answer saved, so the pool
 * balances and losses the next period carries in are always the ones this
 * period actually produced. A FINISHED one is read back out of the frozen JSON
 * instead: a computation printed in June has to still read the same in
 * November, whatever has happened to the books since.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    const row = await requireComputation(id)
    const adjustments = await listAdjustments(id)
    const computation =
      row.status === 'final' && row.computation ? row.computation : await refreshComputation(id)
    return NextResponse.json({ row, computation, adjustments })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    const row = await updateComputation(id, body, gate.user)
    return NextResponse.json({ row, computation: await refreshComputation(id) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    await deleteComputation(id, gate.user)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
