import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError } from './errors'
import { parseCsv } from './csv'
import { formatMoney, isMoneyString, toMoney } from './money'
import { matchBankAccount, requireBankAccount } from './bank-accounts'
import {
  findExistingFingerprints,
  insertBankTransactions,
  prepareStatementLines,
} from './bank-transactions'
import { parseStatementPdf } from './statement-pdf'
import {
  EMPTY_META,
  parseStatementAmount,
  readCounterparty,
  tidyDetails,
  type ParsedStatement,
  type StatementLine,
  type StatementMeta,
} from './statement'
import type { Direction } from './types'

// Bringing a bank statement in.
//
// Importing keeps the bank's own version of events and stops there. Every line
// lands in bk_bank_transactions exactly as the bank wrote it, and nothing else
// in the books moves: no entry is created, nothing is matched, nothing is
// coded.
//
// That is deliberate. Saying what each of two hundred lines was for, in one
// sitting, before any of it is saved, is the bit nobody ever finishes - and an
// import abandoned halfway has kept nothing at all. Explaining the lines is the
// reconciliation screen's job, where it can be done a few at a time, in any
// order, in bulk where the lines are alike, and where the work survives being
// interrupted.
//
// What import still does is check its own reading. The statement's own totals
// are compared against what we read out of it, and a line already held for this
// account is recognised rather than stored twice.

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export type BankPreset = {
  id: string
  label: string
  /** Header names this bank uses, lower-cased, in the order we look for them. */
  date: string[]
  description: string[]
  amount?: string[]
  moneyIn?: string[]
  moneyOut?: string[]
  reference?: string[]
  /** Date order, because 03/04 is two different days depending on the bank. */
  dateFormat: 'dd/mm/yyyy' | 'yyyy-mm-dd' | 'mm/dd/yyyy'
}

export const BANK_PRESETS: BankPreset[] = [
  {
    id: 'generic',
    label: 'Generic (date, description, amount)',
    date: ['date', 'transaction date'],
    description: ['description', 'details', 'narrative'],
    amount: ['amount', 'value'],
    reference: ['reference', 'ref'],
    dateFormat: 'dd/mm/yyyy',
  },
  {
    id: 'tide',
    label: 'Tide',
    date: ['date', 'transaction date'],
    description: ['description', 'details', 'transaction description'],
    moneyIn: ['paid in', 'paid in (£)', 'money in'],
    moneyOut: ['paid out', 'paid out (£)', 'money out'],
    reference: ['reference'],
    dateFormat: 'dd/mm/yyyy',
  },
  {
    id: 'starling',
    label: 'Starling Bank',
    date: ['date'],
    description: ['counter party', 'reference'],
    amount: ['amount (gbp)'],
    reference: ['reference'],
    dateFormat: 'dd/mm/yyyy',
  },
  {
    id: 'monzo',
    label: 'Monzo',
    date: ['date'],
    description: ['name', 'description'],
    amount: ['amount'],
    reference: ['notes and #tags'],
    dateFormat: 'dd/mm/yyyy',
  },
  {
    id: 'hsbc',
    label: 'HSBC',
    date: ['date'],
    description: ['description'],
    amount: ['amount'],
    dateFormat: 'dd/mm/yyyy',
  },
  {
    id: 'barclays',
    label: 'Barclays',
    date: ['date'],
    description: ['memo', 'description'],
    amount: ['amount'],
    reference: ['subcategory'],
    dateFormat: 'dd/mm/yyyy',
  },
  {
    id: 'lloyds',
    label: 'Lloyds / Halifax / Bank of Scotland',
    date: ['transaction date'],
    description: ['transaction description'],
    moneyIn: ['credit amount'],
    moneyOut: ['debit amount'],
    dateFormat: 'dd/mm/yyyy',
  },
  {
    id: 'natwest',
    label: 'NatWest / RBS',
    date: ['date'],
    description: ['description'],
    amount: ['value'],
    dateFormat: 'dd/mm/yyyy',
  },
]

export type ColumnMapping = {
  date: string
  description: string
  amount?: string
  moneyIn?: string
  moneyOut?: string
  reference?: string
  dateFormat: BankPreset['dateFormat']
}

/** Best guess at the mapping from the file's own headers. */
export function guessMapping(headers: string[], presetId?: string): ColumnMapping | null {
  const lower = headers.map((h) => h.trim().toLowerCase())
  const find = (candidates: string[] | undefined): string | undefined => {
    if (!candidates) return undefined
    for (const candidate of candidates) {
      const index = lower.indexOf(candidate)
      if (index !== -1) return headers[index]
    }
    return undefined
  }

  const presets = presetId ? BANK_PRESETS.filter((p) => p.id === presetId) : BANK_PRESETS
  for (const preset of presets) {
    const date = find(preset.date)
    const description = find(preset.description)
    if (!date || !description) continue
    const amount = find(preset.amount)
    const moneyIn = find(preset.moneyIn)
    const moneyOut = find(preset.moneyOut)
    if (!amount && !moneyIn && !moneyOut) continue
    return {
      date,
      description,
      amount,
      moneyIn,
      moneyOut,
      reference: find(preset.reference),
      dateFormat: preset.dateFormat,
    }
  }
  return null
}

export function parseImportDate(value: string, format: ColumnMapping['dateFormat']): Date | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (format === 'yyyy-mm-dd') {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(trimmed)
    if (!match) return null
    return buildDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }

  const match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/.exec(trimmed)
  if (!match) return null
  const first = Number(match[1])
  const second = Number(match[2])
  const year = Number(match[3]!.length === 2 ? `20${match[3]}` : match[3])
  const [day, month] = format === 'mm/dd/yyyy' ? [second, first] : [first, second]
  return buildDate(year, month, day)
}

function buildDate(year: number, month: number, day: number): Date | null {
  if (!year || !month || !day || month > 12 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(date.getTime())) return null
  // Date.UTC rolls an impossible date over - 30 Feb becomes 2 March - which
  // would turn a transposed statement date into a plausibly wrong record
  // instead of a per-row error the reviewer can see.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

/** Strips a currency symbol, thousands separators and a parenthesised minus. */
export function parseImportAmount(value: string): Prisma.Decimal | null {
  return parseStatementAmount(value)
}

const MAX_LINES = 2000

/** Read a CSV export into the same shape a PDF statement produces. */
export function parseStatementCsv(
  text: string,
  presetId: string | undefined,
  override: ColumnMapping | null,
): ParsedStatement {
  const parsed = parseCsv(text)
  if (parsed.headers.length === 0) {
    throw new BookkeepingError('invalid', 'That file has no column headings we could read.')
  }
  if (parsed.rows.length > MAX_LINES) {
    throw new BookkeepingError(
      'too_large',
      `That file has ${parsed.rows.length} rows. Import up to ${MAX_LINES} at a time.`,
    )
  }

  const mapping = override ?? guessMapping(parsed.headers, presetId)
  if (!mapping) {
    throw new BookkeepingError(
      'unmapped',
      'We could not work out which columns are which. Choose your bank, or map the columns yourself.',
    )
  }

  const column = (name: string | undefined): number =>
    name ? parsed.headers.findIndex((h) => h === name) : -1
  const dateColumn = column(mapping.date)
  const descriptionColumn = column(mapping.description)
  const amountColumn = column(mapping.amount)
  const inColumn = column(mapping.moneyIn)
  const outColumn = column(mapping.moneyOut)
  const referenceColumn = column(mapping.reference)

  const lines: StatementLine[] = []
  const warnings: string[] = []

  for (const [index, row] of parsed.rows.entries()) {
    const rawDate = row[dateColumn] ?? ''
    const date = parseImportDate(rawDate, mapping.dateFormat)
    const details = tidyDetails(row[descriptionColumn] ?? '')

    let amount: Prisma.Decimal | null = null
    if (amountColumn !== -1) {
      amount = parseStatementAmount(row[amountColumn] ?? '')
    } else {
      const credit = inColumn === -1 ? null : parseStatementAmount(row[inColumn] ?? '')
      const debit = outColumn === -1 ? null : parseStatementAmount(row[outColumn] ?? '')
      if (credit && !credit.isZero()) amount = credit.abs()
      else if (debit && !debit.isZero()) amount = debit.abs().negated()
    }

    if (!date) {
      warnings.push(`Row ${index + 2}: “${rawDate}” is not a date we can read, so that row was left out.`)
      continue
    }
    if (!details) {
      warnings.push(`Row ${index + 2}: nothing to say who this was with, so that row was left out.`)
      continue
    }
    if (!amount || amount.isZero()) {
      warnings.push(`Row ${index + 2}: no amount we can read, so that row was left out.`)
      continue
    }

    const explicitReference = referenceColumn === -1 ? null : (row[referenceColumn] ?? '').trim() || null
    const read = readCounterparty(details)
    lines.push({
      date: date.toISOString().slice(0, 10),
      details,
      counterparty: read.counterparty,
      reference: explicitReference ?? read.reference,
      transactionType: null,
      amount: formatMoney(amount),
      balance: null,
    })
  }

  return {
    lines,
    meta: { ...EMPTY_META },
    mapping: { reader: 'csv', ...mapping },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// One entry point for both formats
// ---------------------------------------------------------------------------

export type ImportedFile = {
  filename: string
  bytes: Buffer
}

export function readStatementFile(
  file: ImportedFile,
  presetId: string | undefined,
  override: ColumnMapping | null,
): { statement: ParsedStatement; format: 'csv' | 'pdf' } {
  // The magic bytes, not the file name. A statement saved with the wrong
  // extension is ordinary, and reading a PDF as text produces a page of noise
  // and an unhelpful complaint about column headings.
  const isPdf = file.bytes.subarray(0, 5).toString('latin1') === '%PDF-'
  if (isPdf) {
    return { statement: parseStatementPdf(file.bytes), format: 'pdf' }
  }

  const text = file.bytes.toString('utf8')
  if (/^\s*%PDF-/.test(text)) {
    return { statement: parseStatementPdf(file.bytes), format: 'pdf' }
  }
  return { statement: parseStatementCsv(text, presetId, override), format: 'csv' }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type PreparedLine = {
  index: number
  date: string
  details: string
  counterparty: string
  reference: string | null
  transactionType: string | null
  /** Signed, as the bank has it. */
  amount: string
  direction: Direction
  /** The same figure without its sign, which is what an entry is recorded at. */
  gross: string
  balance: string | null
  /** An identical line already on this account, if there is one. */
  duplicateOfId: string | null
}

export type StatementPreview = {
  format: 'csv' | 'pdf'
  filename: string
  meta: StatementMeta
  mapping: Record<string, unknown>
  bankAccountId: string | null
  /** Set when the statement said which account it is and we recognised it. */
  matchedBankAccount: { id: string; name: string } | null
  lines: PreparedLine[]
  duplicates: number
  warnings: string[]
  /** The statement's own totals against what we read, where it printed them. */
  checks: { label: string; statement: string; read: string; agrees: boolean }[]
}

export async function previewStatement(
  file: ImportedFile,
  options: { bankAccountId?: string | null; preset?: string; mapping?: ColumnMapping | null },
): Promise<StatementPreview> {
  const { statement, format } = readStatementFile(file, options.preset, options.mapping ?? null)

  if (statement.lines.length > MAX_LINES) {
    throw new BookkeepingError(
      'too_large',
      `That statement has ${statement.lines.length} lines. Import up to ${MAX_LINES} at a time.`,
    )
  }

  // Which account this is. What the caller chose wins; otherwise what the
  // statement printed about itself, if we recognise it.
  const matched = options.bankAccountId
    ? null
    : await matchBankAccount(statement.meta.accountLast4, statement.meta.sortCode)
  const bankAccountId = options.bankAccountId ?? matched?.id ?? null

  const prepared = prepareStatementLines(statement.lines)
  const existing = bankAccountId
    ? await findExistingFingerprints(bankAccountId, prepared.map((line) => line.fingerprint))
    : new Map<string, string>()

  const lines: PreparedLine[] = prepared.map((line, index) => {
    const amount = toMoney(line.amount)
    return {
      index,
      date: line.date,
      details: line.details,
      counterparty: line.counterparty,
      reference: line.reference,
      transactionType: line.transactionType,
      amount: formatMoney(amount),
      direction: amount.isPositive() ? 'income' : 'expense',
      gross: formatMoney(amount.abs()),
      balance: line.balance,
      duplicateOfId: existing.get(line.fingerprint) ?? null,
    }
  })

  return {
    format,
    filename: file.filename,
    meta: statement.meta,
    mapping: statement.mapping,
    bankAccountId,
    matchedBankAccount: matched ? { id: matched.id, name: matched.name } : null,
    lines,
    duplicates: lines.filter((line) => line.duplicateOfId).length,
    warnings: statement.warnings,
    checks: buildChecks(statement),
  }
}

/**
 * The statement's own totals against the ones we read.
 *
 * Free arithmetic that catches a whole class of misreadings at a glance: if the
 * statement says £261.95 went out and we read £185.46, a line was missed and the
 * reviewer can see that before anything is written rather than at the year end.
 */
function buildChecks(statement: ParsedStatement): StatementPreview['checks'] {
  const checks: StatementPreview['checks'] = []
  const paidIn = statement.lines
    .map((line) => toMoney(line.amount))
    .filter((amount) => amount.isPositive())
    .reduce((total, amount) => total.plus(amount), toMoney('0.00'))
  const paidOut = statement.lines
    .map((line) => toMoney(line.amount))
    .filter((amount) => amount.isNegative())
    .reduce((total, amount) => total.plus(amount.abs()), toMoney('0.00'))

  if (statement.meta.totalPaidIn) {
    checks.push({
      label: 'Total paid in',
      statement: statement.meta.totalPaidIn,
      read: formatMoney(paidIn),
      agrees: toMoney(statement.meta.totalPaidIn).equals(paidIn),
    })
  }
  if (statement.meta.totalPaidOut) {
    checks.push({
      label: 'Total paid out',
      statement: statement.meta.totalPaidOut,
      read: formatMoney(paidOut),
      agrees: toMoney(statement.meta.totalPaidOut).equals(paidOut),
    })
  }
  if (statement.meta.openingBalance && statement.meta.closingBalance) {
    const expected = toMoney(statement.meta.openingBalance).plus(paidIn).minus(paidOut)
    checks.push({
      label: 'Closing balance',
      statement: statement.meta.closingBalance,
      read: formatMoney(expected),
      agrees: toMoney(statement.meta.closingBalance).equals(expected),
    })
  }
  return checks
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export type CommitStatementInput = {
  filename: string
  format: 'csv' | 'pdf'
  bankAccountId: string
  preset?: string | null
  meta: StatementMeta
  mapping: Record<string, unknown>
  lines: PreparedLine[]
}

export type CommitStatementResult = {
  statementId: string
  linesKept: number
  duplicates: number
}

/**
 * The commit body arrives from the browser, and the browser is not trusted with
 * the schema: every field that reaches an INSERT is checked here first, so a
 * doctored line becomes a sentence naming itself rather than a raw constraint
 * violation from Postgres.
 */
function checkLine(line: PreparedLine): void {
  const where = `Line ${line.index + 1}`
  if (!isMoneyString(line.amount) || toMoney(line.amount).isZero()) {
    throw new BookkeepingError('invalid', `${where}: the amount is not one we can record.`)
  }
  if (toMoney(line.amount).abs().greaterThan(new Prisma.Decimal('99999999.99'))) {
    throw new BookkeepingError('invalid', `${where}: the amount is larger than these books can hold.`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(line.date)) {
    throw new BookkeepingError('invalid', `${where}: the date has gone missing.`)
  }
  if (!line.details.trim() && !line.counterparty.trim()) {
    throw new BookkeepingError('invalid', `${where}: the description has gone missing.`)
  }
}

/**
 * Keep the statement, and the bank's own lines from it.
 *
 * Nothing else. No entry is created and nothing is matched: a statement line
 * says money moved, it does not say what for, and the reconciliation screen is
 * where somebody says so.
 */
export async function commitStatement(
  input: CommitStatementInput,
  user: SessionUser | null,
): Promise<CommitStatementResult> {
  const account = await requireBankAccount(input.bankAccountId)
  if (input.lines.length === 0) {
    throw new BookkeepingError('invalid', 'There was nothing in that statement to bring in.')
  }
  if (input.lines.length > MAX_LINES) {
    throw new BookkeepingError(
      'too_large',
      `That statement has ${input.lines.length} lines. Import up to ${MAX_LINES} at a time.`,
    )
  }
  input.lines.forEach(checkLine)

  // Fingerprinted here rather than trusted from the browser: the fingerprint is
  // the duplicate guard, and one supplied by the caller could be made to miss.
  const prepared = prepareStatementLines(
    input.lines.map((line) => ({
      date: line.date,
      details: line.details,
      counterparty: line.counterparty,
      reference: line.reference,
      transactionType: line.transactionType,
      amount: line.amount,
      balance: line.balance,
    })),
  )

  const existing = await findExistingFingerprints(
    account.id,
    prepared.map((line) => line.fingerprint),
  )
  const fresh = prepared.filter((line) => !existing.has(line.fingerprint))

  const result = await prisma.$transaction(async (tx) => {
    const [statement] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "bk_bank_statements" (
        "bank_account_id", "filename", "format", "preset", "period_start", "period_end",
        "opening_balance", "closing_balance", "total_paid_in", "total_paid_out",
        "row_count", "imported_count", "duplicate_count", "mapping", "created_by_user_id"
      ) VALUES (
        ${account.id}, ${input.filename}, ${input.format}, ${input.preset ?? null},
        ${input.meta.periodStart}::date, ${input.meta.periodEnd}::date,
        ${input.meta.openingBalance}::numeric, ${input.meta.closingBalance}::numeric,
        ${input.meta.totalPaidIn}::numeric, ${input.meta.totalPaidOut}::numeric,
        ${input.lines.length}, ${fresh.length}, ${prepared.length - fresh.length},
        ${JSON.stringify(input.mapping)}::jsonb, ${user?.id ?? null}
      )
      RETURNING "id"
    `
    const statementId = statement!.id
    await insertBankTransactions(tx, account.id, statementId, fresh)
    return { statementId, linesKept: fresh.length, duplicates: prepared.length - fresh.length }
  })

  await appendAudit({
    action: 'statement.imported',
    entityType: 'bank_statement',
    entityId: result.statementId,
    summary: `${result.linesKept} statement line${result.linesKept === 1 ? '' : 's'} brought in from ${input.filename}, waiting to be explained`,
    detail: {
      filename: input.filename,
      format: input.format,
      bankAccount: account.name,
      lines: input.lines.length,
      duplicates: result.duplicates,
    },
    user,
  })

  return result
}
