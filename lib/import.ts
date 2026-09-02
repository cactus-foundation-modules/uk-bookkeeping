import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError } from './errors'
import { parseCsv } from './csv'
import { formatMoney, isMoneyString, toMoney } from './money'
import { matchBankAccount, requireBankAccount } from './bank-accounts'
import { forgetStatementFile, storeStatementFile } from './statement-files'
import {
  findExistingFingerprints,
  insertBankTransactions,
  prepareStatementLines,
} from './bank-transactions'
import { parseStatementPdf } from './statement-pdf'
import type { BkBankStatementRow } from './types'
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
// Which statement is this?
// ---------------------------------------------------------------------------
//
// A statement is identified by the account it is for and the stretch of time it
// covers - never by its filename. Banks name their exports after a serial
// number and a timestamp, so the same month downloaded twice arrives as two
// different names, and two consecutive months routinely arrive as near-identical
// ones. The period is the only part of it that means anything.

export type CoveredRange = { from: string | null; to: string | null }

/**
 * The stretch of time a file covers: what the statement declared, and where it
 * declared nothing, the first and last line in it.
 *
 * The fallback is what makes this work for CSVs, which almost never carry a
 * period at all. It is deliberately not written back into period_start and
 * period_end - those columns hold what the STATEMENT said, and a figure we
 * worked out ourselves has no business sitting in a column that means "the bank
 * printed this".
 */
export function coveredRange(meta: StatementMeta, lines: { date: string }[]): CoveredRange {
  const dates = lines
    .map((line) => line.date)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()
  return {
    from: meta.periodStart ?? dates[0] ?? null,
    to: meta.periodEnd ?? dates[dates.length - 1] ?? null,
  }
}

/** The month folder a statement's file belongs in: the end of what it covers. */
function statementFiledUnder(covers: CoveredRange): Date {
  return covers.to ? new Date(`${covers.to}T00:00:00Z`) : new Date()
}

export type ExistingStatement = {
  id: string
  filename: string
  importedAt: string
  updatedAt: string
  updateCount: number
  lineCount: number
  hasFile: boolean
}

/**
 * The statement already held for this account and this period, if there is one.
 *
 * COALESCE either side, so a CSV import with no declared period is matched on
 * the range of its own lines - which is how a re-imported CSV finds the statement
 * it is meant to be replacing rather than piling a second copy alongside it.
 */
export async function findStatementCovering(
  bankAccountId: string,
  covers: CoveredRange,
): Promise<ExistingStatement | null> {
  if (!covers.from || !covers.to) return null

  const rows = await prisma.$queryRaw<
    {
      id: string
      filename: string
      created_at: Date
      updated_at: Date
      update_count: number
      line_count: number
      has_file: boolean
    }[]
  >`
    SELECT s."id", s."filename", s."created_at", s."updated_at", s."update_count",
           COALESCE(r."line_count", 0)::int AS line_count,
           (s."media_key" IS NOT NULL) AS has_file
    FROM "bk_bank_statements" s
    LEFT JOIN LATERAL (
      SELECT MIN("date") AS first_date, MAX("date") AS last_date, COUNT(*)::int AS line_count
      FROM "bk_bank_transactions" WHERE "statement_id" = s."id"
    ) r ON TRUE
    WHERE s."bank_account_id" = ${bankAccountId}
      AND COALESCE(s."period_start", r."first_date") = ${covers.from}::date
      AND COALESCE(s."period_end",   r."last_date")  = ${covers.to}::date
    ORDER BY s."created_at" DESC
    LIMIT 1
  `

  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    filename: row.filename,
    importedAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    updateCount: row.update_count,
    lineCount: row.line_count,
    hasFile: row.has_file,
  }
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
  /** The stretch of time this file covers, declared or worked out. */
  covers: CoveredRange
  /** The statement this one would bring up to date, where there is one. */
  existingStatement: ExistingStatement | null
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

  const covers = coveredRange(statement.meta, prepared)

  return {
    format,
    filename: file.filename,
    meta: statement.meta,
    mapping: statement.mapping,
    bankAccountId,
    matchedBankAccount: matched ? { id: matched.id, name: matched.name } : null,
    covers,
    // Offered, not done. Bringing the same period in twice used to leave two
    // statement rows quietly claiming the same month, with the second one
    // showing no lines because every one of them was a duplicate of the first.
    // Now the screen says which statement this would update, and the person
    // decides.
    existingStatement: bankAccountId ? await findStatementCovering(bankAccountId, covers) : null,
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
  /**
   * The file itself, kept alongside the lines. Optional, and its absence is not
   * an error: a script posting JSON, or a browser that could not re-send the
   * bytes, still imports - it simply leaves no copy of the statement behind.
   */
  file?: Buffer | null
  /**
   * The statement this one brings up to date, rather than a second import of the
   * same month. Comes from the preview, so what the person agreed to and what
   * happens are the same thing.
   */
  replaceStatementId?: string | null
}

export type CommitStatementResult = {
  statementId: string
  linesKept: number
  duplicates: number
  /** True when an existing statement was brought up to date rather than added. */
  updated: boolean
  /** Lines that were on the old version of this statement and are not in the new
   *  file. Removed only where nothing had been done with them yet. */
  removed: number
  /** Lines the new file no longer has, kept because they are already reconciled. */
  keptBecauseUsed: number
  /** Why the file itself is not stored, when it is not. */
  fileNote: string | null
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
  const fingerprints = prepared.map((line) => line.fingerprint)

  const replacing = input.replaceStatementId
    ? await requireStatementOnAccount(input.replaceStatementId, account.id)
    : null

  const existing = await findExistingFingerprints(account.id, fingerprints)
  const fresh = prepared.filter((line) => !existing.has(line.fingerprint))

  // What the previous version of this statement had and this one does not. Only
  // the untouched ones go: a line somebody has already explained is evidence
  // that an entry belongs where it is, and a corrected export is not a good
  // enough reason to pull it out from under one.
  const stale = replacing ? await staleStatementLines(replacing.id, fingerprints) : null

  const result = await prisma.$transaction(async (tx) => {
    let statementId: string

    if (replacing) {
      if (stale && stale.removable.length > 0) {
        await tx.$executeRaw`
          DELETE FROM "bk_bank_transactions" WHERE "id" = ANY(${stale.removable}::text[])
        `
      }
      await tx.$executeRaw`
        UPDATE "bk_bank_statements" SET
          "filename"           = ${input.filename},
          "format"             = ${input.format},
          "preset"             = ${input.preset ?? null},
          "period_start"       = ${input.meta.periodStart}::date,
          "period_end"         = ${input.meta.periodEnd}::date,
          "opening_balance"    = ${input.meta.openingBalance}::numeric,
          "closing_balance"    = ${input.meta.closingBalance}::numeric,
          "total_paid_in"      = ${input.meta.totalPaidIn}::numeric,
          "total_paid_out"     = ${input.meta.totalPaidOut}::numeric,
          "row_count"          = ${input.lines.length},
          "duplicate_count"    = ${prepared.length - fresh.length},
          "mapping"            = ${JSON.stringify(input.mapping)}::jsonb,
          "update_count"       = "update_count" + 1,
          "updated_at"         = NOW(),
          "updated_by_user_id" = ${user?.id ?? null}
        WHERE "id" = ${replacing.id}
      `
      statementId = replacing.id
    } else {
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
      statementId = statement!.id
    }

    await insertBankTransactions(tx, account.id, statementId, fresh)

    // Counted rather than added up, so the figure means "lines this statement
    // holds" on an update as well as on a first import.
    await tx.$executeRaw`
      UPDATE "bk_bank_statements" s
      SET "imported_count" = (
        SELECT COUNT(*)::int FROM "bk_bank_transactions" WHERE "statement_id" = s."id"
      )
      WHERE s."id" = ${statementId}
    `

    return {
      statementId,
      linesKept: fresh.length,
      duplicates: prepared.length - fresh.length,
      updated: !!replacing,
      removed: stale?.removable.length ?? 0,
      keptBecauseUsed: stale?.keptBecauseUsed ?? 0,
      fileNote: null as string | null,
    }
  })

  // The file last, and outside the transaction. Uploading megabytes with a
  // database transaction held open is how a connection pool runs out, and the
  // lines are the part that must land whatever the file store is doing.
  result.fileNote = await keepStatementFile(
    result.statementId,
    account.name,
    input,
    prepared,
    user,
  )

  await appendAudit({
    action: replacing ? 'statement.updated' : 'statement.imported',
    entityType: 'bank_statement',
    entityId: result.statementId,
    summary: replacing
      ? `Statement ${input.filename} brought up to date: ${result.linesKept} new line${result.linesKept === 1 ? '' : 's'}, ${result.removed} removed`
      : `${result.linesKept} statement line${result.linesKept === 1 ? '' : 's'} brought in from ${input.filename}, waiting to be explained`,
    detail: {
      filename: input.filename,
      format: input.format,
      bankAccount: account.name,
      lines: input.lines.length,
      duplicates: result.duplicates,
      removed: result.removed,
      keptBecauseUsed: result.keptBecauseUsed,
    },
    user,
  })

  return result
}

/** The statement being replaced, checked to be this account's. */
async function requireStatementOnAccount(
  statementId: string,
  bankAccountId: string,
): Promise<BkBankStatementRow> {
  const rows = await prisma.$queryRaw<BkBankStatementRow[]>`
    SELECT * FROM "bk_bank_statements" WHERE "id" = ${statementId} LIMIT 1
  `
  const statement = rows[0]
  if (!statement) {
    throw new BookkeepingError('not_found', 'That statement is not here any more, so there is nothing to update.', 404)
  }
  if (statement.bank_account_id !== bankAccountId) {
    throw new BookkeepingError(
      'invalid',
      'That statement belongs to a different account. Choose the account it was imported against.',
    )
  }
  return statement
}

/**
 * Lines the previous version of this statement had that the new file does not.
 *
 * Split in two, because the two halves get very different treatment. A line
 * nobody has touched is a mistake in the old export and simply goes. A line that
 * has been reconciled, or deliberately set aside, is somebody's work: it stays
 * exactly where it is, and the count comes back so the screen can say so rather
 * than quietly leaving it there.
 */
async function staleStatementLines(
  statementId: string,
  fingerprints: string[],
): Promise<{ removable: string[]; keptBecauseUsed: number }> {
  const rows = await prisma.$queryRaw<{ id: string; disposable: boolean }[]>`
    SELECT b."id",
           (b."status" = 'unreconciled'
            AND NOT EXISTS (
              SELECT 1 FROM "bk_reconciliations" r WHERE r."bank_transaction_id" = b."id"
            )) AS disposable
    FROM "bk_bank_transactions" b
    WHERE b."statement_id" = ${statementId}
      AND NOT (b."fingerprint" = ANY(${fingerprints}::text[]))
  `
  return {
    removable: rows.filter((row) => row.disposable).map((row) => row.id),
    keptBecauseUsed: rows.filter((row) => !row.disposable).length,
  }
}

/**
 * Keep the statement file, and point the row at it.
 *
 * New bytes up first, row second, old bytes deleted last - the same order every
 * relocation in core follows, so a failure part way leaves the old file still
 * serving rather than a row pointing at nothing.
 */
async function keepStatementFile(
  statementId: string,
  bankAccountName: string,
  input: CommitStatementInput,
  prepared: { date: string }[],
  user: SessionUser | null,
): Promise<string | null> {
  if (!input.file || input.file.length === 0) return null

  const [previous] = await prisma.$queryRaw<
    { media_provider: string | null; media_key: string | null; media_id: string | null; mime_type: string | null }[]
  >`
    SELECT "media_provider", "media_key", "media_id", "mime_type"
    FROM "bk_bank_statements" WHERE "id" = ${statementId} LIMIT 1
  `

  const { stored, note } = await storeStatementFile(
    {
      bytes: input.file,
      filename: input.filename,
      format: input.format,
      bankAccountName,
      filedUnder: statementFiledUnder(coveredRange(input.meta, prepared)),
    },
    user?.id ?? null,
  )
  if (!stored) return note

  await prisma.$executeRaw`
    UPDATE "bk_bank_statements" SET
      "url"            = ${stored.url},
      "media_provider" = ${stored.provider},
      "media_key"      = ${stored.key},
      "media_id"       = ${stored.mediaId},
      "mime_type"      = ${stored.mimeType},
      "size"           = ${stored.size},
      "sha256"         = ${stored.sha256}
    WHERE "id" = ${statementId}
  `

  if (previous?.media_key && previous.media_key !== stored.key) {
    await forgetStatementFile(previous)
  }
  return null
}
