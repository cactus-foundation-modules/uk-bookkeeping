import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { getOrCreateFolderByPath, resolveFolderPath } from '@/lib/media/organise'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { filingFolderNames, kindForTransaction, type FilingKind, type FilingNameParts } from './filing'
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

/**
 * Media library folder these land in: Bookkeeping / <year> / <month> / <kind>.
 *
 * The kind folder - Customer Invoices, Purchase Receipts and the rest - is
 * lib/filing.ts's business, and is left off entirely when nothing has said what
 * the document is yet. See that file for the whole layout.
 */
export async function resolveEvidenceFolderId(
  date: Date,
  kind: FilingKind | null = null,
): Promise<string | null> {
  return getOrCreateFolderByPath(filingFolderNames(date, kind))
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

// ---------------------------------------------------------------------------
// One file, evidence for several entries
// ---------------------------------------------------------------------------

/** How many entries one shared file may be attached to in one go. */
export const MAX_SHARED_ATTACHMENTS = 200

export type SharedAttachmentTarget = {
  id: string
  taxPointDate: Date
  counterparty: string
}

export type SharedAttachmentTargets = {
  usable: SharedAttachmentTarget[]
  failed: { id: string; error: string }[]
  /** Where the one stored copy is filed: see sharedFilingFor. */
  filedUnder: Date | null
  kind: FilingKind | null
  parts: FilingNameParts
}

/**
 * Which of the ticked entries can take a file, and where the file should live.
 *
 * Checked BEFORE anything is uploaded, so a batch where none can take it never
 * stores a file that nothing points at. An entry in a filed or finalised VAT
 * return is named and left out rather than refusing the lot: one locked entry
 * among thirty fee lines should not strand the other twenty-nine.
 *
 * The stored copy is filed by what the entries have in common. The latest date
 * among them decides the month folder, because a statement covering a month is
 * dated at its end. The kind and the name come from the entries only when they
 * all agree on them - a monthly fee statement for thirty "SQUARE" entries is
 * filed as SQUARE's, and a file shared by entries for three different people is
 * left under the name it was uploaded with rather than credited to one of them.
 */
export async function sharedAttachmentTargets(ids: string[]): Promise<SharedAttachmentTargets> {
  const wanted = [...new Set(ids)]
  const rows = await prisma.$queryRaw<
    {
      id: string
      tax_point_date: Date
      counterparty: string
      direction: 'income' | 'expense'
      entry_type: string | null
      corrects_transaction_id: string | null
      locked_period_id: string | null
      finalised_period_id: string | null
    }[]
  >`
    SELECT "id", "tax_point_date", "counterparty", "direction", "entry_type", "corrects_transaction_id",
           "locked_period_id", "finalised_period_id"
    FROM "bk_transactions"
    WHERE "id" = ANY(${wanted}::text[])
  `
  const byId = new Map(rows.map((row) => [row.id, row]))

  const usable: SharedAttachmentTarget[] = []
  const failed: { id: string; error: string }[] = []
  const kinds = new Set<FilingKind>()
  const names = new Set<string>()
  let filedUnder: Date | null = null

  for (const id of wanted) {
    const row = byId.get(id)
    if (!row) {
      failed.push({ id, error: 'That entry could not be found.' })
      continue
    }
    if (row.locked_period_id) {
      failed.push({ id, error: `The entry for ${row.counterparty} is in a VAT return that has been filed, so its evidence stays as it is.` })
      continue
    }
    if (row.finalised_period_id) {
      failed.push({ id, error: `The entry for ${row.counterparty} is in a VAT return that has been finalised. Unfinalise it first to add evidence.` })
      continue
    }
    usable.push({ id, taxPointDate: row.tax_point_date, counterparty: row.counterparty })
    kinds.add(kindForTransaction(row))
    names.add(row.counterparty.trim().toLowerCase())
    if (!filedUnder || row.tax_point_date > filedUnder) filedUnder = row.tax_point_date
  }

  const kind = kinds.size === 1 ? [...kinds][0]! : null
  const counterparty = names.size === 1 ? usable[0]!.counterparty.trim() : undefined
  return { usable, failed, filedUnder, kind, parts: counterparty ? { counterparty } : {} }
}

/**
 * Attach one stored file to several entries.
 *
 * The file is stored once and each entry gets its own attachment row pointing
 * at it. That is safe because removing evidence from an entry deletes the row
 * and never the file (see deleteAttachment), so taking it off one entry cannot
 * pull it out from under the others - and it means thirty fee entries do not
 * store thirty copies of the same statement.
 *
 * Each entry goes through createAttachment, so each is re-checked at the moment
 * of writing and audited on its own history. One that fails - locked since the
 * check, say - comes back by name and does not stop the rest.
 */
export async function attachToSeveral(
  file: Omit<AttachmentInput, 'transactionId'>,
  targets: SharedAttachmentTarget[],
  user: SessionUser | null,
): Promise<{ done: number; failed: { id: string; error: string }[]; attachmentIds: string[] }> {
  const failed: { id: string; error: string }[] = []
  const attachmentIds: string[] = []
  for (const target of targets) {
    try {
      const row = await createAttachment({ ...file, transactionId: target.id }, user)
      attachmentIds.push(row.id)
    } catch (error) {
      failed.push({
        id: target.id,
        error:
          error instanceof BookkeepingError
            ? `The entry for ${target.counterparty} could not take it: ${error.message}`
            : `The entry for ${target.counterparty} could not take it.`,
      })
    }
  }
  return { done: attachmentIds.length, failed, attachmentIds }
}
