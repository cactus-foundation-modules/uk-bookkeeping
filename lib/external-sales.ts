import { prisma } from '@/lib/db/prisma'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { saveMediaRecord, uploadMedia } from '@/lib/media/upload'
import {
  createAttachment,
  evidenceFolderPath,
  hashBytes,
  listAttachments,
  resolveEvidenceFolderId,
} from './attachments'
import { getCategory, getCategoryByCode } from './categories'
import { BackdatedIntoClosedPeriodError } from './errors'
import { sniffMimeType } from './file-kinds'
import { formatMoney } from './money'
import { getSettings } from './settings'
import { createTransaction, deleteTransaction, getTransaction, type LineInput } from './transactions'
import type { BkTransactionLineRow, VatRateCode } from './types'

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
  /** The document itself, where the publisher can print one. Filed as evidence
   *  against the entry, because a set of books that cannot produce the invoice
   *  behind a line is a set of books with a hole in it - and a link is not
   *  evidence: it dies with the module that served it.
   *
   *  A function rather than bytes because printing an invoice is expensive and
   *  most recorders will not want it. Sinks are called in-process, so this costs
   *  nothing to pass. */
  document?: ExternalSaleDocument
}

export type ExternalSaleDocument = {
  filename: string
  mimeType: string
  bytes: () => Promise<Buffer | Uint8Array | null>
}

/** What a publisher hands over when it withdraws one. */
export type ExternalSaleVoidPayload = {
  source: string
  invoiceNumber: string
  orderNumber?: string
  voidedAt?: string
  reason?: string
  taxPointDate?: string
  description?: string
}

/** What a publisher hands over when it credits part or all of one back.
 *
 *  Deliberately not a void with a smaller number on it. A void says the sale
 *  never stood; this says it stood and some of it has since been handed back -
 *  a different entry, and a different document in the customer's file. It
 *  carries its own number because a credit note is a document in its own right,
 *  and it names the invoice it credits because that is how the two are tied
 *  together.
 *
 *  Every figure is a POSITIVE magnitude: what was credited, not a negative sale.
 *  The negating happens here, exactly as it already does for a void. */
export type ExternalSaleCreditPayload = {
  source: string
  creditNoteId?: string
  creditNoteNumber: string
  invoiceId?: string | null
  /** The invoice being credited - what the sale was filed under. */
  invoiceNumber: string
  orderId?: string
  orderNumber?: string
  issuedAt?: string
  /** yyyy-mm-dd. The tax point of the CREDIT, not of the sale. */
  taxPointDate: string
  currency?: string
  taxMode?: 'INCLUSIVE' | 'EXCLUSIVE'
  customer?: { name?: string; company?: string; email?: string }
  totals?: { net?: string; tax?: string; gross?: string }
  /** Net, tax and gross at each rate, all positive. */
  taxBreakdown: { ratePercent: string; net: string; tax: string; gross: string }[]
  /** Whether this credits the whole invoice or part of it. */
  full?: boolean
  reason?: string
  description?: string
  documentUrl?: string | null
  document?: ExternalSaleDocument
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

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Files the publisher's own document against the entry it just made.
 *
 * Never throws and never fails the sale. An entry with no invoice behind it is
 * worth having; a sale that vanished because a file upload timed out is not. A
 * failure comes back as a sentence, the entry stands, and pressing the
 * publisher's "send to the books again" button tries the attachment again -
 * which is why this is idempotent on the filename.
 */
async function fileDocument(
  transactionId: string,
  taxPointDate: Date,
  document: ExternalSaleDocument | undefined,
): Promise<string> {
  if (!document) return ''
  try {
    const already = await listAttachments(transactionId)
    if (already.some((row) => row.filename === document.filename)) return ''

    const provider = await getActiveMediaProvider()
    if (!provider || !isMediaProviderConfigured(provider)) {
      return ' The invoice itself is not attached: this site has no file storage set up yet.'
    }

    const raw = await document.bytes()
    if (!raw) return ' The invoice itself could not be printed, so nothing is attached to it.'
    // Buffer.from on a Buffer copies; on a Uint8Array it wraps. Either way what
    // goes to storage is a Buffer, because Buffer.isBuffer is false for plenty
    // of things that hold bytes.
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)

    // The bytes decide what it is, exactly as the upload route does it. A
    // publisher that hands over an error page labelled .pdf files nothing.
    const actual = sniffMimeType(buffer)
    if (!actual) return ' The invoice itself was not in a format we can keep, so nothing is attached to it.'

    const settings = await getSettings()
    if (buffer.length > settings.attachment_max_bytes) {
      return ' The invoice itself is too big to keep as evidence, so nothing is attached to it.'
    }

    const folderId = await resolveEvidenceFolderId(taxPointDate)
    const folderPath = await evidenceFolderPath(folderId)
    const result = await uploadMedia(buffer, actual, provider, document.filename, folderPath || undefined)
    const record = await saveMediaRecord({
      key: result.key,
      url: result.url,
      provider,
      mimeType: result.mimeType,
      sizeBytes: result.sizeBytes,
      originalName: document.filename,
      folderId,
    })
    await createAttachment(
      {
        transactionId,
        name: 'Invoice',
        filename: document.filename,
        url: result.url,
        mediaProvider: provider,
        mediaKey: result.key,
        mediaId: record?.id ?? null,
        mimeType: actual,
        size: result.sizeBytes,
        sha256: hashBytes(buffer),
      },
      null,
    )
    return ' The invoice is attached to it.'
  } catch (error) {
    // The reason travels with the refusal, in the publisher's own words rather
    // than ours. "Could not be attached" on its own sent somebody hunting
    // through a bookkeeping module for an afternoon over a file store that was
    // refusing every upload on the site - the sentence that would have settled
    // it in a minute was sitting in a log nobody can read from a deployed site.
    // Truncated because this is appended to a message the publisher stores.
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not attach an external sale document:', message)
    const reason = message.replace(/\s+/g, ' ').trim().slice(0, 200)
    return reason
      ? ` The invoice itself could not be attached - the file store said: ${reason}`
      : ' The invoice itself could not be attached.'
  }
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
    if (already) {
      // The re-send button lands here. Nothing is recorded twice, but a document
      // that never made it the first time gets another go.
      const existingTx = await getTransaction(already)
      const filed = existingTx ? await fileDocument(already, existingTx.tax_point_date, payload.document) : ''
      return { ok: true, message: `Already in the books - nothing recorded twice.${filed}` }
    }

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
      const created = await createTransaction(input, null)
      const filed = await fileDocument(created.id, created.tax_point_date, payload.document)
      return {
        ok: true,
        message: (input.status === 'draft'
          ? `Saved as a draft entry of ${formatMoney(gross.toFixed(2))} for review.`
          : `Recorded as income of ${formatMoney(gross.toFixed(2))} in the books.`) + filed,
      }
    } catch (error) {
      // The one refusal worth working around. A sale dated inside a VAT return
      // that is already filed cannot be posted - the return would never be
      // recomputed and the VAT would silently never be paid. Parking it as a
      // draft keeps the record rather than losing it, and puts the judgement
      // call (a correction in the open period, usually) where it belongs: with
      // the person who files the returns.
      if (error instanceof BackdatedIntoClosedPeriodError) {
        const draft = await createTransaction({ ...input, status: 'draft' }, null)
        const filed = await fileDocument(draft.id, draft.tax_point_date, payload.document)
        return {
          ok: false,
          message:
            'That VAT period is already filed, so this was saved as a draft entry for you to correct in the open period.' + filed,
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

// ---------------------------------------------------------------------------
// Taking one back out again
// ---------------------------------------------------------------------------
//
// A voided invoice is not an invoice that was never raised. By the time somebody
// withdraws one, the sale is in the books and its VAT is in a box on a return -
// so unless the publisher says so, the shop goes on owing HMRC tax on a sale it
// withdrew. That is what `shop.invoice-voided` is for.
//
// Two ways out, and which one is right depends entirely on what has happened to
// the entry since:
//
//  - Nothing has: the return it belongs to is still open, no bank line has been
//    matched to it and nothing corrects it. Then the honest thing is to remove
//    it. It never happened, and leaving a sale and a mirror-image reversal in an
//    open period makes the books harder to read for no gain.
//
//  - Something has: it is in a filed return, it is reconciled against a bank
//    line, or a correction points at it. Then it stays exactly where it is and a
//    reversing entry goes in the open period, which is what a credit note is and
//    the only way a filed return is ever put right.

export type SaleRemovalPlan = 'delete' | 'reverse'

/** Which of the two, given what has happened to the entry. Pure, so the rule can
 *  be read and tested without a database. */
export function planSaleRemoval(state: {
  locked: boolean
  finalised: boolean
  reconciled: boolean
  corrected: boolean
}): SaleRemovalPlan {
  return state.locked || state.finalised || state.reconciled || state.corrected ? 'reverse' : 'delete'
}

/** The original's lines, negated. Same categories, same VAT treatment, same
 *  rates - a credit note is the sale in reverse, not a fresh judgement about
 *  what it was. Gross stays net plus VAT, which is what the CHECK constraint and
 *  the validator both insist on. */
export function reversalLines(lines: Pick<
  BkTransactionLineRow,
  'category_id' | 'description' | 'vat_treatment' | 'vat_rate_code' | 'vat_rate_percent' | 'net_amount' | 'vat_amount' | 'gross_amount' | 'is_capital'
>[]): LineInput[] {
  const negate = (value: unknown): string => {
    const amount = Number(value)
    // -0.00 is a real thing in JavaScript and reads as nonsense on a page.
    const flipped = Number.isFinite(amount) ? -amount : 0
    return (flipped === 0 ? 0 : flipped).toFixed(2)
  }
  return lines.map((line) => ({
    categoryId: line.category_id,
    description: line.description,
    vatTreatment: line.vat_treatment,
    vatRateCode: line.vat_rate_code,
    vatRatePercent: Number(line.vat_rate_percent).toFixed(2),
    netAmount: negate(line.net_amount),
    vatAmount: negate(line.vat_amount),
    grossAmount: negate(line.gross_amount),
    isCapital: line.is_capital,
  }))
}

async function isReconciled(transactionId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_reconciliations" WHERE "transaction_id" = ${transactionId} LIMIT 1
  `
  return rows.length > 0
}

async function isCorrected(transactionId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_transactions" WHERE "corrects_transaction_id" = ${transactionId} LIMIT 1
  `
  return rows.length > 0
}

/** Today, as a plain yyyy-mm-dd. What a reversal is dated: it is a thing done
 *  now, in the period that is open now. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Takes a sale back out of the books after the publisher withdrew its invoice.
 *
 * Never throws, for the same reason nothing else here does: it runs inside the
 * publisher's own void, and a bookkeeping problem must not stop somebody
 * withdrawing a document. Idempotent both ways - the entry is gone or the
 * reversal is already there, and either way saying it twice changes nothing.
 */
export async function reverseExternalSale(payload: ExternalSaleVoidPayload): Promise<ExternalSaleOutcome> {
  try {
    const ref = payload.invoiceNumber?.trim()
    if (!ref) return { ok: false, message: 'The void arrived with no invoice number, so nothing could be matched to it.' }
    const source = payload.source?.trim() || 'external'
    const voidRef = `${ref}:void`

    const originalId = await existingEntry(source, ref)
    if (!originalId) {
      const reversed = await existingEntry(source, voidRef)
      return {
        ok: true,
        message: reversed
          ? 'Already taken out of the books - nothing to do.'
          : 'That invoice was never in the books, so there was nothing to take out.',
      }
    }

    const alreadyReversed = await existingEntry(source, voidRef)
    if (alreadyReversed) return { ok: true, message: 'Already reversed in the books - nothing recorded twice.' }

    const original = await getTransaction(originalId)
    if (!original) return { ok: true, message: 'That invoice was never in the books, so there was nothing to take out.' }

    const plan = planSaleRemoval({
      locked: Boolean(original.locked_period_id),
      finalised: Boolean(original.finalised_period_id),
      reconciled: await isReconciled(originalId),
      corrected: await isCorrected(originalId),
    })

    if (plan === 'delete') {
      await deleteTransaction(originalId, null)
      return { ok: true, message: 'Taken out of the books, along with the VAT on it.' }
    }

    const reason = `Invoice ${ref} was voided${payload.reason?.trim() ? `: ${payload.reason.trim()}` : ''}`
    const input = {
      entryType: 'adjustment' as const,
      direction: original.direction,
      taxPointDate: today(),
      settledDate: null,
      counterparty: original.counterparty,
      description: payload.description ?? `Invoice ${ref} voided`,
      reference: ref,
      status: 'posted' as const,
      source,
      sourceRef: voidRef,
      correctsTransactionId: originalId,
      correctionReason: reason,
      lines: reversalLines(original.lines),
    }

    const gross = input.lines.reduce((sum, line) => sum + Number(line.grossAmount), 0)
    try {
      await createTransaction(input, null)
      return {
        ok: true,
        message: `The sale was in a filed return or matched to the bank, so it stays put and a reversal of ${formatMoney(gross.toFixed(2))} was recorded in the open period.`,
      }
    } catch (error) {
      // Today itself sitting inside a filed return. Vanishingly rare, and a
      // draft is still better than losing the reversal entirely.
      if (error instanceof BackdatedIntoClosedPeriodError) {
        await createTransaction({ ...input, status: 'draft' }, null)
        return {
          ok: false,
          message: 'Every open period is filed, so the reversal was saved as a draft entry for you to date yourself.',
        }
      }
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not reverse an external sale:', message)
    return { ok: false, message }
  }
}

/** What the shop's `shop.invoice-voided` extension point calls. */
export async function ukBookkeepingShopSaleVoider(payload: ExternalSaleVoidPayload): Promise<ExternalSaleOutcome> {
  return reverseExternalSale(payload)
}

// ---------------------------------------------------------------------------
// Crediting part of one back
// ---------------------------------------------------------------------------
//
// The commonest of the three by a distance, and the one whose absence cost the
// most. A refund is not a void: the sale stood, most of it still stands, and
// nothing about it was wrong. What has changed is that some of the money has
// gone back, so that part is no longer turnover and the VAT inside it is no
// longer owed to HMRC. Without this, a shop that refunds hands over tax on money
// it gave to a customer, every quarter, and no screen anywhere says so.
//
// Always a reversing entry, never a deletion - which is the one place this
// differs from a void. A voided invoice sitting in an open period with nothing
// against it may honestly be removed, because it never happened. A credit note
// always happened: there is a document with a number on it in a customer's
// hands, and the sale it credits is still a real sale. Deleting either side of
// that would leave the books disagreeing with the paperwork.

/** The entry a credit note has already made, if it has made one. Namespaced so
 *  it can never collide with the invoice's own ref on a shop whose credit note
 *  and invoice prefixes happen to be the same. */
function creditRef(creditNoteNumber: string): string {
  return `credit:${creditNoteNumber}`
}

/**
 * The publisher's own rate rows, negated into ledger lines.
 *
 * Its rates and its figures, not a scaling of the original sale's: a part refund
 * of a mixed-rate basket is not a fixed proportion of anything, and only the
 * publisher knows which rates the money actually came off. Handing back the
 * zero-rated half of a basket and the standard-rated half are the same money and
 * completely different VAT.
 *
 * Pure, so the rule can be read and tested without a database.
 */
export function creditLines(
  taxBreakdown: { ratePercent: string; net: string; tax: string; gross: string }[],
  categoryId: string,
  description: string,
): LineInput[] {
  const negate = (value: string): string => {
    const amount = Number(value)
    // -0.00 is a real thing in JavaScript and reads as nonsense on a page.
    const flipped = Number.isFinite(amount) ? -amount : 0
    return (flipped === 0 ? 0 : flipped).toFixed(2)
  }
  const lines: LineInput[] = []
  for (const row of taxBreakdown) {
    const net = decimal(row.net)
    const vat = decimal(row.tax)
    const gross = decimal(row.gross)
    // A rate that contributed nothing is not a line. It would pass validation
    // and then sit in the books saying nothing.
    if (Number(net) === 0 && Number(vat) === 0 && Number(gross) === 0) continue
    const percent = Number(row.ratePercent) || 0
    lines.push({
      categoryId,
      description: `${description}${percent > 0 ? ` (${row.ratePercent}%)` : ''}`,
      vatTreatment: 'domestic',
      vatRateCode: rateCodeFor(percent),
      vatRatePercent: percent.toFixed(2),
      netAmount: negate(net),
      vatAmount: negate(vat),
      grossAmount: negate(gross),
    })
  }
  return lines
}

/**
 * Records one credit note against a sale already in the books, or explains in a
 * sentence why it did not.
 *
 * Never throws. It runs inside the publisher's own refund path - money has
 * already moved at a payment provider by the time this is called - and there is
 * no bookkeeping problem that justifies failing that.
 *
 * Idempotent on `source` + `source_ref`. The shop's "send it to the books
 * again" button lands here, and a credit recorded twice is a wrong VAT return in
 * the other direction.
 */
export async function recordExternalCredit(payload: ExternalSaleCreditPayload): Promise<ExternalSaleOutcome> {
  try {
    const creditNumber = payload.creditNoteNumber?.trim()
    if (!creditNumber) return { ok: false, message: 'The credit arrived with no credit note number, so it cannot be filed.' }
    const invoiceRef = payload.invoiceNumber?.trim()
    if (!invoiceRef) {
      return { ok: false, message: 'The credit does not say which invoice it credits, so nothing could be matched to it.' }
    }
    const source = payload.source?.trim() || 'external'
    const ref = creditRef(creditNumber)

    const settings = await getSettings()
    if (!settings.external_sales_enabled) {
      return { ok: true, message: 'Recording sales in the books automatically is switched off in Bookkeeping settings.' }
    }

    const already = await existingEntry(source, ref)
    if (already) {
      // The re-send button lands here. Nothing is recorded twice, but a document
      // that never made it the first time gets another go.
      const existingTx = await getTransaction(already)
      const filed = existingTx ? await fileDocument(already, existingTx.tax_point_date, payload.document) : ''
      return { ok: true, message: `Already in the books - nothing recorded twice.${filed}` }
    }

    // The sale itself has to be here, because a credit is a correction and a
    // correction has to name what it corrects. A credit filed against nothing
    // would push turnover below what was actually sold, which is a worse fault
    // than the one being fixed - so it is refused in words the owner can act on.
    const originalId = await existingEntry(source, invoiceRef)
    if (!originalId) {
      return {
        ok: false,
        message: `Invoice ${invoiceRef} is not in the books, so there is nothing to credit. Send that invoice to the books first, then try this again.`,
      }
    }
    const original = await getTransaction(originalId)
    if (!original) {
      return { ok: false, message: `Invoice ${invoiceRef} is not in the books, so there is nothing to credit.` }
    }

    // The publisher's figures, negated. Its rates, its categories: a credit note
    // is part of the sale in reverse, not a fresh judgement about what the sale
    // was. Taken from the payload rather than by scaling the original's lines,
    // because a part refund of a mixed-rate basket is not a fixed proportion of
    // anything - the publisher is the only thing that knows which rates the money
    // came off.
    const category = settings.external_sales_category_id
      ? await getCategory(settings.external_sales_category_id)
      : await getCategoryByCode('sales')
    if (!category) {
      return { ok: false, message: 'No sales category to file this under. Pick one in Bookkeeping settings.' }
    }

    const lines = creditLines(payload.taxBreakdown ?? [], category.id, payload.description ?? `Credit note ${creditNumber}`)
    if (lines.length === 0) {
      return { ok: true, message: 'Nothing to record - the credit note came to zero.' }
    }

    const reason =
      `Credit note ${creditNumber} against invoice ${invoiceRef}` +
      (payload.reason?.trim() ? `: ${payload.reason.trim()}` : '')

    const input = {
      entryType: 'adjustment' as const,
      direction: original.direction,
      // The credit's own tax point - the day the money went back. Never the
      // sale's: dating it back into the quarter the sale was in would reopen a
      // return that has very probably been filed, and a credit belongs in the
      // period it was given in anyway.
      taxPointDate: payload.taxPointDate || today(),
      settledDate: payload.taxPointDate || today(),
      counterparty: original.counterparty,
      description: payload.description ?? `Credit note ${creditNumber}`,
      reference: creditNumber,
      status: 'posted' as const,
      source,
      sourceRef: ref,
      correctsTransactionId: originalId,
      correctionReason: reason,
      lines,
    }

    const gross = lines.reduce((sum, line) => sum + Math.abs(Number(line.grossAmount)), 0)

    try {
      const created = await createTransaction(input, null)
      const filed = await fileDocument(created.id, created.tax_point_date, payload.document)
      return {
        ok: true,
        message:
          `Recorded as a credit of ${formatMoney(gross.toFixed(2))} against invoice ${invoiceRef}, with the VAT on it.` + filed,
      }
    } catch (error) {
      // The credit's own period already filed. Rare - it is dated the day the
      // money went back, which is nearly always the open one - but a draft keeps
      // the record rather than losing it, and puts the judgement call with the
      // person who files the returns.
      if (error instanceof BackdatedIntoClosedPeriodError) {
        const draft = await createTransaction({ ...input, status: 'draft' }, null)
        const filed = await fileDocument(draft.id, draft.tax_point_date, payload.document)
        return {
          ok: false,
          message:
            'That VAT period is already filed, so this was saved as a draft entry for you to correct in the open period.' + filed,
        }
      }
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not record an external credit:', message)
    return { ok: false, message }
  }
}

/** What the shop's `shop.invoice-credited` extension point calls. */
export async function ukBookkeepingShopSaleCreditor(payload: ExternalSaleCreditPayload): Promise<ExternalSaleOutcome> {
  return recordExternalCredit(payload)
}
