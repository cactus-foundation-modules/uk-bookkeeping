import { createHash, randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { getSettings } from '../settings'

// Gov-Vendor-License-IDs.
//
// HMRC's Test Fraud Prevention Headers endpoint answers a submission without it
// with "Header required (gov-vendor-license-ids)", so it is not optional in
// practice however their page words it. Their format is
// software-name=hashed-licence-value, "hashed consistently".
//
// Consistently is the whole difficulty. A value derived from anything that
// moves - the hostname, the deployment, the module version - produces a
// different hash every time it moves, and a licence identifier that changes is
// not a licence identifier. So the raw value is minted once per install, kept in
// the settings row, and never rotated. Only its SHA-256 is ever sent.

const SOFTWARE_NAME = 'cactus-uk-bookkeeping'

/**
 * The install's licence identifier, minting one on first use.
 *
 * Migration 018 mints it for installs that already exist, so this normally finds
 * one waiting. It is written defensively anyway: a settings row restored from a
 * backup taken before 018 would arrive without one, and an empty header is worse
 * than a late one.
 */
export async function getVendorLicenceId(): Promise<string> {
  const settings = await getSettings()
  if (settings.vendor_license_id) return settings.vendor_license_id
  const minted = randomUUID()
  // ON CONFLICT cannot help here - the row exists - so the guard is in the WHERE
  // clause, and a racing request that mints first wins. Re-read rather than
  // assume ours landed, or two calls in the same second would hash differently.
  await prisma.$executeRaw`
    UPDATE "bk_settings"
       SET "vendor_license_id" = ${minted}, "updated_at" = NOW()
     WHERE "id" = 'singleton' AND "vendor_license_id" IS NULL
  `
  const rows = await prisma.$queryRaw<{ vendor_license_id: string | null }[]>`
    SELECT "vendor_license_id" FROM "bk_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  return rows[0]?.vendor_license_id ?? minted
}

/** SHA-256, uppercase hex, matching the case of the example on HMRC's page. */
export function hashLicenceId(value: string): string {
  return createHash('sha256').update(value).digest('hex').toUpperCase()
}

export const VENDOR_LICENCE_SOFTWARE_NAME = SOFTWARE_NAME
