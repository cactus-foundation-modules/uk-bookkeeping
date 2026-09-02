import { createHash } from 'node:crypto'
import type { MediaProviderType } from '@prisma/client'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import {
  buildLibraryUploadKey,
  deleteMediaBytes,
  saveMediaRecord,
  uploadMedia,
} from '@/lib/media/upload'
import { prisma } from '@/lib/db/prisma'
import { evidenceFolderPath, resolveEvidenceFolderId } from './attachments'
import { filingFilename } from './filing'

// The statement file itself.
//
// Kept, from now on, rather than parsed and dropped. "Show me the statement
// that line came off" is the first thing anybody asks when a figure looks odd,
// and until this existed the honest answer was "we read it and threw it away".
//
// It goes into the media library beside every other piece of evidence, under
// Bookkeeping / <year> / <month> / Bank Statements, named after the account it
// belongs to - "Tide Current Account.pdf" - because that is what somebody
// opening the month's folder is looking for. Not the bank's export name, which
// is usually a serial number and a timestamp.
//
// Deliberately NOT an entry in bk_attachments. An attachment is evidence FOR an
// entry; a statement is the bank's own record of the account, it belongs to no
// single entry, and putting it in that table would make it turn up in the
// unfiled-documents inbox asking to be coded.

/** What a statement file can be. A photograph of a paper statement has no text
 *  in it to read, so it never gets this far - see the import route. */
const STATEMENT_MIME: Record<'csv' | 'pdf', string> = {
  csv: 'text/csv',
  pdf: 'application/pdf',
}

export type StatementFileInput = {
  bytes: Buffer
  /** What the bank called it. Only its extension survives into the stored name. */
  filename: string
  format: 'csv' | 'pdf'
  /** The account this statement is for. It is what the file gets named. */
  bankAccountName: string
  /** Which month's folder it lands in - the end of the period it covers. */
  filedUnder: Date
}

export type StoredStatementFile = {
  url: string
  provider: string
  key: string
  mediaId: string | null
  mimeType: string
  size: number
  sha256: string
}

/**
 * Put a statement file in the library, or say in a sentence why it is not there.
 *
 * Never throws, and never fails an import. The lines are the thing that has to
 * land - they are what reconciliation works from - and a file store having a bad
 * afternoon is not a reason to lose a month of statement lines. A failure comes
 * back as a note the screen shows, and re-importing the same statement tries the
 * file again.
 */
export async function storeStatementFile(
  input: StatementFileInput,
  uploadedById: string | null,
): Promise<{ stored: StoredStatementFile | null; note: string | null }> {
  try {
    const provider = await getActiveMediaProvider()
    if (!provider || !isMediaProviderConfigured(provider)) {
      return {
        stored: null,
        note: 'The statement lines are in, but the file itself is not kept: this site has no file storage set up yet.',
      }
    }

    const mimeType = STATEMENT_MIME[input.format]
    const folderId = await resolveEvidenceFolderId(input.filedUnder, 'bank-statement')
    const folderPath = await evidenceFolderPath(folderId)

    const storedName =
      filingFilename('bank-statement', { accountName: input.bankAccountName }, input.filename) ||
      input.filename

    // The key is settled before the bytes go anywhere, so a second statement for
    // the same account in the same month lands as "-2" instead of writing over
    // the first. Replacing one on purpose is a different operation - see
    // replaceStatementFile - and it goes through the row, not through a key
    // collision nobody asked for.
    const presetKey = await buildLibraryUploadKey(
      provider,
      mimeType,
      storedName,
      folderPath || undefined,
    )

    const result = await uploadMedia(
      input.bytes,
      mimeType,
      provider,
      storedName,
      folderPath || undefined,
      false,
      presetKey,
    )

    const record = await saveMediaRecord({
      key: result.key,
      url: result.url,
      provider,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      uploadedById: uploadedById ?? undefined,
      originalName: storedName,
      folderId,
    })

    return {
      stored: {
        url: result.url,
        provider,
        key: result.key,
        mediaId: record?.id ?? null,
        mimeType: result.mimeType,
        size: result.sizeBytes,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
      },
      note: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not keep a bank statement file:', message)
    const reason = message.replace(/\s+/g, ' ').trim().slice(0, 200)
    return {
      stored: null,
      note: reason
        ? `The statement lines are in, but the file itself was not kept - the file store said: ${reason}`
        : 'The statement lines are in, but the file itself was not kept.',
    }
  }
}

/**
 * Throw away the file a statement used to point at, once a replacement is safely
 * in place.
 *
 * Last, always, and never allowed to fail anything: an orphaned blob in a bucket
 * is a tidying job, and a statement row pointing at bytes that are gone is a
 * broken record. Same order every relocation in core uses, and for the same
 * reason.
 */
export async function forgetStatementFile(previous: {
  media_provider: string | null
  media_key: string | null
  media_id: string | null
  mime_type: string | null
}): Promise<void> {
  try {
    if (previous.media_provider && previous.media_key) {
      await deleteMediaBytes({
        provider: previous.media_provider as MediaProviderType,
        key: previous.media_key,
        mimeType: previous.mime_type ?? 'application/octet-stream',
      })
    }
    if (previous.media_id) {
      await prisma.media.deleteMany({ where: { id: previous.media_id } })
    }
  } catch {
    // Orphaned superseded statement file. Harmless, and still deletable from the
    // media library by hand.
  }
}
