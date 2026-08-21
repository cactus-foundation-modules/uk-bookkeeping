import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { disposeFixedAsset, undoDisposal } from '@/modules/uk-bookkeeping/lib/fixed-assets'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Selling an asset, and taking that back when it was entered against the wrong
// one. Recording the sale does not post anything by itself - the money will
// have come in as an ordinary entry - but it takes the asset out of the capital
// allowances pool, which is what the tax computation needs to know.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ asset: await disposeFixedAsset(id, body, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    return NextResponse.json({ asset: await undoDisposal(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
