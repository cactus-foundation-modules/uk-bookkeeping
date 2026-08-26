import { NextRequest, NextResponse } from 'next/server'
import {
  attachDocument,
  detachDocument,
  toDocumentPayload,
} from '@/modules/uk-bookkeeping/lib/documents'
import { BookkeepingError, toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Giving an unfiled document an entry to belong to, and taking it off one again.
//
// One column changes. The bytes are already in storage, already in the media
// library, already hashed and already counted as in use - so filing cannot
// half-happen and leave a receipt nobody can find, and unfiling is not a
// deletion.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const transactionId = typeof body.transactionId === 'string' ? body.transactionId.trim() : ''
    if (!transactionId) {
      throw new BookkeepingError('invalid', 'Which entry this belongs to has to be said.')
    }
    return NextResponse.json({
      document: toDocumentPayload(await attachDocument(id, transactionId, gate.user)),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    return NextResponse.json({ document: toDocumentPayload(await detachDocument(id, gate.user)) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
