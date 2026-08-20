import { NextRequest, NextResponse } from 'next/server'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { saveMediaRecord, uploadMedia, validateNonImageUpload } from '@/lib/media/upload'
import {
  createAttachment,
  evidenceFolderPath,
  hashBytes,
  listAttachments,
  resolveEvidenceFolderId,
} from '@/modules/uk-bookkeeping/lib/attachments'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  HEIC_MESSAGE,
  formatSize,
  isHeic,
  sniffMimeType,
  typeForFilename,
} from '@/modules/uk-bookkeeping/lib/file-kinds'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { getTransaction } from '@/modules/uk-bookkeeping/lib/transactions'

// Evidence for one entry.
//
// The bytes come through this function rather than going straight to storage:
// the media Worker's direct upload path types a file from its object key's
// extension and accepts only raster images and 3D models, so a PDF sent that way
// is refused outright. That means the platform's request body cap applies, and
// the browser says so before it tries rather than letting a 413 arrive with a
// body that is not even JSON.

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

  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    return NextResponse.json(
      { error: 'File storage is not set up on this site yet. Add a provider in Settings → Media first.' },
      { status: 503 },
    )
  }

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  const rawName = form?.get('name')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was sent.' }, { status: 400 })
  }

  if (isHeic(file.name, file.type)) {
    return NextResponse.json({ error: HEIC_MESSAGE }, { status: 400 })
  }

  const settings = await getSettings()
  const claimed = typeForFilename(file.name)
  if (!claimed) {
    return NextResponse.json(
      { error: `“${file.name}” is not a kind of file we can keep as evidence. Use a PDF, JPEG, PNG or WebP.` },
      { status: 400 },
    )
  }
  if (file.size > settings.attachment_max_bytes) {
    return NextResponse.json(
      {
        error: `“${file.name}” is ${formatSize(file.size)}. The most one piece of evidence can be is ${formatSize(settings.attachment_max_bytes)}.`,
      },
      { status: 400 },
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  // The bytes decide, not the name. A .pdf that is really something else passes
  // every name-based check ever written.
  const actual = sniffMimeType(buffer)
  if (actual !== claimed) {
    return NextResponse.json(
      {
        error: `“${file.name}” is not really a ${claimed.split('/')[1]?.toUpperCase()} file. Nothing has been saved.`,
      },
      { status: 400 },
    )
  }

  const validation = await validateNonImageUpload(claimed, buffer.length, {
    allowedMimeTypes: [claimed],
    maxSizeBytes: settings.attachment_max_bytes,
  })
  if (!validation.valid) {
    return NextResponse.json({ error: validation.reason }, { status: 400 })
  }

  try {
    const folderId = await resolveEvidenceFolderId(transaction.tax_point_date)
    const folderPath = await evidenceFolderPath(folderId)
    const result = await uploadMedia(buffer, claimed, provider, file.name, folderPath || undefined)

    // Recorded in the core library as well as in our own table, so the receipt
    // turns up in Media under Bookkeeping rather than being a file only this
    // module can see. Our row stays the source of truth, and a file whose
    // library row is later deleted goes on downloading from the stored key.
    const record = await saveMediaRecord({
      key: result.key,
      url: result.url,
      provider,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      uploadedById: gate.user.id,
      originalName: file.name || undefined,
      folderId,
    })

    const attachment = await createAttachment(
      {
        transactionId: id,
        name: (typeof rawName === 'string' ? rawName.trim() : '') || file.name,
        filename: file.name,
        url: result.url,
        mediaProvider: provider,
        mediaKey: result.key,
        mediaId: record?.id ?? null,
        mimeType: claimed,
        size: result.sizeBytes,
        sha256: hashBytes(buffer),
      },
      gate.user,
    )
    return NextResponse.json(attachment, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
