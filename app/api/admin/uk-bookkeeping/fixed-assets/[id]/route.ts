import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  deleteFixedAsset,
  listChargesFor,
  requireFixedAsset,
  updateFixedAsset,
} from '@/modules/uk-bookkeeping/lib/fixed-assets'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    const [asset, charges] = await Promise.all([requireFixedAsset(id), listChargesFor(id)])
    return NextResponse.json({ asset, charges })
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
    return NextResponse.json({ asset: await updateFixedAsset(id, body, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    await deleteFixedAsset(id, gate.user)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
