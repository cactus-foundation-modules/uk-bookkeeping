import { HmrcApiError, HmrcNotConfiguredError } from '../errors'
import type {
  DateRangeQuery,
  HmrcCallContext,
  HmrcClient,
  HmrcTokens,
  ObligationsQuery,
  VatLiability,
  VatObligation,
  VatPayment,
  VatReturnPayload,
  VatReturnView,
  VatSubmissionReceipt,
} from './client'
import { beginApiCall, completeApiCall } from './api-log'
import {
  HMRC_ACCEPT,
  HMRC_HOSTS,
  HMRC_SCOPE,
  callbackUrl,
  encodePeriodKey,
  hmrcCredentials,
} from './endpoints'
import { buildVatReturnBody } from './payload'
import {
  HmrcErrorSchema,
  LiabilitiesResponseSchema,
  ObligationsResponseSchema,
  PaymentsResponseSchema,
  SubmissionResponseSchema,
  TokenResponseSchema,
  ViewReturnResponseSchema,
  fromHmrcNumber,
} from './schemas'
import type { HmrcEnvironment, VatBoxes } from '../types'

// The one implementation v1 ships: this install's own credentials, talking
// straight to HMRC. Everything outward-facing in the module goes through the
// HmrcClient interface, so a hosted broker could be dropped in without touching
// a line of the records, computation or period layers.

const TIMEOUT_MS = 30_000

export class DirectHmrcClient implements HmrcClient {
  constructor(private readonly siteUrl: string) {}

  private credentials() {
    const credentials = hmrcCredentials()
    if (!credentials) throw new HmrcNotConfiguredError()
    return credentials
  }

  authorizationUrl({ state, environment }: { state: string; environment: HmrcEnvironment }): string {
    const { clientId } = this.credentials()
    const url = new URL('/oauth/authorize', HMRC_HOSTS[environment].authorize)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('scope', HMRC_SCOPE)
    url.searchParams.set('state', state)
    url.searchParams.set('redirect_uri', callbackUrl(this.siteUrl))
    return url.toString()
  }

  async exchangeCode({
    code,
    environment,
  }: {
    code: string
    environment: HmrcEnvironment
  }): Promise<HmrcTokens> {
    return this.token(environment, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(this.siteUrl),
    })
  }

  async refresh({
    refreshToken,
    environment,
  }: {
    refreshToken: string
    environment: HmrcEnvironment
  }): Promise<HmrcTokens> {
    return this.token(environment, { grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  private async token(
    environment: HmrcEnvironment,
    fields: Record<string, string>,
  ): Promise<HmrcTokens> {
    const { clientId, clientSecret } = this.credentials()
    const body = new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret })

    const response = await fetch(`${HMRC_HOSTS[environment].api}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: HMRC_ACCEPT },
      body: body.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    const text = await response.text()
    if (!response.ok) {
      throw toHmrcError(response.status, text, response.headers.get('X-CorrelationId'))
    }
    const parsed = TokenResponseSchema.parse(JSON.parse(text))
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresIn: parsed.expires_in,
      scope: parsed.scope ?? null,
    }
  }

  // -------------------------------------------------------------------------
  // Authenticated calls
  // -------------------------------------------------------------------------

  private async call(
    method: string,
    path: string,
    ctx: HmrcCallContext,
    body?: string,
  ): Promise<{ text: string; correlationId: string | null; receiptId: string | null; receiptTimestamp: string | null }> {
    const headers: Record<string, string> = {
      Accept: HMRC_ACCEPT,
      Authorization: `Bearer ${ctx.accessToken}`,
      ...ctx.fraudHeaders,
    }
    if (body) headers['Content-Type'] = 'application/json'

    // The row goes in BEFORE the call. A timeout that leaves no trace is how a
    // duplicate submission happens.
    const callId = await beginApiCall({
      environment: ctx.environment,
      method,
      path,
      fraudHeaders: ctx.fraudHeaders,
      actorUserId: ctx.actorUserId ?? null,
    })
    const startedAt = Date.now()

    let response: Response
    try {
      response = await fetch(`${HMRC_HOSTS[ctx.environment].api}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      await completeApiCall(callId, {
        statusCode: null,
        durationMs: Date.now() - startedAt,
        errorCode: 'NETWORK',
        errorBody: { message: error instanceof Error ? error.message : 'unknown' },
      })
      throw new HmrcApiError({
        hmrcCode: 'NETWORK',
        message:
          'We could not reach HMRC. Nothing has been sent. Try again in a moment; if it keeps happening, HMRC may be having trouble.',
        httpStatus: 504,
      })
    }

    const text = await response.text()
    const correlationId = response.headers.get('X-CorrelationId')
    const receiptId = response.headers.get('Receipt-ID')
    const receiptTimestamp = response.headers.get('Receipt-Timestamp')

    if (!response.ok) {
      const error = toHmrcError(response.status, text, correlationId)
      await completeApiCall(callId, {
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        correlationId,
        errorCode: error.hmrcCode,
        errorBody: safeJson(text),
      })
      throw error
    }

    await completeApiCall(callId, {
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      correlationId,
      receiptId,
    })

    return { text, correlationId, receiptId, receiptTimestamp }
  }

  async obligations(input: ObligationsQuery, ctx: HmrcCallContext): Promise<VatObligation[]> {
    const query = new URLSearchParams()
    if (input.from) query.set('from', input.from)
    if (input.to) query.set('to', input.to)
    if (input.status) query.set('status', input.status)
    const suffix = query.toString() ? `?${query.toString()}` : ''

    const { text } = await this.call(
      'GET',
      `/organisations/vat/${encodeURIComponent(input.vrn)}/obligations${suffix}`,
      ctx,
    )
    return ObligationsResponseSchema.parse(JSON.parse(text)).obligations
  }

  async submitReturn(input: VatReturnPayload, ctx: HmrcCallContext): Promise<VatSubmissionReceipt> {
    const body = buildVatReturnBody(input.periodKey, input.boxes)
    const { text, correlationId, receiptId, receiptTimestamp } = await this.call(
      'POST',
      `/organisations/vat/${encodeURIComponent(input.vrn)}/returns`,
      ctx,
      body,
    )
    const parsed = SubmissionResponseSchema.parse(JSON.parse(text))
    return {
      processingDate: parsed.processingDate,
      paymentIndicator: parsed.paymentIndicator ?? null,
      formBundleNumber: parsed.formBundleNumber,
      chargeRefNumber: parsed.chargeRefNumber ?? null,
      receiptId,
      receiptTimestamp,
      correlationId,
    }
  }

  async viewReturn(
    input: { vrn: string; periodKey: string },
    ctx: HmrcCallContext,
  ): Promise<VatReturnView> {
    const { text } = await this.call(
      'GET',
      `/organisations/vat/${encodeURIComponent(input.vrn)}/returns/${encodePeriodKey(input.periodKey)}`,
      ctx,
    )
    const parsed = ViewReturnResponseSchema.parse(JSON.parse(text))
    const boxes: VatBoxes = {
      vatDueSales: fromHmrcNumber(parsed.vatDueSales),
      vatDueAcquisitions: fromHmrcNumber(parsed.vatDueAcquisitions),
      totalVatDue: fromHmrcNumber(parsed.totalVatDue),
      vatReclaimedCurrPeriod: fromHmrcNumber(parsed.vatReclaimedCurrPeriod),
      netVatDue: fromHmrcNumber(parsed.netVatDue),
      totalValueSalesExVAT: fromHmrcNumber(parsed.totalValueSalesExVAT),
      totalValuePurchasesExVAT: fromHmrcNumber(parsed.totalValuePurchasesExVAT),
      totalValueGoodsSuppliedExVAT: fromHmrcNumber(parsed.totalValueGoodsSuppliedExVAT),
      totalAcquisitionsExVAT: fromHmrcNumber(parsed.totalAcquisitionsExVAT),
    }
    return { ...boxes, periodKey: parsed.periodKey }
  }

  async liabilities(input: DateRangeQuery, ctx: HmrcCallContext): Promise<VatLiability[]> {
    const query = new URLSearchParams({ from: input.from, to: input.to })
    const { text } = await this.call(
      'GET',
      `/organisations/vat/${encodeURIComponent(input.vrn)}/liabilities?${query.toString()}`,
      ctx,
    )
    return LiabilitiesResponseSchema.parse(JSON.parse(text)).liabilities.map((l) => ({
      taxPeriodFrom: l.taxPeriod?.from ?? null,
      taxPeriodTo: l.taxPeriod?.to ?? null,
      type: l.type,
      originalAmount: fromHmrcNumber(l.originalAmount),
      outstandingAmount: l.outstandingAmount === undefined ? null : fromHmrcNumber(l.outstandingAmount),
      due: l.due ?? null,
    }))
  }

  async payments(input: DateRangeQuery, ctx: HmrcCallContext): Promise<VatPayment[]> {
    const query = new URLSearchParams({ from: input.from, to: input.to })
    const { text } = await this.call(
      'GET',
      `/organisations/vat/${encodeURIComponent(input.vrn)}/payments?${query.toString()}`,
      ctx,
    )
    return PaymentsResponseSchema.parse(JSON.parse(text)).payments.map((p) => ({
      amount: fromHmrcNumber(p.amount),
      received: p.received ?? null,
    }))
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text.slice(0, 2000) }
  }
}

/**
 * HMRC's error bodies carry a `code` and a `message`. The code is what anything
 * downstream branches on; the message is shown alongside our own plain-English
 * gloss, never parsed.
 */
function toHmrcError(status: number, text: string, correlationId: string | null): HmrcApiError {
  const parsed = HmrcErrorSchema.safeParse(safeJson(text))
  const code = parsed.success ? parsed.data.code : `HTTP_${status}`
  const detail = parsed.success ? parsed.data.message : undefined
  return new HmrcApiError({
    hmrcCode: code,
    message: detail ?? `HMRC refused the request (${code}).`,
    httpStatus: status,
    correlationId,
  })
}

/** Plain English for the codes an owner is actually likely to meet. */
export function glossHmrcCode(code: string): string | null {
  switch (code) {
    case 'DUPLICATE_SUBMISSION':
      return 'HMRC says a return has already been filed for this period.'
    case 'PERIOD_KEY_INVALID':
      return 'HMRC does not recognise the period this return is filed against. Refresh your obligations and try again.'
    case 'VRN_INVALID':
      return 'HMRC does not recognise that VAT number.'
    case 'INVALID_REQUEST':
      return 'HMRC would not accept the figures as sent. Nothing has been filed.'
    case 'CLIENT_OR_AGENT_NOT_AUTHORISED':
      return 'The Government Gateway account you connected is not authorised for this VAT number.'
    case 'TAX_PERIOD_NOT_ENDED':
      return 'That VAT period has not finished yet, so HMRC will not accept a return for it.'
    case 'BUSINESS_ERROR':
      return 'HMRC rejected the return. Their message is below.'
    case 'NETWORK':
      return 'We could not reach HMRC. Nothing has been sent.'
    default:
      return null
  }
}
