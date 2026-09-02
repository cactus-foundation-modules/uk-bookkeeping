import { prisma } from '@/lib/db/prisma'

// Provider for the core.media-usage-providers extension point.
//
// Receipts and invoices attached to bookkeeping entries are plain Media id
// columns core has no sight of. Without this they would be counted as unused
// library clutter and offered up for a tidy - and HMRC expects the records kept
// six years. The media clean-up is not allowed to be the thing that loses a VAT
// return's evidence.
//
// Bank statement files are in the same boat and are named here too. They are not
// attachments - a statement belongs to no single entry - so a query against
// bk_attachments alone would leave every statement file in the library looking
// like nothing needed it.
export async function ukBookkeepingMediaUsageProvider(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ ref: string | null }[]>`
    SELECT "media_id" AS ref FROM "bk_attachments" WHERE "media_id" IS NOT NULL
    UNION
    SELECT "media_id" AS ref FROM "bk_bank_statements" WHERE "media_id" IS NOT NULL
  `
  return rows.map((r) => r.ref).filter((r): r is string => !!r)
}
