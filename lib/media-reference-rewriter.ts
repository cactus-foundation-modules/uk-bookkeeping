import { prisma } from '@/lib/db/prisma'
import type { MediaReferenceChange } from '@/lib/media/reference-rewriters'

// Provider for the core.media-reference-rewriters extension point.
//
// Core moves a blob to a fresh key and url whenever it is optimised, resized,
// cropped, replaced, renamed or re-filed. An attachment row keeps both halves of
// that address - the url it serves from and the key it re-reads by - and neither
// follows on its own, so a receipt would 404 while the file sat perfectly safely
// under its new name and the library showed nothing wrong.
//
// Note that this repoints LOCKED rows too, and deliberately. The immutability
// trigger on bk_attachments allows exactly these four columns to change on a
// locked row and refuses everything else: the evidence is frozen, its storage
// address is not. Without that carve-out, moving one filed receipt in the media
// library would fail with an accounting error.
//
// Equality, not substring: each column holds the whole value, so `= oldUrl` can
// never touch an unrelated row.
export async function ukBookkeepingMediaReferenceRewriter(
  change: MediaReferenceChange,
): Promise<void> {
  const { oldUrl, newUrl, oldKey, newKey } = change

  if (oldUrl && oldUrl !== newUrl) {
    await prisma.$executeRaw`
      UPDATE "bk_attachments" SET "url" = ${newUrl} WHERE "url" = ${oldUrl}
    `
  }
  if (oldKey && oldKey !== newKey) {
    await prisma.$executeRaw`
      UPDATE "bk_attachments" SET "media_key" = ${newKey} WHERE "media_key" = ${oldKey}
    `
  }
}
