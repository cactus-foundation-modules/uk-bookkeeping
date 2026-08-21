import { HmrcApiError, HmrcNotConfiguredError } from '../errors'
import type {
  DateRangeQuery,
  FraudHeaderVerdict,
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
import { assertValidPeriodKey, assertValidVrn } from './limits'
import { buildVatReturnBody } from './payload'
import {
  ApplicationTokenSchema,
  FraudHeaderVerdictSchema,
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

    // No Accept header, deliberately: HMRC's own documented curl examples for
    // both the authorization_code exchange and the refresh send content-type
    // alone, and /oauth/token is not a versioned API resource.
    //
    // Measured against the sandbox rather than assumed (sandbox.live.test.ts):
    // sending the versioned media type here made NO difference - both shapes are
    // answered identically. So this is a tidy-up rather than a fix. It is still
    // worth doing, because quietly deviating from a published example is how
    // something breaks later for a reason nobody can find.
    const response = await fetch(`${HMRC_HOSTS[environment].api}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
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
    assertValidVrn(input.vrn)
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
    assertValidVrn(input.vrn)
    // buildVatReturnBody validates the period key and every box against HMRC's
    // own limits, and throws before anything is sent.
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
    assertValidVrn(input.vrn)
    assertValidPeriodKey(input.periodKey)
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
    assertValidVrn(input.vrn)
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
    assertValidVrn(input.vrn)
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

  /**
   * HMRC marking our own homework.
   *
   * Their Test Fraud Prevention Headers API validates the headers on whatever
   * request carries it, so this is a real call with the real bag rather than a
   * description of one. **Application-restricted**, so it uses a
   * client_credentials token of its own rather than the owner's - which means it
   * works before anybody has connected a Government Gateway account, and getting
   * the headers right stops being something you discover ten working days into a
   * production approval application.
   *
   * Sandbox only. On production it reports UNAVAILABLE rather than pretending,
   * because HMRC do not publish it there.
   */
  async validateFraudHeaders(
    input: { environment: HmrcEnvironment; fraudHeaders: Record<string, string> },
    actorUserId: string | null,
  ): Promise<FraudHeaderVerdict> {
    if (input.environment !== 'sandbox') {
      return {
        code: 'UNAVAILABLE',
        message:
          'HMRC only offer this check on their practice service. Switch to it if you want your details checked before you apply for production access.',
        specVersion: null,
        errors: [],
        warnings: [],
      }
    }

    const path = '/test/fraud-prevention-headers/validate'
    const callId = await beginApiCall({
      environment: input.environment,
      method: 'GET',
      path,
      fraudHeaders: input.fraudHeaders,
      actorUserId,
    })
    const startedAt = Date.now()

    try {
      const token = await this.applicationToken(input.environment)
      const response = await fetch(`${HMRC_HOSTS[input.environment].api}${path}`, {
        method: 'GET',
        headers: {
          Accept: HMRC_ACCEPT,
          Authorization: `Bearer ${token}`,
          ...input.fraudHeaders,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const text = await response.text()
      await completeApiCall(callId, {
        statusCode: response.status,
        durationMs: Date.now() - startedAt,
        correlationId: response.headers.get('X-CorrelationId'),
      })

      const parsed = FraudHeaderVerdictSchema.safeParse(safeJson(text))
      if (!parsed.success) {
        return {
          code: 'UNAVAILABLE',
          message: 'HMRC answered in a way we did not recognise. Nothing is wrong with your records.',
          specVersion: null,
          errors: [],
          warnings: [],
        }
      }
      return {
        code: parsed.data.code,
        message: parsed.data.message,
        specVersion: parsed.data.specVersion ?? null,
        errors: (parsed.data.errors ?? []).map(normaliseFinding),
        warnings: (parsed.data.warnings ?? []).map(normaliseFinding),
      }
    } catch (error) {
      await completeApiCall(callId, {
        statusCode: null,
        durationMs: Date.now() - startedAt,
        errorCode: 'NETWORK',
        errorBody: { message: error instanceof Error ? error.message : 'unknown' },
      })
      return {
        code: 'UNAVAILABLE',
        message: 'We could not reach HMRC to have the details checked. Try again in a moment.',
        specVersion: null,
        errors: [],
        warnings: [],
      }
    }
  }

  /**
   * A token for this application rather than for a person. Not stored: it is
   * short-lived, it authorises nothing about anybody's VAT account, and keeping
   * it would be one more secret at rest for no benefit.
   */
  private async applicationToken(environment: HmrcEnvironment): Promise<string> {
    const { clientId, clientSecret } = this.credentials()
    const response = await fetch(`${HMRC_HOSTS[environment].api}/oauth/token`, {
      method: 'POST',
      // Same as the user token above: HMRC's documented shape, content-type alone.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text()
    if (!response.ok) {
      throw toHmrcError(response.status, text, response.headers.get('X-CorrelationId'))
    }
    const parsed = ApplicationTokenSchema.parse(JSON.parse(text))
    return parsed.access_token
  }
}

function normaliseFinding(finding: { code: string; message?: string; headers?: string[] }) {
  return {
    code: finding.code,
    message: finding.message ?? finding.code,
    headers: finding.headers ?? [],
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

/**
 * Plain English for every error code HMRC document on the endpoints this module
 * calls, plus the two we raise ourselves. Branching is on the CODE - the codes
 * are contractual, their wording is not - and anything unlisted falls through to
 * HMRC's own message rather than being guessed at.
 */
export function glossHmrcCode(code: string): string | null {
  switch (code) {
    // Submission
    case 'DUPLICATE_SUBMISSION':
      return 'HMRC says a return has already been filed for this period.'
    case 'PERIOD_KEY_INVALID':
      return 'HMRC does not recognise the period this return is filed against. Refresh your obligations and try again.'
    case 'TAX_PERIOD_NOT_ENDED':
      return 'That VAT period has not finished yet, so HMRC will not accept a return for it.'
    case 'NOT_FINALISED':
      return 'HMRC did not see the declaration that these figures are final. Nothing has been filed.'
    case 'INVALID_REQUEST':
      return 'HMRC would not accept the return as sent. Nothing has been filed.'
    case 'VAT_TOTAL_VALUE':
      return 'HMRC checked the totals and they did not add up on their side. Nothing has been filed - please report this.'
    case 'VAT_NET_VALUE':
      return 'HMRC checked box 5 against boxes 3 and 4 and it did not match. Nothing has been filed - please report this.'
    case 'INVALID_MONETARY_AMOUNT':
    case 'INVALID_NUMERIC_VALUE':
      return 'HMRC would not accept one of the figures as written. Nothing has been filed - please report this.'
    // Obligations, liabilities and payments
    case 'INVALID_DATE_FROM':
    case 'INVALID_DATE_TO':
      return 'HMRC would not accept those dates.'
    case 'INVALID_DATE_RANGE':
      return 'HMRC will only look at a year at a time. Try a shorter stretch of dates.'
    case 'INVALID_STATUS':
      return 'HMRC did not understand which returns were being asked for.'
    case 'NOT_FOUND':
      return 'HMRC has nothing on record for that.'
    // Account-level
    case 'VRN_INVALID':
      return 'HMRC does not recognise that VAT number.'
    case 'CLIENT_OR_AGENT_NOT_AUTHORISED':
      return 'The Government Gateway account you connected is not authorised for this VAT number.'
    case 'RULE_INSOLVENT_TRADER':
      return 'HMRC have flagged this VAT number as insolvent, so it cannot be used here. You will need to speak to them.'
    case 'BUSINESS_ERROR':
      return 'HMRC rejected the return. Their message is below.'
    // Ours
    case 'NETWORK':
      return 'We could not reach HMRC. Nothing has been sent.'
    default:
      return null
  }
}
