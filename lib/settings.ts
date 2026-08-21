import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { BookkeepingError } from './errors'
import type { BkSettingsRow } from './types'

// The singleton settings row. Seeded by 001_initial.sql, but read defensively
// anyway: a database restored from another install could in principle arrive
// without it, and a missing settings row should not take the whole section down.

const FALLBACK: BkSettingsRow = {
  id: 'singleton',
  business_name: null,
  business_type: 'ltd',
  vrn: null,
  vat_registered_from: null,
  scheme: 'accrual',
  scheme_changed_at: null,
  period_frequency: 'quarterly',
  first_period_start: null,
  hmrc_environment: 'sandbox',
  error_threshold_fixed: new Prisma.Decimal('10000.00'),
  error_threshold_percent: new Prisma.Decimal('1.00'),
  error_threshold_cap: new Prisma.Decimal('50000.00'),
  box_rounding: 'nearest',
  attachment_max_bytes: 15_728_640,
  retention_years: 6,
  vendor_public_ip: null,
  created_at: new Date(),
  updated_at: new Date(),
}

export async function getSettings(): Promise<BkSettingsRow> {
  const rows = await prisma.$queryRaw<BkSettingsRow[]>`
    SELECT * FROM "bk_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  const row = rows[0]
  if (row) return row
  // Put the row back rather than living on the fallback forever: a settings page
  // that saves into thin air is worse than one that is briefly empty.
  await prisma.$executeRaw`
    INSERT INTO "bk_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING
  `
  const retry = await prisma.$queryRaw<BkSettingsRow[]>`
    SELECT * FROM "bk_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  return retry[0] ?? FALLBACK
}

export type SettingsPatch = {
  businessName?: string | null
  businessType?: 'ltd' | 'sole_trader'
  vrn?: string | null
  vatRegisteredFrom?: string | null
  scheme?: 'accrual' | 'cash'
  periodFrequency?: 'monthly' | 'quarterly' | 'annual'
  firstPeriodStart?: string | null
  hmrcEnvironment?: 'sandbox' | 'production'
  errorThresholdFixed?: string
  errorThresholdPercent?: string
  errorThresholdCap?: string
  boxRounding?: 'nearest' | 'down'
  attachmentMaxBytes?: number
  retentionYears?: number
  vendorPublicIp?: string | null
}

/**
 * VRNs are nine digits. Stored without spaces so a value typed as
 * "123 4567 89" still matches the one HMRC returns.
 */
export function normaliseVrn(input: string | null | undefined): string | null {
  if (!input) return null
  const digits = input.replace(/\D/g, '')
  return digits.length > 0 ? digits : null
}

export function isValidVrn(input: string | null | undefined): boolean {
  return !!input && /^\d{9}$/.test(input)
}

/** A plain non-negative amount, or a refusal in a sentence rather than a raw ::numeric error. */
function checkAmountSetting(value: string | undefined, name: string): void {
  if (value === undefined) return
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(value.trim())) {
    throw new BookkeepingError('invalid', `${name} needs to be a plain amount, like 10000.00.`)
  }
}

/** A date string Postgres will accept, or a refusal that names the field. */
function checkDateSetting(value: string | null | undefined, name: string): void {
  if (value === undefined || value === null || value === '') return
  if (Number.isNaN(new Date(`${value.slice(0, 10)}T00:00:00.000Z`).getTime())) {
    throw new BookkeepingError('invalid', `${name} is not a date we can read.`)
  }
}

export async function updateSettings(patch: SettingsPatch): Promise<BkSettingsRow> {
  const current = await getSettings()

  checkAmountSetting(patch.errorThresholdFixed, 'The fixed error threshold')
  checkAmountSetting(patch.errorThresholdCap, 'The error threshold cap')
  checkDateSetting(patch.vatRegisteredFrom, 'The VAT registration date')
  checkDateSetting(patch.firstPeriodStart, 'The first period start date')
  if (patch.errorThresholdPercent !== undefined) {
    checkAmountSetting(patch.errorThresholdPercent, 'The error threshold percentage')
    const percent = Number(patch.errorThresholdPercent)
    if (percent < 0 || percent > 100) {
      throw new BookkeepingError('invalid', 'The error threshold percentage sits between 0 and 100.')
    }
  }

  // Changing the scheme restates every future return, so record when it
  // happened. The change is refused while an open period already holds
  // transactions - the changeover adjustment is a judgement call, and getting it
  // wrong gets it wrong on a filed return. Open periods that are still empty
  // move to the new scheme with the setting, so the next return computed is the
  // one the owner just chose.
  const schemeChanged = patch.scheme !== undefined && patch.scheme !== current.scheme
  if (schemeChanged) {
    const [busy] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p."id" FROM "bk_vat_periods" p
      WHERE p."status" = 'open' AND EXISTS (
        SELECT 1 FROM "bk_transactions" t
        WHERE t."status" = 'posted' AND (
          (p."scheme" = 'accrual'
            AND t."tax_point_date" BETWEEN p."start_date" AND p."end_date")
          OR (p."scheme" = 'cash' AND t."settled_date" IS NOT NULL
            AND t."settled_date" BETWEEN p."start_date" AND p."end_date")
        )
      )
      LIMIT 1
    `
    if (busy) {
      throw new BookkeepingError(
        'scheme_change_blocked',
        'There are already entries recorded in an open VAT period, so the scheme cannot simply be flipped - the changeover needs those entries dealt with first. File the open period, then change scheme.',
        409,
      )
    }
  }

  await prisma.$executeRaw`
    UPDATE "bk_settings" SET
      "business_name"           = ${patch.businessName === undefined ? current.business_name : patch.businessName},
      "business_type"           = ${patch.businessType ?? current.business_type},
      "vrn"                     = ${patch.vrn === undefined ? current.vrn : normaliseVrn(patch.vrn)},
      "vat_registered_from"     = ${
        patch.vatRegisteredFrom === undefined
          ? current.vat_registered_from
          : patch.vatRegisteredFrom
            ? new Date(patch.vatRegisteredFrom)
            : null
      }::date,
      "scheme"                  = ${patch.scheme ?? current.scheme},
      "scheme_changed_at"       = ${schemeChanged ? new Date() : current.scheme_changed_at},
      "period_frequency"        = ${patch.periodFrequency ?? current.period_frequency},
      "first_period_start"      = ${
        patch.firstPeriodStart === undefined
          ? current.first_period_start
          : patch.firstPeriodStart
            ? new Date(patch.firstPeriodStart)
            : null
      }::date,
      "hmrc_environment"        = ${patch.hmrcEnvironment ?? current.hmrc_environment},
      "error_threshold_fixed"   = ${patch.errorThresholdFixed ?? current.error_threshold_fixed.toFixed(2)}::numeric,
      "error_threshold_percent" = ${patch.errorThresholdPercent ?? current.error_threshold_percent.toFixed(2)}::numeric,
      "error_threshold_cap"     = ${patch.errorThresholdCap ?? current.error_threshold_cap.toFixed(2)}::numeric,
      "box_rounding"            = ${patch.boxRounding ?? current.box_rounding},
      "attachment_max_bytes"    = ${patch.attachmentMaxBytes ?? current.attachment_max_bytes},
      "retention_years"         = ${patch.retentionYears ?? current.retention_years},
      "vendor_public_ip"        = ${patch.vendorPublicIp === undefined ? current.vendor_public_ip : patch.vendorPublicIp},
      "updated_at"              = NOW()
    WHERE "id" = 'singleton'
  `
  if (schemeChanged) {
    await prisma.$executeRaw`
      UPDATE "bk_vat_periods" SET "scheme" = ${patch.scheme}, "updated_at" = NOW()
      WHERE "status" = 'open'
    `
  }
  return getSettings()
}
