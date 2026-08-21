import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'
import { appendAudit } from './audit'
import { BookkeepingError, LockedRecordError, NotFoundError } from './errors'
import { formatMoney, formatPounds, toMoney } from './money'
import type { BkAccountRow, BkJournalLineRow, BkJournalRow, JournalStatus, Money } from './types'

// Journals: the entries that are not money moving.
//
// Depreciation, a year-end accrual, a prepayment, moving something posted to the
// wrong account, a director putting money in or taking it out other than through
// the bank. None of these is a receipt and none of them has VAT on it, which is
// exactly why they are here and not in the cashbook.
//
// The two rules, both enforced in the database as well as here:
//   - a posted journal balances, to the penny
//   - a journal reaches no VAT box, ever
//
// The second one is not a limitation waiting to be lifted. "No VAT box figure is
// ever typed by a human" is the guarantee this whole module exists to make, and
// a journal that could reach box 1 would be precisely such a figure.

type TxClient = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>

export type JournalLineInput = {
  accountId: string
  description?: string
  debit?: string | null
  credit?: string | null
}

export type JournalInput = {
  date: string
  reference?: string | null
  narrative: string
  status?: JournalStatus
  source?: string
  lines: JournalLineInput[]
}

export type JournalWithLines = BkJournalRow & {
  lines: BkJournalLineRow[]
  account_names: Record<string, string>
  total_debits: string
  total_credits: string
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

const LARGEST = new Prisma.Decimal('99999999.99')

type CheckedLine = { accountId: string; description: string; debit: Money; credit: Money }

function checkLines(lines: JournalLineInput[], posted: boolean): CheckedLine[] {
  if (!lines?.length) {
    throw new BookkeepingError('invalid', 'A journal needs at least two lines - one on each side.')
  }

  const checked: CheckedLine[] = []
  for (const [index, line] of lines.entries()) {
    const where = `Line ${index + 1}`
    if (!line.accountId) throw new BookkeepingError('invalid', `${where} needs an account.`)

    const debit = toMoney(line.debit ?? '0.00')
    const credit = toMoney(line.credit ?? '0.00')

    if (debit.isNegative() || credit.isNegative()) {
      throw new BookkeepingError(
        'invalid',
        `${where} has a negative amount on it. Put it on the other side instead - that is what the other side is for.`,
      )
    }
    if (!debit.isZero() && !credit.isZero()) {
      throw new BookkeepingError('invalid', `${where} has an amount on both sides. It belongs on one or the other.`)
    }
    if (debit.isZero() && credit.isZero()) {
      throw new BookkeepingError('invalid', `${where} has no amount on it.`)
    }
    if (debit.greaterThan(LARGEST) || credit.greaterThan(LARGEST)) {
      throw new BookkeepingError('invalid', `${where} is larger than these books can hold (amounts run to 99,999,999.99).`)
    }

    checked.push({
      accountId: line.accountId,
      description: line.description?.trim() ?? '',
      debit,
      credit,
    })
  }

  if (posted) {
    const debits = checked.reduce<Money>((total, line) => total.plus(line.debit), toMoney('0.00'))
    const credits = checked.reduce<Money>((total, line) => total.plus(line.credit), toMoney('0.00'))
    if (!debits.equals(credits)) {
      const difference = debits.minus(credits).abs()
      throw new BookkeepingError(
        'unbalanced',
        `This journal does not balance. The debits come to ${formatPounds(debits)} and the credits to ${formatPounds(credits)}, which is ${formatPounds(difference)} out.`,
      )
    }
    if (debits.isZero()) {
      throw new BookkeepingError('invalid', 'This journal is for nothing at all.')
    }
  }

  return checked
}

async function checkAccountsExist(accountIds: string[]): Promise<void> {
  const unique = [...new Set(accountIds)]
  const rows = await prisma.$queryRaw<{ id: string; archived: boolean; name: string }[]>`
    SELECT "id", "archived", "name" FROM "bk_accounts" WHERE "id" = ANY(${unique}::text[])
  `
  const found = new Map(rows.map((row) => [row.id, row]))
  for (const id of unique) {
    const account = found.get(id)
    if (!account) throw new BookkeepingError('invalid', 'One of the lines points at an account that does not exist.')
    if (account.archived) {
      throw new BookkeepingError('invalid', `"${account.name}" has been archived, so nothing new can be posted to it.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type JournalFilter = {
  from?: string | null
  to?: string | null
  status?: JournalStatus | null
  accountId?: string | null
  search?: string | null
  limit?: number
  offset?: number
}

export type JournalListRow = BkJournalRow & {
  total_debits: Money
  line_count: number
  accounts: string
}

export async function listJournals(filter: JournalFilter): Promise<{ rows: JournalListRow[]; total: number }> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)
  const from = filter.from ? parseDate(filter.from, 'The "from" date') : null
  const to = filter.to ? parseDate(filter.to, 'The "to" date') : null
  const search = filter.search?.trim() ? `%${filter.search.trim().toLowerCase()}%` : null

  const where = Prisma.sql`
    WHERE (${from}::date IS NULL OR j."date" >= ${from}::date)
      AND (${to}::date IS NULL OR j."date" <= ${to}::date)
      AND (${filter.status ?? null}::text IS NULL OR j."status" = ${filter.status ?? null})
      AND (${search}::text IS NULL
           OR lower(j."narrative") LIKE ${search}
           OR lower(COALESCE(j."reference", '')) LIKE ${search})
      AND (${filter.accountId ?? null}::text IS NULL OR EXISTS (
            SELECT 1 FROM "bk_journal_lines" l
            WHERE l."journal_id" = j."id" AND l."account_id" = ${filter.accountId ?? null}))
  `

  const rows = await prisma.$queryRaw<JournalListRow[]>`
    SELECT j.*,
      COALESCE(l."total_debits", 0)::numeric AS total_debits,
      COALESCE(l."line_count", 0)::int       AS line_count,
      COALESCE(l."accounts", '')             AS accounts
    FROM "bk_journals" j
    LEFT JOIN LATERAL (
      SELECT SUM(jl."debit") AS total_debits, COUNT(*) AS line_count,
             string_agg(DISTINCT a."name", ', ' ORDER BY a."name") AS accounts
      FROM "bk_journal_lines" jl
      JOIN "bk_accounts" a ON a."id" = jl."account_id"
      WHERE jl."journal_id" = j."id"
    ) l ON TRUE
    ${where}
    ORDER BY j."date" DESC, j."created_at" DESC
    LIMIT ${limit} OFFSET ${offset}
  `

  const [counted] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM "bk_journals" j ${where}
  `

  return { rows, total: Number(counted?.count ?? 0n) }
}

export async function getJournal(id: string): Promise<JournalWithLines | null> {
  const rows = await prisma.$queryRaw<BkJournalRow[]>`
    SELECT * FROM "bk_journals" WHERE "id" = ${id} LIMIT 1
  `
  const journal = rows[0]
  if (!journal) return null

  const lines = await prisma.$queryRaw<BkJournalLineRow[]>`
    SELECT * FROM "bk_journal_lines" WHERE "journal_id" = ${id}
    ORDER BY "position" ASC, "created_at" ASC
  `
  const accounts = await prisma.$queryRaw<Pick<BkAccountRow, 'id' | 'name'>[]>`
    SELECT "id", "name" FROM "bk_accounts"
  `

  const debits = lines.reduce<Money>((total, line) => total.plus(toMoney(line.debit)), toMoney('0.00'))
  const credits = lines.reduce<Money>((total, line) => total.plus(toMoney(line.credit)), toMoney('0.00'))

  return {
    ...journal,
    lines,
    account_names: Object.fromEntries(accounts.map((a) => [a.id, a.name])),
    total_debits: formatMoney(debits),
    total_credits: formatMoney(credits),
  }
}

export async function requireJournal(id: string): Promise<JournalWithLines> {
  const journal = await getJournal(id)
  if (!journal) throw new NotFoundError(`Journal ${id}`)
  return journal
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function assertJournalMutable(id: string): Promise<BkJournalRow> {
  const rows = await prisma.$queryRaw<BkJournalRow[]>`
    SELECT * FROM "bk_journals" WHERE "id" = ${id} LIMIT 1
  `
  const journal = rows[0]
  if (!journal) throw new NotFoundError(`Journal ${id}`)
  if (journal.locked_period_id) throw new LockedRecordError(id, journal.locked_period_id)
  if (journal.reversed_by_journal_id) {
    throw new BookkeepingError(
      'reversed',
      'That journal has already been reversed, so changing it now would leave the reversal describing something that never happened. Reverse the reversal instead, or post a fresh journal.',
      409,
    )
  }
  return journal
}

async function insertLines(tx: TxClient, journalId: string, lines: CheckedLine[]): Promise<void> {
  if (lines.length === 0) return
  await tx.$executeRaw`
    INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "description", "debit", "credit")
    SELECT ${journalId}, d."position"::int, d."account_id", d."description",
           d."debit"::numeric, d."credit"::numeric
    FROM UNNEST(
      ${lines.map((_, index) => String(index))}::text[],
      ${lines.map((line) => line.accountId)}::text[],
      ${lines.map((line) => line.description)}::text[],
      ${lines.map((line) => formatMoney(line.debit))}::text[],
      ${lines.map((line) => formatMoney(line.credit))}::text[]
    ) AS d("position", "account_id", "description", "debit", "credit")
  `
}

export async function createJournal(input: JournalInput, user: SessionUser | null): Promise<JournalWithLines> {
  const status = input.status ?? 'posted'
  if (!input.narrative?.trim()) {
    throw new BookkeepingError(
      'invalid',
      'A journal needs a note saying what it is for. In a year nobody will remember, and this is the only thing that will tell them.',
    )
  }
  const lines = checkLines(input.lines, status === 'posted')
  await checkAccountsExist(lines.map((line) => line.accountId))
  const date = parseDate(input.date, 'The journal date')

  const id = await prisma.$transaction(async (tx) => {
    const [created] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "bk_journals"
        ("date", "reference", "narrative", "status", "source", "created_by_user_id", "updated_by_user_id")
      VALUES (
        ${date}::date, ${input.reference?.trim() || null}, ${input.narrative.trim()},
        ${status}, ${input.source ?? 'manual'}, ${user?.id ?? null}, ${user?.id ?? null}
      )
      RETURNING "id"
    `
    await insertLines(tx, created!.id, lines)
    return created!.id
  })

  await appendAudit({
    action: 'journal.created',
    entityType: 'journal',
    entityId: id,
    summary: `Journal posted: ${input.narrative.trim()}`,
    detail: { after: input },
    user,
  })

  return requireJournal(id)
}

export async function updateJournal(
  id: string,
  input: JournalInput,
  user: SessionUser | null,
): Promise<JournalWithLines> {
  await assertJournalMutable(id)
  const before = await requireJournal(id)
  const status = input.status ?? before.status
  const lines = checkLines(input.lines, status === 'posted')
  await checkAccountsExist(lines.map((line) => line.accountId))
  const date = parseDate(input.date, 'The journal date')

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "bk_journals" SET
        "date"      = ${date}::date,
        "reference" = ${input.reference?.trim() || null},
        "narrative" = ${input.narrative.trim()},
        "status"    = ${status},
        "updated_by_user_id" = ${user?.id ?? null},
        "updated_at" = NOW()
      WHERE "id" = ${id}
    `
    // Lines are replaced wholesale rather than diffed, the same as a
    // transaction's are. They have no identity anybody refers to, and the
    // balance check is deferred to COMMIT, so the half-second where the journal
    // has no lines at all is invisible and harmless.
    await tx.$executeRaw`DELETE FROM "bk_journal_lines" WHERE "journal_id" = ${id}`
    await insertLines(tx, id, lines)
  })

  await appendAudit({
    action: 'journal.updated',
    entityType: 'journal',
    entityId: id,
    summary: `Journal changed: ${input.narrative.trim()}`,
    detail: {
      before: {
        date: before.date,
        narrative: before.narrative,
        lines: before.lines.map((line) => ({
          accountId: line.account_id,
          debit: formatMoney(line.debit),
          credit: formatMoney(line.credit),
        })),
      },
      after: input,
    },
    user,
  })

  return requireJournal(id)
}

export async function deleteJournal(id: string, user: SessionUser | null): Promise<void> {
  const journal = await assertJournalMutable(id)
  const before = await requireJournal(id)

  const [reversal] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_journals" WHERE "reverses_journal_id" = ${id} LIMIT 1
  `
  if (reversal) {
    throw new BookkeepingError(
      'referenced',
      'Another journal reverses this one, so it cannot be deleted. Delete the reversal first.',
      409,
    )
  }

  await prisma.$executeRaw`DELETE FROM "bk_journals" WHERE "id" = ${id}`

  await appendAudit({
    action: 'journal.deleted',
    entityType: 'journal',
    entityId: id,
    summary: `Journal deleted: ${journal.narrative}`,
    detail: {
      before: {
        date: before.date,
        narrative: before.narrative,
        total: before.total_debits,
      },
    },
    user,
  })
}

export async function postJournal(id: string, user: SessionUser | null): Promise<JournalWithLines> {
  const journal = await requireJournal(id)
  if (journal.status === 'posted') {
    throw new BookkeepingError('invalid', 'That journal has already been posted.')
  }
  // Checked here so the refusal is a sentence naming the difference rather than
  // the trigger's version, which is correct but written for a developer.
  checkLines(
    journal.lines.map((line) => ({
      accountId: line.account_id,
      description: line.description,
      debit: formatMoney(line.debit),
      credit: formatMoney(line.credit),
    })),
    true,
  )

  await prisma.$executeRaw`
    UPDATE "bk_journals"
    SET "status" = 'posted', "updated_by_user_id" = ${user?.id ?? null}, "updated_at" = NOW()
    WHERE "id" = ${id}
  `
  await appendAudit({
    action: 'journal.posted',
    entityType: 'journal',
    entityId: id,
    summary: `Journal posted: ${journal.narrative}`,
    user,
  })
  return requireJournal(id)
}

/**
 * Reverse a journal: the same lines, the other way round, on a date you choose.
 *
 * This is how an accrual is taken back out on the first day of the next year,
 * and it is also the only way to undo a journal that can no longer be edited.
 * The original stays exactly as it was, which is the point - the books show what
 * was posted and what was then taken back, rather than quietly showing neither.
 */
export async function reverseJournal(
  id: string,
  date: string,
  user: SessionUser | null,
): Promise<JournalWithLines> {
  const original = await requireJournal(id)
  if (original.status !== 'posted') {
    throw new BookkeepingError('invalid', 'Only a posted journal needs reversing. Edit this one instead.')
  }
  if (original.reversed_by_journal_id) {
    throw new BookkeepingError('invalid', 'That journal has already been reversed.')
  }

  const reversalDate = parseDate(date, 'The reversal date')
  const lines: CheckedLine[] = original.lines.map((line) => ({
    accountId: line.account_id,
    description: line.description,
    debit: toMoney(line.credit),
    credit: toMoney(line.debit),
  }))

  const reversalId = await prisma.$transaction(async (tx) => {
    const [created] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "bk_journals"
        ("date", "reference", "narrative", "status", "source", "reverses_journal_id",
         "created_by_user_id", "updated_by_user_id")
      VALUES (
        ${reversalDate}::date, ${original.reference},
        ${`Reversal of: ${original.narrative}`}, 'posted', ${original.source}, ${id},
        ${user?.id ?? null}, ${user?.id ?? null}
      )
      RETURNING "id"
    `
    await insertLines(tx, created!.id, lines)
    await tx.$executeRaw`
      UPDATE "bk_journals" SET "reversed_by_journal_id" = ${created!.id}, "updated_at" = NOW()
      WHERE "id" = ${id}
    `
    return created!.id
  })

  await appendAudit({
    action: 'journal.reversed',
    entityType: 'journal',
    entityId: id,
    summary: `Journal reversed: ${original.narrative}`,
    detail: { reversalId, date: reversalDate.toISOString().slice(0, 10) },
    user,
  })

  return requireJournal(reversalId)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * The handful of journals a small limited company actually posts, as starting
 * points rather than as automation. Each one fills in the narrative and picks
 * the two accounts; the amounts and the date stay for a human, because those are
 * the parts that need thinking about.
 */
export type JournalTemplate = {
  id: string
  label: string
  description: string
  narrative: string
  /** Account codes, resolved to ids when the template is offered. */
  debitCode: string
  creditCode: string
  /** Whether this one usually wants reversing on the first day of the next year. */
  reversing: boolean
}

export const JOURNAL_TEMPLATES: JournalTemplate[] = [
  {
    id: 'depreciation',
    label: 'Depreciation for the year',
    description: 'Writes down equipment over its useful life. Nothing moves in the bank.',
    narrative: 'Depreciation for the year',
    debitCode: 'pl-depreciation',
    creditCode: 'accumulated-depreciation',
    reversing: false,
  },
  {
    id: 'accrual',
    label: 'Accrual - a cost incurred but not yet billed',
    description: 'Puts a cost in the year it belongs to when the invoice has not turned up yet.',
    narrative: 'Accrual at the year end',
    debitCode: 'pl-other-expenses',
    creditCode: 'accruals',
    reversing: true,
  },
  {
    id: 'prepayment',
    label: 'Prepayment - a cost paid in advance',
    description: 'Takes the part of a bill that belongs to next year back out of this one.',
    narrative: 'Prepayment at the year end',
    debitCode: 'prepayments',
    creditCode: 'pl-other-expenses',
    reversing: true,
  },
  {
    id: 'director-loan-in',
    label: 'Money the director put in, other than through the bank',
    description: 'A cost paid personally on the company’s behalf. The company now owes it back.',
    narrative: 'Paid personally by the director',
    debitCode: 'pl-other-expenses',
    creditCode: 'directors-loan',
    reversing: false,
  },
  {
    id: 'director-loan-out',
    label: 'Money the director took out, other than through the bank',
    description: 'Increases what the director owes the company. Watch the year-end position.',
    narrative: 'Taken by the director',
    debitCode: 'directors-loan',
    creditCode: 'bank-current',
    reversing: false,
  },
  {
    id: 'salary',
    label: 'Payroll for the month',
    description: 'The gross cost split between what is paid out and what is owed to HMRC.',
    narrative: 'Payroll',
    debitCode: 'pl-wages',
    creditCode: 'paye-control',
    reversing: false,
  },
  {
    id: 'correction',
    label: 'Move something posted to the wrong account',
    description: 'Takes it off one account and puts it on another. Nothing moves in the bank.',
    narrative: 'Correction',
    debitCode: 'suspense',
    creditCode: 'suspense',
    reversing: false,
  },
]

export type ResolvedTemplate = JournalTemplate & {
  debitAccountId: string | null
  creditAccountId: string | null
}

export async function listTemplates(): Promise<ResolvedTemplate[]> {
  const codes = [...new Set(JOURNAL_TEMPLATES.flatMap((t) => [t.debitCode, t.creditCode]))]
  const rows = await prisma.$queryRaw<{ id: string; code: string }[]>`
    SELECT "id", "code" FROM "bk_accounts" WHERE "code" = ANY(${codes}::text[])
  `
  const byCode = new Map(rows.map((row) => [row.code, row.id]))
  return JOURNAL_TEMPLATES.map((template) => ({
    ...template,
    debitAccountId: byCode.get(template.debitCode) ?? null,
    creditAccountId: byCode.get(template.creditCode) ?? null,
  }))
}
