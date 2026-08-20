import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
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

export async function updateSettings(patch: SettingsPatch): Promise<BkSettingsRow> {
  const current = await getSettings()

  // Changing the scheme restates every future return, so record when it
  // happened. periods.ts refuses the change while an open period already holds
  // transactions - the changeover adjustment is a judgement call, and getting it
  // wrong gets it wrong on a filed return.
  const schemeChanged = patch.scheme !== undefined && patch.scheme !== current.scheme

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
  return getSettings()
}
