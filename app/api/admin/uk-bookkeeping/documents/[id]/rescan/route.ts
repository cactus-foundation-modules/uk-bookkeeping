import { NextRequest, NextResponse } from 'next/server'
import { downloadMedia } from '@/lib/media/upload'
import type { MediaProviderType } from '@prisma/client'
import {
  getDocument,
  rescanDocument,
  toDocumentPayload,
} from '@/modules/uk-bookkeeping/lib/documents'
import { BookkeepingError, toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Reading a document again.
//
// Worth having for the one case the reader keeps getting better at: a supplier
// nobody had dealt with the first time round is a supplier the books know by the
// third invoice, and re-reading the first one then finds the name it could not
// find before.
//
// Refused on a document somebody has already checked by hand unless they ask
// twice with ?force=1 - the point of confirming a reading is that nothing
// silently overwrites it afterwards.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    const document = await getDocument(id)
    if (!document) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (!document.media_provider || !document.media_key) {
      throw new BookkeepingError(
        'no_stored_copy',
        'We have no stored copy of that file to read, only a link to it.',
        409,
      )
    }

    const bytes = await downloadMedia(
      document.media_provider as MediaProviderType,
      document.media_key,
      document.url,
    ).catch(() => null)
    if (!bytes) {
      throw new BookkeepingError(
        'unreadable',
        'That file could not be read from storage. It may have been removed from the media library.',
        404,
      )
    }

    const force = request.nextUrl.searchParams.get('force') === '1'
    const reading = await rescanDocument(id, Buffer.from(bytes), gate.user, force)
    const updated = await getDocument(id)
    return NextResponse.json({
      reading,
      document: updated ? toDocumentPayload(updated) : null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
