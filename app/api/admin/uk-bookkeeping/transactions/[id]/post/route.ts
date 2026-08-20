import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { postDraft } from '@/modules/uk-bookkeeping/lib/transactions'

// An imported draft, reviewed by a human and turned into a record. Until this
// runs, the row reaches no VAT box at all.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    return NextResponse.json(await postDraft(id, gate.user))
  } catch (error) {
    return toErrorResponse(error)
  }
}
