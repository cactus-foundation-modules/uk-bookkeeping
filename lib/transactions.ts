import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { assertDateNotInClosedPeriod, assertTransactionMutable } from './guards'
import { formatMoney, toMoney } from './money'
import type {
  BkAttachmentRow,
  BkTransactionLineRow,
  BkTransactionRow,
  Direction,
  EntryType,
  TransactionStatus,
  VatRateCode,
  VatTreatment,
} from './types'
import { VAT_RATE_CODES, VAT_TREATMENTS } from './types'

// Records. A transaction is a header - date, counterparty, direction - with one
// or more lines, and lines exist because a single receipt genuinely does split
// across categories and rates.

export type TransactionWithLines = BkTransactionRow & {
  lines: BkTransactionLineRow[]
  attachments: BkAttachmentRow[]
  category_names: Record<string, string>
}

export type LineInput = {
  categoryId: string
  description?: string
  vatTreatment: VatTreatment
  vatRateCode: VatRateCode
  vatRatePercent: string
  netAmount: string
  vatAmount: string
  grossAmount: string
  isCapital?: boolean
}

export type TransactionInput = {
  entryType?: EntryType
  direction: Direction
  taxPointDate: string
  settledDate?: string | null
  counterparty: string
  description?: string
  reference?: string | null
  status?: TransactionStatus
  source?: string
  sourceRef?: string | null
  importBatchId?: string | null
  correctsTransactionId?: string | null
  correctionReason?: string | null
  lines: LineInput[]
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function parseDate(value: string, field: string): Date {
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) {
    throw new BookkeepingError('invalid', `${field} is not a date we can read.`)
  }
  return parsed
}

/**
 * Line arithmetic, checked here as well as by the CHECK constraint, so the
 * refusal is a sentence rather than a constraint violation.
 *
 * Gross must equal net plus VAT exactly. It is exact because these are decimals
 * and not floats, which is the whole reason for NUMERIC(10,2).
 */
function validateLine(line: LineInput, index: number): void {
  if (!line.categoryId) {
    throw new BookkeepingError('invalid', `Line ${index + 1} needs a category.`)
  }
  if (!VAT_RATE_CODES.includes(line.vatRateCode)) {
    throw new BookkeepingError('invalid', `Line ${index + 1} has a VAT rate we do not recognise.`)
  }
  if (!VAT_TREATMENTS.includes(line.vatTreatment)) {
    throw new BookkeepingError('invalid', `Line ${index + 1} has a VAT treatment we do not recognise.`)
  }

  const net = toMoney(line.netAmount)
  const vat = toMoney(line.vatAmount)
  const gross = toMoney(line.grossAmount)
  if (!gross.equals(net.plus(vat))) {
    throw new BookkeepingError(
      'invalid',
      `Line ${index + 1} does not add up: ${formatMoney(net)} plus ${formatMoney(vat)} VAT is not ${formatMoney(gross)}.`,
    )
  }

  // Zero-rated, exempt and outside-scope lines carry no VAT. Letting one through
  // with VAT on it would put a figure in box 1 or box 4 that has no business
  // being there, and nothing downstream would ever question it.
  if (line.vatRateCode !== 'standard' && line.vatRateCode !== 'reduced' && !vat.isZero()) {
    throw new BookkeepingError(
      'invalid',
      `Line ${index + 1} is ${line.vatRateCode.replace('_', ' ')}, so it cannot carry VAT.`,
    )
  }
}

function validateInput(input: TransactionInput): void {
  if (!input.counterparty?.trim()) {
    throw new BookkeepingError('invalid', 'Who the money went to or came from is needed.')
  }
  if (!input.lines?.length) {
    throw new BookkeepingError('invalid', 'A transaction needs at least one line.')
  }
  if (input.entryType === 'adjustment' && !input.correctsTransactionId) {
    throw new BookkeepingError('invalid', 'A correction has to say which entry it puts right.')
  }
  if (input.entryType === 'adjustment' && !input.correctionReason?.trim()) {
    throw new BookkeepingError('invalid', 'A correction has to say why.')
  }
  if (input.entryType !== 'adjustment' && input.correctsTransactionId) {
    throw new BookkeepingError('invalid', 'Only a correction can point at another entry.')
  }
  input.lines.forEach(validateLine)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type TransactionFilter = {
  from?: string | null
  to?: string | null
  direction?: Direction | null
  categoryId?: string | null
  vatRateCode?: VatRateCode | null
  counterparty?: string | null
  status?: TransactionStatus | null
  locked?: boolean | null
  hasEvidence?: boolean | null
  limit?: number
  offset?: number
}

export type TransactionListRow = BkTransactionRow & {
  net_total: Prisma.Decimal
  vat_total: Prisma.Decimal
  gross_total: Prisma.Decimal
  line_count: number
  attachment_count: number
}

export type TransactionList = {
  rows: TransactionListRow[]
  total: number
  totals: { net: string; vat: string; gross: string }
}

/**
 * One statement for the page, one for the count, one for the running totals.
 * Never a query per row: PgBouncer wraps every statement in its own
 * BEGIN/DEALLOCATE ALL/COMMIT, so an N+1 here is four network round trips per
 * transaction on the screen.
 */
export async function listTransactions(filter: TransactionFilter): Promise<TransactionList> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)

  const from = filter.from ? parseDate(filter.from, 'The "from" date') : null
  const to = filter.to ? parseDate(filter.to, 'The "to" date') : null
  const counterparty = filter.counterparty?.trim() ? `%${filter.counterparty.trim().toLowerCase()}%` : null

  const where = Prisma.sql`
    WHERE (${from}::date IS NULL OR t."tax_point_date" >= ${from}::date)
      AND (${to}::date IS NULL OR t."tax_point_date" <= ${to}::date)
      AND (${filter.direction ?? null}::text IS NULL OR t."direction" = ${filter.direction ?? null})
      AND (${filter.status ?? null}::text IS NULL OR t."status" = ${filter.status ?? null})
      AND (${counterparty}::text IS NULL OR lower(t."counterparty") LIKE ${counterparty})
      AND (${filter.locked ?? null}::boolean IS NULL
           OR (${filter.locked ?? null}::boolean = TRUE AND t."locked_period_id" IS NOT NULL)
           OR (${filter.locked ?? null}::boolean = FALSE AND t."locked_period_id" IS NULL))
      AND (${filter.categoryId ?? null}::text IS NULL OR EXISTS (
            SELECT 1 FROM "bk_transaction_lines" l
            WHERE l."transaction_id" = t."id" AND l."category_id" = ${filter.categoryId ?? null}))
      AND (${filter.vatRateCode ?? null}::text IS NULL OR EXISTS (
            SELECT 1 FROM "bk_transaction_lines" l
            WHERE l."transaction_id" = t."id" AND l."vat_rate_code" = ${filter.vatRateCode ?? null}))
      AND (${filter.hasEvidence ?? null}::boolean IS NULL
           OR (${filter.hasEvidence ?? null}::boolean = TRUE AND EXISTS (
                 SELECT 1 FROM "bk_attachments" a WHERE a."transaction_id" = t."id"))
           OR (${filter.hasEvidence ?? null}::boolean = FALSE AND NOT EXISTS (
                 SELECT 1 FROM "bk_attachments" a WHERE a."transaction_id" = t."id")))
  `

  const rows = await prisma.$queryRaw<TransactionListRow[]>`
    SELECT t.*,
      COALESCE(l."net_total", 0)::numeric   AS net_total,
      COALESCE(l."vat_total", 0)::numeric   AS vat_total,
      COALESCE(l."gross_total", 0)::numeric AS gross_total,
      COALESCE(l."line_count", 0)::int      AS line_count,
      COALESCE(a."attachment_count", 0)::int AS attachment_count
    FROM "bk_transactions" t
    LEFT JOIN LATERAL (
      SELECT SUM("net_amount") AS net_total, SUM("vat_amount") AS vat_total,
             SUM("gross_amount") AS gross_total, COUNT(*) AS line_count
      FROM "bk_transaction_lines" WHERE "transaction_id" = t."id"
    ) l ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS attachment_count FROM "bk_attachments" WHERE "transaction_id" = t."id"
    ) a ON TRUE
    ${where}
    ORDER BY t."tax_point_date" DESC, t."created_at" DESC
    LIMIT ${limit} OFFSET ${offset}
  `

  const [counted] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_transactions" t ${where}
  `

  const [totals] = await prisma.$queryRaw<
    { net: Prisma.Decimal; vat: Prisma.Decimal; gross: Prisma.Decimal }[]
  >`
    SELECT COALESCE(SUM(l."net_amount"), 0)::numeric   AS net,
           COALESCE(SUM(l."vat_amount"), 0)::numeric   AS vat,
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross
    FROM "bk_transactions" t
    JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    ${where}
  `

  return {
    rows,
    total: Number(counted?.count ?? 0n),
    totals: {
      net: formatMoney(totals?.net ?? null),
      vat: formatMoney(totals?.vat ?? null),
      gross: formatMoney(totals?.gross ?? null),
    },
  }
}

export async function getTransaction(id: string): Promise<TransactionWithLines | null> {
  const rows = await prisma.$queryRaw<BkTransactionRow[]>`
    SELECT * FROM "bk_transactions" WHERE "id" = ${id} LIMIT 1
  `
  const transaction = rows[0]
  if (!transaction) return null

  const lines = await prisma.$queryRaw<BkTransactionLineRow[]>`
    SELECT * FROM "bk_transaction_lines" WHERE "transaction_id" = ${id}
    ORDER BY "position" ASC, "created_at" ASC
  `
  const attachments = await prisma.$queryRaw<BkAttachmentRow[]>`
    SELECT * FROM "bk_attachments" WHERE "transaction_id" = ${id}
    ORDER BY "position" ASC, "created_at" ASC
  `
  const categories = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT "id", "name" FROM "bk_categories"
  `

  return {
    ...transaction,
    lines,
    attachments,
    category_names: Object.fromEntries(categories.map((c) => [c.id, c.name])),
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createTransaction(
  input: TransactionInput,
  user: SessionUser | null,
): Promise<TransactionWithLines> {
  validateInput(input)

  const taxPoint = parseDate(input.taxPointDate, 'The invoice or receipt date')
  const settled = input.settledDate ? parseDate(input.settledDate, 'The date it was paid') : null

  // A draft is not a record yet - it is an imported row waiting for a human - so
  // it is allowed to sit anywhere while it is reviewed.
  const status = input.status ?? 'posted'
  if (status === 'posted' && input.entryType !== 'adjustment') {
    await assertDateNotInClosedPeriod(taxPoint)
  }

  if (input.correctsTransactionId) {
    const [target] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "bk_transactions" WHERE "id" = ${input.correctsTransactionId} LIMIT 1
    `
    if (!target) throw new NotFoundError('The entry this correction points at')
  }

  const id = await prisma.$transaction(async (tx) => {
    const [created] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "bk_transactions" (
        "entry_type", "direction", "tax_point_date", "settled_date", "counterparty",
        "description", "reference", "status", "source", "source_ref", "import_batch_id",
        "corrects_transaction_id", "correction_reason", "created_by_user_id", "updated_by_user_id"
      ) VALUES (
        ${input.entryType ?? 'normal'}, ${input.direction}, ${taxPoint}::date, ${settled}::date,
        ${input.counterparty.trim()}, ${input.description?.trim() ?? ''}, ${input.reference?.trim() || null},
        ${status}, ${input.source ?? 'manual'}, ${input.sourceRef ?? null}, ${input.importBatchId ?? null},
        ${input.correctsTransactionId ?? null}, ${input.correctionReason?.trim() ?? null},
        ${user?.id ?? null}, ${user?.id ?? null}
      )
      RETURNING "id"
    `
    const transactionId = created!.id
    await insertLines(tx, transactionId, input.lines)
    return transactionId
  })

  await appendAudit({
    action: 'transaction.created',
    entityType: 'transaction',
    entityId: id,
    summary: `${input.direction === 'income' ? 'Income' : 'Expense'} recorded for ${input.counterparty.trim()}`,
    detail: { after: input },
    user,
  })

  return (await getTransaction(id))!
}

type TxClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

async function insertLines(tx: TxClient, transactionId: string, lines: LineInput[]): Promise<void> {
  for (const [position, line] of lines.entries()) {
    await tx.$executeRaw`
      INSERT INTO "bk_transaction_lines" (
        "transaction_id", "position", "category_id", "description", "vat_treatment",
        "vat_rate_code", "vat_rate_percent", "net_amount", "vat_amount", "gross_amount", "is_capital"
      ) VALUES (
        ${transactionId}, ${position}, ${line.categoryId}, ${line.description?.trim() ?? ''},
        ${line.vatTreatment}, ${line.vatRateCode},
        ${formatMoney(line.vatRatePercent)}::numeric, ${formatMoney(line.netAmount)}::numeric,
        ${formatMoney(line.vatAmount)}::numeric, ${formatMoney(line.grossAmount)}::numeric,
        ${line.isCapital ?? false}
      )
    `
  }
}

export async function updateTransaction(
  id: string,
  input: TransactionInput,
  user: SessionUser | null,
): Promise<TransactionWithLines> {
  await assertTransactionMutable(id)
  validateInput(input)

  const before = await getTransaction(id)
  if (!before) throw new NotFoundError(`Transaction ${id}`)

  const taxPoint = parseDate(input.taxPointDate, 'The invoice or receipt date')
  const settled = input.settledDate ? parseDate(input.settledDate, 'The date it was paid') : null
  const status = input.status ?? before.status
  if (status === 'posted' && input.entryType !== 'adjustment') {
    await assertDateNotInClosedPeriod(taxPoint)
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "bk_transactions" SET
        "entry_type"        = ${input.entryType ?? before.entry_type},
        "direction"         = ${input.direction},
        "tax_point_date"    = ${taxPoint}::date,
        "settled_date"      = ${settled}::date,
        "counterparty"      = ${input.counterparty.trim()},
        "description"       = ${input.description?.trim() ?? ''},
        "reference"         = ${input.reference?.trim() || null},
        "status"            = ${status},
        "correction_reason" = ${input.correctionReason?.trim() ?? before.correction_reason},
        "updated_by_user_id"= ${user?.id ?? null},
        "updated_at"        = NOW()
      WHERE "id" = ${id}
    `
    // Lines are replaced wholesale rather than diffed. They have no identity a
    // human ever refers to, and a diff would be a great deal of code standing
    // between the owner and a corrected receipt.
    await tx.$executeRaw`DELETE FROM "bk_transaction_lines" WHERE "transaction_id" = ${id}`
    await insertLines(tx, id, input.lines)
  })

  await appendAudit({
    action: 'transaction.updated',
    entityType: 'transaction',
    entityId: id,
    summary: `Entry for ${input.counterparty.trim()} changed`,
    detail: {
      before: {
        direction: before.direction,
        taxPointDate: before.tax_point_date,
        counterparty: before.counterparty,
        lines: before.lines.map((l) => ({
          categoryId: l.category_id,
          net: formatMoney(l.net_amount),
          vat: formatMoney(l.vat_amount),
        })),
      },
      after: input,
    },
    user,
  })

  return (await getTransaction(id))!
}

export async function deleteTransaction(id: string, user: SessionUser | null): Promise<void> {
  await assertTransactionMutable(id)
  const before = await getTransaction(id)
  if (!before) throw new NotFoundError(`Transaction ${id}`)

  // Something else corrects this one, so it is part of the story of a filed
  // return even though it is not itself locked.
  const [corrector] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_transactions" WHERE "corrects_transaction_id" = ${id} LIMIT 1
  `
  if (corrector) {
    throw new BookkeepingError(
      'referenced',
      'A correction points at this entry, so it cannot be deleted. Delete the correction first.',
      409,
    )
  }

  await prisma.$executeRaw`DELETE FROM "bk_transactions" WHERE "id" = ${id}`

  await appendAudit({
    action: 'transaction.deleted',
    entityType: 'transaction',
    entityId: id,
    summary: `Entry for ${before.counterparty} deleted`,
    detail: {
      before: {
        direction: before.direction,
        taxPointDate: before.tax_point_date,
        counterparty: before.counterparty,
        reference: before.reference,
      },
    },
    user,
  })
}

/** Turn a reviewed import draft into a record. */
export async function postDraft(id: string, user: SessionUser | null): Promise<TransactionWithLines> {
  const transaction = await getTransaction(id)
  if (!transaction) throw new NotFoundError(`Transaction ${id}`)
  if (transaction.status !== 'draft') {
    throw new BookkeepingError('invalid', 'That entry has already been posted.')
  }
  await assertDateNotInClosedPeriod(transaction.tax_point_date)

  await prisma.$executeRaw`
    UPDATE "bk_transactions"
    SET "status" = 'posted', "updated_by_user_id" = ${user?.id ?? null}, "updated_at" = NOW()
    WHERE "id" = ${id}
  `
  await appendAudit({
    action: 'transaction.posted',
    entityType: 'transaction',
    entityId: id,
    summary: `Imported entry for ${transaction.counterparty} reviewed and posted`,
    user,
  })
  return (await getTransaction(id))!
}

/**
 * Counterparties this site has dealt with before, most used first. Used by the
 * form's suggestions and by the importer's category guess.
 */
export async function suggestCategoryForCounterparty(counterparty: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ category_id: string }[]>`
    SELECT l."category_id"
    FROM "bk_transactions" t
    JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE lower(t."counterparty") = ${counterparty.trim().toLowerCase()}
      AND t."status" = 'posted'
    GROUP BY l."category_id"
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `
  return rows[0]?.category_id ?? null
}
