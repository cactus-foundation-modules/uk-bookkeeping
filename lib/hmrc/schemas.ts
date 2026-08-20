import { z } from 'zod'

// Every response body from HMRC is validated before anything is stored.
//
// Two rules follow from that. First, a number HMRC sends back is read as a
// number by zod and immediately turned into a fixed two-place string, because
// the moment we keep it as a JS number we are back in floating point. Second,
// the UI branches on HMRC's error `code`, never on its `message` text - the
// codes are contractual, the wording is not.

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
})

export const ObligationsResponseSchema = z.object({
  obligations: z.array(
    z.object({
      start: z.string(),
      end: z.string(),
      due: z.string(),
      status: z.enum(['O', 'F']),
      periodKey: z.string(),
      received: z.string().optional(),
    }),
  ),
})

export const SubmissionResponseSchema = z.object({
  processingDate: z.string(),
  paymentIndicator: z.string().optional(),
  formBundleNumber: z.string(),
  chargeRefNumber: z.string().optional(),
})

export const ViewReturnResponseSchema = z.object({
  periodKey: z.string(),
  vatDueSales: z.number(),
  vatDueAcquisitions: z.number(),
  totalVatDue: z.number(),
  vatReclaimedCurrPeriod: z.number(),
  netVatDue: z.number(),
  totalValueSalesExVAT: z.number(),
  totalValuePurchasesExVAT: z.number(),
  totalValueGoodsSuppliedExVAT: z.number(),
  totalAcquisitionsExVAT: z.number(),
})

export const LiabilitiesResponseSchema = z.object({
  liabilities: z.array(
    z.object({
      taxPeriod: z.object({ from: z.string(), to: z.string() }).optional(),
      type: z.string(),
      originalAmount: z.number(),
      outstandingAmount: z.number().optional(),
      due: z.string().optional(),
    }),
  ),
})

export const PaymentsResponseSchema = z.object({
  payments: z.array(
    z.object({
      amount: z.number(),
      received: z.string().optional(),
    }),
  ),
})

/** A client_credentials token: no refresh token, no user, short-lived. */
export const ApplicationTokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
})

const FraudFindingSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  headers: z.array(z.string()).optional(),
})

export const FraudHeaderVerdictSchema = z.object({
  code: z.enum(['VALID_HEADERS', 'INVALID_HEADERS', 'POTENTIALLY_INVALID_HEADERS']),
  message: z.string(),
  specVersion: z.string().optional(),
  errors: z.array(FraudFindingSchema).optional(),
  warnings: z.array(FraudFindingSchema).optional(),
})

export const HmrcErrorSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  errors: z
    .array(z.object({ code: z.string(), message: z.string().optional(), path: z.string().optional() }))
    .optional(),
})

/**
 * A number that came back from HMRC, rendered as a two-place decimal string.
 *
 * Only ever used on the way IN. A figure HMRC is showing us is already whatever
 * it is; this stops it drifting further on our side, and keeps everything in the
 * module speaking the same language.
 */
export function fromHmrcNumber(value: number): string {
  return value.toFixed(2)
}
