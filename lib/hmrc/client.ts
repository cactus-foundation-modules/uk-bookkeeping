import type { HmrcEnvironment, VatBoxes } from '../types'

// The seam.
//
// All outward traffic goes through this one interface. v1 ships one
// implementation, DirectHmrcClient, which reads HMRC_CLIENT_ID and
// HMRC_CLIENT_SECRET from the install's own environment and talks straight to
// HMRC.
//
// A future hosted BrokerHmrcClient would post the same payload plus the same
// fraud bag to a Cactus-operated broker holding one set of production
// credentials and, crucially, a stable egress IP. Because the fraud headers are
// gathered client-side and threaded through as an opaque bag, and because tokens
// are only ever handled inside a client implementation, swapping the two touches
// nothing in the records, computation or period layers. That is the whole point
// of the seam, and it is why nothing outside this folder imports `fetch`.

export type HmrcTokens = {
  accessToken: string
  /** Seconds from now. HMRC's access tokens run about four hours. */
  expiresIn: number
  /**
   * Rotates on every use. Store the new one every single time or the next
   * refresh fails, and the owner is told to reconnect for no reason.
   */
  refreshToken: string
  scope: string | null
}

/**
 * An opaque bag of Gov-* headers, already assembled and encoded. Nothing outside
 * lib/hmrc/fraud-headers.ts knows what is in it, which is what lets a broker
 * implementation forward it untouched.
 */
export type HmrcCallContext = {
  accessToken: string
  environment: HmrcEnvironment
  fraudHeaders: Record<string, string>
  actorUserId?: string | null
}

export type ObligationsQuery = {
  vrn: string
  from?: string
  to?: string
  /** 'O' for open, 'F' for fulfilled. Omitted returns both. */
  status?: 'O' | 'F'
}

export type VatObligation = {
  start: string
  end: string
  due: string
  status: 'O' | 'F'
  periodKey: string
  received?: string
}

export type VatReturnPayload = {
  vrn: string
  periodKey: string
  boxes: VatBoxes
}

export type VatSubmissionReceipt = {
  processingDate: string
  paymentIndicator: string | null
  formBundleNumber: string
  chargeRefNumber: string | null
  receiptId: string | null
  receiptTimestamp: string | null
  correlationId: string | null
}

export type VatReturnView = VatBoxes & { periodKey: string }

export type DateRangeQuery = { vrn: string; from: string; to: string }

/**
 * HMRC's own verdict on the fraud prevention headers we send. `code` is what to
 * branch on; `message` is theirs to word.
 */
export type FraudHeaderVerdict = {
  code: 'VALID_HEADERS' | 'INVALID_HEADERS' | 'POTENTIALLY_INVALID_HEADERS' | 'UNAVAILABLE'
  message: string
  specVersion: string | null
  errors: { code: string; message: string; headers: string[] }[]
  warnings: { code: string; message: string; headers: string[] }[]
}

export type VatLiability = {
  taxPeriodFrom: string | null
  taxPeriodTo: string | null
  type: string
  originalAmount: string
  outstandingAmount: string | null
  due: string | null
}

export type VatPayment = {
  amount: string
  received: string | null
}

export interface HmrcClient {
  authorizationUrl(input: { state: string; environment: HmrcEnvironment }): string
  exchangeCode(input: { code: string; environment: HmrcEnvironment }): Promise<HmrcTokens>
  refresh(input: { refreshToken: string; environment: HmrcEnvironment }): Promise<HmrcTokens>
  obligations(input: ObligationsQuery, ctx: HmrcCallContext): Promise<VatObligation[]>
  submitReturn(input: VatReturnPayload, ctx: HmrcCallContext): Promise<VatSubmissionReceipt>
  viewReturn(
    input: { vrn: string; periodKey: string },
    ctx: HmrcCallContext,
  ): Promise<VatReturnView>
  liabilities(input: DateRangeQuery, ctx: HmrcCallContext): Promise<VatLiability[]>
  payments(input: DateRangeQuery, ctx: HmrcCallContext): Promise<VatPayment[]>
  /**
   * Deliberately does NOT take an HmrcCallContext: the validator is
   * application-restricted rather than user-authorised, so it works before
   * anybody has connected a Government Gateway account.
   */
  validateFraudHeaders(
    input: { environment: HmrcEnvironment; fraudHeaders: Record<string, string> },
    actorUserId: string | null,
  ): Promise<FraudHeaderVerdict>
}
