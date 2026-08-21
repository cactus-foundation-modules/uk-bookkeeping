import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { getSettings, updateSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { appendAudit } from '@/modules/uk-bookkeeping/lib/audit'
import { checkTriggerHealth } from '@/modules/uk-bookkeeping/lib/health'
import { getChainHead } from '@/modules/uk-bookkeeping/lib/audit'
import { getConnection } from '@/modules/uk-bookkeeping/lib/hmrc/tokens'
import { isHmrcConfigured, callbackUrl } from '@/modules/uk-bookkeeping/lib/hmrc/endpoints'
import { getSiteUrlOrNull } from '@/lib/config/env'
import { FRAUD_SPEC_READ_ON, FRAUD_SPEC_SOURCE } from '@/modules/uk-bookkeeping/lib/hmrc/fraud-spec'

export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const [settings, connection, health, chainHead] = await Promise.all([
    getSettings(),
    getConnection(),
    checkTriggerHealth(),
    getChainHead(),
  ])
  const siteUrl = getSiteUrlOrNull()

  return NextResponse.json({
    settings: {
      businessName: settings.business_name,
      businessType: settings.business_type,
      vrn: settings.vrn,
      vatRegisteredFrom: settings.vat_registered_from,
      scheme: settings.scheme,
      schemeChangedAt: settings.scheme_changed_at,
      periodFrequency: settings.period_frequency,
      firstPeriodStart: settings.first_period_start,
      firstPeriodEnd: settings.first_period_end,
      hmrcEnvironment: settings.hmrc_environment,
      errorThresholdFixed: settings.error_threshold_fixed.toFixed(2),
      errorThresholdPercent: settings.error_threshold_percent.toFixed(2),
      errorThresholdCap: settings.error_threshold_cap.toFixed(2),
      boxRounding: settings.box_rounding,
      attachmentMaxBytes: settings.attachment_max_bytes,
      retentionYears: settings.retention_years,
      vendorPublicIp: settings.vendor_public_ip,
      yearEndMonth: settings.year_end_month,
      yearEndDay: settings.year_end_day,
      externalSalesEnabled: settings.external_sales_enabled,
      externalSalesCategoryId: settings.external_sales_category_id,
      externalSalesStatus: settings.external_sales_status,
    },
    hmrc: {
      configured: isHmrcConfigured(),
      status: connection.status,
      vrn: connection.vrn,
      environment: connection.environment,
      connectedAt: connection.connected_at,
      accessTokenExpiresAt: connection.access_token_expires_at,
      refreshTokenExpiresAt: connection.refresh_token_expires_at,
      lastRefreshError: connection.last_refresh_error,
      redirectUri: siteUrl ? callbackUrl(siteUrl) : null,
      fraudSpecReadOn: FRAUD_SPEC_READ_ON,
      fraudSpecSource: FRAUD_SPEC_SOURCE,
    },
    health,
    chainHead,
  })
}

const PatchBody = z.object({
  businessName: z.string().nullable().optional(),
  businessType: z.enum(['ltd', 'sole_trader']).optional(),
  vrn: z.string().nullable().optional(),
  vatRegisteredFrom: z.string().nullable().optional(),
  scheme: z.enum(['accrual', 'cash']).optional(),
  periodFrequency: z.enum(['monthly', 'quarterly', 'annual']).optional(),
  firstPeriodStart: z.string().nullable().optional(),
  firstPeriodEnd: z.string().nullable().optional(),
  hmrcEnvironment: z.enum(['sandbox', 'production']).optional(),
  errorThresholdFixed: z.string().optional(),
  errorThresholdPercent: z.string().optional(),
  errorThresholdCap: z.string().optional(),
  boxRounding: z.enum(['nearest', 'down']).optional(),
  attachmentMaxBytes: z.number().int().min(1024).max(100 * 1024 * 1024).optional(),
  retentionYears: z.number().int().min(1).max(20).optional(),
  vendorPublicIp: z.string().nullable().optional(),
  // The accounting year end, as a month and a day. Whether the day exists in the
  // chosen month is settled in lib/settings.ts, which can say so in a sentence.
  yearEndMonth: z.number().int().min(1).max(12).optional(),
  yearEndDay: z.number().int().min(1).max(31).optional(),
  externalSalesEnabled: z.boolean().optional(),
  externalSalesCategoryId: z.string().nullable().optional(),
  externalSalesStatus: z.enum(['draft', 'posted']).optional(),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }

  try {
    const before = await getSettings()
    const settings = await updateSettings(parsed.data)
    await appendAudit({
      action: 'settings.updated',
      entityType: 'settings',
      entityId: 'singleton',
      summary: 'Bookkeeping settings changed',
      detail: {
        before: { scheme: before.scheme, environment: before.hmrc_environment, vrn: before.vrn },
        after: { scheme: settings.scheme, environment: settings.hmrc_environment, vrn: settings.vrn },
      },
      user: gate.user,
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
