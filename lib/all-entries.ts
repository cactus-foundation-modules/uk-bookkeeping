import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMoney, toMoney } from './money'

// Every entry on the books in one list, for the audit.
//
// The other reports answer a question (what was the profit, who owes us). This
// one answers the auditor's question: show me everything, and tell me what you
// filed each thing under. One row per cashbook line - not per entry, because an
// entry split across two categories has two answers - plus one row per journal
// line, so adjustments, depreciation and year-end journals are in the same list
// rather than a separate hunt.
//
// Drafts are included and labelled. An audit that hides what has not been
// posted yet hides exactly the entries somebody forgot about.

export type AllEntriesRow = {
  date: string
  settledDate: string | null
  kind: 'Money in' | 'Money out' | 'Journal'
  entryType: string
  counterparty: string
  description: string
  reference: string | null
  categoryCode: string | null
  categoryName: string | null
  ledgerAccount: string | null
  vatTreatment: string | null
  vatRate: string | null
  net: string
  vat: string
  gross: string
  debit: string | null
  credit: string | null
  status: string
  paidFrom: string | null
  source: string
  entryId: string
}

export type AllEntries = {
  from: string
  to: string
  rows: AllEntriesRow[]
  totals: { net: string; vat: string; gross: string }
  /** Set when the list was cut short; the CSV is never cut. */
  truncated: boolean
}

type RawRow = {
  date: Date
  settled_date: Date | null
  kind: string
  entry_type: string
  counterparty: string
  description: string
  reference: string | null
  category_code: string | null
  category_name: string | null
  ledger_account: string | null
  vat_treatment: string | null
  vat_rate: Prisma.Decimal | null
  net: Prisma.Decimal | null
  vat: Prisma.Decimal | null
  gross: Prisma.Decimal | null
  debit: Prisma.Decimal | null
  credit: Prisma.Decimal | null
  status: string
  paid_from: string | null
  source: string
  entry_id: string
}

const day = (value: Date) => value.toISOString().slice(0, 10)

export async function allEntries(
  from: Date,
  to: Date,
  options: { limit?: number } = {},
): Promise<AllEntries> {
  const limit = options.limit ?? null
  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT * FROM (
      SELECT t."tax_point_date" AS date, t."settled_date",
             CASE WHEN t."direction" = 'income' THEN 'Money in' ELSE 'Money out' END AS kind,
             t."entry_type", t."counterparty",
             COALESCE(NULLIF(l."description", ''), t."description") AS description,
             t."reference", c."code" AS category_code, c."name" AS category_name,
             (SELECT a."name" FROM "bk_accounts" a WHERE a."category_id" = c."id"
               ORDER BY a."is_system" DESC, a."position" ASC, a."id" ASC LIMIT 1) AS ledger_account,
             l."vat_treatment", l."vat_rate_percent" AS vat_rate,
             l."net_amount" AS net, l."vat_amount" AS vat, l."gross_amount" AS gross,
             NULL::numeric AS debit, NULL::numeric AS credit,
             t."status", b."name" AS paid_from, t."source", t."id" AS entry_id,
             l."position" AS sort_pos
      FROM "bk_transactions" t
      JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
      JOIN "bk_categories" c ON c."id" = l."category_id"
      LEFT JOIN "bk_bank_accounts" b ON b."id" = t."bank_account_id"
      WHERE t."tax_point_date" >= ${from}::date AND t."tax_point_date" <= ${to}::date
      UNION ALL
      SELECT j."date", NULL::date, 'Journal', j."kind", j."narrative",
             COALESCE(NULLIF(jl."description", ''), j."narrative"),
             j."reference", NULL, NULL, a."code" || ' ' || a."name",
             NULL, NULL, NULL::numeric, NULL::numeric, NULL::numeric,
             jl."debit", jl."credit", j."status", NULL, j."source", j."id",
             jl."position"
      FROM "bk_journals" j
      JOIN "bk_journal_lines" jl ON jl."journal_id" = j."id"
      JOIN "bk_accounts" a ON a."id" = jl."account_id"
      WHERE j."date" >= ${from}::date AND j."date" <= ${to}::date
    ) e
    ORDER BY e.date ASC, e.entry_id ASC, e.sort_pos ASC
    ${limit ? Prisma.sql`LIMIT ${limit + 1}` : Prisma.empty}
  `)

  const truncated = limit !== null && rows.length > limit
  const kept = truncated ? rows.slice(0, limit) : rows

  let net = toMoney('0.00')
  let vat = toMoney('0.00')
  let gross = toMoney('0.00')
  const mapped: AllEntriesRow[] = kept.map((row) => {
    if (row.net !== null && row.vat !== null && row.gross !== null) {
      // Signed totals: money in minus money out, so the footer reads as the
      // net movement and a credit note reduces it, rather than all adding up.
      const out = row.kind === 'Money out'
      net = out ? net.minus(toMoney(row.net)) : net.plus(toMoney(row.net))
      vat = out ? vat.minus(toMoney(row.vat)) : vat.plus(toMoney(row.vat))
      gross = out ? gross.minus(toMoney(row.gross)) : gross.plus(toMoney(row.gross))
    }
    return {
      date: day(row.date),
      settledDate: row.settled_date ? day(row.settled_date) : null,
      kind: row.kind as AllEntriesRow['kind'],
      entryType: row.entry_type,
      counterparty: row.counterparty,
      description: row.description,
      reference: row.reference,
      categoryCode: row.category_code,
      categoryName: row.category_name,
      ledgerAccount: row.ledger_account,
      vatTreatment: row.vat_treatment,
      vatRate: row.vat_rate === null ? null : formatMoney(row.vat_rate),
      net: row.net === null ? '' : formatMoney(row.net),
      vat: row.vat === null ? '' : formatMoney(row.vat),
      gross: row.gross === null ? '' : formatMoney(row.gross),
      debit: row.debit === null ? null : formatMoney(row.debit),
      credit: row.credit === null ? null : formatMoney(row.credit),
      status: row.status,
      paidFrom: row.paid_from,
      source: row.source,
      entryId: row.entry_id,
    }
  })

  return {
    from: day(from),
    to: day(to),
    rows: mapped,
    totals: { net: formatMoney(net), vat: formatMoney(vat), gross: formatMoney(gross) },
    truncated,
  }
}
