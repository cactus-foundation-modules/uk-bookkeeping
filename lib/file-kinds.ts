// What counts as evidence, and how we decide.
//
// Core's own upload sniff is sharp-based and therefore image-only, which does
// not cover a PDF - and a PDF is most of what a receipts folder is. So the
// magic-byte check lives here, in the module, rather than being pushed into core
// as a "generic" capability with one consumer.
//
// There is NO virus scanning anywhere in Cactus and this module does not invent
// any. Files are stored, not executed, served with Content-Disposition:
// attachment, and type-sniffed. That is the extent of it, it is said plainly in
// the upload panel and in the wiki, and pretending otherwise would be worse than
// not doing it.

export const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

export const ALLOWED_EXTENSIONS: Record<string, AllowedMimeType> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase()
}

export function typeForFilename(filename: string): AllowedMimeType | null {
  return ALLOWED_EXTENSIONS[extensionOf(filename)] ?? null
}

/** iPhone photos, which arrive as HEIC and are worth their own sentence. */
export function isHeic(filename: string, mimeType: string): boolean {
  const extension = extensionOf(filename)
  return extension === 'heic' || extension === 'heif' || /image\/hei[cf]/i.test(mimeType)
}

export const HEIC_MESSAGE =
  'iPhone photos in HEIC format are not accepted. Share the photo as a JPEG, or change Camera settings to Most Compatible, then try again.'

/**
 * What the browser can decide before it uploads anything. The same rules run
 * again at the route, because a check only the browser does is not a check.
 */
export function preflightFileError(file: File, maxBytes = DEFAULT_MAX_BYTES): string | null {
  if (isHeic(file.name, file.type)) return HEIC_MESSAGE
  if (!typeForFilename(file.name)) {
    return `“${file.name}” is not a kind of file we can keep as evidence. Use a PDF, JPEG, PNG or WebP.`
  }
  if (file.size > maxBytes) {
    return `“${file.name}” is ${formatSize(file.size)}. The most one piece of evidence can be is ${formatSize(maxBytes)}.`
  }
  if (file.size === 0) return `“${file.name}” is empty.`
  return null
}

/**
 * The bytes, checked against what the name claims.
 *
 * A .pdf that is really an executable passes every name-based check ever
 * written, so the first few bytes decide. WebP is the fiddly one: it is a RIFF
 * container, so "RIFF" at 0 and "WEBP" at 8 both have to be there.
 */
export function sniffMimeType(buffer: Buffer): AllowedMimeType | null {
  if (buffer.length < 12) return null

  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('latin1') === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a
  ) {
    return 'image/png'
  }
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}
