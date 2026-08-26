import { NextRequest, NextResponse } from 'next/server'
import { hasPermission } from '@/lib/permissions/check'
import {
  deleteDocument,
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
        vatTreatment: body.vatTreatment ?? null,
      },
      gate.user,
    )
    return NextResponse.json({ document: toDocumentPayload(document) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  // `?deleteFile=1` throws the bytes away as well as the row. Deleting from the
  // media library is a media permission, not a bookkeeping one, and it is asked
  // for BEFORE anything is removed: somebody without it should be told to untick
  // the box, not left with the receipt gone and the file still sitting there.
  const deleteFile = request.nextUrl.searchParams.get('deleteFile') === '1'
  if (deleteFile && !(await hasPermission(gate.user, 'media.delete'))) {
    return NextResponse.json(
      {
        error:
          'You do not have permission to delete files from the media library. Untick that box and the receipt will still be thrown away.',
      },
      { status: 403 },
    )
  }

  const { id } = await params
  try {
    return NextResponse.json({ ok: true, ...(await deleteDocument(id, gate.user, deleteFile)) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
