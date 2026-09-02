import { NextRequest, NextResponse } from 'next/server'
import { createAttachment, hashBytes, listAttachments } from '@/modules/uk-bookkeeping/lib/attachments'
import { buildReadingContext, saveReading } from '@/modules/uk-bookkeeping/lib/documents'
import { readDocument } from '@/modules/uk-bookkeeping/lib/document-reading'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { readEvidenceUpload, storeEvidence } from '@/modules/uk-bookkeeping/lib/evidence-upload'
import { kindForTransaction } from '@/modules/uk-bookkeeping/lib/filing'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { getTransaction } from '@/modules/uk-bookkeeping/lib/transactions'

// Evidence for one entry.
//
// The checking and storing is lib/evidence-upload.ts, shared with the inbox
// route. Two copies of the rules that decide whether a file is kept at all
// would eventually disagree, and one of the two doors would have no lock on it.
//
// A receipt dropped straight onto an entry is read as well, even though nothing
// needs autofilling here: it costs nothing on a PDF, and it means the VAT number
// on it teaches the reader who this supplier is for every later document.

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await params
  return NextResponse.json({ attachments: await listAttachments(id) })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  const transaction = await getTransaction(id)
  if (!transaction) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const settings = await getSettings()
    const form = await request.formData().catch(() => null)
    const upload = await readEvidenceUpload(form, settings.attachment_max_bytes)

    // The entry decides the whole address here - its tax point, its direction,
    // its counterparty and its reference. The entry is the fact; whatever the
    // reader thinks it can see on the paper is a guess, and a guess does not get
    // to overrule one.
    const stored = await storeEvidence(upload, transaction.tax_point_date, gate.user.id, {
      kind: kindForTransaction(transaction),
      parts: {
        counterparty: transaction.counterparty,
        documentNumber: transaction.reference,
      },
    })

    const attachment = await createAttachment(
      {
        transactionId: id,
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

    // Best effort, and deliberately after the row exists. A reader that throws
    // must not be the reason a receipt fails to attach.
    try {
      const reading = readDocument(
        { bytes: upload.buffer, mimeType: upload.mimeType, filename: upload.filename },
        await buildReadingContext(),
      )
      await saveReading(attachment.id, reading)
    } catch {
      // Nothing to say. The evidence is attached, which is the job.
    }

    return NextResponse.json(attachment, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
