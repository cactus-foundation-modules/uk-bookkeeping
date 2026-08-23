import { NextRequest, NextResponse } from 'next/server'
import { downloadMedia } from '@/lib/media/upload'
import type { MediaProviderType } from '@prisma/client'
import { deleteAttachment, getAttachment } from '@/modules/uk-bookkeeping/lib/attachments'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Opening a receipt, and removing one.
//
// The read goes by provider and key rather than following the stored url, so a
// file whose media library row somebody deleted still comes back.
//
// WHAT IS SHOWN IN THE BROWSER AND WHAT IS NOT. This used to force a download
// on everything, on the grounds that nothing in an evidence folder should be
// rendered in the same origin as the admin - which is the right worry and the
// wrong remedy: it made checking a receipt against an entry a matter of saving
// the thing to disk first, every time.
//
// So: an allowlist, and only an allowlist. A PDF or an ordinary photograph is
// shown; everything else is still sent as a download. The dangerous case is a
// file the browser will treat as a document in our origin - HTML, or an SVG,
// which is XML that may carry script - and neither is on the list. `nosniff`
// is what makes the list mean anything: without it a browser may look inside a
// file declared as a PDF, decide it is really HTML, and run it. The mime type
// is recorded at upload from what the browser reported, so it is not trusted
// to be true - only to be one of these.
//
// `?download=1` forces the save-to-disk behaviour for anything, which is what
// the Download link beside each file uses.
const VIEWABLE_IN_BROWSER = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/heic',
  'image/heif',
])

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { id } = await params
  const attachment = await getAttachment(id)
  if (!attachment) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!attachment.media_provider || !attachment.media_key) {
    return NextResponse.redirect(attachment.url)
  }

  // Headers only carry latin-1, so an accented or Unicode upload name would
  // make the Response constructor throw - inside the catch below, telling the
  // owner a perfectly healthy file "could not be read from storage". ASCII
  // fallback in `filename`, the real name percent-encoded in `filename*`.
  const asciiName =
    attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'attachment'
  const utf8Name = encodeURIComponent(attachment.filename)

  const forced = request.nextUrl.searchParams.get('download') === '1'
  const disposition =
    !forced && VIEWABLE_IN_BROWSER.has(attachment.mime_type.toLowerCase()) ? 'inline' : 'attachment'

  try {
    const bytes = await downloadMedia(
      attachment.media_provider as MediaProviderType,
      attachment.media_key,
      attachment.url,
    )
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': attachment.mime_type,
        'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
        // Load-bearing, not belt and braces: it is what stops a browser
        // second-guessing the type above and rendering something as a document.
        'X-Content-Type-Options': 'nosniff',
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
