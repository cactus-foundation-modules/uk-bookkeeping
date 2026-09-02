import { z } from 'zod'

// Request shapes, kept here rather than in a route file so two routes can share
// one without importing each other - a route module importing a sibling route
// module is the sort of thing that works right up until a bundler decides
// otherwise.

export const LineBody = z.object({
  categoryId: z.string().min(1),
  description: z.string().optional(),
  vatTreatment: z.enum([
    'domestic',
    'ni_eu_acquisition',
    'ni_eu_dispatch',
    'reverse_charge_services',
    'import_pva',
    'domestic_reverse_charge',
    'outside_scope',
  ]),
  vatRateCode: z.enum(['standard', 'reduced', 'zero', 'exempt', 'outside_scope']),
  vatRatePercent: z.string(),
  netAmount: z.string(),
  vatAmount: z.string(),
  grossAmount: z.string(),
  isCapital: z.boolean().optional(),
  registerAsset: z.boolean().optional(),
})

export const TransactionBody = z.object({
  entryType: z.enum(['normal', 'adjustment', 'opening_balance']).optional(),
  direction: z.enum(['income', 'expense']),
  taxPointDate: z.string().min(8),
  settledDate: z.string().nullable().optional(),
  /**
   * Which account it was paid from or into. Null means the main current
   * account, which is where a cashbook entry has always settled and is what
   * every entry recorded before this field existed still means.
   */
  bankAccountId: z.string().nullable().optional(),
  counterparty: z.string().min(1),
  description: z.string().optional(),
  reference: z.string().nullable().optional(),
  status: z.enum(['draft', 'posted']).optional(),
  /** "No receipt is coming, and none is meant to." */
  evidenceNotRequired: z.boolean().optional(),
  correctsTransactionId: z.string().nullable().optional(),
  correctionReason: z.string().nullable().optional(),
  lines: z.array(LineBody).min(1),
})

/**
 * Money moved between two accounts the business already owns.
 *
 * Deliberately its own shape rather than a variant of TransactionBody: a
 * transfer has no counterparty, no category, no VAT and no lines, and letting it
 * share a body would mean five optional fields that must be absent, checked by
 * hand, in a place where forgetting one posts a VAT figure nobody typed.
 */
export const TransferBody = z.object({
  date: z.string().min(8),
  /** Always positive. To send it the other way, swap the two accounts over. */
  amount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Give the amount as a number, like 250.00.'),
  fromBankAccountId: z.string().min(1),
  toBankAccountId: z.string().min(1),
  reference: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.enum(['draft', 'posted']).optional(),
})

/** What the browser's fraud collector sends. Everything optional - a value we
 * could not collect is a header we do not send, not a request we refuse. */
export const FraudBagBody = z.object({
  deviceId: z.string().optional(),
  timezoneOffsetMinutes: z.number().optional(),
  screens: z
    .array(
      z.object({
        width: z.number(),
        height: z.number(),
        scalingFactor: z.number(),
        colourDepth: z.number(),
      }),
    )
    .optional(),
  windowWidth: z.number().optional(),
  windowHeight: z.number().optional(),
  userAgent: z.string().optional(),
})

export const HmrcCallBody = z.object({ fraudBag: FraudBagBody.optional() })
