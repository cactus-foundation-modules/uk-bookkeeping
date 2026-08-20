import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'
import { sendTemplateEmail } from '@/lib/email'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit, getChainHead } from '../audit'
import {
  BookkeepingError,
  HmrcApiError,
  HmrcNotConfiguredError,
  PeriodStateError,
} from '../errors'
import { formatPounds } from '../money'
import {
  compareWithFinalisedSnapshot,
  computePeriod,
  describeNetVat,
  lockPeriodRecords,
  requirePeriod,
  toDateOnly,
  writeSnapshot,
} from '../periods'
import { getSettings } from '../settings'
import { boxesMatch } from '../vat-boxes'
import type { BkVatPeriodRow, VatBoxes } from '../types'
import type { HmrcCallContext, HmrcClient, VatObligation } from './client'
import { DirectHmrcClient } from './direct-client'
import { isHmrcConfigured } from './endpoints'
import { buildFraudHeaders, type FraudBag } from './fraud-headers'
import { getAccessToken, getConnection } from './tokens'

// Everything that needs HMRC, in one place, so the rest of the module never
// touches a token, a header or a URL.

export function getHmrcClient(): HmrcClient {
  if (!isHmrcConfigured()) throw new HmrcNotConfiguredError()
  return new DirectHmrcClient(getSiteUrl())
}

export type CallInputs = {
  request: Request
  fraudBag: FraudBag
  user: SessionUser | null
}

/** Token, environment and the assembled fraud bag, ready for one call. */
export async function buildCallContext(
  client: HmrcClient,
  inputs: CallInputs,
): Promise<HmrcCallContext & { vrn: string | null }> {
  const { accessToken, environment, vrn } = await getAccessToken(client)
  const fraudHeaders = await buildFraudHeaders({
    request: inputs.request,
    bag: inputs.fraudBag,
    user: inputs.user,
    // Admin sign-in on this platform is either a passkey or a password followed
    // by an emailed one-time code. Both are genuinely a second factor, and HMRC
    // asks that one be declared where it happened.
    usedMultiFactor: true,
  })
  return { accessToken, environment, fraudHeaders, actorUserId: inputs.user?.id ?? null, vrn }
}

async function requireVrn(): Promise<string> {
  const connection = await getConnection()
  const settings = await getSettings()
  const vrn = connection.vrn ?? settings.vrn
  if (!vrn) {
    throw new BookkeepingError(
      'no_vrn',
      'This site does not have a VAT number recorded yet. Add it in Settings.',
    )
  }
  return vrn
}

// ---------------------------------------------------------------------------
// Obligations
// ---------------------------------------------------------------------------

/**
 * Fetch HMRC's obligations and match them onto local periods by date range.
 *
 * A period created locally from the scheme setting becomes a real one the moment
 * its dates line up with an obligation; anything HMRC returns that we have never
 * seen is created. Never assume quarters - HMRC's own start and end dates are
 * what a period is, and monthly, quarterly and annual all fall out of them.
 */
export async function syncObligations(inputs: CallInputs): Promise<{
  fetched: number
  matched: number
  created: number
}> {
  const client = getHmrcClient()
  const ctx = await buildCallContext(client, inputs)
  const vrn = await requireVrn()

  // Eighteen months back and twelve forward covers every obligation an ordinary
  // business has any interest in, and keeps the request inside the dispatcher's
  // 60 second ceiling with room to spare.
  const from = new Date()
  from.setUTCMonth(from.getUTCMonth() - 18)
  const to = new Date()
  to.setUTCMonth(to.getUTCMonth() + 12)

  const obligations = await client.obligations(
    { vrn, from: toDateOnly(from), to: toDateOnly(to) },
    ctx,
  )

  let matched = 0
  let created = 0
  const settings = await getSettings()

  for (const obligation of obligations) {
    const applied = await applyObligation(obligation, vrn, settings.scheme)
    if (applied === 'matched') matched += 1
    if (applied === 'created') created += 1
  }

  return { fetched: obligations.length, matched, created }
}

async function applyObligation(
  obligation: VatObligation,
  vrn: string,
  fallbackScheme: 'accrual' | 'cash',
): Promise<'matched' | 'created' | 'skipped'> {
  const [existing] = await prisma.$queryRaw<{ id: string; status: string }[]>`
    SELECT "id", "status" FROM "bk_vat_periods"
    WHERE "start_date" = ${obligation.start}::date AND "end_date" = ${obligation.end}::date
    LIMIT 1
  `

  if (existing) {
    // A submitted period is terminal, and the trigger would refuse this anyway.
    if (existing.status === 'submitted') return 'skipped'
    await prisma.$executeRaw`
      UPDATE "bk_vat_periods" SET
        "period_key" = ${obligation.periodKey},
        "due_date" = ${obligation.due}::date,
        "obligation_status" = ${obligation.status},
        "source" = 'hmrc',
        "vrn" = ${vrn},
        "updated_at" = NOW()
      WHERE "id" = ${existing.id}
    `
    return 'matched'
  }

  await prisma.$executeRaw`
    INSERT INTO "bk_vat_periods"
      ("period_key", "start_date", "end_date", "due_date", "scheme", "source", "obligation_status", "vrn")
    VALUES (
      ${obligation.periodKey}, ${obligation.start}::date, ${obligation.end}::date,
      ${obligation.due}::date, ${fallbackScheme}, 'hmrc', ${obligation.status}, ${vrn}
    )
    ON CONFLICT ("start_date", "end_date") DO NOTHING
  `
  return 'created'
}

export async function fetchLiabilities(inputs: CallInputs, from: string, to: string) {
  const client = getHmrcClient()
  const ctx = await buildCallContext(client, inputs)
  return client.liabilities({ vrn: await requireVrn(), from, to }, ctx)
}

export async function fetchPayments(inputs: CallInputs, from: string, to: string) {
  const client = getHmrcClient()
  const ctx = await buildCallContext(client, inputs)
  return client.payments({ vrn: await requireVrn(), from, to }, ctx)
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * File a return.
 *
 * Deliberately NOT one database transaction: a network call sits in the middle,
 * and holding a transaction open across it would pin a pooled connection for the
 * length of HMRC's response.
 *
 * The order inside the closing transaction matters. The lock goes on LAST, after
 * the receipt is stored, so a crash between the two leaves a period that is
 * submitted-and-unlocked - recoverable, and visible to anyone looking - rather
 * than locked-with-no-receipt, which is a mystery nobody can unpick.
 */
export async function submitPeriod(
  periodId: string,
  inputs: CallInputs,
): Promise<{ period: BkVatPeriodRow; boxes: VatBoxes }> {
  const period = await requirePeriod(periodId)

  if (period.status !== 'finalised') {
    throw new PeriodStateError(
      period.status === 'submitted'
        ? 'That return has already been filed.'
        : 'Finalise the return first. Nothing is sent to HMRC until you have seen the figures and said so.',
    )
  }
  if (!period.period_key) {
    throw new PeriodStateError(
      'HMRC has not given us anything to file this return against. Refresh your obligations from HMRC first.',
    )
  }

  // The digital-links guarantee: what we send is provably what was frozen.
  const comparison = await compareWithFinalisedSnapshot(period)
  if (!comparison.frozen) {
    throw new PeriodStateError('There is no finalised set of figures for this period to send.')
  }
  if (!comparison.matches) {
    throw new BookkeepingError(
      'records_changed',
      'The records changed after this return was finalised, so what would be sent no longer matches what you approved. Unfinalise it, review the figures, and finalise again.',
      409,
    )
  }

  const boxes = comparison.frozen
  const client = getHmrcClient()
  const ctx = await buildCallContext(client, inputs)
  const vrn = period.vrn ?? (await requireVrn())

  await appendAudit({
    action: 'hmrc.submission-attempted',
    entityType: 'vat_period',
    entityId: period.id,
    summary: `Filing the VAT return for ${toDateOnly(period.start_date)} to ${toDateOnly(period.end_date)}`,
    detail: { boxes, periodKey: period.period_key },
    user: inputs.user,
  })

  try {
    const receipt = await client.submitReturn(
      { vrn, periodKey: period.period_key, boxes },
      ctx,
    )
    await recordSubmission(period, boxes, receipt, inputs.user)
  } catch (error) {
    if (error instanceof HmrcApiError && error.hmrcCode === 'DUPLICATE_SUBMISSION') {
      // Do NOT roll the period back to open. HMRC may well hold exactly the
      // return we just tried to send - most often because a previous attempt
      // reached them and the reply did not reach us. The screen offers "check
      // with HMRC", which is reconcileWithHmrc below.
      await appendAudit({
        action: 'hmrc.submission-failed',
        entityType: 'vat_period',
        entityId: period.id,
        summary: 'HMRC says a return for this period has already been filed',
        detail: { code: error.hmrcCode, correlationId: error.correlationId },
        user: inputs.user,
      })
      throw error
    }
    await appendAudit({
      action: 'hmrc.submission-failed',
      entityType: 'vat_period',
      entityId: period.id,
      summary: 'HMRC refused the return',
      detail: {
        code: error instanceof HmrcApiError ? error.hmrcCode : 'unknown',
        correlationId: error instanceof HmrcApiError ? error.correlationId : null,
      },
      user: inputs.user,
    })
    throw error
  }

  return { period: await requirePeriod(period.id), boxes }
}

async function recordSubmission(
  period: BkVatPeriodRow,
  boxes: VatBoxes,
  receipt: {
    processingDate: string
    paymentIndicator: string | null
    formBundleNumber: string
    chargeRefNumber: string | null
    receiptId: string | null
    receiptTimestamp: string | null
    correlationId: string | null
  },
  user: SessionUser | null,
): Promise<void> {
  const computed = await computePeriod(period)
  const settings = await getSettings()

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "bk_vat_periods" SET
        "hmrc_processing_date"    = ${new Date(receipt.processingDate)},
        "hmrc_form_bundle_number" = ${receipt.formBundleNumber},
        "hmrc_charge_ref_number"  = ${receipt.chargeRefNumber},
        "hmrc_payment_indicator"  = ${receipt.paymentIndicator},
        "hmrc_receipt_id"         = ${receipt.receiptId},
        "hmrc_receipt_timestamp"  = ${receipt.receiptTimestamp},
        "hmrc_correlation_id"     = ${receipt.correlationId},
        "submitted_at"            = NOW(),
        "submitted_by_user_id"    = ${user?.id ?? null},
        "updated_at"              = NOW()
      WHERE "id" = ${period.id}
    `
    await writeSnapshot(tx, {
      periodId: period.id,
      kind: 'submitted',
      scheme: period.scheme,
      boxes,
      unrounded: computed.unrounded,
      lines: computed.lines,
      vrn: period.vrn ?? settings.vrn,
      user,
    })

    await lockPeriodRecords(tx, period.id)
    await tx.$executeRaw`
      UPDATE "bk_vat_periods" SET "status" = 'submitted', "updated_at" = NOW() WHERE "id" = ${period.id}
    `
  })

  await appendAudit({
    action: 'period.submitted',
    entityType: 'vat_period',
    entityId: period.id,
    summary: `VAT return for ${toDateOnly(period.start_date)} to ${toDateOnly(period.end_date)} filed with HMRC`,
    detail: { boxes, formBundleNumber: receipt.formBundleNumber, receiptId: receipt.receiptId },
    user,
  })

  await emailReceipt(period, boxes, receipt.formBundleNumber, user)
}

/**
 * The anchor. A receipt in a mailbox we cannot edit is what turns the hash chain
 * from a comforting illusion into something that would actually catch a later
 * rewrite of history: the head hash in this email will no longer match.
 */
async function emailReceipt(
  period: BkVatPeriodRow,
  boxes: VatBoxes,
  formBundleNumber: string,
  user: SessionUser | null,
): Promise<void> {
  const to = user?.email
  if (!to) return
  const head = await getChainHead()
  try {
    await sendTemplateEmail(to, 'uk-bookkeeping.vat-return-filed', {
      periodStart: toDateOnly(period.start_date),
      periodEnd: toDateOnly(period.end_date),
      box1: formatPounds(boxes.vatDueSales),
      box2: formatPounds(boxes.vatDueAcquisitions),
      box3: formatPounds(boxes.totalVatDue),
      box4: formatPounds(boxes.vatReclaimedCurrPeriod),
      box5: describeNetVat(boxes),
      box6: formatPounds(boxes.totalValueSalesExVAT),
      box7: formatPounds(boxes.totalValuePurchasesExVAT),
      box8: formatPounds(boxes.totalValueGoodsSuppliedExVAT),
      box9: formatPounds(boxes.totalAcquisitionsExVAT),
      formBundleNumber,
      recordsFingerprint: head ?? 'not yet available',
    })
  } catch (error) {
    console.error('[uk-bookkeeping] receipt email failed', error)
  }
}

/**
 * "Check with HMRC", offered after a duplicate-submission refusal.
 *
 * Asks HMRC what it holds for this period. If it matches the figures we froze,
 * the return really was filed and we complete the local record without sending
 * anything again. If it does not match, we say so and change nothing - a
 * mismatch is a conversation with HMRC, not something to paper over.
 */
export async function reconcileWithHmrc(
  periodId: string,
  inputs: CallInputs,
): Promise<{ reconciled: boolean; theirs: VatBoxes | null }> {
  const period = await requirePeriod(periodId)
  if (period.status === 'submitted') return { reconciled: true, theirs: null }
  if (!period.period_key) {
    throw new PeriodStateError('There is no HMRC period to check this against.')
  }

  const client = getHmrcClient()
  const ctx = await buildCallContext(client, inputs)
  const vrn = period.vrn ?? (await requireVrn())
  const view = await client.viewReturn({ vrn, periodKey: period.period_key }, ctx)

  const comparison = await compareWithFinalisedSnapshot(period)
  if (!comparison.frozen) {
    throw new PeriodStateError('There is no finalised set of figures for this period to compare.')
  }

  const { periodKey: _periodKey, ...theirs } = view
  if (!boxesMatch(comparison.frozen, theirs)) {
    return { reconciled: false, theirs }
  }

  await recordSubmission(
    period,
    comparison.frozen,
    {
      processingDate: new Date().toISOString(),
      paymentIndicator: null,
      // HMRC's view endpoint does not return the form bundle number, so the
      // record says where the figure came from rather than inventing one.
      formBundleNumber: 'reconciled-with-hmrc',
      chargeRefNumber: null,
      receiptId: null,
      receiptTimestamp: null,
      correlationId: null,
    },
    inputs.user,
  )

  return { reconciled: true, theirs }
}
