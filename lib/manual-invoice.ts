import { prisma } from '@/lib/db/prisma'
import { getActiveMediaProvider, isMediaProviderConfigured } from '@/lib/config/env'
import { resolvePrintBrowser } from '@/lib/documents/chromium'
import type { SessionUser } from '@/lib/auth/session'
import { createAttachment, hashBytes } from './attachments'
import { BookkeepingError, NotFoundError } from './errors'
import { storeEvidence } from './evidence-upload'
import { sniffMimeType } from './file-kinds'
import { formatPounds } from './money'
import { getSettings } from './settings'
import { getTransaction, type TransactionWithLines } from './transactions'
import type { BkSettingsRow } from './types'

// An invoice for money somebody recorded by hand.
//
// A sale the shop took comes with the shop's own invoice. A payment typed into
// the books - a failed delivery charge, a cash sale, a transfer nobody raised
// paperwork for - had nothing, so the entry sat in "evidence missing" and the
// customer had nothing to be sent. This makes the invoice from the entry itself:
// the figures are the entry's own lines, so the document and the books cannot
// disagree, and it is filed as the entry's evidence exactly as an uploaded
// invoice would be.
//
// The number is taken from a counter on the settings row and written onto the
// entry BEFORE anything is printed. A print that fails (no browser, no file
// storage) leaves the entry holding its number, and the retry prints under that
// same number - a gap in a run of invoice numbers is the first thing anybody
// checking the records asks about.

/** Which entries get one: money in, recorded by a person, not a correction. */
export function wantsManualInvoice(
  transaction: Pick<TransactionWithLines, 'direction' | 'entry_type' | 'source' | 'status'>,
): boolean {
  return (
    transaction.direction === 'income' &&
    transaction.entry_type === 'normal' &&
    transaction.source === 'manual' &&
    transaction.status === 'posted'
  )
}

export function formatInvoiceNumber(prefix: string, counter: number): string {
  return `${prefix.trim()}${String(counter).padStart(6, '0')}`
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const lines = (value: string | null | undefined): string[] =>
  (value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

function longDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/**
 * The document, as a self-contained page: no stylesheet to fetch, no logo to
 * wait for, so printing it needs nothing from the network.
 */
export function renderInvoiceHtml(
  transaction: TransactionWithLines,
  invoiceNumber: string,
  settings: Pick<BkSettingsRow, 'business_name' | 'business_address' | 'vrn'>,
): string {
  const vatTotal = transaction.lines.reduce((sum, line) => sum + Number(line.vat_amount), 0)
  const net = transaction.lines.reduce((sum, line) => sum + Number(line.net_amount), 0)
  const gross = transaction.lines.reduce((sum, line) => sum + Number(line.gross_amount), 0)
  const title = settings.vrn && vatTotal > 0 ? 'VAT invoice' : 'Invoice'

  const rows = transaction.lines
    .map((line) => {
      const rate = line.vat_rate_code === 'standard' || line.vat_rate_code === 'reduced'
        ? `${Number(line.vat_rate_percent)}%`
        : line.vat_rate_code === 'zero' ? '0%' : 'No VAT'
      return `<tr>
        <td>${escapeHtml(line.description || transaction.description || 'Payment')}</td>
        <td class="n">${formatPounds(line.net_amount)}</td>
        <td class="n">${rate}</td>
        <td class="n">${formatPounds(line.vat_amount)}</td>
        <td class="n">${formatPounds(line.gross_amount)}</td>
      </tr>`
    })
    .join('')

  const seller = [settings.business_name ?? '', ...lines(settings.business_address)]
  const paid = transaction.settled_date
    ? `Paid in full, received ${longDate(transaction.settled_date)}.`
    : 'Paid in full. Thank you.'

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(invoiceNumber)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; font-size: 11pt; color: #1a1a1a; margin: 0; }
  h1 { font-size: 22pt; margin: 0 0 4mm; letter-spacing: 0.02em; }
  .top { display: flex; justify-content: space-between; gap: 12mm; margin-bottom: 12mm; }
  .seller { text-align: right; line-height: 1.45; }
  .seller strong { font-size: 12pt; }
  .meta, .to { line-height: 1.5; }
  .label { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.08em; color: #666; }
  table { width: 100%; border-collapse: collapse; margin-top: 10mm; }
  th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.06em; color: #666; border-bottom: 1.5px solid #1a1a1a; padding: 2mm 2mm; }
  td { padding: 3mm 2mm; border-bottom: 1px solid #ddd; vertical-align: top; }
  .n { text-align: right; white-space: nowrap; }
  th.n { text-align: right; }
  .totals { margin: 6mm 0 0 auto; width: 70mm; }
  .totals div { display: flex; justify-content: space-between; padding: 1.2mm 0; }
  .totals .grand { border-top: 1.5px solid #1a1a1a; margin-top: 1.5mm; padding-top: 2.5mm; font-weight: 700; font-size: 12.5pt; }
  .paid { margin-top: 12mm; font-weight: 600; }
  .foot { margin-top: 6mm; font-size: 9pt; color: #666; }
</style></head><body>
  <div class="top">
    <div class="meta">
      <h1>${title}</h1>
      <div><span class="label">Invoice number</span><br>${escapeHtml(invoiceNumber)}</div>
      <div style="margin-top:3mm"><span class="label">Date</span><br>${longDate(transaction.tax_point_date)}</div>
      ${transaction.reference ? `<div style="margin-top:3mm"><span class="label">Your reference</span><br>${escapeHtml(transaction.reference)}</div>` : ''}
    </div>
    <div class="seller">
      ${seller.map((line, index) => (index === 0 ? `<strong>${escapeHtml(line)}</strong>` : escapeHtml(line))).join('<br>')}
      ${settings.vrn ? `<br>VAT number ${escapeHtml(settings.vrn)}` : ''}
    </div>
  </div>
  <div class="to"><span class="label">Billed to</span><br><strong>${escapeHtml(transaction.counterparty)}</strong></div>
  <table>
    <thead><tr><th>Description</th><th class="n">Net</th><th class="n">VAT rate</th><th class="n">VAT</th><th class="n">Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div><span>Net</span><span>${formatPounds(net.toFixed(2))}</span></div>
    <div><span>VAT</span><span>${formatPounds(vatTotal.toFixed(2))}</span></div>
    <div class="grand"><span>Total</span><span>${formatPounds(gross.toFixed(2))}</span></div>
  </div>
  <div class="paid">${escapeHtml(paid)}</div>
</body></html>`
}

/** HTML to PDF bytes, with the same browser core prints every other document with. */
export async function printPdf(html: string): Promise<Buffer> {
  const [{ default: puppeteer }, resolved] = await Promise.all([
    import('puppeteer-core'),
    resolvePrintBrowser().catch((error: unknown) => {
      throw new BookkeepingError(
        'invoice_pdf_unavailable',
        `The packaged browser could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
        503,
      )
    }),
  ])
  if (!resolved) {
    throw new BookkeepingError(
      'invoice_pdf_unavailable',
      'No browser is available to make a PDF. Install Google Chrome locally, or set CHROME_PATH.',
      503,
    )
  }

  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: resolved.executablePath,
      args: resolved.args,
      headless: true,
      defaultViewport: { width: 794, height: 1123, deviceScaleFactor: 2 },
    })
  } catch (error) {
    throw new BookkeepingError(
      'invoice_pdf_unavailable',
      `The browser would not start: ${error instanceof Error ? error.message : String(error)}`,
      503,
    )
  }
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 })
    await page.emulateMediaType('print')
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true })
    return Buffer.from(pdf)
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * The entry's invoice number, taking the next one off the counter if it has
 * none yet. One transaction, so the counter and the entry move together: either
 * the entry holds a number the counter has passed, or neither happened.
 */
async function ensureInvoiceNumber(transaction: TransactionWithLines): Promise<string> {
  if (transaction.invoice_number) return transaction.invoice_number

  return prisma.$transaction(async (tx) => {
    const [taken] = await tx.$queryRaw<{ invoice_prefix: string; taken: number }[]>`
      UPDATE "bk_settings"
      SET "next_invoice_number" = "next_invoice_number" + 1, "updated_at" = NOW()
      WHERE "id" = 'singleton'
      RETURNING "invoice_prefix", ("next_invoice_number" - 1) AS "taken"
    `
    if (!taken) throw new BookkeepingError('invalid', 'The bookkeeping settings are missing.')
    const number = formatInvoiceNumber(taken.invoice_prefix, taken.taken)
    // `IS NULL` makes a second request that raced this one a no-op rather than a
    // second number for the same entry; the loser reads the winner's.
    const updated = await tx.$executeRaw`
      UPDATE "bk_transactions" SET "invoice_number" = ${number}
      WHERE "id" = ${transaction.id} AND "invoice_number" IS NULL
    `
    if (updated === 0) {
      const [existing] = await tx.$queryRaw<{ invoice_number: string }[]>`
        SELECT "invoice_number" FROM "bk_transactions" WHERE "id" = ${transaction.id}
      `
      if (existing?.invoice_number) throw new RaceLostError(existing.invoice_number)
    }
    return number
  }).catch((error) => {
    // Rolled back with the transaction, so the counter did not move for it.
    if (error instanceof RaceLostError) return error.number
    throw error
  })
}

class RaceLostError extends Error {
  constructor(readonly number: string) {
    super('invoice number already taken')
  }
}

export type IssuedInvoice = { invoiceNumber: string; attachmentId: string; created: boolean }

/**
 * Makes the invoice for an entry and files it as the entry's evidence.
 * Idempotent: an entry that already has its invoice attached gets it back.
 * Throws a BookkeepingError carrying a sentence when it cannot - callers that
 * must not lose the entry over it catch it (see the transactions route).
 */
export async function issueManualInvoice(
  transactionId: string,
  user: SessionUser | null,
): Promise<IssuedInvoice> {
  const transaction = await getTransaction(transactionId)
  if (!transaction) throw new NotFoundError(`Transaction ${transactionId}`)
  if (!wantsManualInvoice(transaction)) {
    throw new BookkeepingError(
      'invalid',
      'Only a recorded payment coming in can have an invoice made for it. Sales from the shop already come with theirs.',
    )
  }

  const settings = await getSettings()
  const invoiceNumber = await ensureInvoiceNumber(transaction)
  const filename = `${invoiceNumber.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`

  const existing = transaction.attachments.find((row) => row.name === 'Invoice' && row.filename.endsWith(filename))
  if (existing) return { invoiceNumber, attachmentId: existing.id, created: false }

  const provider = await getActiveMediaProvider()
  if (!provider || !isMediaProviderConfigured(provider)) {
    throw new BookkeepingError(
      'no_media_provider',
      'File storage is not set up on this site yet. Add a provider in Settings → Media first.',
      503,
    )
  }

  const buffer = await printPdf(renderInvoiceHtml(transaction, invoiceNumber, settings))
  const mimeType = sniffMimeType(buffer)
  if (mimeType !== 'application/pdf') {
    throw new BookkeepingError('invoice_pdf_unavailable', 'The browser did not produce a PDF.', 503)
  }
  if (buffer.length > settings.attachment_max_bytes) {
    throw new BookkeepingError('invalid', 'The invoice came out larger than the evidence size limit.')
  }

  const stored = await storeEvidence(
    { buffer, mimeType, filename, name: 'Invoice' },
    transaction.tax_point_date,
    user?.id ?? null,
    { kind: 'sales-invoice', parts: { documentNumber: invoiceNumber } },
  )
  const attachment = await createAttachment(
    {
      transactionId,
      name: 'Invoice',
      filename,
      url: stored.url,
      mediaProvider: stored.provider,
      mediaKey: stored.key,
      mediaId: stored.mediaId,
      mimeType,
      size: stored.size,
      sha256: hashBytes(buffer),
    },
    user,
  )
  return { invoiceNumber, attachmentId: attachment.id, created: true }
}
