import { describe, expect, it } from 'vitest'
import { parseStatementPdf } from './statement-pdf'
import { parseStatementAmount, parseStatementDate, readCounterparty } from './statement'
import { extractPdfText } from './pdf/text'

// The statements these tests are built from are made here rather than checked in
// as files, for two reasons. A real statement is somebody's bank details, and
// this module's repository is not the place for those. And a hand-built one can
// be made to carry the exact awkwardness that broke the reader while it was
// being written - two-byte fonts, hex strings, kerning instead of spaces,
// descriptions wrapped over three lines - which a convenient real file happens
// to carry or happens not to.

// ---------------------------------------------------------------------------
// A minimal PDF, built the way the ones banks send are built
// ---------------------------------------------------------------------------

type Cell = {
  x: number
  y: number
  text: string
  size?: number
  hex?: boolean
  /**
   * Shown as separate strings one after another inside one text object, with no
   * repositioning between them - the way a generator writes a word that switches
   * font for one glyph. When set, these are what is drawn, and `text` only says
   * what they should read as.
   */
  pieces?: string[]
}

type BuildOptions = {
  /**
   * Give the font advance widths: every glyph half an em, so a run of n
   * characters at size s is n * s / 2 points wide. Without them the reader has
   * nothing to measure with, which is its own case worth keeping.
   */
  widths?: boolean
}

/** The glyph code for a character. The ligature has a code of its own, mapped in the CMap. */
const glyphCode = (character: string): number => (character === '\uFB03' ? 0x0100 : character.charCodeAt(0) & 0xff)

/**
 * A one-page PDF with a Type0 font, Identity-H encoding and a ToUnicode CMap.
 *
 * That combination is what nearly every statement generator produces, and it is
 * the one that hides mistakes: the font's character codes mean nothing without
 * the CMap, so a reader that mishandles a code silently drops the glyph rather
 * than printing something obviously wrong.
 */
function buildPdf(cells: Cell[], pages: Cell[][] = [], options: BuildOptions = {}): Buffer {
  const allPages = [cells, ...pages]

  const encode = (text: string, hex: boolean): string => {
    if (hex) {
      return `<${[...text].map((c) => glyphCode(c).toString(16).padStart(4, '0')).join('')}>`
    }
    // A literal string in a two-byte encoding still has to escape the bytes that
    // mean something to the syntax, which is exactly where a naive reader trips.
    const bytes = [...text].flatMap((c) => [glyphCode(c) >> 8, glyphCode(c) & 0xff])
    const escaped = bytes
      .map((b) => {
        const char = String.fromCharCode(b)
        if (char === '(' || char === ')' || char === '\\') return `\\${char}`
        if (b < 32 || b > 126) return `\\${b.toString(8).padStart(3, '0')}`
        return char
      })
      .join('')
    return `(${escaped})`
  }

  const contentFor = (pageCells: Cell[]): string =>
    pageCells
      .map((cell) => {
        if (cell.pieces) {
          return [
            'BT',
            `/F1 ${cell.size ?? 8} Tf`,
            `1 0 0 1 ${cell.x} ${cell.y} Tm`,
            ...cell.pieces.map((piece) => `${encode(piece, false)} Tj`),
            'ET',
          ].join('\n')
        }
        // Written as a TJ array with a kern between the halves, so the reader has
        // to put a text run back together from pieces rather than reading one
        // string - which is how a real generator writes a line.
        const half = Math.ceil(cell.text.length / 2)
        const left = cell.text.slice(0, half)
        const right = cell.text.slice(half)
        return [
          'BT',
          `/F1 ${cell.size ?? 8} Tf`,
          `1 0 0 1 ${cell.x} ${cell.y} Tm`,
          `[${encode(left, cell.hex ?? false)} -12 ${encode(right, !(cell.hex ?? false))}] TJ`,
          'ET',
        ].join('\n')
      })
      .join('\n')

  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '1 beginbfrange <0020> <00FF> <0020> endbfrange',
    '1 beginbfchar <0100> <FB03> endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n')

  const objects: string[] = []
  const pageObjectNumbers = allPages.map((_, index) => 6 + index * 2)

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${allPages.length} >>`
  objects[3] = `<< /Type /Font /Subtype /Type0 /BaseFont /Test-Regular /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>`
  objects[4] = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test-Regular${options.widths ? ' /W [32 256 500]' : ''} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>`
  objects[5] = `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`

  allPages.forEach((pageCells, index) => {
    const pageNumber = pageObjectNumbers[index]!
    const contentNumber = pageNumber + 1
    const content = contentFor(pageCells)
    objects[pageNumber] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNumber} 0 R >>`
    objects[contentNumber] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  })

  let pdf = '%PDF-1.4\n'
  for (let i = 1; i < objects.length; i += 1) {
    if (!objects[i]) continue
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }
  pdf += 'trailer\n<< /Size 99 /Root 1 0 R >>\n%%EOF\n'
  return Buffer.from(pdf, 'latin1')
}

/** A statement laid out the way Tide, Starling and most others lay one out. */
function tideStyleStatement(): Buffer {
  return buildPdf([
    { x: 36, y: 800, text: 'Bank statement', size: 14 },
    { x: 52, y: 760, text: 'Account number: 32687225' },
    { x: 52, y: 745, text: 'Sort code: 040605' },
    { x: 52, y: 730, text: 'Statement for: 10 Jul 2026 - 31 Jul 2026' },
    { x: 283, y: 760, text: 'Balance (£) on 10 Jul 2026' },
    { x: 528, y: 760, text: '0.00' },
    { x: 283, y: 745, text: 'Total paid in (£)' },
    { x: 519, y: 745, text: '262.00' },
    { x: 283, y: 730, text: 'Total paid out (£)' },
    { x: 521, y: 730, text: '261.95' },
    { x: 283, y: 715, text: 'Balance (£) on 31 Jul 2026' },
    { x: 528, y: 715, text: '0.05' },

    // The table header. Everything below this row is read by column position.
    { x: 41, y: 660, text: 'Date' },
    { x: 101, y: 660, text: 'Transaction type' },
    { x: 188, y: 660, text: 'Details' },
    { x: 394, y: 660, text: 'Paid in (£)' },
    { x: 447, y: 660, text: 'Paid out (£)' },
    { x: 506, y: 660, text: 'Balance (£)' },

    // Newest first, which is how most statements print. The description wraps
    // over lines that sit both above and below the dated row.
    { x: 188, y: 630, text: 'AMAZON UK* G24YU16C5 - 1 Principal Place, Worship', hex: true },
    { x: 188, y: 621, text: 'Street, LONDON' },
    { x: 41, y: 617, text: '29 Jul 2026' },
    { x: 101, y: 617, text: 'Card Transaction' },
    { x: 447, y: 617, text: '10.19' },
    { x: 506, y: 617, text: '0.05' },
    { x: 188, y: 613, text: 'Fee (£): 0.00' },
    { x: 188, y: 604, text: 'Tide Card: **** **** **** 5313' },

    { x: 41, y: 570, text: '28 Jul 2026' },
    { x: 101, y: 570, text: 'Domestic Transfer' },
    { x: 188, y: 570, text: 'Christopher Taylor-Guest / ref: TopUp', hex: true },
    { x: 394, y: 570, text: '77.00' },
    { x: 506, y: 570, text: '10.24' },

    { x: 41, y: 540, text: '26 Jul 2026' },
    { x: 101, y: 540, text: 'Card Transaction' },
    { x: 188, y: 540, text: 'ANTHROPIC* CLAUDE SUB - 548 Market Street' },
    { x: 447, y: 540, text: '144.59' },
    { x: 506, y: 540, text: '-66.76' },

    // Footer small print, far below the table. It must not be swept into the
    // last transaction's description.
    { x: 36, y: 120, text: 'Your account is provided by a bank, authorised and regulated.', size: 6 },
  ])
}

describe('reading a PDF at all', () => {
  it('gets the text back out of a two-byte font with a ToUnicode map', () => {
    const text = extractPdfText(tideStyleStatement())
    expect(text.plain).toContain('Bank statement')
    // The line written as a hex string is the one a mishandled hex string loses.
    expect(text.plain).toContain('AMAZON UK* G24YU16C5')
    expect(text.plain).toContain('Christopher Taylor-Guest')
    expect(text.pageCount).toBe(1)
  })

  it('refuses a file that is not a PDF, in words a person can act on', () => {
    expect(() => extractPdfText(Buffer.from('just some text', 'utf8'))).toThrow(/not a PDF/i)
  })

  it('says so when the PDF is a scan rather than a statement', () => {
    // A page with no text operators at all: what a photographed statement is.
    const scanned = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
        '4 0 obj\n<< /Length 10 >>\nstream\n0 0 0 rg\n\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
      'latin1',
    )
    expect(() => extractPdfText(scanned)).toThrow(/scan|photograph/i)
  })

  it('refuses a password-protected PDF rather than returning nonsense', () => {
    const encrypted = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Encrypt 9 0 R /Root 1 0 R >>\n%%EOF\n',
      'latin1',
    )
    expect(() => extractPdfText(encrypted)).toThrow(/password protected/i)
  })
})

describe('reading the table', () => {
  const parsed = parseStatementPdf(tideStyleStatement())

  it('finds every transaction and no others', () => {
    expect(parsed.lines).toHaveLength(3)
  })

  it('takes the sign from which money column the figure is in', () => {
    const amounts = parsed.lines.map((line) => line.amount)
    expect(amounts).toContain('-10.19')
    expect(amounts).toContain('77.00')
    expect(amounts).toContain('-144.59')
  })

  it('does not mistake the balance column for an amount', () => {
    const anthropic = parsed.lines.find((line) => line.counterparty.startsWith('ANTHROPIC'))!
    expect(anthropic.amount).toBe('-144.59')
    expect(anthropic.balance).toBe('-66.76')
  })

  it('joins a description wrapped above and below the dated row', () => {
    const amazon = parsed.lines.find((line) => line.counterparty.startsWith('AMAZON'))!
    expect(amazon.details).toContain('Worship Street, LONDON')
    expect(amazon.details).toContain('Tide Card')
  })

  it('reads the counterparty without the address or the card noise', () => {
    const amazon = parsed.lines.find((line) => line.details.includes('AMAZON'))!
    expect(amazon.counterparty).toBe('AMAZON UK* G24YU16C5')
  })

  it('picks the reference out of a transfer', () => {
    const transfer = parsed.lines.find((line) => line.counterparty.includes('Taylor-Guest'))!
    expect(transfer.reference).toBe('TopUp')
    expect(transfer.transactionType).toBe('Domestic Transfer')
  })

  it('puts the lines in the order they happened, not the order they were printed', () => {
    expect(parsed.lines.map((line) => line.date)).toEqual(['2026-07-26', '2026-07-28', '2026-07-29'])
  })

  it('leaves the small print out of the last transaction', () => {
    for (const line of parsed.lines) {
      expect(line.details).not.toContain('authorised and regulated')
    }
  })

  it('reads the statement summary as well as the table', () => {
    expect(parsed.meta.accountLast4).toBe('7225')
    expect(parsed.meta.sortCode).toBe('04-06-05')
    expect(parsed.meta.periodStart).toBe('2026-07-10')
    expect(parsed.meta.periodEnd).toBe('2026-07-31')
    expect(parsed.meta.openingBalance).toBe('0.00')
    expect(parsed.meta.closingBalance).toBe('0.05')
    expect(parsed.meta.totalPaidIn).toBe('262.00')
    expect(parsed.meta.totalPaidOut).toBe('261.95')
  })

  it('never puts an account number anywhere near the output', () => {
    // Only the last four digits are kept, deliberately.
    expect(JSON.stringify(parsed.meta)).not.toContain('32687225')
  })
})

describe('when the reading does not tie back', () => {
  it('warns when the running balance disagrees', () => {
    const parsed = parseStatementPdf(
      buildPdf([
        { x: 41, y: 660, text: 'Date' },
        { x: 188, y: 660, text: 'Details' },
        { x: 394, y: 660, text: 'Paid in (£)' },
        { x: 447, y: 660, text: 'Paid out (£)' },
        { x: 506, y: 660, text: 'Balance (£)' },
        { x: 41, y: 630, text: '01 Jul 2026' },
        { x: 188, y: 630, text: 'One' },
        { x: 394, y: 630, text: '100.00' },
        { x: 506, y: 630, text: '100.00' },
        { x: 41, y: 610, text: '02 Jul 2026' },
        { x: 188, y: 610, text: 'Two' },
        { x: 394, y: 610, text: '100.00' },
        { x: 506, y: 610, text: '999.00' },
        { x: 41, y: 590, text: '03 Jul 2026' },
        { x: 188, y: 590, text: 'Three' },
        { x: 394, y: 590, text: '100.00' },
        { x: 506, y: 590, text: '888.00' },
        { x: 41, y: 570, text: '04 Jul 2026' },
        { x: 188, y: 570, text: 'Four' },
        { x: 394, y: 570, text: '100.00' },
        { x: 506, y: 570, text: '777.00' },
      ]),
    )
    expect(parsed.lines).toHaveLength(4)
    expect(parsed.warnings.join(' ')).toMatch(/running balance/i)
  })

  it('says so plainly when there is no table to find', () => {
    const parsed = parseStatementPdf(
      buildPdf([
        { x: 36, y: 700, text: 'Certificate of balance' },
        { x: 36, y: 680, text: 'This confirms the account was open on 31 July 2026.' },
      ]),
    )
    expect(parsed.lines).toHaveLength(0)
    expect(parsed.warnings.join(' ')).toMatch(/could not find a table/i)
  })
})

describe('a single signed amount column', () => {
  it('reads the sign off the figure itself', () => {
    const parsed = parseStatementPdf(
      buildPdf([
        { x: 41, y: 660, text: 'Date' },
        { x: 188, y: 660, text: 'Description' },
        { x: 420, y: 660, text: 'Amount' },
        { x: 41, y: 630, text: '05/07/2026' },
        { x: 188, y: 630, text: 'ACME LTD' },
        { x: 420, y: 630, text: '-42.50' },
        { x: 41, y: 610, text: '06/07/2026' },
        { x: 188, y: 610, text: 'A CUSTOMER' },
        { x: 420, y: 610, text: '1,250.00' },
      ]),
    )
    expect(parsed.lines.map((line) => line.amount)).toEqual(['-42.50', '1250.00'])
  })
})

describe('statements running over more than one page', () => {
  it('reads the table on every page, header and all', () => {
    const header: Cell[] = [
      { x: 41, y: 660, text: 'Date' },
      { x: 188, y: 660, text: 'Details' },
      { x: 420, y: 660, text: 'Amount' },
    ]
    const parsed = parseStatementPdf(
      buildPdf(
        [...header, { x: 41, y: 630, text: '01 Jul 2026' }, { x: 188, y: 630, text: 'First' }, { x: 420, y: 630, text: '10.00' }],
        [[...header, { x: 41, y: 630, text: '02 Jul 2026' }, { x: 188, y: 630, text: 'Second' }, { x: 420, y: 630, text: '20.00' }]],
      ),
    )
    expect(parsed.lines.map((line) => line.details)).toEqual(['First', 'Second'])
  })
})

/** Where a figure starts when it is set right-aligned to `edge`, under the test font's half-em glyphs. */
const alignRight = (edge: number, text: string, size = 8): number => edge - (text.length * size) / 2

/**
 * A statement laid out the way Monzo lays one out, which is everything the
 * column reader used to assume turned upside down:
 *
 * - the header is printed once, on the first page, and the table runs on down
 *   the next pages without it;
 * - figures are right-aligned under headers that start well to their left, so
 *   a short figure's left edge is past the midpoint between two headers;
 * - descriptions are centred on the dated row, one line above and one below,
 *   and one of them carries on over the page break;
 * - a merchant's town and country are placed as separate pieces far enough
 *   right to cross into the amount column;
 * - "Office" is printed as "O", a ligature glyph in another font, then "ce".
 *
 * Printed newest first. Running balance from 100.00.
 */
function monzoStyleStatement(): Buffer {
  const money = (y: number, amount: string, balance: string): Cell[] => [
    { x: alignRight(440, amount), y, text: amount },
    { x: alignRight(525, balance), y, text: balance },
  ]
  return buildPdf(
    [
      { x: 280, y: 800, text: 'Business Account statement', size: 14 },
      { x: 359, y: 780, text: '01/09/2026 - 30/09/2026' },
      { x: 63, y: 740, text: 'Sort code: 04-00-06' },
      { x: 63, y: 726, text: 'Account number: 12345678' },

      { x: 70, y: 600, text: 'Date', size: 10 },
      { x: 153, y: 600, text: 'Description', size: 10 },
      { x: 380, y: 600, text: '(GBP) Amount', size: 10 },
      { x: 460, y: 600, text: '(GBP) Balance', size: 10 },

      { x: 70, y: 570, text: '30/09/2026' },
      { x: 153, y: 570, text: 'OVHcloud London GBR' },
      ...money(570, '-4.68', '154.49'),

      { x: 70, y: 540.5, text: '29/09/2026' },
      { x: 153, y: 540.5, text: 'A Customer (P2P Payment)' },
      ...money(540.5, '-60.00', '159.17'),

      { x: 153, y: 511, text: 'SQUARE (Faster Payments) Reference:' },
      { x: 70, y: 504, text: '28/09/2026' },
      ...money(504, '129.84', '219.17'),
    ],
    [
      [
        // The rest of the line above, carried over the page break.
        { x: 153, y: 790, text: 'T3RM7VFYS3QNVAZ' },

        { x: 70, y: 760.5, text: '28/09/2026' },
        { x: 153, y: 760.5, text: 'A Customer (P2P Payment)' },
        ...money(760.5, '4.05', '89.33'),

        { x: 153, y: 731, text: 'Dynamic Office Seating Ltd (Faster', pieces: ['Dynamic O', '\uFB03', 'ce Seating Ltd (Faster'] },
        { x: 70, y: 724, text: '27/09/2026' },
        ...money(724, '-46.80', '85.28'),
        { x: 153, y: 717, text: 'Payments) Reference: DESKWELL 8688' },

        { x: 153, y: 687.5, text: 'SQUARE (Faster Payments) Reference:' },
        { x: 70, y: 680.5, text: '26/09/2026' },
        ...money(680.5, '47.08', '132.08'),
        { x: 153, y: 673.5, text: 'T3EVF0EBV1772GN' },

        { x: 70, y: 644, text: '25/09/2026' },
        { x: 153, y: 644, text: 'ANTHROPIC* CLAUDE SUB ' },
        { x: 241, y: 644, text: 'DUBLIN 4 ' },
        { x: 277, y: 644, text: 'IRL' },
        ...money(644, '-15.00', '85.00'),

        // The bank's small print, close under the last line and running the
        // width of the page.
        { x: 70, y: 620, text: 'Example Bank Limited is a company registered in England. Registered' },
        { x: 360, y: 620, text: 'office: 1 High Street' },
      ],
      [
        { x: 63, y: 650, text: 'Important information about compensation' },
        { x: 118, y: 620, text: "We're covered by the FSCS. " },
        { x: 246, y: 620, text: 'The FSCS compensate depositors if a bank fails.' },
      ],
    ],
    { widths: true },
  )
}

describe('a statement laid out like Monzo', () => {
  const parsed = parseStatementPdf(monzoStyleStatement())
  const on = (date: string, amount: string) => parsed.lines.find((line) => line.date === date && line.amount === amount)!

  it('reads every line on every page, and ties back to the running balance', () => {
    expect(parsed.lines).toHaveLength(7)
    expect(parsed.warnings).toEqual([])
  })

  it('puts a short right-aligned figure in its own column, not the next one', () => {
    expect(on('2026-09-26', '47.08').balance).toBe('132.08')
    expect(on('2026-09-28', '4.05').balance).toBe('89.33')
    expect(on('2026-09-30', '-4.68').balance).toBe('154.49')
  })

  it('keeps the pieces of a long description out of the amount column', () => {
    const anthropic = on('2026-09-25', '-15.00')
    expect(anthropic.details).toBe('ANTHROPIC* CLAUDE SUB DUBLIN 4 IRL')
  })

  it('puts a word printed in pieces back together', () => {
    const supplier = on('2026-09-27', '-46.80')
    expect(supplier.details).toBe('Dynamic Office Seating Ltd (Faster Payments) Reference: DESKWELL 8688')
    expect(supplier.counterparty).toBe('Dynamic Office Seating Ltd')
    expect(supplier.reference).toBe('DESKWELL 8688')
  })

  it('finishes a description that ran over the page on the line it started on', () => {
    expect(on('2026-09-28', '129.84').details).toBe('SQUARE (Faster Payments) Reference: T3RM7VFYS3QNVAZ')
    expect(on('2026-09-28', '4.05').details).toBe('A Customer (P2P Payment)')
  })

  it('leaves the small print and the terms out of everybody', () => {
    for (const line of parsed.lines) {
      expect(line.details).not.toMatch(/registered|office: 1 High|FSCS/i)
    }
  })

  it('puts the lines in the order they happened', () => {
    expect(parsed.lines.map((line) => line.date)).toEqual([
      '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-28', '2026-09-29', '2026-09-30',
    ])
  })

  it('reads the statement period printed under the title', () => {
    expect(parsed.meta.periodStart).toBe('2026-09-01')
    expect(parsed.meta.periodEnd).toBe('2026-09-30')
  })
})

// ---------------------------------------------------------------------------
// The small parsers underneath
// ---------------------------------------------------------------------------

describe('parseStatementDate', () => {
  it('reads the forms banks print', () => {
    expect(parseStatementDate('29 Jul 2026')).toBe('2026-07-29')
    expect(parseStatementDate('29 July 2026')).toBe('2026-07-29')
    expect(parseStatementDate('29-Jul-2026')).toBe('2026-07-29')
    expect(parseStatementDate('2026-07-29')).toBe('2026-07-29')
    expect(parseStatementDate('Jul 29, 2026')).toBe('2026-07-29')
  })

  it('reads a numeric date day first, as a UK statement means it', () => {
    expect(parseStatementDate('05/07/2026')).toBe('2026-07-05')
    expect(parseStatementDate('05/07/26')).toBe('2026-07-05')
  })

  it('refuses an impossible date rather than rolling it into next month', () => {
    expect(parseStatementDate('30/02/2026')).toBeNull()
    expect(parseStatementDate('31 Apr 2026')).toBeNull()
    expect(parseStatementDate('not a date')).toBeNull()
  })
})

describe('parseStatementAmount', () => {
  it('reads what a statement prints', () => {
    expect(parseStatementAmount('1,234.56')?.toFixed(2)).toBe('1234.56')
    expect(parseStatementAmount('£1,234.56')?.toFixed(2)).toBe('1234.56')
    expect(parseStatementAmount('(50.00)')?.toFixed(2)).toBe('-50.00')
    expect(parseStatementAmount('50.00-')?.toFixed(2)).toBe('-50.00')
    expect(parseStatementAmount('50.00 DR')?.toFixed(2)).toBe('-50.00')
    expect(parseStatementAmount('50.00 CR')?.toFixed(2)).toBe('50.00')
  })

  it('refuses anything that is not simply an amount', () => {
    expect(parseStatementAmount('')).toBeNull()
    expect(parseStatementAmount('-')).toBeNull()
    expect(parseStatementAmount('INV-2026-001')).toBeNull()
    expect(parseStatementAmount('12.3456')).toBeNull()
    expect(parseStatementAmount('Ref 12345')).toBeNull()
  })
})

describe('readCounterparty', () => {
  it('splits who from where', () => {
    expect(readCounterparty('OVHcloud - 4th Floor Lincoln House, London').counterparty).toBe('OVHcloud')
  })

  it('splits who from the reference', () => {
    const read = readCounterparty('Christopher Taylor-Guest / ref: TopUp')
    expect(read.counterparty).toBe('Christopher Taylor-Guest')
    expect(read.reference).toBe('TopUp')
  })

  it('leaves a plain name alone', () => {
    expect(readCounterparty('TWILIO.COM').counterparty).toBe('TWILIO.COM')
  })

  it('would rather return too much than trim a name away to nothing', () => {
    expect(readCounterparty('A - B').counterparty).toBe('A - B')
  })

  it('stops the name where the reference starts, separator or not', () => {
    const read = readCounterparty('SQUARE (Faster Payments) Reference: T3EVF0EBV1772GN')
    expect(read.counterparty).toBe('SQUARE')
    expect(read.reference).toBe('T3EVF0EBV1772GN')
  })

  it('leaves out how the money moved', () => {
    expect(readCounterparty('A Customer (P2P Payment)').counterparty).toBe('A Customer')
  })

  it('leaves out the foreign currency note, which changes every month', () => {
    expect(readCounterparty('FLY.IO SAN FRANCISCO USA Amount: USD -7.23. Exchange rate: 1.324176.').counterparty).toBe(
      'FLY.IO SAN FRANCISCO USA',
    )
  })

  it('does not mistake a refund for a reference', () => {
    const read = readCounterparty('AMAZON REFUND')
    expect(read.counterparty).toBe('AMAZON REFUND')
    expect(read.reference).toBeNull()
  })
})
