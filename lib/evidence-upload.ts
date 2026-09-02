import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import {
  buildLibraryUploadKey,
  saveMediaRecord,
  uploadMedia,
  validateNonImageUpload,
} from '@/lib/media/upload'
import { evidenceFolderPath, resolveEvidenceFolderId } from './attachments'
import { BookkeepingError } from './errors'
import { filingFilename, type FilingKind, type FilingNameParts } from './filing'
import {
  HEIC_MESSAGE,
  formatSize,
  isHeic,
  sniffMimeType,
  typeForFilename,
  type AllowedMimeType,
} from './file-kinds'

// Getting a receipt out of a browser and into storage.
//
// Two routes need this now - evidence dropped onto an entry, and a document
// dropped into the inbox before there is an entry - and they must not drift
// apart. The checks here are the ones that decide whether a file is kept at
// all, so two copies slowly disagreeing would mean one door in the building
// having a lock and the other not.
//
// The bytes come through the server rather than going straight to storage: the
// media Worker's direct upload path types a file from its object key's
// extension and accepts only raster images and 3D models, so a PDF sent that
// way is refused outright.

export type EvidenceUpload = {
  buffer: Buffer
  mimeType: AllowedMimeType
  filename: string
  /** What to call it in the list. The uploader may name it; otherwise the filename. */
  name: string
}

/**
 * The file out of a multipart body, checked.
 *
 * Every refusal is a BookkeepingError carrying a sentence somebody can act on.
 * The same rules run in the browser first (see lib/file-kinds.ts) so a rejection
 * is usually instant - but a check only the browser does is not a check.
 */
export async function readEvidenceUpload(
  form: FormData | null,
  maxBytes: number,
): Promise<EvidenceUpload> {
  const file = form?.get('file')
  const rawName = form?.get('name')
  if (!(file instanceof File)) {
    throw new BookkeepingError('invalid', 'No file was sent.')
  }

  if (isHeic(file.name, file.type)) throw new BookkeepingError('invalid', HEIC_MESSAGE)

  const claimed = typeForFilename(file.name)
  if (!claimed) {
    throw new BookkeepingError(
      'invalid',
      `“${file.name}” is not a kind of file we can keep as evidence. Use a PDF, JPEG, PNG or WebP.`,
    )
  }
  if (file.size > maxBytes) {
    throw new BookkeepingError(
      'invalid',
      `“${file.name}” is ${formatSize(file.size)}. The most one piece of evidence can be is ${formatSize(maxBytes)}.`,
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // The bytes decide, not the name. A .pdf that is really something else passes
  // every name-based check ever written.
  const actual = sniffMimeType(buffer)
  if (actual !== claimed) {
    throw new BookkeepingError(
      'invalid',
      `“${file.name}” is not really a ${claimed.split('/')[1]?.toUpperCase()} file. Nothing has been saved.`,
    )
  }

  const validation = await validateNonImageUpload(claimed, buffer.length, {
    allowedMimeTypes: [claimed],
    maxSizeBytes: maxBytes,
  })
  if (!validation.valid) throw new BookkeepingError('invalid', validation.reason ?? 'That file was refused.')

  return {
    buffer,
    mimeType: claimed,
    filename: file.name,
    name: (typeof rawName === 'string' ? rawName.trim() : '') || file.name,
  }
}

export type StoredEvidence = {
  url: string
  provider: string
  key: string
  mediaId: string | null
  size: number
}

/**
 * What a document is, so it can be filed under the right heading and given the
 * name a person would give it. Null kind means nobody knows yet - see
 * lib/filing.ts.
 */
export type FilingIntent = {
  kind: FilingKind | null
  parts?: FilingNameParts
}

/**
 * Put the bytes where the site keeps its media, and record them in the library.
 *
 * `filedUnder` is the date that decides which Bookkeeping / year / month folder
 * it lands in. For evidence on an entry that is the entry's tax point; for a
 * document in the inbox it is whatever date we read off the document, falling
 * back to today - which is why the reading happens before the upload rather
 * than after it.
 *
 * `filing` decides the rest of the address: which of the four folders inside
 * that month, and what the file is called when it gets there. Both are allowed
 * to be unknown, and an unknown one is not a failure - an unreadable photograph
 * of a receipt keeps the name it was uploaded under and waits in the month
 * folder until somebody says what it is.
 */
export async function storeEvidence(
  upload: EvidenceUpload,
  filedUnder: Date,
  // Null for a document a publisher handed over rather than a person uploading
  // one: Media.uploadedById is a foreign key to a real user, and inventing one
  // would be worse than leaving it empty.
  uploadedById: string | null,
  filing: FilingIntent = { kind: null },
): Promise<StoredEvidence> {
  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    throw new BookkeepingError(
      'no_media_provider',
      'File storage is not set up on this site yet. Add a provider in Settings → Media first.',
      503,
    )
  }

  const folderId = await resolveEvidenceFolderId(filedUnder, filing.kind)
  const folderPath = await evidenceFolderPath(folderId)

  // The name it is filed under, where the filing scheme can produce one:
  // "INV-1042.pdf", "Screwfix-8817342.pdf". The key is settled BEFORE the upload
  // by buildLibraryUploadKey, which is what makes a second invoice of the same
  // number land as "-2" rather than writing over the first one.
  const filedAs =
    filing.kind && filingFilename(filing.kind, filing.parts ?? {}, upload.filename)
  const storedName = filedAs || upload.filename
  const presetKey = filedAs
    ? await buildLibraryUploadKey(provider, upload.mimeType, filedAs, folderPath || undefined)
    : undefined

  const result = await uploadMedia(
    upload.buffer,
    upload.mimeType,
    provider,
    storedName,
    folderPath || undefined,
    false,
    presetKey,
  )

  // Recorded in the core library as well as in our own table, so the receipt
  // turns up in Media under Bookkeeping rather than being a file only this
  // module can see. Our row stays the source of truth, and a file whose library
  // row is later deleted goes on downloading from the stored key.
  const record = await saveMediaRecord({
    key: result.key,
    url: result.url,
    provider,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
    uploadedById: uploadedById ?? undefined,
    originalName: storedName || undefined,
    folderId,
  })

  return {
    url: result.url,
    provider,
    key: result.key,
    mediaId: record?.id ?? null,
    size: result.sizeBytes,
  }
}
