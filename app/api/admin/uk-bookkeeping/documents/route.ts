import { NextRequest, NextResponse } from 'next/server'
import { createAttachment, hashBytes } from '@/modules/uk-bookkeeping/lib/attachments'
import {
  buildReadingContext,
  countUnfiledDocuments,
  listDocuments,
  saveReading,
  toDocumentPayload,
} from '@/modules/uk-bookkeeping/lib/documents'
import { readDocument } from '@/modules/uk-bookkeeping/lib/document-reading'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { readEvidenceUpload, storeEvidence } from '@/modules/uk-bookkeeping/lib/evidence-upload'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'

// The inbox: receipts and invoices that have arrived but have not been filed.
//
// The order of the POST matters and is not the obvious one. The file is READ
// before it is uploaded, because what we read off it includes the invoice date,
// and the invoice date decides which Bookkeeping / year / month folder it
// belongs in. Uploading first and reading second would file August's invoice
// under whatever month somebody got round to dealing with it.

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  try {
    const list = await listDocuments({
      unfiled: params.get('unfiled') !== '0',
      search: params.get('search'),
      from: params.get('from'),
      to: params.get('to'),
      limit: Number(params.get('limit') ?? 100),
      offset: Number(params.get('offset') ?? 0),
    })
    return NextResponse.json({
      rows: list.rows.map(toDocumentPayload),
      total: list.total,
      unfiledCount: await countUnfiledDocuments(),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  try {
    const settings = await getSettings()
    const form = await request.formData().catch(() => null)
    const upload = await readEvidenceUpload(form, settings.attachment_max_bytes)

    // Read first, upload second. See the note at the top of the file.
    const context = await buildReadingContext()
    const reading = readDocument(
      { bytes: upload.buffer, mimeType: upload.mimeType, filename: upload.filename },
      context,
    )

    const filedUnder = reading.documentDate
      ? new Date(`${reading.documentDate}T00:00:00Z`)
      : new Date()
    const stored = await storeEvidence(upload, filedUnder, gate.user.id)

    const document = await createAttachment(
      {
        transactionId: null,
        name: upload.name,
        filename: upload.filename,
        url: stored.url,
        mediaProvider: stored.provider,
        mediaKey: stored.key,
        mediaId: stored.mediaId,
        mimeType: upload.mimeType,
        size: stored.size,
        sha256: hashBytes(upload.buffer),
      },
      gate.user,
    )
    await saveReading(document.id, reading)

    return NextResponse.json(
      // The reading goes back with the row so the browser can say what it made
      // of the file without a second round trip, and so it can say WHY it could
      // not read one - scanNote is not a column, it is a sentence for a human.
      { id: document.id, reading },
      { status: 201 },
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
