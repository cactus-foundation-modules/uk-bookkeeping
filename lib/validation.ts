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
  counterparty: z.string().min(1),
  description: z.string().optional(),
  reference: z.string().nullable().optional(),
  status: z.enum(['draft', 'posted']).optional(),
  correctsTransactionId: z.string().nullable().optional(),
  correctionReason: z.string().nullable().optional(),
  lines: z.array(LineBody).min(1),
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
