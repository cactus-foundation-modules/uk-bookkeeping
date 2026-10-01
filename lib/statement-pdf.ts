import { Prisma } from '@prisma/client'
import { formatMoney } from './money'
import {
  EMPTY_META,
  parseStatementAmount,
  parseStatementDate,
  readCounterparty,
  tidyDetails,
  type ParsedStatement,
  type StatementLine,
  type StatementMeta,
} from './statement'
import { extractPdfText, type PdfTextItem, type PdfTextRow } from './pdf/text'

// Reading the table out of a PDF bank statement.
//
// The approach is layout-driven rather than bank-specific. Find the header row,
// take the columns from where its words sit, and put every later cell in the
// column its position says it belongs to. That is the same thing a person does
// when they look at a statement, and it works on a bank we have never seen -
// which matters, because there are dozens of them and they all redesign their
// PDFs eventually.
//
// The header words themselves are the only bank knowledge here, and they are
// synonyms rather than layouts: "Paid out", "Money out", "Debit" and "Withdrawn"
// are one column under four names.

type ColumnKey = 'date' | 'type' | 'details' | 'paidIn' | 'paidOut' | 'amount' | 'balance'

const HEADER_SYNONYMS: Record<ColumnKey, string[]> = {
  date: ['date', 'transaction date', 'posting date', 'value date', 'date posted'],
  type: ['transaction type', 'type', 'payment type'],
  details: [
    'details', 'description', 'narrative', 'transaction', 'payee', 'transaction details',
    'merchant', 'particulars', 'reference',
  ],
  paidIn: ['paid in', 'money in', 'credit', 'credits', 'credit amount', 'received', 'in', 'deposits'],
  paidOut: ['paid out', 'money out', 'debit', 'debits', 'debit amount', 'withdrawn', 'out', 'withdrawals'],
  amount: ['amount', 'value', 'amount (gbp)'],
  balance: ['balance', 'running balance', 'balance carried forward'],
}

/** Header text, reduced to the words that identify it. */
function normaliseHeader(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(\s*[£$€]?\s*(gbp)?\s*\)/g, ' ')
    .replace(/[£$€]/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function headerKey(text: string): ColumnKey | null {
  const normalised = normaliseHeader(text)
  if (!normalised) return null
  // Longest synonym first, so "paid out" is not claimed by "out" and
  // "transaction type" is not claimed by "transaction".
  const candidates: { key: ColumnKey; synonym: string }[] = []
  for (const [key, synonyms] of Object.entries(HEADER_SYNONYMS) as [ColumnKey, string[]][]) {
    for (const synonym of synonyms) candidates.push({ key, synonym })
  }
  candidates.sort((a, b) => b.synonym.length - a.synonym.length)
  for (const candidate of candidates) {
    if (normalised === candidate.synonym) return candidate.key
  }
  for (const candidate of candidates) {
    if (candidate.synonym.length >= 5 && normalised.startsWith(candidate.synonym)) return candidate.key
  }
  return null
}

type Column = {
  key: ColumnKey
  x: number
  /** Where the header text ends, when the font told us how wide it is. */
  right: number | null
}
type HeaderRow = { row: PdfTextRow; columns: Column[] }

const MONEY_COLUMNS: ReadonlySet<ColumnKey> = new Set<ColumnKey>(['paidIn', 'paidOut', 'amount', 'balance'])

/**
 * A row is the table's header when it names a date column and at least one money
 * column. Anything less is a heading, a summary box or a footnote that happens
 * to contain the word "balance".
 */
function readHeader(row: PdfTextRow): HeaderRow | null {
  const columns: Column[] = []
  for (const cell of row.cells) {
    const key = headerKey(cell.text)
    if (!key) continue
    if (columns.some((c) => c.key === key)) continue
    columns.push({ key, x: cell.x, right: cell.width > 0 ? cell.x + cell.width : null })
  }
  const hasDate = columns.some((c) => c.key === 'date')
  const hasMoney = columns.some((c) => c.key === 'paidIn' || c.key === 'paidOut' || c.key === 'amount')
  if (!hasDate || !hasMoney) return null
  columns.sort((a, b) => a.x - b.x)
  return { row, columns }
}

/**
 * Which column a cell sits in.
 *
 * Boundaries are the midpoints between where the headers start. Statements set
 * text columns left-aligned and money columns right-aligned, so a value's left
 * edge drifts leftwards as it gets longer; the midpoint rule tolerates that as
 * far as half a column, which is further than any realistic amount drifts.
 */
function assignColumn(x: number, columns: Column[]): ColumnKey | null {
  if (columns.length === 0) return null
  for (let i = 0; i < columns.length; i += 1) {
    const next = columns[i + 1]
    if (!next) return columns[i]!.key
    const boundary = (columns[i]!.x + next.x) / 2
    if (x < boundary) return columns[i]!.key
  }
  return columns[columns.length - 1]!.key
}

/**
 * Which money column a figure belongs to, by how it lines up under the headers.
 *
 * Banks set figures right-aligned, and plenty set the header that way too, so a
 * figure's left edge says little: under an "(GBP) Amount" header that starts at
 * 373 and ends at 440, a short figure starts at 421 and a long one at 398, and
 * the midpoint rule sends the short one to the balance column. The span the
 * figure covers is what does not move - it sits under its own header, whichever
 * way both are aligned. Most overlap wins; failing any overlap, the nearest
 * header. Null when the font gave no widths to measure with.
 */
function moneyColumnFor(cell: PdfTextItem, columns: Column[]): ColumnKey | null {
  if (!(cell.width > 0)) return null
  const left = cell.x
  const right = cell.x + cell.width
  let best: { key: ColumnKey; overlap: number } | null = null
  for (const column of columns) {
    if (!MONEY_COLUMNS.has(column.key) || column.right === null) continue
    // Negative when the two do not overlap: then it is minus the gap between
    // them, so the largest value is still the best fit.
    const overlap = Math.min(right, column.right) - Math.max(left, column.x)
    if (!best || overlap > best.overlap) best = { key: column.key, overlap }
  }
  return best?.key ?? null
}

/**
 * True when a cell has words in it, rather than a figure and its trimmings.
 *
 * A money column holds a figure, maybe a currency sign, maybe CR or DR. A cell
 * with any other letters in it is a description that ran long - "ANTHROPIC*
 * CLAUDE SUB", then "DUBLIN 4", then "IRL", each placed separately and the last
 * two far enough right to cross the midpoint into the amount column. Letting it
 * in there turns "-15.00" into "DUBLIN 4 IRL -15.00", which is not an amount,
 * and the whole line disappears.
 */
function hasWords(text: string): boolean {
  return /[a-z]/i.test(text.replace(/\b(?:CR|DR)\b\.?/gi, ''))
}

/** Two runs closer than this, as a fraction of the text size, are one word printed in pieces. */
const SAME_WORD_GAP = 0.18

type Cells = Partial<Record<ColumnKey, string>>

function readCells(row: PdfTextRow, columns: Column[]): Cells {
  const cells: Cells = {}
  const lastIn: Partial<Record<ColumnKey, PdfTextItem>> = {}
  const textColumns = columns.filter((column) => !MONEY_COLUMNS.has(column.key))

  for (const cell of row.cells) {
    let key = assignColumn(cell.x, columns)
    if (!key) continue
    if (MONEY_COLUMNS.has(key)) {
      if (hasWords(cell.text)) {
        key = assignColumn(cell.x, textColumns)
        if (!key) continue
      } else if (parseStatementAmount(cell.text)) {
        key = moneyColumnFor(cell, columns) ?? key
      }
    }

    const previous = lastIn[key]
    const text = cell.text.trim()
    if (!previous || !cells[key]) {
      cells[key] = text
    } else {
      // One word split over two runs - a ligature in another font, a bold
      // letter - joins up with no space. Anything with a visible gap is two words.
      const gap = cell.x - (previous.x + previous.width)
      const joined =
        previous.width > 0 &&
        !previous.text.endsWith(' ') &&
        Math.abs(gap) <= Math.max(previous.size, cell.size) * SAME_WORD_GAP
      cells[key] = joined ? `${cells[key]}${text}` : `${cells[key]} ${text}`.trim()
    }
    lastIn[key] = cell
  }
  return cells
}

type WorkingLine = {
  y: number
  page: number
  date: string
  cells: Cells
  detailParts: { page: number; y: number; text: string }[]
  amount: Prisma.Decimal
  balance: Prisma.Decimal | null
}

/**
 * The signed amount for a row, from whichever money columns the statement has.
 *
 * Two columns is the common case and unambiguous. One "amount" column carries
 * its own sign - except where a bank writes every figure positive and puts the
 * direction in a separate word, which is what `type` is consulted for.
 */
function amountFor(cells: Cells, columns: Column[]): Prisma.Decimal | null {
  const hasSplit = columns.some((c) => c.key === 'paidIn') || columns.some((c) => c.key === 'paidOut')
  if (hasSplit) {
    const paidIn = parseStatementAmount(cells.paidIn ?? '')
    const paidOut = parseStatementAmount(cells.paidOut ?? '')
    if (paidIn && !paidIn.isZero()) return paidIn.abs()
    if (paidOut && !paidOut.isZero()) return paidOut.abs().negated()
    return null
  }

  const amount = parseStatementAmount(cells.amount ?? '')
  if (!amount || amount.isZero()) return null
  if (amount.isNegative()) return amount
  const direction = `${cells.type ?? ''} ${cells.details ?? ''}`.toLowerCase()
  if (/\b(dr|debit|withdrawal|payment out|paid out)\b/.test(direction)) return amount.negated()
  return amount
}

/**
 * Check the reading against the statement's own running balance.
 *
 * Every line's balance should be the line before it plus that line's amount.
 * When it is, the columns were read the right way round and no line was missed -
 * which is a stronger guarantee than any amount of parsing care, and it is free,
 * because the statement already did the arithmetic for us.
 */
function checkAgainstBalances(lines: WorkingLine[]): {
  warnings: string[]
  /** True when the statement was printed newest first, so the reading runs backwards. */
  printedNewestFirst: boolean | null
} {
  const withBalance = lines.filter((line) => line.balance !== null)
  if (withBalance.length < 3) return { warnings: [], printedNewestFirst: null }

  const countAgreements = (ordered: WorkingLine[]): number => {
    let agreed = 0
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1]!.balance!
      const expected = previous.plus(ordered[i]!.amount)
      if (expected.equals(ordered[i]!.balance!)) agreed += 1
    }
    return agreed
  }

  // A statement runs newest-first or oldest-first, and both are ordinary. Try
  // the order it was printed in, and the reverse of it, and believe whichever
  // the arithmetic agrees with. This settles two questions at once: whether the
  // columns were read the right way round, and which way round the statement
  // runs - which is the only thing that can order two payments made on the same
  // afternoon, since the date alone cannot.
  const printed = countAgreements(withBalance)
  const reversed = countAgreements([...withBalance].reverse())
  const best = Math.max(printed, reversed)
  const checks = withBalance.length - 1
  const printedNewestFirst = best === 0 ? null : reversed > printed

  if (best === checks) return { warnings: [], printedNewestFirst }
  if (best >= checks - 1) {
    return {
      printedNewestFirst,
      warnings: [
        'One line does not tie back to the running balance on the statement. It is worth a look before you bring these in.',
      ],
    }
  }
  return {
    printedNewestFirst,
    warnings: [
      `The running balance on the statement only agrees with ${best} of ${checks} lines we read. Check the amounts against the PDF before bringing them in, and if they are wrong, import a CSV from your bank instead.`,
    ],
  }
}

// ---------------------------------------------------------------------------
// Statement metadata
// ---------------------------------------------------------------------------

function readMeta(plain: string): StatementMeta {
  const meta: StatementMeta = { ...EMPTY_META }
  const text = plain.replace(/[ \t]+/g, ' ')

  const account = /account\s*(?:number|no\.?)\s*:?\s*([\d*\s-]{4,})/i.exec(text)
  if (account) {
    const digits = account[1]!.replace(/\D/g, '')
    if (digits.length >= 4) meta.accountLast4 = digits.slice(-4)
  }

  const sortCode = /sort\s*code\s*:?\s*(\d{2}\s*-?\s*\d{2}\s*-?\s*\d{2})/i.exec(text)
  if (sortCode) {
    const digits = sortCode[1]!.replace(/\D/g, '')
    if (digits.length === 6) meta.sortCode = `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`
  }

  const period =
    /statement (?:for|period)\s*:?\s*(.+?)\s*(?:to|-|–|—)\s*([\d]{1,2}[^\n,]{2,16}\d{4})/i.exec(text) ??
    // "Business Account statement" with the dates on the line under it, and no
    // "for" or "period" to introduce them.
    /statement\s*:?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\s*(?:to|-|–|—)\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i.exec(text) ??
    /(?:period|from)\s*:?\s*(.+?)\s*(?:to|-|–|—)\s*([\d]{1,2}[^\n,]{2,16}\d{4})/i.exec(text)
  if (period) {
    meta.periodStart = parseStatementDate(period[1]!.trim())
    meta.periodEnd = parseStatementDate(period[2]!.trim())
  }

  // "Balance (£) on 10 Jul 2026  0.00" … "Balance (£) on 31 Jul 2026  0.05".
  // Earliest date is the opening figure, latest the closing one, whichever order
  // the statement printed them in.
  const balances: { date: string; amount: string }[] = []
  for (const match of text.matchAll(/balance[^\n\d]*?on\s+([\d]{1,2}\s*[A-Za-z]{3,9}\.?\s*\d{2,4}|[\d/.-]{6,10})[^\d\n-]*(-?[\d,]+\.\d{2})/gi)) {
    const date = parseStatementDate(match[1]!)
    const amount = parseStatementAmount(match[2]!)
    if (date && amount) balances.push({ date, amount: formatMoney(amount) })
  }
  if (balances.length >= 2) {
    const sorted = [...balances].sort((a, b) => a.date.localeCompare(b.date))
    meta.openingBalance = sorted[0]!.amount
    meta.closingBalance = sorted[sorted.length - 1]!.amount
    meta.periodStart ??= sorted[0]!.date
    meta.periodEnd ??= sorted[sorted.length - 1]!.date
  }

  const opening = /opening balance[^\d-]*(-?[\d,]+\.\d{2})/i.exec(text)
  if (opening) meta.openingBalance ??= formatMoney(parseStatementAmount(opening[1]!) ?? null)
  const closing = /closing balance[^\d-]*(-?[\d,]+\.\d{2})/i.exec(text)
  if (closing) meta.closingBalance ??= formatMoney(parseStatementAmount(closing[1]!) ?? null)

  const paidIn = /total (?:paid in|money in|credits)[^\d-]*(-?[\d,]+\.\d{2})/i.exec(text)
  if (paidIn) meta.totalPaidIn = formatMoney(parseStatementAmount(paidIn[1]!) ?? null)
  const paidOut = /total (?:paid out|money out|debits)[^\d-]*(-?[\d,]+\.\d{2})/i.exec(text)
  if (paidOut) meta.totalPaidOut = formatMoney(parseStatementAmount(paidOut[1]!) ?? null)

  // Only the top of the first page. A bank's name appearing further down is far
  // more likely to be who a payment was to than who wrote the statement, and
  // labelling a Barclays statement "Monzo" because somebody paid a friend is a
  // silly way to lose the reader's confidence in everything else on the screen.
  const heading = text.slice(0, 1200)
  const known = ['Tide', 'Starling', 'Monzo', 'Barclays', 'HSBC', 'Lloyds', 'NatWest', 'Santander', 'Revolut', 'Metro Bank', 'Co-operative Bank', 'TSB', 'Halifax', 'Royal Bank of Scotland', 'Cashplus', 'ANNA', 'Mettle']
  for (const bank of known) {
    if (new RegExp(`\\b${bank.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(heading)) {
      meta.bank = bank
      break
    }
  }

  return meta
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

/**
 * How far a wrapped description line may sit from the dated row it belongs to.
 *
 * Statements wrap a long description over two or three lines, and put them above
 * or below the dated row depending on the design. Anything further away than
 * this is a different part of the page - a footer, a summary box - and attaching
 * it would put the bank's small print into somebody's books.
 */
const CONTINUATION_REACH = 34

/**
 * A gap this much smaller than the one between two transactions is a gap inside
 * one transaction.
 */
const SAME_ENTRY_RATIO = 0.7

type Orphan = { y: number; page: number; cells: Cells }

type Placed = { page: number; y: number; line: WorkingLine | null; orphan: Orphan | null }

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function nearestLine(orphan: Orphan, lines: WorkingLine[]): WorkingLine | null {
  let best: WorkingLine | null = null
  let bestDistance = Infinity
  for (const line of lines) {
    if (line.page !== orphan.page) continue
    const distance = Math.abs(line.y - orphan.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = line
    }
  }
  return best && bestDistance <= CONTINUATION_REACH ? best : null
}

/**
 * Give each wrapped description line to the transaction it belongs to.
 *
 * The plain rule is nearest dated row, because statements differ on which side
 * of the date they put the rest of the description, and some put it on both.
 *
 * Where the statement spaces its transactions apart - most of them do, and the
 * gap between two transactions is plainly wider than the gap between two lines
 * of one - the spacing says more than distance does. Rows closer together than
 * that are one transaction, so they go together. And it settles the case
 * nearest gets wrong: a description that ran off the bottom of one page and
 * finishes at the top of the next. Its last line sits a whole transaction's gap
 * above the next page's first row, which is the page telling you it is not part
 * of that one - it belongs to the transaction the previous page ended on.
 */
function attachWrappedLines(lines: WorkingLine[], orphans: Orphan[]): void {
  const give = (line: WorkingLine, orphan: Orphan): void => {
    const text = [orphan.cells.details, orphan.cells.type].filter(Boolean).join(' ').trim()
    if (text) line.detailParts.push({ page: orphan.page, y: orphan.y, text })
  }

  const pages = new Map<number, Placed[]>()
  for (const line of lines) {
    const list = pages.get(line.page) ?? []
    list.push({ page: line.page, y: line.y, line, orphan: null })
    pages.set(line.page, list)
  }
  for (const orphan of orphans) {
    const list = pages.get(orphan.page) ?? []
    list.push({ page: orphan.page, y: orphan.y, line: null, orphan })
    pages.set(orphan.page, list)
  }
  for (const list of pages.values()) list.sort((a, b) => b.y - a.y)

  // The gap between two transactions, from the places two dated rows sit next
  // to each other with nothing between them.
  const entryGaps: number[] = []
  for (const list of pages.values()) {
    for (let i = 1; i < list.length; i += 1) {
      if (list[i - 1]!.line && list[i]!.line) entryGaps.push(list[i - 1]!.y - list[i]!.y)
    }
  }
  const entryGap = median(entryGaps)

  if (entryGap === null || entryGap <= 0) {
    for (const orphan of orphans) {
      const line = nearestLine(orphan, lines)
      if (line) give(line, orphan)
    }
    return
  }

  const lastLineOn = (page: number): WorkingLine | null => {
    const list = pages.get(page)
    if (!list) return null
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]!.line) return list[i]!.line
    }
    return null
  }

  for (const [page, list] of pages) {
    // Split the page into runs of rows set close together.
    const blocks: Placed[][] = []
    for (const placed of list) {
      const block = blocks[blocks.length - 1]
      const previous = block?.[block.length - 1]
      if (block && previous && previous.y - placed.y < entryGap * SAME_ENTRY_RATIO) block.push(placed)
      else blocks.push([placed])
    }

    for (const [index, block] of blocks.entries()) {
      const dated = block.filter((placed) => placed.line)
      const loose = block.filter((placed): placed is Placed & { orphan: Orphan } => placed.orphan !== null)
      if (loose.length === 0) continue

      if (dated.length === 1) {
        for (const placed of loose) give(dated[0]!.line!, placed.orphan)
        continue
      }

      // Rows at the very top of a page, a full transaction's gap above its first
      // dated row: the end of the transaction the page before finished on.
      const next = blocks[index + 1]?.[0]
      const carriedOver =
        dated.length === 0 &&
        index === 0 &&
        next?.line &&
        block[block.length - 1]!.y - next.y <= entryGap * 1.5
          ? lastLineOn(page - 1)
          : null
      if (carriedOver) {
        for (const placed of loose) give(carriedOver, placed.orphan)
        continue
      }

      for (const placed of loose) {
        const line = nearestLine(placed.orphan, lines)
        if (line) give(line, placed.orphan)
      }
    }
  }
}

export function parseStatementPdf(bytes: Buffer): ParsedStatement {
  const extracted = extractPdfText(bytes)
  const meta = readMeta(extracted.plain)

  const lines: WorkingLine[] = []
  const unattached: Orphan[] = []
  let usedColumns: Column[] = []
  let headerCount = 0

  // Page by page: the header repeats at the top of each one, and a column that
  // moved between pages is a column that moved, not a mis-read.
  const byPage = new Map<number, PdfTextRow[]>()
  for (const row of extracted.rows) {
    const list = byPage.get(row.page) ?? []
    list.push(row)
    byPage.set(row.page, list)
  }

  // The columns a page with no header of its own goes on using. Plenty of
  // statements - Monzo's among them - print the header once, on the first page,
  // and let the table run on down the next three without it. Carried only while
  // the table is still going: a page that yielded no lines is where it ended,
  // and the terms and conditions after it are not to be read as payments.
  let carried: Column[] | null = null

  for (const [page, rows] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    let columns: Column[] | null = null
    let start = rows.length
    for (const [index, row] of rows.entries()) {
      const header = readHeader(row)
      if (header) {
        headerCount += 1
        usedColumns = header.columns
        columns = header.columns
        start = index + 1
        break
      }
    }
    if (!columns && carried) {
      columns = carried
      start = 0
    }
    if (!columns) {
      carried = null
      continue
    }

    const linesBefore = lines.length
    for (const row of rows.slice(start)) {
      const cells = readCells(row, columns)
      const date = parseStatementDate(cells.date ?? '')
      const amount = date ? amountFor(cells, columns) : null

      if (date && amount) {
        const balance = parseStatementAmount(cells.balance ?? '')
        lines.push({
          y: row.y,
          page,
          date,
          cells,
          detailParts: cells.details ? [{ page, y: row.y, text: cells.details }] : [],
          amount,
          balance,
        })
      } else if ((cells.details || cells.type) && (date || !cells.date)) {
        // A wrapped description leaves the date column empty. Words in it that
        // are not a date are a paragraph running the width of the page - the
        // bank's registered office, the deposit protection blurb - and that is
        // not the rest of anybody's payment.
        unattached.push({ y: row.y, page, cells })
      }
    }
    carried = lines.length > linesBefore ? columns : null
  }

  if (headerCount === 0) {
    return {
      lines: [],
      meta,
      mapping: { reader: 'pdf', pages: extracted.pageCount, columns: [] },
      warnings: [
        'We could not find a table of transactions in that PDF. Check it is the statement itself rather than a summary or a certificate, or import a CSV from your bank instead.',
      ],
    }
  }

  attachWrappedLines(lines, unattached)

  const { warnings, printedNewestFirst } = checkAgainstBalances(lines)

  // Put the lines in the order they happened.
  //
  // Where the running balance told us which way the statement runs, that answer
  // is better than the dates: it orders two payments made on the same day, which
  // a date sort cannot, and getting that wrong makes a running balance in our
  // own screens jump about for no visible reason.
  if (printedNewestFirst === true) lines.reverse()
  else if (printedNewestFirst === null) {
    lines.sort((a, b) => a.date.localeCompare(b.date))
  }

  const statementLines: StatementLine[] = lines.map((line) => {
    // Top to bottom, page by page: a description that ran over onto the next page
    // carries on there, so the next page's piece comes after this one's.
    const details = tidyDetails(
      line.detailParts
        .sort((a, b) => a.page - b.page || b.y - a.y)
        .map((part) => part.text)
        .join(' '),
    )
    const { counterparty, reference } = readCounterparty(details)
    return {
      date: line.date,
      details,
      counterparty: counterparty || (line.cells.type ?? 'Unnamed'),
      reference,
      transactionType: line.cells.type?.trim() || null,
      amount: formatMoney(line.amount),
      balance: line.balance ? formatMoney(line.balance) : null,
    }
  })

  if (statementLines.length === 0) {
    warnings.push('We found the table but no lines in it we could read.')
  }

  return {
    lines: statementLines,
    meta,
    mapping: {
      reader: 'pdf',
      pages: extracted.pageCount,
      columns: usedColumns.map((column) => ({ key: column.key, x: Math.round(column.x) })),
    },
    warnings,
  }
}
