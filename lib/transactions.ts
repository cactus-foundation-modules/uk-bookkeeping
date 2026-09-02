import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError } from './errors'
import { refreshBankTransactionStatuses } from './reconciliation'
import { removeAssetDraftsForTransaction, syncAssetDraftsForTransaction } from './fixed-assets'
import { assertDatesNotInClosedPeriod, assertTransactionMutable } from './guards'
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
  /**
   * "Put this line on the asset register." One asset per ticked LINE: a receipt
   * for a desk and a chair is two assets, so there is deliberately no such flag
   * on the entry as a whole. Separate from isCapital, which is the accounting
   * treatment and follows the category.
   */
  registerAsset?: boolean
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
  /**
   * "This one is never going to have a receipt." A top-up onto a balance held
   * with a supplier, a bank charge, a payment on account. Left alone by every
   * count of what is still missing evidence.
   */
  evidenceNotRequired?: boolean
  source?: string
  sourceRef?: string | null
  importBatchId?: string | null
  /** The account it was paid from or into, where that is known. */
  bankAccountId?: string | null
  statementId?: string | null
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
  // NUMERIC(10,2) holds eight digits before the point. Refuse beyond it here,
  // as a sentence naming the line, rather than letting Postgres overflow with a
  // raw numeric error mid-save.
  const LARGEST = new Prisma.Decimal('99999999.99')
  if (net.abs().greaterThan(LARGEST) || vat.abs().greaterThan(LARGEST) || gross.abs().greaterThan(LARGEST)) {
    throw new BookkeepingError(
      'invalid',
      `Line ${index + 1} is larger than these books can hold (amounts run to 99,999,999.99).`,
    )
  }
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
  /**
   * 'transfer' is not a direction on the row - it cannot be, see
   * migrations/020_transfers.sql - but it is one of the things somebody picks
   * from the same menu, so the filter carries it and the query below sorts out
   * what that means.
   */
  direction?: Direction | 'transfer' | null
  categoryId?: string | null
  vatRateCode?: VatRateCode | null
  counterparty?: string | null
  status?: TransactionStatus | null
  locked?: boolean | null
  hasEvidence?: boolean | null
  /** Only the ones marked as needing no receipt, or only the ones not marked. */
  evidenceNotRequired?: boolean | null
  limit?: number
  offset?: number
}

export type TransactionListRow = Omit<BkTransactionRow, 'direction'> & {
  /**
   * Null on a transfer, which is neither money in nor money out - it is the same
   * money, somewhere else. Anything rendering this has to say so rather than
   * falling back to "expense", which is what a default would quietly do.
   */
  direction: Direction | null
  net_total: Prisma.Decimal
  vat_total: Prisma.Decimal
  gross_total: Prisma.Decimal
  line_count: number
  attachment_count: number
  /**
   * Which of the two tables this row came out of. 'transfer' rows are journals
   * wearing an entry's clothes: they have a date, an amount and two accounts,
   * and none of the rest of it.
   */
  entry_kind: 'entry' | 'transfer'
  /** Set on a transfer row only, for the "Current → Savings" line on screen. */
  transfer_from_name: string | null
  transfer_to_name: string | null
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

  // A transfer is neither income nor an expense, so asking for one of those
  // rules them out; so does any filter that only an entry can answer - a
  // category, a VAT rate, whether a receipt is attached. What is left is the
  // plain view of "what happened", which is where they belong.
  const entryOnlyFilter =
    (filter.direction != null && filter.direction !== 'transfer') ||
    filter.categoryId != null ||
    filter.vatRateCode != null ||
    filter.hasEvidence != null ||
    filter.evidenceNotRequired != null
  const wantsTransfers = filter.direction === 'transfer' || !entryOnlyFilter
  const wantsEntries = filter.direction !== 'transfer'

  const where = Prisma.sql`
    WHERE (${from}::date IS NULL OR t."tax_point_date" >= ${from}::date)
      AND (${to}::date IS NULL OR t."tax_point_date" <= ${to}::date)
      AND (${filter.direction === 'transfer' ? null : (filter.direction ?? null)}::text IS NULL
           OR t."direction" = ${filter.direction === 'transfer' ? null : (filter.direction ?? null)})
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
      AND (${filter.evidenceNotRequired ?? null}::boolean IS NULL
           OR t."evidence_not_required" = ${filter.evidenceNotRequired ?? null}::boolean)
  `

  // Transfers live in bk_journals, so one page of "what happened" is two tables.
  // Paginating a merge in TypeScript would be wrong at every page boundary, and
  // union-ing the full rows would mean writing out every column of
  // bk_transactions by hand and quietly dropping the next one somebody adds.
  //
  // So the union carries identity and sort key only. It picks the page; the two
  // hydrating queries below fill it in, each in the shape its own table has.
  const paged = Prisma.sql`
    SELECT id, kind, sort_date, sort_created FROM (
      ${
        wantsEntries
          ? Prisma.sql`
        SELECT t."id" AS id, 'entry'::text AS kind,
               t."tax_point_date" AS sort_date, t."created_at" AS sort_created
        FROM "bk_transactions" t
        ${where}`
          : Prisma.sql`
        SELECT NULL::text AS id, NULL::text AS kind,
               NULL::date AS sort_date, NULL::timestamptz AS sort_created
        WHERE FALSE`
      }
      UNION ALL
      ${
        wantsTransfers
          ? Prisma.sql`
        SELECT j."id" AS id, 'transfer'::text AS kind,
               j."date" AS sort_date, j."created_at" AS sort_created
        FROM "bk_journals" j
        WHERE j."kind" = 'transfer'
          AND (${from}::date IS NULL OR j."date" >= ${from}::date)
          AND (${to}::date IS NULL OR j."date" <= ${to}::date)
          AND (${filter.status ?? null}::text IS NULL OR j."status" = ${filter.status ?? null})
          AND (${counterparty}::text IS NULL OR lower(j."narrative") LIKE ${counterparty})
          AND (${filter.locked ?? null}::boolean IS NULL
               OR (${filter.locked ?? null}::boolean = TRUE AND j."locked_period_id" IS NOT NULL)
               OR (${filter.locked ?? null}::boolean = FALSE AND j."locked_period_id" IS NULL))`
          : Prisma.sql`
        SELECT NULL::text AS id, NULL::text AS kind,
               NULL::date AS sort_date, NULL::timestamptz AS sort_created
        WHERE FALSE`
      }
    ) merged
  `

  const page = await prisma.$queryRaw<{ id: string; kind: 'entry' | 'transfer' }[]>`
    ${paged}
    ORDER BY sort_date DESC, sort_created DESC
    LIMIT ${limit} OFFSET ${offset}
  `

  const entryIds = page.filter((row) => row.kind === 'entry').map((row) => row.id)
  const transferIds = page.filter((row) => row.kind === 'transfer').map((row) => row.id)

  const entryRows = entryIds.length
    ? await prisma.$queryRaw<TransactionListRow[]>`
        SELECT t.*,
          COALESCE(l."net_total", 0)::numeric   AS net_total,
          COALESCE(l."vat_total", 0)::numeric   AS vat_total,
          COALESCE(l."gross_total", 0)::numeric AS gross_total,
          COALESCE(l."line_count", 0)::int      AS line_count,
          COALESCE(a."attachment_count", 0)::int AS attachment_count,
          'entry'::text AS entry_kind,
          NULL::text AS transfer_from_name,
          NULL::text AS transfer_to_name
        FROM "bk_transactions" t
        LEFT JOIN LATERAL (
          SELECT SUM("net_amount") AS net_total, SUM("vat_amount") AS vat_total,
                 SUM("gross_amount") AS gross_total, COUNT(*) AS line_count
          FROM "bk_transaction_lines" WHERE "transaction_id" = t."id"
        ) l ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS attachment_count FROM "bk_attachments" WHERE "transaction_id" = t."id"
        ) a ON TRUE
        WHERE t."id" = ANY(${entryIds}::text[])
      `
    : []

  // A transfer has no VAT and no category, so the money columns carry the amount
  // as gross and leave net and VAT at zero rather than inventing a split. It is
  // shown as "moved", not as a sale or a cost, and it is left out of the totals
  // below for the same reason.
  const transferRows = transferIds.length
    ? await prisma.$queryRaw<TransactionListRow[]>`
        SELECT j."id",
          'normal'::text  AS entry_type,
          NULL::text AS direction,
          j."date" AS tax_point_date,
          j."date" AS settled_date,
          j."narrative" AS counterparty,
          ''::text AS description,
          j."reference",
          j."status",
          TRUE AS evidence_not_required,
          j."source",
          NULL::text AS source_ref,
          NULL::text AS import_batch_id,
          j."from_bank_account_id" AS bank_account_id,
          NULL::text AS statement_id,
          NULL::text AS corrects_transaction_id,
          NULL::text AS correction_reason,
          j."finalised_period_id",
          j."locked_period_id",
          j."locked_at",
          j."created_by_user_id",
          j."updated_by_user_id",
          j."created_at",
          j."updated_at",
          0::numeric AS net_total,
          0::numeric AS vat_total,
          COALESCE(SUM(l."debit"), 0)::numeric AS gross_total,
          0::int AS line_count,
          0::int AS attachment_count,
          'transfer'::text AS entry_kind,
          f."name" AS transfer_from_name,
          b."name" AS transfer_to_name
        FROM "bk_journals" j
        JOIN "bk_journal_lines" l ON l."journal_id" = j."id"
        LEFT JOIN "bk_bank_accounts" f ON f."id" = j."from_bank_account_id"
        LEFT JOIN "bk_bank_accounts" b ON b."id" = j."to_bank_account_id"
        WHERE j."id" = ANY(${transferIds}::text[])
        GROUP BY j."id", f."name", b."name"
      `
    : []

  const hydrated = new Map<string, TransactionListRow>(
    [...entryRows, ...transferRows].map((row) => [row.id, row]),
  )
  // The page decided the order; the hydration only filled it in.
  const rows = page.map((row) => hydrated.get(row.id)).filter((row): row is TransactionListRow => !!row)

  const [counted] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (${paged}) counted
  `

  // Entries only. A transfer has no net and no VAT, and adding its amount to the
  // gross would say the business spent money it merely moved.
  const [totals] = wantsEntries
    ? await prisma.$queryRaw<
        { net: Prisma.Decimal; vat: Prisma.Decimal; gross: Prisma.Decimal }[]
      >`
        SELECT COALESCE(SUM(l."net_amount"), 0)::numeric   AS net,
               COALESCE(SUM(l."vat_amount"), 0)::numeric   AS vat,
               COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross
        FROM "bk_transactions" t
        JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
        ${where}
      `
    : []

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

/**
 * The account it was paid from, checked as a sentence.
 *
 * There is a foreign key behind this, so an id that is not an account of the
 * business fails either way - but it fails as a constraint violation and a 500,
 * and every other refusal in this module is a sentence somebody can act on.
 */
async function assertBankAccountUsable(id: string | null | undefined): Promise<void> {
  if (!id) return
  const [row] = await prisma.$queryRaw<{ name: string; archived: boolean }[]>`
    SELECT "name", "archived" FROM "bk_bank_accounts" WHERE "id" = ${id} LIMIT 1
  `
  if (!row) throw new BookkeepingError('invalid', 'The account it was paid from is not one of yours.')
  if (row.archived) {
    throw new BookkeepingError(
      'invalid',
      `"${row.name}" has been archived, so nothing new can be recorded against it.`,
    )
  }
}

export async function createTransaction(
  input: TransactionInput,
  user: SessionUser | null,
): Promise<TransactionWithLines> {
  validateInput(input)

  const taxPoint = parseDate(input.taxPointDate, 'The invoice or receipt date')
  const settled = input.settledDate ? parseDate(input.settledDate, 'The date it was paid') : null

  // A draft is not a record yet - it is an imported row waiting for a human - so
  // it is allowed to sit anywhere while it is reviewed.
  //
  // The guard covers adjustments too: a correction exists to land on the OPEN
  // return, and dating one inside a filed period would park its VAT in a period
  // that is never recomputed - the correction would silently never be filed.
  // Only an opening balance may sit in a closed period; it is outside the scope
  // of VAT and contributes to no box.
  const status = input.status ?? 'posted'
  if (status === 'posted' && (input.entryType ?? 'normal') !== 'opening_balance') {
    await assertDatesNotInClosedPeriod(taxPoint, settled)
  }

  if (input.correctsTransactionId) {
    const [target] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "bk_transactions" WHERE "id" = ${input.correctsTransactionId} LIMIT 1
    `
    if (!target) throw new NotFoundError('The entry this correction points at')
  }

  await assertBankAccountUsable(input.bankAccountId)

  const id = await prisma.$transaction(async (tx) => insertTransactionRows(tx, input, user))

  // Ticked lines raise their draft assets here rather than inside the write
  // above: an asset that fails to appear is a nag that never shows up, which is
  // bad, and a receipt that fails to save because of it is worse.
  await syncAssetDraftsForTransaction(id, user)

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

/**
 * The one-line summary a list, a report and a bank statement all want, worked
 * out from the lines when the caller did not hand one over.
 *
 * "What it was for" is asked per line, because that is the level it is true at.
 * But `bk_transactions.description` is what the transactions table, the CSV
 * export and the reconciliation screen print, and none of those has room for a
 * list. So the line texts are folded into one sentence here, distinct and in
 * order, and a caller that knows better (the importer, a publisher handing over
 * its own wording) still gets to say so by passing one.
 */
export function describeFromLines(lines: LineInput[]): string {
  const seen: string[] = []
  for (const line of lines) {
    const text = line.description?.trim()
    if (text && !seen.includes(text)) seen.push(text)
  }
  if (seen.length === 0) return ''
  // Three is what fits. Beyond that the entry is a shop order or a long receipt
  // and the count is more use than a truncated fourth item.
  if (seen.length <= 3) return seen.join(', ')
  return `${seen.slice(0, 3).join(', ')} and ${seen.length - 3} more`
}

/** The description to store: the caller's where it gave one, the lines' summary
 *  otherwise. Trimmed, because a description of spaces is not one. */
function resolveDescription(input: TransactionInput): string {
  return input.description?.trim() || describeFromLines(input.lines)
}

type TxClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

/**
 * The bare insert - header plus lines - on a transaction handle the CALLER
 * owns. Exists so the importer can put a whole batch inside one transaction
 * (createTransaction opens its own, and transactions do not nest) while both
 * paths share one INSERT and one set of validation.
 */
export async function insertTransactionRows(
  tx: TxClient,
  input: TransactionInput,
  user: SessionUser | null,
): Promise<string> {
  const taxPoint = parseDate(input.taxPointDate, 'The invoice or receipt date')
  const settled = input.settledDate ? parseDate(input.settledDate, 'The date it was paid') : null
  const [created] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "bk_transactions" (
      "entry_type", "direction", "tax_point_date", "settled_date", "counterparty",
      "description", "reference", "status", "evidence_not_required", "source", "source_ref", "import_batch_id",
      "bank_account_id", "statement_id",
      "corrects_transaction_id", "correction_reason", "created_by_user_id", "updated_by_user_id"
    ) VALUES (
      ${input.entryType ?? 'normal'}, ${input.direction}, ${taxPoint}::date, ${settled}::date,
      ${input.counterparty.trim()}, ${resolveDescription(input)}, ${input.reference?.trim() || null},
      ${input.status ?? 'posted'}, ${input.evidenceNotRequired ?? false},
      ${input.source ?? 'manual'}, ${input.sourceRef ?? null}, ${input.importBatchId ?? null},
      ${input.bankAccountId ?? null}, ${input.statementId ?? null},
      ${input.correctsTransactionId ?? null}, ${input.correctionReason?.trim() ?? null},
      ${user?.id ?? null}, ${user?.id ?? null}
    )
    RETURNING "id"
  `
  const transactionId = created!.id
  await insertLines(tx, transactionId, input.lines)
  return transactionId
}

async function insertLines(tx: TxClient, transactionId: string, lines: LineInput[]): Promise<void> {
  for (const [position, line] of lines.entries()) {
    await tx.$executeRaw`
      INSERT INTO "bk_transaction_lines" (
        "transaction_id", "position", "category_id", "description", "vat_treatment",
        "vat_rate_code", "vat_rate_percent", "net_amount", "vat_amount", "gross_amount", "is_capital",
        "register_asset"
      ) VALUES (
        ${transactionId}, ${position}, ${line.categoryId}, ${line.description?.trim() ?? ''},
        ${line.vatTreatment}, ${line.vatRateCode},
        ${formatMoney(line.vatRatePercent)}::numeric, ${formatMoney(line.netAmount)}::numeric,
        ${formatMoney(line.vatAmount)}::numeric, ${formatMoney(line.grossAmount)}::numeric,
        ${line.isCapital ?? false},
        ${line.registerAsset ?? false}
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
  const entryType = input.entryType ?? before.entry_type
  if (status === 'posted' && entryType !== 'opening_balance') {
    await assertDatesNotInClosedPeriod(taxPoint, settled)
  }

  // The CHECK constraint ties entry_type and corrects_transaction_id together:
  // an adjustment must point at something, anything else must not. Writing one
  // without the other turned a legitimate type change into a raw constraint 500.
  const correctsId =
    entryType === 'adjustment'
      ? (input.correctsTransactionId ?? before.corrects_transaction_id)
      : null
  if (entryType === 'adjustment' && !correctsId) {
    throw new BookkeepingError('invalid', 'A correction has to say which entry it puts right.')
  }
  if (input.bankAccountId !== undefined && input.bankAccountId !== before.bank_account_id) {
    await assertBankAccountUsable(input.bankAccountId)
  }

  if (correctsId && correctsId !== before.corrects_transaction_id) {
    const [target] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "bk_transactions" WHERE "id" = ${correctsId} LIMIT 1
    `
    if (!target) throw new NotFoundError('The entry this correction points at')
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "bk_transactions" SET
        "entry_type"        = ${entryType},
        "direction"         = ${input.direction},
        "tax_point_date"    = ${taxPoint}::date,
        "settled_date"      = ${settled}::date,
        "counterparty"      = ${input.counterparty.trim()},
        -- Undefined means "leave it alone", not "clear it". An entry raised
        -- from a bank line carries the account it was reconciled against, and
        -- a caller that does not send the field must not quietly move it to
        -- the main current account. Same trap the lines had with is_capital.
        "bank_account_id"   = ${
          input.bankAccountId === undefined ? before.bank_account_id : input.bankAccountId
        },
        "description"       = ${resolveDescription(input)},
        "reference"         = ${input.reference?.trim() || null},
        "status"            = ${status},
        -- Undefined keeps what is there, for the same reason bank_account_id
        -- does: a caller that does not send the field must not untick it.
        "evidence_not_required" = ${
          input.evidenceNotRequired === undefined
            ? before.evidence_not_required
            : input.evidenceNotRequired
        },
        "corrects_transaction_id" = ${correctsId},
        "correction_reason" = ${entryType === 'adjustment' ? (input.correctionReason?.trim() ?? before.correction_reason) : null},
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

  // Lines were replaced wholesale, so the ticks may have moved. Anything newly
  // ticked raises a draft; anything unticked loses its draft, but never an
  // asset that has already been finished off - that is a register entry now,
  // and correcting the receipt it came from is not grounds for deleting it.
  await syncAssetDraftsForTransaction(id, user)

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

  // The foreign key sets transaction_id to NULL, which is right for a finished
  // asset and useless for a draft: without its purchase a draft has nothing to
  // say where it came from.
  await removeAssetDraftsForTransaction(id)

  // Which statement lines this entry was explaining, read BEFORE it goes: the
  // reconciliations cascade with it, and after the delete there is nothing left
  // to say which lines are now short of an explanation.
  const matched = await prisma.$queryRaw<{ bank_transaction_id: string }[]>`
    SELECT DISTINCT "bank_transaction_id" FROM "bk_reconciliations" WHERE "transaction_id" = ${id}
  `

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM "bk_transactions" WHERE "id" = ${id}`
    // The cascade takes the matches; nothing took the CONSEQUENCE of the
    // matches. A line left stamped 'reconciled' with nothing explaining it
    // disappears off the reconciliation screen entirely - ticked off by an
    // entry that no longer exists, and no way back to it but setting it aside
    // and bringing it back.
    await refreshBankTransactionStatuses(
      tx,
      matched.map((row) => row.bank_transaction_id),
    )
  })

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
  if (transaction.entry_type !== 'opening_balance') {
    await assertDatesNotInClosedPeriod(transaction.tax_point_date, transaction.settled_date)
  }

  await prisma.$executeRaw`
    UPDATE "bk_transactions"
    SET "status" = 'posted', "updated_by_user_id" = ${user?.id ?? null}, "updated_at" = NOW()
    WHERE "id" = ${id}
  `
  // Now it is a record, its ticked lines can raise their assets. Not before:
  // an import waiting for review is not something anybody has agreed happened.
  await syncAssetDraftsForTransaction(id, user)

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
 * Post or bin a batch of import drafts in one action, so reviewing forty bank
 * lines is not forty separate clicks. Per-row outcomes, not all-or-nothing: one
 * draft whose date has since landed in a closed period should not strand the
 * other thirty-nine.
 */
export type BulkOutcome = { done: number; failed: { id: string; error: string }[] }

export async function bulkPostDrafts(ids: string[], user: SessionUser | null): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { done: 0, failed: [] }
  for (const id of ids) {
    try {
      await postDraft(id, user)
      outcome.done += 1
    } catch (error) {
      outcome.failed.push({
        id,
        error: error instanceof Error ? error.message : 'Could not be posted.',
      })
    }
  }
  return outcome
}

export async function bulkDeleteDrafts(ids: string[], user: SessionUser | null): Promise<BulkOutcome> {
  const outcome: BulkOutcome = { done: 0, failed: [] }
  for (const id of ids) {
    try {
      const [row] = await prisma.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "bk_transactions" WHERE "id" = ${id} LIMIT 1
      `
      // Bulk delete is a review tool for imported drafts and nothing else - a
      // posted record wants deleting one at a time, with its own confirm.
      if (!row || row.status !== 'draft') {
        outcome.failed.push({ id, error: 'Only entries still waiting for review can be removed in bulk.' })
        continue
      }
      await deleteTransaction(id, user)
      outcome.done += 1
    } catch (error) {
      outcome.failed.push({
        id,
        error: error instanceof Error ? error.message : 'Could not be removed.',
      })
    }
  }
  return outcome
}

/** Counterparties this site has dealt with before, most used first. Feeds the form's suggestions. */
export async function listKnownCounterparties(limit = 200): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ counterparty: string }[]>`
    SELECT MIN(t."counterparty") AS counterparty
    FROM "bk_transactions" t
    WHERE t."status" = 'posted'
    GROUP BY lower(t."counterparty")
    ORDER BY COUNT(*) DESC, MIN(t."counterparty") ASC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `
  return rows.map((r) => r.counterparty)
}

/** What this counterparty was filed under last time, for one name. */
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

/**
 * The same guess for a whole screenful of names, in one query.
 *
 * The reconciliation screen pre-picks a category on every statement line it
 * shows, and asking per name would be a hundred round trips through PgBouncer
 * for one page. DISTINCT ON takes the most-used category per name in a single
 * pass instead. Keyed by the lower-cased name, because that is what the counting
 * groups on.
 */
export async function suggestCategoriesForCounterparties(
  counterparties: string[],
): Promise<Map<string, string>> {
  const names = [...new Set(counterparties.map((name) => name.trim().toLowerCase()).filter(Boolean))]
  if (names.length === 0) return new Map()

  const rows = await prisma.$queryRaw<{ name: string; category_id: string }[]>`
    SELECT DISTINCT ON (name) name, "category_id"
    FROM (
      SELECT lower(t."counterparty") AS name, l."category_id", COUNT(*) AS uses
      FROM "bk_transactions" t
      JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
      WHERE lower(t."counterparty") = ANY(${names}::text[])
        AND t."status" = 'posted'
      GROUP BY lower(t."counterparty"), l."category_id"
    ) counted
    ORDER BY name, uses DESC, "category_id"
  `
  return new Map(rows.map((row) => [row.name, row.category_id]))
}
