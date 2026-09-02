import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { deleteTransfer, requireTransfer, updateTransfer } from '@/modules/uk-bookkeeping/lib/transfers'
import { TransferBody } from '@/modules/uk-bookkeeping/lib/validation'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, { params }: Params) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  try {
    return NextResponse.json(await requireTransfer((await params).id))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const parsed = TransferBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  try {
    return NextResponse.json(await updateTransfer((await params).id, parsed.data, gate.user))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  try {
    await deleteTransfer((await params).id, gate.user)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
