import { NextRequest, NextResponse } from 'next/server'
import { deleteAttachment } from '@/modules/uk-bookkeeping/lib/attachments'
import {
  getDocument,
  toDocumentPayload,
  updateDocumentReading,
} from '@/modules/uk-bookkeeping/lib/documents'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// One document: what it says, correcting what it says, and throwing it away.
//
// The FILE itself is opened and downloaded through /admin/attachments/[id],
// which knows about content types and dispositions and does not need a second
// implementation here.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { id } = await params
  const document = await getDocument(id)
  if (!document) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ document: toDocumentPayload(document) })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const document = await updateDocumentReading(
      id,
      {
        counterparty: body.counterparty ?? null,
        direction: body.direction ?? null,
        documentDate: body.documentDate ?? null,
        documentNumber: body.documentNumber ?? null,
        net: body.net ?? null,
        vat: body.vat ?? null,
        total: body.total ?? null,
        vatRateCode: body.vatRateCode ?? null,
      },
      gate.user,
    )
    return NextResponse.json({ document: toDocumentPayload(document) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    await deleteAttachment(id, gate.user)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
