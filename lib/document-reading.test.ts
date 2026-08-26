import { describe, expect, it } from 'vitest'
import {
  findDocumentDate,
  findVatTreatment,
  findDocumentNumber,
  findVatNumber,
  isValidVatNumber,
  readDocument,
  readExtractedText,
  type ReadingContext,
} from './document-reading'
import type { PdfText, PdfTextItem, PdfTextRow } from './pdf/text'

// The reader, on the documents that break readers.
//
// Every case here is one an invoice in the wild actually does, and most of them
// are cases where the obvious implementation is confidently wrong rather than
// merely unhelpful: "Total VAT" read as the total, "Invoice Date 04/09/2026"
// read as invoice number 04/09/2026, a phone number beside the word VAT read as
// a registration, an American 04/09 read as April.
//
// No database anywhere in this file. That is the point of the reader taking its
// context as an argument.

const TODAY = '2026-09-20'

function context(overrides: Partial<ReadingContext> = {}): ReadingContext {
  return {
    knownCounterparties: [],
    aliases: new Map(),
    vatNumberOwners: new Map(),
    ownBusinessName: null,
    ownVatNumber: null,
    ...overrides,
  }
}

/**
 * A page, laid out the way lib/pdf hands one over: cells with coordinates,
 * grouped into rows, plus the whole thing flattened.
 *
 * Rows are twenty points apart from the top down, and cells a hundred and fifty
 * across, which is enough separation for the "top of the page" and "last figure
 * on the row" rules to mean what they mean on a real page.
 */
function page(rows: { cells: string[]; size?: number }[]): Pick<PdfText, 'plain' | 'rows' | 'items'> {
  const items: PdfTextItem[] = []
  const pdfRows: PdfTextRow[] = []
  rows.forEach((row, index) => {
    const y = 800 - index * 20
    const cells: PdfTextItem[] = row.cells.map((text, column) => ({
      page: 0,
      x: 50 + column * 150,
      y,
      size: row.size ?? 10,
      text,
      // Unmeasured, which is what makes mergeGlyphRuns leave these rows alone -
      // they are already words.
      width: 0,
    }))
    items.push(...cells)
    pdfRows.push({ page: 0, y, cells })
  })
  return { items, rows: pdfRows, plain: rows.map((row) => row.cells.join(' ')).join('\n') }
}

describe('the three figures', () => {
  it('reads a subtotal, a VAT line and a total off their own rows', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Acme Supplies Ltd'], size: 18 },
        { cells: ['Invoice'] },
        { cells: ['Widget', '2', '61.70'] },
        { cells: ['Subtotal', '61.70'] },
        { cells: ['VAT @ 20%', '12.34'] },
        { cells: ['Total', '74.04'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.net).toBe('61.70')
    expect(reading.vat).toBe('12.34')
    expect(reading.total).toBe('74.04')
    expect(reading.vatRateCode).toBe('standard')
  })

  it('does not read "Total VAT" as the total', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Net Total', '100.00'] },
        { cells: ['Total VAT', '20.00'] },
        { cells: ['Amount Due', '120.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.net).toBe('100.00')
    expect(reading.vat).toBe('20.00')
    expect(reading.total).toBe('120.00')
  })

  it('does not read "Total including VAT" as the VAT', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Total excluding VAT', '50.00'] },
        { cells: ['VAT', '10.00'] },
        { cells: ['Total including VAT', '60.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.total).toBe('60.00')
    expect(reading.net).toBe('50.00')
    expect(reading.vat).toBe('10.00')
  })

  it('works the missing figure out from the two it has', () => {
    const fromTotalAndVat = readExtractedText(
      page([
        { cells: ['VAT', '4.00'] },
        { cells: ['Total', '24.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(fromTotalAndVat.net).toBe('20.00')

    const fromNetAndVat = readExtractedText(
      page([
        { cells: ['Subtotal', '20.00'] },
        { cells: ['VAT', '4.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(fromNetAndVat.total).toBe('24.00')
  })

  it('trusts the total and the net when the three do not add up', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Subtotal', '100.00'] },
        { cells: ['VAT', '19.99'] },
        { cells: ['Total', '120.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.net).toBe('100.00')
    expect(reading.total).toBe('120.00')
    expect(reading.vat).toBe('20.00')
  })

  it('leaves VAT null when the document never mentions it', () => {
    const reading = readExtractedText(
      page([{ cells: ['Total', '18.50'] }]),
      'receipt.pdf',
      context(),
      TODAY,
    )
    expect(reading.total).toBe('18.50')
    expect(reading.vat).toBeNull()
    expect(reading.net).toBeNull()
    expect(reading.vatRateCode).toBeNull()
  })

  it('reads a reduced rate as reduced and a zero-rated bill as zero', () => {
    const reduced = readExtractedText(
      page([
        { cells: ['Subtotal', '100.00'] },
        { cells: ['VAT', '5.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reduced.vatRateCode).toBe('reduced')

    const zero = readExtractedText(
      page([
        { cells: ['Subtotal', '100.00'] },
        { cells: ['VAT', '0.00'] },
        { cells: ['Total', '100.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(zero.vatRateCode).toBe('zero')
  })

  it('refuses to name a rate when the ratio is not a UK one', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Subtotal', '100.00'] },
        { cells: ['VAT', '13.50'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.vat).toBe('13.50')
    expect(reading.vatRateCode).toBeNull()
  })

  it('is not fooled by numbers that are not money', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Invoice 12345'] },
        { cells: ['Unit 4, Trading Estate'] },
        { cells: ['Total', '9.99'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.total).toBe('9.99')
  })
})

describe('VAT registration numbers', () => {
  it('checks the modulus-97 sum rather than trusting nine digits', () => {
    expect(isValidVatNumber('123456782')).toBe(true)
    expect(isValidVatNumber('123456789')).toBe(false)
    expect(isValidVatNumber('12345678')).toBe(false)
  })

  it('takes one with a GB prefix, spaced as a letterhead spaces it', () => {
    expect(findVatNumber('VAT Reg No. GB 123 4567 82')).toBe('GB123456782')
  })

  it('takes a labelled one with no prefix', () => {
    expect(findVatNumber('VAT Registration Number: 123456782')).toBe('GB123456782')
  })

  it('ignores a number beside the word VAT that is not a registration', () => {
    expect(findVatNumber('VAT enquiries: 0300 200 3700')).toBeNull()
    expect(findVatNumber('VAT Reg No. GB 123 4567 89')).toBeNull()
  })

  it('drops the branch suffix so two invoices are one supplier', () => {
    expect(findVatNumber('GB123456782001')).toBe('GB123456782')
  })

  it('treats our own number as proof we wrote the document', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Our Company Ltd'], size: 18 },
        { cells: ['VAT Reg No GB123456782'] },
        { cells: ['Total', '90.00'] },
      ]),
      'invoice.pdf',
      context({ ownVatNumber: 'GB123456782', ownBusinessName: 'Our Company Ltd' }),
      TODAY,
    )
    expect(reading.direction).toBe('income')
    // Never filed in the supplier's column, or it would claim every later
    // document for us.
    expect(reading.vatNumber).toBeNull()
  })
})

describe('dates', () => {
  it('reads a numeric date day-first', () => {
    expect(findDocumentDate('Invoice Date 04/09/2026', TODAY)).toBe('2026-09-04')
  })

  it('reads a named month, ordinal and all', () => {
    expect(findDocumentDate('Date of Issue: 1st Sep 2026', TODAY)).toBe('2026-09-01')
  })

  it('prefers the tax point over anything else on the page', () => {
    expect(
      findDocumentDate('Due date 30/09/2026 Tax point 02/09/2026 Printed 20/09/2026', TODAY),
    ).toBe('2026-09-02')
  })

  it('does not take a due date for an invoice date', () => {
    // Nothing labelled as an invoice date at all, so the first readable date
    // wins - which is the one printed first, not the one after "Due date".
    expect(findDocumentDate('Issued 03/09/2026, due date 30/09/2026', TODAY)).toBe('2026-09-03')
  })

  it('refuses a date that cannot be an invoice date', () => {
    expect(findDocumentDate('Renewal 04/09/2035', TODAY)).toBeNull()
    expect(findDocumentDate('© 1998 Acme', TODAY)).toBeNull()
  })

  it('refuses a day that does not exist', () => {
    expect(findDocumentDate('Invoice date 30/02/2026', TODAY)).toBeNull()
  })
})

describe('document numbers', () => {
  it('reads the invoice number off its label', () => {
    expect(findDocumentNumber('Invoice No: INV-0042')).toBe('INV-0042')
    expect(findDocumentNumber('Tax Invoice No 883021')).toBe('883021')
    expect(findDocumentNumber('Invoice #A/2026/17')).toBe('A/2026/17')
  })

  it('does not hand back the invoice DATE as the invoice number', () => {
    expect(findDocumentNumber('Invoice Date 04/09/2026')).toBeNull()
  })

  it('ignores a label with a word after it rather than a number', () => {
    expect(findDocumentNumber('Invoice to Acme Supplies')).toBeNull()
  })

  it('prefers the invoice number to an order number', () => {
    expect(findDocumentNumber('Order No PO-9 Invoice No INV-77')).toBe('INV-77')
  })
})

describe('a number whose punctuation the font would not name', () => {
  // Some subset fonts map a glyph to U+0000 - "no character" - and there is
  // nowhere else to look: the embedded cmap covers only what the subsetter kept
  // and `post` 3.0 carries no glyph names. So a hyphen simply is not there, and
  // the page reads "C1DC111A 0012". The file it arrived in knows.
  it('takes the spelling from the filename when every readable character agrees', () => {
    expect(findDocumentNumber('Invoice number C1DC111A 0012', 'Invoice-C1DC111A-0012.pdf')).toBe(
      'C1DC111A-0012',
    )
  })

  it('works when the gap closed up rather than became a space', () => {
    expect(findDocumentNumber('Invoice No INV0042', 'INV-0042.pdf')).toBe('INV-0042')
  })

  it('leaves it alone when the filename says nothing', () => {
    expect(findDocumentNumber('Invoice number C1DC111A 0012', 'scan001.pdf')).toBe('C1DC111A 0012')
    expect(findDocumentNumber('Invoice No INV-77', 'invoice.pdf')).toBe('INV-77')
  })

  it('refuses a filename that disagrees on a character we could read', () => {
    // One digit different is a different invoice, not different punctuation.
    expect(findDocumentNumber('Invoice number C1DC111A 0012', 'Invoice-C1DC111A-0013.pdf')).toBe(
      'C1DC111A 0012',
    )
  })

  it('refuses to take the tail of a longer number out of a filename', () => {
    // "0012" inside "990012" is somebody else's reference, not ours.
    expect(findDocumentNumber('Invoice No 0012', 'Invoice-990012.pdf')).toBe('0012')
  })

  it('does not match on a key too short to mean anything', () => {
    expect(findDocumentNumber('Invoice No 12', 'Statement-1-2.pdf')).toBe('12')
  })
})

describe('who it is from', () => {
  const layout = (extra: { cells: string[]; size?: number }[] = []) =>
    page([
      { cells: ['Acme Supplies Limited'], size: 20 },
      { cells: ['12 Trading Estate, Leeds'] },
      { cells: ['hello@acmesupplies.co.uk'] },
      { cells: ['INVOICE'], size: 14 },
      { cells: ['Bill To'] },
      { cells: ['Our Company Ltd'] },
      ...extra,
      { cells: ['Total', '120.00'] },
    ])

  it('prefers a supplier the books already know', () => {
    const reading = readExtractedText(layout(), 'scan001.pdf', context({
      knownCounterparties: ['Acme Supplies Ltd'],
      ownBusinessName: 'Our Company Ltd',
    }), TODAY)
    expect(reading.counterparty).toBe('Acme Supplies Ltd')
    expect(reading.counterpartyConfidence).toBeGreaterThanOrEqual(85)
  })

  it('never reads our own name off a Bill To block as the supplier', () => {
    const reading = readExtractedText(
      layout(),
      'scan001.pdf',
      context({ knownCounterparties: ['Our Company Ltd'], ownBusinessName: 'Our Company Ltd' }),
      TODAY,
    )
    expect(reading.counterparty).not.toBe('Our Company Ltd')
  })

  it('falls back to the biggest thing at the top of the page', () => {
    const reading = readExtractedText(layout(), 'scan001.pdf', context({
      ownBusinessName: 'Our Company Ltd',
    }), TODAY)
    expect(reading.counterparty).toBe('Acme Supplies Limited')
    expect(reading.counterpartySource).toBe('letterhead')
  })

  it('does not mistake the word INVOICE for a company', () => {
    const reading = readExtractedText(
      page([
        { cells: ['INVOICE'], size: 24 },
        { cells: ['Riverside Joinery'], size: 16 },
        { cells: ['Total', '80.00'] },
      ]),
      'scan.pdf',
      context(),
      TODAY,
    )
    expect(reading.counterparty).toBe('Riverside Joinery')
  })

  it('uses a name learned from an earlier correction', () => {
    const reading = readExtractedText(layout(), 'scan001.pdf', context({
      aliases: new Map([['acme supplies', 'Acme Supplies (Leeds)']]),
      ownBusinessName: 'Our Company Ltd',
    }), TODAY)
    expect(reading.counterparty).toBe('Acme Supplies (Leeds)')
    expect(reading.counterpartySource).toBe('alias')
  })

  it('recognises a supplier by their VAT number even with a new letterhead', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Acme Group PLC'], size: 20 },
        { cells: ['VAT Reg No GB123456782'] },
        { cells: ['Total', '120.00'] },
      ]),
      'scan.pdf',
      context({ vatNumberOwners: new Map([['GB123456782', 'Acme Supplies Ltd']]) }),
      TODAY,
    )
    expect(reading.counterparty).toBe('Acme Supplies Ltd')
    expect(reading.counterpartySource).toBe('vat_number')
    expect(reading.counterpartyConfidence).toBeGreaterThan(90)
  })

  it('takes a web address when there is no letterhead text at all', () => {
    const reading = readExtractedText(
      page([
        { cells: ['INVOICE'], size: 24 },
        { cells: ['www.riverside-joinery.co.uk'] },
        { cells: ['Total', '80.00'] },
      ]),
      'scan.pdf',
      context(),
      TODAY,
    )
    expect(reading.counterparty).toBe('Riverside Joinery')
    expect(reading.counterpartySource).toBe('domain')
  })

  it('does not read a mail provider as a supplier', () => {
    const reading = readExtractedText(
      page([
        { cells: ['RECEIPT'], size: 24 },
        { cells: ['bob@gmail.com'] },
        { cells: ['Total', '8.00'] },
      ]),
      'scan.pdf',
      context(),
      TODAY,
    )
    expect(reading.counterpartySource).not.toBe('domain')
  })
})

describe('the headings an invoice puts in its own biggest type', () => {
  // Every case here comes off one real invoice, which the reader got wrong in
  // four different ways before any of them existed.
  const stripeish = (extra: { cells: string[]; size?: number }[] = []) =>
    page([
      { cells: ['Invoice'], size: 18 },
      { cells: ['Invoice number', 'C1DC111A 0012'] },
      { cells: ['Date of issue', 'August 26, 2026'] },
      { cells: ['VAT Registration UK VAT GB475258267'] },
      { cells: ['Anthropic, PBC @anthropic'] },
      { cells: ['support@anthropic.com'] },
      ...extra,
      { cells: ['Total', '75.00'] },
    ])

  it('does not read "Invoice number" as the supplier', () => {
    const reading = readExtractedText(stripeish(), 'invoice.pdf', context(), TODAY)
    expect(reading.counterparty).not.toMatch(/invoice/i)
  })

  it('does not read the date beside "Date of issue" as the supplier', () => {
    const reading = readExtractedText(stripeish(), 'invoice.pdf', context(), TODAY)
    expect(reading.counterparty).not.toMatch(/august/i)
  })

  it('keeps the name and drops the handle stuck on the end of it', () => {
    const reading = readExtractedText(stripeish(), 'invoice.pdf', context(), TODAY)
    expect(reading.counterparty).toBe('Anthropic, PBC')
  })

  it('trusts a letterhead line more when the web address agrees with it', () => {
    const reading = readExtractedText(stripeish(), 'invoice.pdf', context(), TODAY)
    expect(reading.counterpartyConfidence).toBeGreaterThan(60)
  })

  it('reads the invoice number across the gap a lost hyphen leaves', () => {
    const reading = readExtractedText(stripeish(), 'invoice.pdf', context(), TODAY)
    // The font maps its hyphen to nothing, so the page reads "C1DC111A 0012".
    // Stopping at the gap would hand back a different invoice number.
    expect(reading.documentNumber).toBe('C1DC111A 0012')
  })

  it('still refuses a date as an invoice number', () => {
    expect(findDocumentNumber('Invoice Date 04/09/2026')).toBeNull()
    expect(findDocumentNumber('Invoice Date 04 09 2026')).toBeNull()
  })
})

describe('how the VAT works, which is not the same as at what rate', () => {
  const expense = { direction: 'expense' as const, vat: '0.00', vatNumber: null }

  it('takes the supplier at their word when they say reverse charge', () => {
    expect(findVatTreatment('Tax to be paid on reverse charge basis', expense)).toBe(
      'reverse_charge_services',
    )
    expect(findVatTreatment('VAT to be accounted for by the customer', expense)).toBe(
      'reverse_charge_services',
    )
    expect(findVatTreatment('Article 196 of Council Directive 2006/112/EC', expense)).toBe(
      'reverse_charge_services',
    )
  })

  it('tells UK construction apart from an overseas service', () => {
    // Both self-account, and they differ in box 6, which takes overseas
    // services and not construction work.
    expect(
      findVatTreatment('Domestic reverse charge: customer to account for VAT to HMRC (CIS)', expense),
    ).toBe('domestic_reverse_charge')
  })

  it('recognises postponed import VAT', () => {
    expect(findVatTreatment('Postponed VAT accounting applies', expense)).toBe('import_pva')
  })

  it('reads an EU supplier charging nothing as a reverse charge, unsaid', () => {
    // No wording at all, an Irish registration, and no VAT charged. That is a
    // reverse charge that did not spell itself out.
    expect(
      findVatTreatment('Acme BV VAT IE4276970QH Total 100.00', {
        direction: 'expense',
        vat: '0.00',
        vatNumber: null,
      }),
    ).toBe('reverse_charge_services')
  })

  it('does not do that to an ordinary zero-rated UK purchase', () => {
    expect(
      findVatTreatment('Books R Us VAT Reg GB123456782 Total 100.00 VAT 0.00', {
        direction: 'expense',
        vat: '0.00',
        vatNumber: 'GB123456782',
      }),
    ).toBeNull()
  })

  it('says nothing rather than guessing "domestic"', () => {
    // Null means not known. A caller reading it as domestic would be putting a
    // default where an answer belongs, and the whole point is that a person
    // sees it before it becomes an entry.
    expect(findVatTreatment('An ordinary invoice. Total 120.00', expense)).toBeNull()
  })

  it('puts the notional UK rate on a reverse charge, not the 0% the invoice shows', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Acme BV'], size: 18 },
        { cells: ['Subtotal', '75.00'] },
        { cells: ['VAT', '0.00'] },
        { cells: ['Total', '75.00'] },
        { cells: ['Tax to be paid on reverse charge basis'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.vatTreatment).toBe('reverse_charge_services')
    // The line keeps what the supplier charged - nothing - and the rate says
    // what the return has to account at.
    expect(reading.vat).toBe('0.00')
    expect(reading.total).toBe('75.00')
    expect(reading.vatRateCode).toBe('standard')
  })

  it('leaves a genuinely zero-rated purchase zero-rated', () => {
    const reading = readExtractedText(
      page([
        { cells: ['Books R Us'], size: 18 },
        { cells: ['Subtotal', '75.00'] },
        { cells: ['VAT', '0.00'] },
        { cells: ['Total', '75.00'] },
      ]),
      'invoice.pdf',
      context(),
      TODAY,
    )
    expect(reading.vatTreatment).toBeNull()
    expect(reading.vatRateCode).toBe('zero')
  })
})

describe('files nothing can be read from', () => {
  it('says a photograph is a photograph rather than failing', () => {
    const reading = readDocument(
      { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), mimeType: 'image/jpeg', filename: 'IMG_4021.jpg' },
      context(),
      TODAY,
    )
    expect(reading.scanStatus).toBe('no_text')
    expect(reading.scanNote).toMatch(/photo or a scan/i)
    expect(reading.counterparty).toBeNull()
  })

  it('does not throw on a PDF that is not a PDF', () => {
    const reading = readDocument(
      { bytes: Buffer.from('not really a pdf'), mimeType: 'application/pdf', filename: 'broken.pdf' },
      context(),
      TODAY,
    )
    expect(['no_text', 'unreadable']).toContain(reading.scanStatus)
    expect(reading.scanNote).toBeTruthy()
  })
})
