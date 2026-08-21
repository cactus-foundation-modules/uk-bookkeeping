import { prisma } from '@/lib/db/prisma'
import { getCategory, getCategoryByCode } from './categories'
import { BackdatedIntoClosedPeriodError } from './errors'
import { formatMoney } from './money'
import { getSettings } from './settings'
import { createTransaction, type LineInput } from './transactions'
import type { VatRateCode } from './types'

// Recording a sale another module already knows about.
//
// A shop that raises an invoice knows, at that moment, exactly what was charged
// and at what rate. Re-keying that into the books is both work and a chance to
// get it wrong, so it is handed over instead: the shop publishes
// `shop.invoice-issued`, this module registers against it (see the manifest),
// and what arrives is a plain object with a VAT breakdown on it.
//
// Nothing in this file imports anything from the shop module, and nothing may.
// The books do not depend on the shop, are installed on sites that have no shop
// at all, and their files still have to compile there. So the payload below is a
// STRUCTURAL copy of the shop's contract, not an import of it - the two agree by
// both being written down, which is the deal any published extension point
// makes.
//
// Idempotent on `source` + `source_ref`. The shop may hand the same invoice over
// twice (its own re-send button does exactly that), and a sale recorded twice is
// a wrong VAT return.

/** What a publisher hands over. Mirrors `ShopInvoiceSinkPayload` in the shop
 *  module; see the note above about why it is copied rather than imported. */
export type ExternalSalePayload = {
  source: string
  invoiceId?: string
  invoiceNumber: string
  orderId?: string
  orderNumber?: string
  issuedAt?: string
  /** yyyy-mm-dd. The date the VAT belongs to. */
  taxPointDate: string
  /** yyyy-mm-dd it was paid, or null. Cash accounting turns on this. */
  settledDate?: string | null
  currency?: string
  taxMode?: 'INCLUSIVE' | 'EXCLUSIVE'
  customer?: { name?: string; company?: string; email?: string }
  totals?: { net?: string; tax?: string; gross?: string }
  /** Net, tax and gross at each rate. This is the part the books actually need. */
  taxBreakdown: { ratePercent: string; net: string; tax: string; gross: string }[]
  description?: string
  documentUrl?: string | null
}

export type ExternalSaleOutcome = { ok: boolean; message: string }

/**
 * Which VAT rate code a percentage is.
 *
 * The publisher knows what it charged, not what HMRC calls it, so the mapping
 * lives here where the vocabulary does. Anything above the reduced band is the
 * standard rate whatever the number happens to be that year (it has been 17.5
 * and 15 within living memory), anything between zero and there is a reduced
 * rate (5, and the 12.5 hospitality rate), and zero is zero-rated.
 *
 * Zero-rated rather than exempt or outside-scope, deliberately: all three carry
 * no VAT, but a zero-rated sale still belongs in box 6, and a shop's tax table
 * cannot tell the three apart - it only knows the rate it charged. Filing a sale
 * as outside-scope on a guess would quietly shrink the turnover box.
 */
function rateCodeFor(percent: number): VatRateCode {
  if (percent <= 0) return 'zero'
  return percent >= 15 ? 'standard' : 'reduced'
}

function decimal(value: string | undefined): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : '0.00'
}

/** The entry this sale already made, if it made one. */
async function existingEntry(source: string, ref: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_transactions"
    WHERE "source" = ${source} AND "source_ref" = ${ref}
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

/**
 * Records one sale in the books, or explains in a sentence why it did not.
 *
 * Never throws. It runs inside the publisher's own write path - a shop raising
 * an invoice off the back of an order being completed - and a bookkeeping
 * problem must not fail somebody's order. Every refusal comes back as
 * `{ ok: false, message }`, which the publisher records against the document so
 * an owner can see it and press the button again.
 */
export async function recordExternalSale(payload: ExternalSalePayload): Promise<ExternalSaleOutcome> {
  try {
    const ref = payload.invoiceNumber?.trim()
    if (!ref) return { ok: false, message: 'The sale arrived with no invoice number, so it cannot be filed.' }
    const source = payload.source?.trim() || 'external'

    const settings = await getSettings()
    if (!settings.external_sales_enabled) {
      return { ok: true, message: 'Recording sales in the books automatically is switched off in Bookkeeping settings.' }
    }

    const already = await existingEntry(source, ref)
    if (already) return { ok: true, message: `Already in the books - nothing recorded twice.` }

    const category = settings.external_sales_category_id
      ? await getCategory(settings.external_sales_category_id)
      : await getCategoryByCode('sales')
    if (!category) {
      return { ok: false, message: 'No sales category to file this under. Pick one in Bookkeeping settings.' }
    }
    if (category.direction === 'expense') {
      return { ok: false, message: `"${category.name}" is an expense category, so sales cannot be filed into it.` }
    }

    // One line per VAT rate, which is exactly the shape the books want and
    // exactly what a mixed-rate basket needs: a return that lumps 20% and 0%
    // together is wrong in box 1 and box 6 at once.
    const lines: LineInput[] = []
    for (const row of payload.taxBreakdown ?? []) {
      const net = decimal(row.net)
      const vat = decimal(row.tax)
      const gross = decimal(row.gross)
      // A rate that contributed nothing is not a line. It would pass validation
      // and then sit in the books saying nothing.
      if (Number(net) === 0 && Number(vat) === 0 && Number(gross) === 0) continue
      const percent = Number(row.ratePercent) || 0
      lines.push({
        categoryId: category.id,
        description: `${payload.description ?? `Invoice ${ref}`}${percent > 0 ? ` (${row.ratePercent}%)` : ''}`,
        vatTreatment: 'domestic',
        vatRateCode: rateCodeFor(percent),
        vatRatePercent: percent.toFixed(2),
        netAmount: net,
        vatAmount: vat,
        grossAmount: gross,
      })
    }
    if (lines.length === 0) {
      return { ok: true, message: 'Nothing to record - the invoice came to zero.' }
    }

    const counterparty =
      payload.customer?.company?.trim() ||
      payload.customer?.name?.trim() ||
      'Retail customer'

    const input = {
      direction: 'income' as const,
      taxPointDate: payload.taxPointDate,
      settledDate: payload.settledDate ?? null,
      counterparty,
      description: payload.description ?? `Invoice ${ref}`,
      reference: ref,
      status: settings.external_sales_status === 'draft' ? ('draft' as const) : ('posted' as const),
      source,
      sourceRef: ref,
      lines,
    }

    const gross = lines.reduce((sum, line) => sum + Number(line.grossAmount), 0)

    try {
      await createTransaction(input, null)
      return {
        ok: true,
        message: input.status === 'draft'
          ? `Saved as a draft entry of ${formatMoney(gross.toFixed(2))} for review.`
          : `Recorded as income of ${formatMoney(gross.toFixed(2))} in the books.`,
      }
    } catch (error) {
      // The one refusal worth working around. A sale dated inside a VAT return
      // that is already filed cannot be posted - the return would never be
      // recomputed and the VAT would silently never be paid. Parking it as a
      // draft keeps the record rather than losing it, and puts the judgement
      // call (a correction in the open period, usually) where it belongs: with
      // the person who files the returns.
      if (error instanceof BackdatedIntoClosedPeriodError) {
        await createTransaction({ ...input, status: 'draft' }, null)
        return {
          ok: false,
          message: 'That VAT period is already filed, so this was saved as a draft entry for you to correct in the open period.',
        }
      }
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not record an external sale:', message)
    return { ok: false, message }
  }
}

/** What the shop's `shop.invoice-issued` extension point calls. Named for the
 *  publisher it is registered against; the work is generic and lives above. */
export async function ukBookkeepingShopSaleRecorder(payload: ExternalSalePayload): Promise<ExternalSaleOutcome> {
  return recordExternalSale(payload)
}
