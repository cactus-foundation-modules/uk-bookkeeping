import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { getOrCreateFolderByPath, resolveFolderPath } from '@/lib/media/organise'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { assertTransactionMutable } from './guards'
import type { BkAttachmentRow } from './types'

// Evidence, and where it lives.
//
// Attachments go through core's media abstraction, whatever provider the site
// happens to use - B2, R2, S3, Spaces, Wasabi, MinIO, Vercel Blob, Supabase,
// Cloudinary, ImageKit. Never a hardcoded bucket.
//
// Each row keeps the provider and key as well as the url, so a download still
// works if somebody deletes the media library row - and the module registers a
// core.media-usage-providers extension so the library never counts these as
// unused clutter in the first place. HMRC expects records kept six years; the
// media tidy-up must not be the thing that loses them.

/** Media library folder these land in: Bookkeeping / <year> / <month>. */
export async function resolveEvidenceFolderId(date: Date): Promise<string | null> {
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return getOrCreateFolderByPath(['Bookkeeping', year, month])
}

export async function evidenceFolderPath(folderId: string | null): Promise<string> {
  if (!folderId) return ''
  return resolveFolderPath(folderId)
}

export function hashBytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function listAttachments(transactionId: string): Promise<BkAttachmentRow[]> {
  return prisma.$queryRaw<BkAttachmentRow[]>`
    SELECT * FROM "bk_attachments" WHERE "transaction_id" = ${transactionId}
    ORDER BY "position" ASC, "created_at" ASC
  `
}

export async function getAttachment(id: string): Promise<BkAttachmentRow | null> {
  const rows = await prisma.$queryRaw<BkAttachmentRow[]>`
    SELECT * FROM "bk_attachments" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

export type AttachmentInput = {
  /**
   * Null for a document uploaded into the inbox before anybody has said what it
   * belongs to. See lib/documents.ts, which is the other half of this.
   */
  transactionId: string | null
  name: string
  filename: string
  url: string
  mediaProvider: string | null
  mediaKey: string | null
  mediaId: string | null
  mimeType: string
  size: number
  sha256: string | null
}

export async function createAttachment(
  input: AttachmentInput,
  user: SessionUser | null,
): Promise<BkAttachmentRow> {
  if (input.transactionId) await assertTransactionMutable(input.transactionId)

  // `= NULL` matches nothing, so an inbox upload starts at position 0 and stays
  // there. Position only orders the evidence ON an entry; the inbox is ordered
  // by when it arrived.
  const [next] = await prisma.$queryRaw<{ position: number }[]>`
    SELECT COALESCE(MAX("position") + 1, 0)::int AS position
    FROM "bk_attachments" WHERE "transaction_id" = ${input.transactionId}
  `

  const rows = await prisma.$queryRaw<BkAttachmentRow[]>`
    INSERT INTO "bk_attachments" (
      "transaction_id", "name", "filename", "url", "media_provider", "media_key",
      "media_id", "mime_type", "size", "sha256", "position", "uploaded_by_user_id"
    ) VALUES (
      ${input.transactionId}, ${input.name}, ${input.filename}, ${input.url},
      ${input.mediaProvider}, ${input.mediaKey}, ${input.mediaId}, ${input.mimeType},
      ${input.size}, ${input.sha256}, ${next?.position ?? 0}, ${user?.id ?? null}
    )
    RETURNING *
  `

  await appendAudit({
    action: 'attachment.added',
    entityType: input.transactionId ? 'transaction' : 'attachment',
    entityId: input.transactionId ?? rows[0]!.id,
    summary: input.transactionId
      ? `Evidence “${input.name}” attached`
      : `Document “${input.name}” added to the inbox`,
    detail: { filename: input.filename, size: input.size, sha256: input.sha256 },
    user,
  })

  return rows[0]!
}

export async function deleteAttachment(id: string, user: SessionUser | null): Promise<void> {
  const attachment = await getAttachment(id)
  if (!attachment) throw new NotFoundError('That piece of evidence')
  if (attachment.locked_period_id) {
    throw new BookkeepingError(
      'locked',
      'That evidence belongs to a VAT return that has been filed, so it stays where it is.',
      409,
    )
  }
  if (attachment.transaction_id) await assertTransactionMutable(attachment.transaction_id)

  // The row goes; the blob does not. A file may be attached elsewhere, and it is
  // in the media library under the site owner's own control - deleting somebody
  // else's bytes on their behalf is not this module's business.
  await prisma.$executeRaw`DELETE FROM "bk_attachments" WHERE "id" = ${id}`

  await appendAudit({
    action: 'attachment.removed',
    entityType: attachment.transaction_id ? 'transaction' : 'attachment',
    entityId: attachment.transaction_id ?? attachment.id,
    summary: attachment.transaction_id
      ? `Evidence “${attachment.name}” removed`
      : `Document “${attachment.name}” removed from the inbox`,
    detail: { filename: attachment.filename },
    user,
  })
}
