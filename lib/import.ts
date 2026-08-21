import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError } from './errors'
import { parseCsv } from './csv'
import { formatMoney, isMoneyString, toMoney } from './money'
import { insertTransactionRows, suggestCategoryForCounterparty } from './transactions'
import { getCategoryByCode } from './categories'
import { matchBankAccount, requireBankAccount } from './bank-accounts'
import {
  findExistingFingerprints,
  insertBankTransactions,
  prepareStatementLines,
} from './bank-transactions'
import {
  confidentMatch,
  refreshBankTransactionStatus,
  suggestMatchesForLines,
  type MatchCandidate,
} from './reconciliation'
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
// Three things happen to every line, in this order, and the order is the whole
// design:
//
//   1. It is kept, as the bank wrote it, in bk_bank_transactions. That is what
//      makes reconciliation possible later - "does the bank agree with the
//      books" is unanswerable once the bank's version has been thrown away.
//   2. It is offered to whatever entry already explains it. Most lines of most
//      statements are things already recorded, and importing a second copy of
//      them is the commonest way a set of books goes wrong.
//   3. Only what is left becomes a new entry, and only as a DRAFT. A statement
//      line says money moved; it does not say what for, and guessing that is
//      what makes a set of books wrong in the other direction.
//
// Nothing here ever posts. A draft reaches no VAT box until a human has looked
// at it and said what it was.

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
      `That file has ${parsed.rows.length} rows. Import up to ${MAX_LINES} at a time, so the review stays something a human can actually do.`,
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

/** What we propose to do with one statement line. */
export type LineAction = 'import' | 'match' | 'skip'

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
  /** Entries that could be what this line is, best first. */
  suggestions: MatchCandidate[]
  /** The one we would tick, if any one of them is clearly it. */
  suggestedMatchId: string | null
  /** What this counterparty was filed under last time, for the ones we create. */
  categoryId: string | null
  action: LineAction
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
  matches: number
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
      `That statement has ${statement.lines.length} lines. Import up to ${MAX_LINES} at a time, so the review stays something a human can actually do.`,
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

  const suggestions = await suggestMatchesForLines(
    statement.lines.map((line) => ({
      date: line.date,
      amount: line.amount,
      counterparty: line.counterparty,
      details: line.details,
      reference: line.reference,
    })),
  )

  const categoryIds = await suggestCategories(statement.lines)

  const lines: PreparedLine[] = prepared.map((line, index) => {
    const amount = toMoney(line.amount)
    const direction: Direction = amount.isPositive() ? 'income' : 'expense'
    const duplicateOfId = existing.get(line.fingerprint) ?? null
    const candidates = suggestions.get(index) ?? []
    const confident = confidentMatch(candidates)

    return {
      index,
      date: line.date,
      details: line.details,
      counterparty: line.counterparty,
      reference: line.reference,
      transactionType: line.transactionType,
      amount: formatMoney(amount),
      direction,
      gross: formatMoney(amount.abs()),
      balance: line.balance,
      duplicateOfId,
      suggestions: candidates,
      suggestedMatchId: confident?.transactionId ?? null,
      categoryId: categoryIds.get(line.counterparty) ?? categoryIds.get('') ?? null,
      // Already have it: leave it alone. Something already explains it: match it.
      // Otherwise it is new, and becomes a draft for review.
      action: duplicateOfId ? 'skip' : confident ? 'match' : 'import',
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
    matches: lines.filter((line) => line.action === 'match').length,
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

/** What each counterparty was filed under last time, in as few queries as possible. */
async function suggestCategories(lines: StatementLine[]): Promise<Map<string, string | null>> {
  const names = [...new Set(lines.map((line) => line.counterparty))]
  const suggestions = new Map<string, string | null>()
  for (const name of names) {
    suggestions.set(name, await suggestCategoryForCounterparty(name))
  }

  const fallbackIncome = await getCategoryByCode('sales')
  const fallbackExpense = await getCategoryByCode('other-expenses')
  for (const line of lines) {
    if (suggestions.get(line.counterparty)) continue
    suggestions.set(
      line.counterparty,
      toMoney(line.amount).isPositive() ? (fallbackIncome?.id ?? null) : (fallbackExpense?.id ?? null),
    )
  }
  return suggestions
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
  /** Per line: what the reviewer settled on. Keyed by the line's index. */
  decisions: Record<string, { action: LineAction; matchTransactionId?: string | null; categoryId?: string | null }>
}

export type CommitStatementResult = {
  statementId: string
  linesKept: number
  entriesCreated: number
  matched: number
  skipped: number
}

/**
 * The commit body arrives from the browser, and the browser is not trusted with
 * the schema: every field that reaches an INSERT is checked here first, so a
 * doctored line becomes a sentence naming itself rather than a raw constraint
 * violation from Postgres.
 */
function checkLine(line: PreparedLine, categoryIds: Set<string>, categoryId: string | null): void {
  const where = `Line ${line.index + 1}`
  if (line.direction !== 'income' && line.direction !== 'expense') {
    throw new BookkeepingError('invalid', `${where}: the direction is not one we recognise.`)
  }
  if (!isMoneyString(line.gross) || toMoney(line.gross).isNegative() || toMoney(line.gross).isZero()) {
    throw new BookkeepingError('invalid', `${where}: the amount is not one we can record.`)
  }
  if (toMoney(line.gross).greaterThan(new Prisma.Decimal('99999999.99'))) {
    throw new BookkeepingError('invalid', `${where}: the amount is larger than these books can hold.`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(line.date) || !line.counterparty.trim()) {
    throw new BookkeepingError('invalid', `${where}: the date or the description has gone missing.`)
  }
  if (categoryId && !categoryIds.has(categoryId)) {
    throw new BookkeepingError('invalid', `${where}: that category does not exist.`)
  }
}

export async function commitStatement(
  input: CommitStatementInput,
  user: SessionUser | null,
): Promise<CommitStatementResult> {
  const account = await requireBankAccount(input.bankAccountId)

  const categories = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "bk_categories"`
  const categoryIds = new Set(categories.map((category) => category.id))

  type Planned = {
    line: PreparedLine
    action: LineAction
    categoryId: string | null
    matchTransactionId: string | null
    fingerprint: string
  }

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

  const planned: Planned[] = []
  for (const [index, line] of input.lines.entries()) {
    const decision = input.decisions[String(line.index)] ?? { action: line.action }
    if (decision.action === 'skip') continue

    const categoryId = decision.categoryId ?? line.categoryId ?? null
    if (decision.action === 'import') checkLine(line, categoryIds, categoryId)
    planned.push({
      line,
      action: decision.action,
      categoryId,
      matchTransactionId: decision.matchTransactionId ?? line.suggestedMatchId ?? null,
      fingerprint: prepared[index]!.fingerprint,
    })
  }

  // Whatever the reviewer decided, a line already on this account is not stored
  // twice. The unique index enforces it; this is what keeps the count honest.
  const existing = await findExistingFingerprints(
    account.id,
    planned.map((item) => item.fingerprint),
  )

  const result = await prisma.$transaction(async (tx) => {
    const [statement] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "bk_bank_statements" (
        "bank_account_id", "filename", "format", "preset", "period_start", "period_end",
        "opening_balance", "closing_balance", "total_paid_in", "total_paid_out",
        "row_count", "mapping", "created_by_user_id"
      ) VALUES (
        ${account.id}, ${input.filename}, ${input.format}, ${input.preset ?? null},
        ${input.meta.periodStart}::date, ${input.meta.periodEnd}::date,
        ${input.meta.openingBalance}::numeric, ${input.meta.closingBalance}::numeric,
        ${input.meta.totalPaidIn}::numeric, ${input.meta.totalPaidOut}::numeric,
        ${input.lines.length}, ${JSON.stringify(input.mapping)}::jsonb, ${user?.id ?? null}
      )
      RETURNING "id"
    `
    const statementId = statement!.id

    const fresh = planned.filter((item) => !existing.has(item.fingerprint))
    await insertBankTransactions(
      tx,
      account.id,
      statementId,
      fresh.map((item) => ({
        date: item.line.date,
        details: item.line.details,
        counterparty: item.line.counterparty,
        reference: item.line.reference,
        transactionType: item.line.transactionType,
        amount: item.line.amount,
        balance: item.line.balance,
        fingerprint: item.fingerprint,
      })),
    )

    // Read the ids back by fingerprint rather than trusting the RETURNING order:
    // ON CONFLICT DO NOTHING returns only the rows it actually wrote, so the two
    // lists stop lining up the moment anything is skipped.
    const saved = await tx.$queryRaw<{ id: string; fingerprint: string; amount: Prisma.Decimal }[]>`
      SELECT "id", "fingerprint", "amount" FROM "bk_bank_transactions"
      WHERE "bank_account_id" = ${account.id}
        AND "fingerprint" = ANY(${planned.map((item) => item.fingerprint)}::text[])
    `
    const byFingerprint = new Map(saved.map((row) => [row.fingerprint, row]))

    let entriesCreated = 0
    let matched = 0

    for (const item of planned) {
      const bankRow = byFingerprint.get(item.fingerprint)
      if (!bankRow) continue

      let transactionId = item.matchTransactionId

      if (item.action === 'import') {
        const gross = toMoney(item.line.gross)
        transactionId = await insertTransactionRows(
          tx,
          {
            direction: item.line.direction,
            taxPointDate: item.line.date,
            settledDate: item.line.date,
            counterparty: item.line.counterparty,
            description: item.line.details === item.line.counterparty ? '' : item.line.details,
            reference: item.line.reference,
            // Draft, always. Nothing imported is a record until a human says so.
            status: 'draft',
            source: 'import',
            sourceRef: `${statementId}:${item.line.index}`,
            bankAccountId: account.id,
            statementId,
            lines: [
              {
                categoryId: item.categoryId!,
                // Zero rated by default: a bank line does not know what VAT was
                // on it, and inventing VAT here would be inventing a box 1 figure.
                vatTreatment: 'domestic',
                vatRateCode: 'zero',
                vatRatePercent: '0.00',
                netAmount: formatMoney(gross),
                vatAmount: '0.00',
                grossAmount: formatMoney(gross),
              },
            ],
          },
          user,
        )
        entriesCreated += 1
      }

      if (!transactionId) continue

      // The entry explains the statement line, so record that it does. An
      // imported draft is tied to the line it came from for the same reason: it
      // IS that line, and the reconciliation screen should not ask about it
      // again.
      await tx.$executeRaw`
        INSERT INTO "bk_reconciliations"
          ("bank_transaction_id", "transaction_id", "amount", "match_method", "created_by_user_id")
        SELECT ${bankRow.id}, ${transactionId}, ${formatMoney(bankRow.amount)}::numeric,
               ${item.action === 'import' ? 'import' : 'suggested'}, ${user?.id ?? null}
        WHERE NOT EXISTS (
          SELECT 1 FROM "bk_reconciliations"
          WHERE "bank_transaction_id" = ${bankRow.id} AND "transaction_id" = ${transactionId}
        )
        AND NOT EXISTS (
          SELECT 1 FROM "bk_transactions" WHERE "id" = ${transactionId} AND "locked_period_id" IS NOT NULL
        )
      `
      if (item.action === 'match') matched += 1
      await refreshBankTransactionStatus(tx, bankRow.id)
    }

    const linesKept = fresh.length
    await tx.$executeRaw`
      UPDATE "bk_bank_statements"
      SET "imported_count" = ${linesKept},
          "duplicate_count" = ${planned.length - linesKept}
      WHERE "id" = ${statementId}
    `

    return { statementId, linesKept, entriesCreated, matched }
  })

  await appendAudit({
    action: 'statement.imported',
    entityType: 'bank_statement',
    entityId: result.statementId,
    summary: `${result.linesKept} statement line${result.linesKept === 1 ? '' : 's'} brought in from ${input.filename}, ${result.entriesCreated} new entr${result.entriesCreated === 1 ? 'y' : 'ies'} for review`,
    detail: {
      filename: input.filename,
      format: input.format,
      bankAccount: account.name,
      lines: input.lines.length,
      matched: result.matched,
    },
    user,
  })

  return {
    ...result,
    skipped: input.lines.length - result.linesKept,
  }
}
