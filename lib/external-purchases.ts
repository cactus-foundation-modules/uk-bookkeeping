import { prisma } from '@/lib/db/prisma'
import { createAttachment, listAttachments } from './attachments'
import { getCategory, getCategoryByCode } from './categories'
import { learnAlias, resolveAlias } from './counterparty-aliases'
import { BackdatedIntoClosedPeriodError } from './errors'
import { planSaleRemoval, reversalLines } from './external-sales'
import { formatMoney } from './money'
import { createTransaction, deleteTransaction, getTransaction, type LineInput } from './transactions'
import { VAT_RATE_CODES, VAT_TREATMENTS, type VatRateCode, type VatTreatment } from './types'

// Recording a purchase another module already knows about.
//
// The mirror image of lib/external-sales.ts, and it exists for the same reason.
// A purchasing module that has an approved supplier invoice on screen knows what
// was bought, what it cost, what VAT was charged and what it was for - all of it
// already typed in once, by somebody checking it against a delivery. Re-keying
// that into the books is both work and a chance to get it wrong, so it is handed
// over instead: the publisher fires `purchase-orders.bill-approved`, this module
// registers against it (see the manifest), and what arrives is a plain object
// with a VAT breakdown and a category on every line.
//
// Nothing in this file imports anything from the purchasing module, and nothing
// may. The books do not depend on it, are installed on sites that have no
// purchase orders at all, and their files still have to compile there. So the
// payload below is a STRUCTURAL copy of the publisher's contract, not an import
// of it - the two agree by both being written down, which is the deal any
// published extension point makes.
//
// Idempotent on `source` + `source_ref`, keyed off the publisher's own id for
// the bill rather than the supplier's invoice number: two suppliers both
// numbering their first invoice "INV-001" is entirely ordinary, and filing the
// second as a duplicate of the first would lose it without a word.
//
// Dormant on a site with no purchasing module. No schema, no screen, no setting,
// nothing a bookkeeping-only owner pays for - exactly the shape the shop-sales
// consumer beside it already has.

/** One line of the entry, in the SITE's own currency. The publisher converts:
 *  it is the only thing that knows the rate the invoice was struck at. */
export type ExternalPurchaseLine = {
  description: string
  /** A category id from these books, where the publisher offered a picker and
   *  somebody chose. Null, or an id that no longer exists, falls back. */
  categoryId?: string | null
  vatRateCode?: string | null
  vatTreatment?: string | null
  /** The rate that applies. Under a reverse charge this is the rate the books
   *  compute the notional VAT from, with no VAT on the line itself. */
  ratePercent?: string | null
  net: string
  tax: string
  gross?: string
}

/** The supplier's own invoice, already in the site's media library. A reference
 *  rather than bytes: it is one file in one place under the owner's control, and
 *  a second copy is a second thing to keep for six years. */
export type ExternalPurchaseDocument = {
  mediaId?: string | null
  url: string
  filename: string
  mimeType?: string | null
  sizeBytes?: number | null
  mediaProvider?: string | null
  mediaKey?: string | null
}

export type ExternalPurchaseSupplier = {
  name?: string
  accountNumber?: string | null
  taxRegistrationNumber?: string | null
}

/** What a publisher hands over when a supplier's invoice is approved to pay. */
export type ExternalPurchasePayload = {
  source: string
  /** The publisher's own id for the bill. The dedupe key is built from it. */
  billId: string
  /** The number on the supplier's document, for the entry's reference. */
  invoiceNumber: string
  orderId?: string | null
  orderNumber?: string | null
  supplier?: ExternalPurchaseSupplier
  /** yyyy-mm-dd. The invoice date, which is the tax point. */
  taxPointDate: string
  dueDate?: string | null
  currency?: string
  baseCurrency?: string
  fxRate?: string
  totals?: { net?: string; tax?: string; gross?: string }
  lines: ExternalPurchaseLine[]
  description?: string
  document?: ExternalPurchaseDocument
}

/** What a publisher hands over when it withdraws one. */
export type ExternalPurchaseVoidPayload = {
  source: string
  billId: string
  invoiceNumber: string
  orderNumber?: string | null
  supplierName?: string
  voidedAt?: string
  reason?: string
  taxPointDate?: string
  description?: string
}

/** What a publisher hands over when a supplier credits goods sent back.
 *
 *  Every figure is a POSITIVE magnitude: what was credited, not a negative
 *  purchase. The negating happens here, exactly as it does for a sale.
 *
 *  Unlike a sale's credit note, this does NOT insist the purchase is already in
 *  the books. Goods routinely go back before the supplier's invoice ever
 *  arrives, and a credit note is a real reduction of expenditure and of input
 *  VAT whether or not there is an entry beside it to correct. */
export type ExternalPurchaseCreditPayload = {
  source: string
  returnId?: string
  /** The publisher's own credit or returns-note number. */
  returnNumber: string
  orderId?: string | null
  orderNumber?: string | null
  /** The bill this credits, where the publisher could name exactly one. */
  billId?: string | null
  billInvoiceNumber?: string | null
  supplier?: ExternalPurchaseSupplier
  /** yyyy-mm-dd. The tax point of the CREDIT, not of the purchase. */
  taxPointDate: string
  currency?: string
  baseCurrency?: string
  fxRate?: string
  totals?: { net?: string; tax?: string; gross?: string }
  lines: ExternalPurchaseLine[]
  reason?: string
  description?: string
}

export type ExternalPurchaseOutcome = { ok: boolean; message: string }

// ---------------------------------------------------------------------------
// The small stuff
// ---------------------------------------------------------------------------

function decimal(value: string | number | null | undefined): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : '0.00'
}

function pennies(value: string): number {
  return Math.round((Number(value) || 0) * 100)
}

/** -0.00 is a real thing in JavaScript and reads as nonsense on a page. */
function signed(value: string, negate: boolean): string {
  const amount = Number(value)
  const flipped = Number.isFinite(amount) ? (negate ? -amount : amount) : 0
  return (flipped === 0 ? 0 : flipped).toFixed(2)
}

function ledgerDescription(text: string): string {
  const trimmed = (text || '').trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed
}

/** Today, as a plain yyyy-mm-dd. What a reversal is dated: a thing done now, in
 *  the period that is open now. */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The entry this document already made, if it made one. */
async function existingEntry(source: string, ref: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_transactions"
    WHERE "source" = ${source} AND "source_ref" = ${ref}
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

/**
 * Which VAT rate code a percentage is, when the publisher did not say or said
 * something this module has never heard of.
 *
 * The same rule the sales handoff uses. A purchasing module knows what it was
 * charged, not what HMRC calls it: anything at or above the reduced band is the
 * standard rate whatever the number happens to be that year, anything between
 * zero and there is a reduced rate, and zero is zero-rated. Zero-rated rather
 * than exempt, because both carry no VAT but only zero-rated belongs in box 7,
 * and guessing exempt would quietly shrink the purchases box.
 */
function rateCodeFor(percent: number): VatRateCode {
  if (percent <= 0) return 'zero'
  return percent >= 15 ? 'standard' : 'reduced'
}

function rateCodeOf(value: unknown, percent: number): VatRateCode {
  return typeof value === 'string' && (VAT_RATE_CODES as string[]).includes(value)
    ? (value as VatRateCode)
    : rateCodeFor(percent)
}

function treatmentOf(value: unknown): VatTreatment {
  return typeof value === 'string' && (VAT_TREATMENTS as string[]).includes(value)
    ? (value as VatTreatment)
    : 'domestic'
}

/**
 * Where a line is filed.
 *
 * The publisher's own choice wins where it names a category of these books that
 * still exists and can take an expense - the whole point of it offering a picker
 * is that somebody looked at the invoice and said what it was for. Anything else
 * falls back to one category for the lot, which an owner can split afterwards.
 *
 * A cache, because a fifteen-line invoice is fifteen lines pointing at two or
 * three categories and there is no sense asking the database the same question
 * thirteen times.
 */
async function categoryResolver(): Promise<(id: string | null | undefined) => Promise<string | null>> {
  const seen = new Map<string, string | null>()
  return async (id: string | null | undefined): Promise<string | null> => {
    const key = (id ?? '').trim()
    if (!key) return null
    if (seen.has(key)) return seen.get(key) ?? null
    const category = await getCategory(key)
    const usable = category && !category.archived && category.direction !== 'income' ? category.id : null
    seen.set(key, usable)
    return usable
  }
}

/** The category everything else goes to. Cost of goods, because that is what a
 *  purchase order is for; other expenses if a site has archived that one. */
async function fallbackCategoryId(): Promise<string | null> {
  const preferred = await getCategoryByCode('cogs')
  if (preferred && !preferred.archived) return preferred.id
  const other = await getCategoryByCode('other-expenses')
  return other && !other.archived ? other.id : null
}

/**
 * The publisher's lines as ledger lines.
 *
 * One line in, one line out: a purchase invoice already arrives itemised, with a
 * category and a VAT treatment on each line, and folding that into a lump per
 * rate would throw away the part an accountant actually reads. Nothing is
 * re-derived except the gross, which is forced to net plus VAT because the CHECK
 * constraint and the validator both insist on it.
 *
 * Pure, so the rule can be read and tested without a database.
 */
export function purchaseLines(
  lines: ExternalPurchaseLine[],
  categoryFor: (line: ExternalPurchaseLine) => string,
  opts: { negate?: boolean } = {},
): LineInput[] {
  const negate = opts.negate ?? false
  const out: LineInput[] = []

  for (const line of lines) {
    const net = decimal(line.net)
    const vat = decimal(line.tax)
    // A line that contributed nothing is not a line. It would pass validation
    // and then sit in the books saying nothing.
    if (pennies(net) === 0 && pennies(vat) === 0) continue

    const percent = Number(line.ratePercent) || 0
    // The money is the truth. A line that carries VAT cannot be filed as
    // zero-rated, exempt or outside the scope - the validator refuses it, and
    // rightly: there would be a figure in box 4 with no rate behind it.
    const declared = rateCodeOf(line.vatRateCode, percent)
    const code =
      pennies(vat) !== 0 && declared !== 'standard' && declared !== 'reduced'
        ? rateCodeFor(percent)
        : declared

    out.push({
      categoryId: categoryFor(line),
      description: ledgerDescription(line.description),
      vatTreatment: treatmentOf(line.vatTreatment),
      vatRateCode: code,
      vatRatePercent: percent.toFixed(2),
      netAmount: signed(net, negate),
      vatAmount: signed(vat, negate),
      grossAmount: signed((Number(net) + Number(vat)).toFixed(2), negate),
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Files the supplier's own invoice against the entry it just made.
 *
 * Nothing is uploaded and nothing is copied: the file is already in this site's
 * media library, put there by whoever attached it to the bill, and an attachment
 * row records where it lives. HMRC expects the document behind an entry to be
 * producible for six years, and this module's own media-usage extension is what
 * stops the library counting it as clutter and offering to tidy it away.
 *
 * Never throws and never fails the purchase. An entry with no invoice behind it
 * is worth having; a purchase that vanished because a file reference was odd is
 * not. Idempotent on the filename, so the publisher's "try again" button files a
 * document that missed the first time without filing it twice.
 */
async function fileDocument(
  transactionId: string,
  document: ExternalPurchaseDocument | undefined,
): Promise<string> {
  if (!document?.url) return ''
  try {
    const already = await listAttachments(transactionId)
    if (already.some((row) => row.filename === document.filename)) return ''

    await createAttachment(
      {
        transactionId,
        name: 'Supplier invoice',
        filename: document.filename || 'supplier-invoice',
        url: document.url,
        mediaProvider: document.mediaProvider ?? null,
        mediaKey: document.mediaKey ?? null,
        mediaId: document.mediaId ?? null,
        mimeType: document.mimeType || 'application/octet-stream',
        size: Number(document.sizeBytes) || 0,
        // The bytes never pass through here, so there is nothing to hash. Null
        // is the honest answer; a hash of something we never read would be worse.
        sha256: null,
      },
      null,
    )
    return ' Their invoice is attached to it.'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not attach an external purchase document:', message)
    const reason = message.replace(/\s+/g, ' ').trim().slice(0, 200)
    return reason
      ? ` Their invoice itself could not be attached: ${reason}`
      : ' Their invoice itself could not be attached.'
  }
}

/** What the entry calls the supplier, through whatever this site has learned.
 *  A statement line reading "AMZNMKTPLACE" and an invoice from "Amazon EU Sarl"
 *  are the same supplier only because somebody once said so. */
async function counterpartyFor(name: string): Promise<string> {
  const written = (name || '').trim() || 'Supplier'
  return (await resolveAlias(written)) ?? written
}

// ---------------------------------------------------------------------------
// Recording one
// ---------------------------------------------------------------------------

/** The dedupe key. The publisher's id for the bill, never the supplier's own
 *  invoice number: those are unique per supplier and nothing more. */
function billRef(billId: string): string {
  return `bill:${billId}`
}

function creditRef(returnNumber: string): string {
  return `credit:${returnNumber}`
}

/**
 * Records one purchase in the books, or explains in a sentence why it did not.
 *
 * Never throws. It runs inside the publisher's own write path - somebody
 * approving a supplier's invoice - and a bookkeeping problem must not fail that.
 * Every refusal comes back as `{ ok: false, message }`, which the publisher
 * records against the bill so an owner can see it and press the button again.
 */
export async function recordExternalPurchase(
  payload: ExternalPurchasePayload,
): Promise<ExternalPurchaseOutcome> {
  try {
    const billId = payload.billId?.trim()
    if (!billId) return { ok: false, message: 'The invoice arrived without an id, so it cannot be filed.' }
    const invoiceNumber = payload.invoiceNumber?.trim() || billId
    const source = payload.source?.trim() || 'external'
    const ref = billRef(billId)

    const already = await existingEntry(source, ref)
    if (already) {
      // The try-again button lands here. Nothing is recorded twice, but a
      // document that never made it the first time gets another go.
      const filed = await fileDocument(already, payload.document)
      return { ok: true, message: `Already in the books - nothing recorded twice.${filed}` }
    }

    const fallback = await fallbackCategoryId()
    if (!fallback) {
      return {
        ok: false,
        message: 'There is no expense category to file this under. Add one in Bookkeeping and try again.',
      }
    }
    const resolve = await categoryResolver()
    // Resolved up front so the line builder can stay pure and synchronous.
    const chosen = new Map<ExternalPurchaseLine, string>()
    for (const line of payload.lines ?? []) {
      chosen.set(line, (await resolve(line.categoryId)) ?? fallback)
    }

    const lines = purchaseLines(payload.lines ?? [], (line) => chosen.get(line) ?? fallback)
    if (lines.length === 0) {
      return { ok: true, message: 'Nothing to record - the invoice came to zero.' }
    }

    const counterparty = await counterpartyFor(payload.supplier?.name ?? '')
    const description = payload.description ?? `Invoice ${invoiceNumber}`

    const input = {
      direction: 'expense' as const,
      taxPointDate: payload.taxPointDate,
      // Approving an invoice is agreeing to pay it, not paying it. The date it
      // was settled belongs to whatever matches it to the bank later; saying it
      // now would put a cash-accounting return a month early.
      settledDate: null,
      counterparty,
      description,
      reference: invoiceNumber,
      status: 'posted' as const,
      source,
      sourceRef: ref,
      lines,
    }

    const gross = lines.reduce((sum, line) => sum + Number(line.grossAmount), 0)

    try {
      const created = await createTransaction(input, null)
      const filed = await fileDocument(created.id, payload.document)
      await learnAlias(payload.supplier?.name ?? '', counterparty, null)
      return {
        ok: true,
        message: `Recorded as an expense of ${formatMoney(gross.toFixed(2))} in the books.${filed}`,
      }
    } catch (error) {
      // A purchase dated inside a VAT return that is already filed cannot be
      // posted - the return would never be recomputed and the VAT would silently
      // never be reclaimed. Parking it as a draft keeps the record rather than
      // losing it, and puts the judgement call where it belongs: with whoever
      // files the returns.
      if (error instanceof BackdatedIntoClosedPeriodError) {
        const draft = await createTransaction({ ...input, status: 'draft' }, null)
        const filed = await fileDocument(draft.id, payload.document)
        return {
          ok: false,
          message:
            'That VAT period is already filed, so this was saved as a draft entry for you to correct in the open period.' +
            filed,
        }
      }
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not record an external purchase:', message)
    return { ok: false, message }
  }
}

/** What `purchase-orders.bill-approved` calls. Named for the publisher it is
 *  registered against; the work is generic and lives above. */
export async function ukBookkeepingPurchaseRecorder(
  payload: ExternalPurchasePayload,
): Promise<ExternalPurchaseOutcome> {
  return recordExternalPurchase(payload)
}

// ---------------------------------------------------------------------------
// Taking one back out again
// ---------------------------------------------------------------------------
//
// A withdrawn invoice is not an invoice that was never approved. By the time
// somebody voids one, the purchase is in the books and its VAT is in box 4 - so
// unless the publisher says so, the business goes on reclaiming input tax on an
// invoice it decided it did not owe.
//
// Two ways out, and which is right depends entirely on what has happened to the
// entry since. `planSaleRemoval` in lib/external-sales.ts already decides this
// and is imported rather than copied: whether an entry may simply be removed is
// a fact about the entry, not about what kind of document made it.

export async function reverseExternalPurchase(
  payload: ExternalPurchaseVoidPayload,
): Promise<ExternalPurchaseOutcome> {
  try {
    const billId = payload.billId?.trim()
    if (!billId) return { ok: false, message: 'The withdrawal arrived without an id, so nothing could be matched to it.' }
    const source = payload.source?.trim() || 'external'
    const ref = billRef(billId)
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

    const invoiceNumber = payload.invoiceNumber?.trim() || billId
    const reason = `Invoice ${invoiceNumber} was withdrawn${payload.reason?.trim() ? `: ${payload.reason.trim()}` : ''}`
    const input = {
      entryType: 'adjustment' as const,
      direction: original.direction,
      taxPointDate: today(),
      settledDate: null,
      counterparty: original.counterparty,
      description: payload.description ?? `Invoice ${invoiceNumber} withdrawn`,
      reference: invoiceNumber,
      status: 'posted' as const,
      source,
      sourceRef: voidRef,
      correctsTransactionId: originalId,
      correctionReason: reason,
      lines: reversalLines(original.lines),
    }

    const gross = input.lines.reduce((sum, line) => sum + Math.abs(Number(line.grossAmount)), 0)
    try {
      await createTransaction(input, null)
      return {
        ok: true,
        message: `The purchase was in a filed return or matched to the bank, so it stays put and a reversal of ${formatMoney(gross.toFixed(2))} was recorded in the open period.`,
      }
    } catch (error) {
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
    console.error('[uk-bookkeeping] could not reverse an external purchase:', message)
    return { ok: false, message }
  }
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

/** What `purchase-orders.bill-voided` calls. */
export async function ukBookkeepingPurchaseVoider(
  payload: ExternalPurchaseVoidPayload,
): Promise<ExternalPurchaseOutcome> {
  return reverseExternalPurchase(payload)
}

// ---------------------------------------------------------------------------
// A supplier crediting something back
// ---------------------------------------------------------------------------
//
// Goods go back, the supplier issues a credit note, and the money the business
// spent goes down. Without this, a business that returns a damaged desk goes on
// showing the cost of it and goes on reclaiming the input VAT on it, and no
// screen anywhere says so.
//
// Always a reversing entry, never a deletion, exactly as a sales credit is: the
// purchase stood, the goods were bought, and there is a credit note with a
// number on it in a supplier's file. Deleting either side would leave the books
// disagreeing with the paperwork.
//
// Unlike a sale's credit, this does NOT insist the purchase is already here. The
// goods often go back before the invoice ever arrives, and a credit note is a
// real reduction of expenditure whether or not there is an entry beside it. Where
// the publisher can name the bill and that bill IS in the books, the entry points
// at it as a correction; where it cannot, it stands on its own.

export async function recordExternalPurchaseCredit(
  payload: ExternalPurchaseCreditPayload,
): Promise<ExternalPurchaseOutcome> {
  try {
    const number = payload.returnNumber?.trim()
    if (!number) return { ok: false, message: 'The credit arrived with no number on it, so it cannot be filed.' }
    const source = payload.source?.trim() || 'external'
    const ref = creditRef(number)

    const already = await existingEntry(source, ref)
    if (already) return { ok: true, message: 'Already in the books - nothing recorded twice.' }

    const fallback = await fallbackCategoryId()
    if (!fallback) {
      return {
        ok: false,
        message: 'There is no expense category to file this under. Add one in Bookkeeping and try again.',
      }
    }
    const resolve = await categoryResolver()
    const chosen = new Map<ExternalPurchaseLine, string>()
    for (const line of payload.lines ?? []) {
      chosen.set(line, (await resolve(line.categoryId)) ?? fallback)
    }

    // The publisher's figures, negated. Its rates and its categories: a credit
    // is part of the purchase in reverse, not a fresh judgement about what the
    // purchase was.
    const lines = purchaseLines(payload.lines ?? [], (line) => chosen.get(line) ?? fallback, { negate: true })
    if (lines.length === 0) {
      return { ok: true, message: 'Nothing to record - the credit came to zero.' }
    }

    const billId = payload.billId?.trim()
    const originalId = billId ? await existingEntry(source, billRef(billId)) : null
    const original = originalId ? await getTransaction(originalId) : null

    const counterparty = original?.counterparty ?? (await counterpartyFor(payload.supplier?.name ?? ''))
    const against = payload.billInvoiceNumber?.trim()
    const reason =
      `Credit note ${number}${against ? ` against invoice ${against}` : ''}` +
      (payload.reason?.trim() ? `: ${payload.reason.trim()}` : '')

    const input = {
      entryType: 'adjustment' as const,
      direction: 'expense' as const,
      // The credit's own tax point - the day the money came back. Never the
      // purchase's: dating it back would reopen a return that has very probably
      // been filed, and a credit belongs in the period it was given in anyway.
      taxPointDate: payload.taxPointDate || today(),
      settledDate: payload.taxPointDate || today(),
      counterparty,
      description: payload.description ?? `Credit note ${number}`,
      reference: number,
      status: 'posted' as const,
      source,
      sourceRef: ref,
      ...(originalId ? { correctsTransactionId: originalId, correctionReason: reason } : {}),
      lines,
    }

    const gross = lines.reduce((sum, line) => sum + Math.abs(Number(line.grossAmount)), 0)

    try {
      await createTransaction(input, null)
      return {
        ok: true,
        message: against
          ? `Recorded as a credit of ${formatMoney(gross.toFixed(2))} against invoice ${against}, with the VAT on it.`
          : `Recorded as a credit of ${formatMoney(gross.toFixed(2))}, with the VAT on it.`,
      }
    } catch (error) {
      if (error instanceof BackdatedIntoClosedPeriodError) {
        await createTransaction({ ...input, status: 'draft' }, null)
        return {
          ok: false,
          message:
            'That VAT period is already filed, so this was saved as a draft entry for you to correct in the open period.',
        }
      }
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[uk-bookkeeping] could not record an external purchase credit:', message)
    return { ok: false, message }
  }
}

/** What `purchase-orders.bill-credited` calls. */
export async function ukBookkeepingPurchaseCreditor(
  payload: ExternalPurchaseCreditPayload,
): Promise<ExternalPurchaseOutcome> {
  return recordExternalPurchaseCredit(payload)
}
