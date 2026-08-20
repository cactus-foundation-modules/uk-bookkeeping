import { NextRequest, NextResponse } from 'next/server'
import { downloadMedia } from '@/lib/media/upload'
import type { MediaProviderType } from '@prisma/client'
import { deleteAttachment, getAttachment } from '@/modules/uk-bookkeeping/lib/attachments'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Downloading a receipt, and removing one.
//
// The download reads by provider and key rather than following the stored url,
// so a file whose media library row somebody deleted still comes back. Always
// as an attachment, never inline: nothing in an evidence folder should ever be
// rendered by the browser in the same origin as the admin.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { id } = await params
  const attachment = await getAttachment(id)
  if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!attachment.media_provider || !attachment.media_key) {
    return NextResponse.redirect(attachment.url)
  }

  try {
    const bytes = await downloadMedia(
      attachment.media_provider as MediaProviderType,
      attachment.media_key,
      attachment.url,
    )
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': attachment.mime_type,
        'Content-Disposition': `attachment; filename="${attachment.filename.replace(/"/g, '')}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'That file could not be read from storage. It may have been removed from the media library.' },
      { status: 404 },
    )
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
