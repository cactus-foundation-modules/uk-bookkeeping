import { NextRequest, NextResponse } from 'next/server'
import type { MediaProviderType } from '@prisma/client'
import { downloadMedia } from '@/lib/media/upload'
import { prisma } from '@/lib/db/prisma'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import type { BkBankStatementRow } from '@/modules/uk-bookkeeping/lib/types'

// The statement file, back out again.
//
// Read by provider and key rather than by following the stored url, exactly as
// a receipt is, so a statement whose media library row somebody deleted still
// opens. A PDF is shown in the browser; anything else - a CSV - is sent as a
// download, because a browser rendering a spreadsheet as text in the admin's
// own origin helps nobody.
export const runtime = 'nodejs'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { id } = await params
  const rows = await prisma.$queryRaw<BkBankStatementRow[]>`
    SELECT * FROM "bk_bank_statements" WHERE "id" = ${id} LIMIT 1
  `
  const statement = rows[0]
  if (!statement) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (!statement.media_provider || !statement.media_key) {
    return NextResponse.json(
      {
        error:
          'No copy of that statement was kept. Statements imported before this site started keeping them have only their lines - import the file again to keep it.',
      },
      { status: 404 },
    )
  }

  // Headers carry latin-1 only, so a Unicode filename would make the Response
  // constructor throw inside the catch below and report a healthy file as
  // unreadable. ASCII in `filename`, the real name percent-encoded in `filename*`.
  const asciiName =
    statement.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'statement'
  const utf8Name = encodeURIComponent(statement.filename)

  const mimeType = statement.mime_type ?? 'application/octet-stream'
  const forced = request.nextUrl.searchParams.get('download') === '1'
  const disposition = !forced && mimeType === 'application/pdf' ? 'inline' : 'attachment'

  try {
    const bytes = await downloadMedia(
      statement.media_provider as MediaProviderType,
      statement.media_key,
      statement.url ?? '',
    )
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
        // Load-bearing: it is what stops a browser second-guessing the type
        // above and rendering something as a document.
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'That statement could not be read from storage. It may have been removed from the media library.' },
      { status: 404 },
    )
  }
}
