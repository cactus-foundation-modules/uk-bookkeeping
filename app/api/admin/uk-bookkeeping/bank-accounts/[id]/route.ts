import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  deleteOrArchiveBankAccount,
  requireBankAccount,
  updateBankAccount,
} from '@/modules/uk-bookkeeping/lib/bank-accounts'
import { getBankAccountPosition } from '@/modules/uk-bookkeeping/lib/bank-transactions'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await context.params

  try {
    const account = await requireBankAccount(id)
    return NextResponse.json({ account, position: await getBankAccountPosition(id) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error
  const { id } = await context.params

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ account: await updateBankAccount(id, body) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error
  const { id } = await context.params

  try {
    return NextResponse.json({ outcome: await deleteOrArchiveBankAccount(id) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
