import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError } from './errors'
import { parseCsv } from './csv'
import { formatMoney, toMoney } from './money'
import { createTransaction, suggestCategoryForCounterparty } from './transactions'
import { getCategoryByCode } from './categories'
import type { Direction } from './types'

// Bank statement import.
//
// Everything lands as a DRAFT and nothing else. A draft reaches no VAT box, can
// be edited and deleted freely, and only becomes a record when a human has
// looked at it and said so. That is not caution for its own sake: a statement
// line says money moved, it does not say what for, and guessing that is what
// makes a set of books wrong.

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
  return Number.isNaN(date.getTime()) ? null : date
}

/** Strips a currency symbol, thousands separators and a parenthesised minus. */
export function parseImportAmount(value: string): Prisma.Decimal | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const negative = /^\(.*\)$/.test(trimmed)
  const cleaned = trimmed.replace(/[()£$€,\s]/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const decimal = new Prisma.Decimal(cleaned).toDecimalPlaces(2)
  return negative ? decimal.negated() : decimal
}

export type PreparedRow = {
  index: number
  date: string
  counterparty: string
  reference: string | null
  direction: Direction
  gross: string
  duplicateOfId: string | null
  categoryId: string | null
  error: string | null
}

export type ImportPreview = {
  headers: string[]
  mapping: ColumnMapping
  rows: PreparedRow[]
  duplicates: number
  errors: number
}

const MAX_ROWS = 2000

/**
 * Read the file and work out what each row would become, without writing
 * anything.
 *
 * The cheap work goes first, deliberately. Every module route runs through the
 * one core dispatcher pinned at maxDuration = 60, so parsing, mapping and
 * arithmetic all happen before the first database round trip - and the duplicate
 * check that follows is one query for the whole file rather than one per row, a
 * lesson this platform has already paid for once with a Google Sheets importer.
 */
export async function previewImport(
  text: string,
  presetId: string | undefined,
  override: ColumnMapping | null,
): Promise<ImportPreview> {
  const parsed = parseCsv(text)
  if (parsed.headers.length === 0) {
    throw new BookkeepingError('invalid', 'That file has no column headings we could read.')
  }
  if (parsed.rows.length > MAX_ROWS) {
    throw new BookkeepingError(
      'too_large',
      `That file has ${parsed.rows.length} rows. Import up to ${MAX_ROWS} at a time, so the review stays something a human can actually do.`,
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

  const prepared: PreparedRow[] = []
  for (const [index, row] of parsed.rows.entries()) {
    const rawDate = row[dateColumn] ?? ''
    const date = parseImportDate(rawDate, mapping.dateFormat)
    const counterparty = (row[descriptionColumn] ?? '').trim()

    let amount: Prisma.Decimal | null = null
    if (amountColumn !== -1) {
      amount = parseImportAmount(row[amountColumn] ?? '')
    } else {
      const credit = inColumn === -1 ? null : parseImportAmount(row[inColumn] ?? '')
      const debit = outColumn === -1 ? null : parseImportAmount(row[outColumn] ?? '')
      if (credit && !credit.isZero()) amount = credit
      else if (debit && !debit.isZero()) amount = debit.abs().negated()
    }

    let error: string | null = null
    if (!date) error = `Row ${index + 2}, column “${mapping.date}”: “${rawDate}” is not a date we can read.`
    else if (!counterparty) error = `Row ${index + 2}, column “${mapping.description}”: nothing to say who this was.`
    else if (!amount || amount.isZero()) error = `Row ${index + 2}: no amount we can read.`

    prepared.push({
      index,
      date: date ? date.toISOString().slice(0, 10) : rawDate,
      counterparty,
      reference: referenceColumn === -1 ? null : (row[referenceColumn] ?? '').trim() || null,
      direction: amount && amount.isPositive() ? 'income' : 'expense',
      gross: amount ? formatMoney(amount.abs()) : '0.00',
      duplicateOfId: null,
      categoryId: null,
      error,
    })
  }

  await markDuplicates(prepared)
  await suggestCategories(prepared)

  return {
    headers: parsed.headers,
    mapping,
    rows: prepared,
    duplicates: prepared.filter((r) => r.duplicateOfId).length,
    errors: prepared.filter((r) => r.error).length,
  }
}

/**
 * One query for the whole file. Same day, same counterparty, same gross: not
 * proof, but the shape of an overlapping export, and enough to flag rather than
 * silently create a second copy of January.
 */
async function markDuplicates(rows: PreparedRow[]): Promise<void> {
  const usable = rows.filter((r) => !r.error)
  if (usable.length === 0) return

  const dates = [...new Set(usable.map((r) => r.date))]
  const existing = await prisma.$queryRaw<
    { id: string; tax_point_date: Date; counterparty: string; gross: Prisma.Decimal }[]
  >`
    SELECT t."id", t."tax_point_date", t."counterparty",
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross
    FROM "bk_transactions" t
    LEFT JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE t."tax_point_date" = ANY(${dates}::date[])
    GROUP BY t."id", t."tax_point_date", t."counterparty"
  `

  const key = (date: string, counterparty: string, gross: string) =>
    `${date}|${counterparty.trim().toLowerCase()}|${gross}`
  const seen = new Map(
    existing.map((row) => [
      key(row.tax_point_date.toISOString().slice(0, 10), row.counterparty, formatMoney(row.gross)),
      row.id,
    ]),
  )

  for (const row of usable) {
    row.duplicateOfId = seen.get(key(row.date, row.counterparty, row.gross)) ?? null
  }
}

/** What this counterparty was filed under last time, if it has been seen before. */
async function suggestCategories(rows: PreparedRow[]): Promise<void> {
  const names = [...new Set(rows.filter((r) => !r.error).map((r) => r.counterparty))]
  const suggestions = new Map<string, string | null>()
  for (const name of names) {
    suggestions.set(name, await suggestCategoryForCounterparty(name))
  }
  const fallbackIncome = await getCategoryByCode('sales')
  const fallbackExpense = await getCategoryByCode('other-expenses')

  for (const row of rows) {
    if (row.error) continue
    row.categoryId =
      suggestions.get(row.counterparty) ??
      (row.direction === 'income' ? (fallbackIncome?.id ?? null) : (fallbackExpense?.id ?? null))
  }
}

export type CommitImportInput = {
  filename: string
  preset?: string | null
  mapping: ColumnMapping
  rows: PreparedRow[]
  /** Rows the reviewer ticked. Everything else is left alone. */
  include: number[]
}

export async function commitImport(
  input: CommitImportInput,
  user: SessionUser | null,
): Promise<{ batchId: string; created: number; skipped: number }> {
  const chosen = new Set(input.include)
  const usable = input.rows.filter((row) => chosen.has(row.index) && !row.error)

  const [batch] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "bk_import_batches"
      ("filename", "preset", "row_count", "duplicate_count", "mapping", "created_by_user_id")
    VALUES (
      ${input.filename}, ${input.preset ?? null}, ${input.rows.length},
      ${input.rows.filter((r) => r.duplicateOfId).length},
      ${JSON.stringify(input.mapping)}::jsonb, ${user?.id ?? null}
    )
    RETURNING "id"
  `
  const batchId = batch!.id

  let created = 0
  for (const row of usable) {
    if (!row.categoryId) continue
    const gross = toMoney(row.gross)
    await createTransaction(
      {
        direction: row.direction,
        taxPointDate: row.date,
        settledDate: row.date,
        counterparty: row.counterparty,
        description: '',
        reference: row.reference,
        // Draft, always. Nothing imported is a record until a human says so.
        status: 'draft',
        source: 'import',
        sourceRef: `${batchId}:${row.index}`,
        importBatchId: batchId,
        lines: [
          {
            categoryId: row.categoryId,
            // Zero rated by default: a bank line does not know what VAT was on
            // it, and inventing VAT here would be inventing a box 1 figure.
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
    created += 1
  }

  await prisma.$executeRaw`
    UPDATE "bk_import_batches" SET "created_count" = ${created} WHERE "id" = ${batchId}
  `
  await appendAudit({
    action: 'import.created',
    entityType: 'import_batch',
    entityId: batchId,
    summary: `${created} entr${created === 1 ? 'y' : 'ies'} imported from ${input.filename} for review`,
    detail: { filename: input.filename, preset: input.preset, rows: input.rows.length },
    user,
  })

  return { batchId, created, skipped: input.rows.length - created }
}
