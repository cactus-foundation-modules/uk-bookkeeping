import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import {
  MAX_SHARED_ATTACHMENTS,
  attachToSeveral,
  hashBytes,
  sharedAttachmentTargets,
} from '@/modules/uk-bookkeeping/lib/attachments'
import { buildReadingContext, saveReading } from '@/modules/uk-bookkeeping/lib/documents'
import { readDocument } from '@/modules/uk-bookkeeping/lib/document-reading'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { readEvidenceUpload, storeEvidence } from '@/modules/uk-bookkeeping/lib/evidence-upload'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'

// One file, evidence for every ticked entry: a monthly statement of card fees
// against each fee the payouts recorded, one invoice covering several
// deliveries. Stored once, attached to each - see attachToSeveral for why that
// is safe.
//
// Multipart, like the single-entry route: `file`, optional `name`, and `ids` as
// a JSON array of entry ids.

const IDS = z.array(z.string().min(1)).min(1).max(MAX_SHARED_ATTACHMENTS)

function readIds(raw: FormDataEntryValue | null | undefined): string[] | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = IDS.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  try {
    const form = await request.formData().catch(() => null)
    const ids = readIds(form?.get('ids'))
    if (!ids) {
      return NextResponse.json(
        { error: `Tick between 1 and ${MAX_SHARED_ATTACHMENTS} entries to attach the file to.` },
        { status: 400 },
      )
    }

    const settings = await getSettings()
    const upload = await readEvidenceUpload(form, settings.attachment_max_bytes)

    // Who can take it, worked out before the upload: if nobody can, nothing is
    // stored, and there is no orphaned file in the media library to explain.
    const targets = await sharedAttachmentTargets(ids)
    if (targets.usable.length === 0 || !targets.filedUnder) {
      return NextResponse.json(
        {
          error: targets.failed[0]?.error ?? 'None of those entries can take a file.',
          done: 0,
          failed: targets.failed,
        },
        { status: 409 },
      )
    }

    const stored = await storeEvidence(upload, targets.filedUnder, gate.user.id, {
      kind: targets.kind,
      parts: targets.parts,
    })

    const outcome = await attachToSeveral(
      {
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
      targets.usable,
      gate.user,
    )

    // Read once, kept against every copy. Best effort and after the rows exist,
    // the same as the single-entry route: a reader that throws must not be the
    // reason evidence fails to attach.
    if (outcome.attachmentIds.length > 0) {
      try {
        const reading = readDocument(
          { bytes: upload.buffer, mimeType: upload.mimeType, filename: upload.filename },
          await buildReadingContext(),
        )
        for (const attachmentId of outcome.attachmentIds) await saveReading(attachmentId, reading)
      } catch {
        // Nothing to say. The evidence is attached, which is the job.
      }
    }

    return NextResponse.json({ done: outcome.done, failed: [...targets.failed, ...outcome.failed] })
  } catch (error) {
    return toErrorResponse(error)
  }
}
