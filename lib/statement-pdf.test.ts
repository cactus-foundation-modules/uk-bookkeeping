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

type Cell = { x: number; y: number; text: string; size?: number; hex?: boolean }

/**
 * A one-page PDF with a Type0 font, Identity-H encoding and a ToUnicode CMap.
 *
 * That combination is what nearly every statement generator produces, and it is
 * the one that hides mistakes: the font's character codes mean nothing without
 * the CMap, so a reader that mishandles a code silently drops the glyph rather
 * than printing something obviously wrong.
 */
function buildPdf(cells: Cell[], pages: Cell[][] = []): Buffer {
  const allPages = [cells, ...pages]

  const encode = (text: string, hex: boolean): string => {
    if (hex) {
      return `<${[...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`
    }
    // A literal string in a two-byte encoding still has to escape the bytes that
    // mean something to the syntax, which is exactly where a naive reader trips.
    const bytes = [...text].flatMap((c) => [0x00, c.charCodeAt(0) & 0xff])
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
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n')

  const objects: string[] = []
  const pageObjectNumbers = allPages.map((_, index) => 6 + index * 2)

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${allPages.length} >>`
  objects[3] = `<< /Type /Font /Subtype /Type0 /BaseFont /Test-Regular /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>`
  objects[4] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>'
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
})
