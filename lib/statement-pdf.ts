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
import { extractPdfText, type PdfTextRow } from './pdf/text'

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

type Column = { key: ColumnKey; x: number }
type HeaderRow = { row: PdfTextRow; columns: Column[] }

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
    columns.push({ key, x: cell.x })
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

type Cells = Partial<Record<ColumnKey, string>>

function readCells(row: PdfTextRow, columns: Column[]): Cells {
  const cells: Cells = {}
  for (const cell of row.cells) {
    const key = assignColumn(cell.x, columns)
    if (!key) continue
    cells[key] = cells[key] ? `${cells[key]} ${cell.text}`.trim() : cell.text.trim()
  }
  return cells
}

type WorkingLine = {
  y: number
  page: number
  date: string
  cells: Cells
  detailParts: { y: number; text: string }[]
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

export function parseStatementPdf(bytes: Buffer): ParsedStatement {
  const extracted = extractPdfText(bytes)
  const meta = readMeta(extracted.plain)

  const lines: WorkingLine[] = []
  const unattached: { y: number; page: number; cells: Cells }[] = []
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

  for (const [page, rows] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    let header: HeaderRow | null = null

    for (const row of rows) {
      if (!header) {
        header = readHeader(row)
        if (header) {
          headerCount += 1
          usedColumns = header.columns
        }
        continue
      }

      const cells = readCells(row, header.columns)
      const date = parseStatementDate(cells.date ?? '')
      const amount = date ? amountFor(cells, header.columns) : null

      if (date && amount) {
        const balance = parseStatementAmount(cells.balance ?? '')
        lines.push({
          y: row.y,
          page,
          date,
          cells,
          detailParts: cells.details ? [{ y: row.y, text: cells.details }] : [],
          amount,
          balance,
        })
      } else if (cells.details || cells.type) {
        unattached.push({ y: row.y, page, cells })
      }
    }
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

  // Wrapped description lines join the dated row they sit nearest to. Nearest
  // rather than "the one above" because statements differ on which side of the
  // date they put the rest of the description, and some put it on both.
  for (const orphan of unattached) {
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
    if (!best || bestDistance > CONTINUATION_REACH) continue
    const text = [orphan.cells.details, orphan.cells.type].filter(Boolean).join(' ').trim()
    if (text) best.detailParts.push({ y: orphan.y, text })
  }

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
    const details = tidyDetails(
      line.detailParts.sort((a, b) => b.y - a.y).map((part) => part.text).join(' '),
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
