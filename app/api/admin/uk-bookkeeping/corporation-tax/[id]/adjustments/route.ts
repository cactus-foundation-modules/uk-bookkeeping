import { NextRequest, NextResponse } from 'next/server'
import { addAdjustment, refreshComputation } from '@/modules/uk-bookkeeping/lib/corporation-tax'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    const adjustment = await addAdjustment(id, body, gate.user)
    return NextResponse.json({ adjustment, computation: await refreshComputation(id) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
