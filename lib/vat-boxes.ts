import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMoney, roundWholePounds, toMoney } from './money'
import type { BoxRounding, SnapshotLine, VatBoxes, VatScheme } from './types'

// The nine boxes, as a function of (period start, period end, scheme) and
// nothing else.
//
// No box value is ever typed by a human, at any point, in any code path. There
// is no service function that accepts a box value as an argument, and the only
// way a number reaches HMRC is out of the query below. That is the Making Tax
// Digital digital-links requirement and it is the reason this module exists in
// this shape.
//
// The scheme decides one thing and one thing only: which date column selects the
// rows. Every box formula is identical under both schemes, so there is no second
// implementation to keep in step.

/**
 * Period membership. The ONLY place the scheme matters.
 *
 *   accrual - the tax point falls in the period
 *   cash    - the money moved in the period, and an unpaid invoice is in no
 *             period at all until it is paid
 *
 * Note what is NOT filtered here: entry_type. An adjustment is an ordinary line
 * for box purposes, which is precisely how a correction reaches a return - it
 * lands in the open period and is summed with everything else. Adjustments are
 * only ever distinguished in the "net errors on previous returns" figure, which
 * is a display and not a different arithmetic.
 *
 * An opening_balance entry carries vat_rate_code and vat_treatment of
 * 'outside_scope', so it contributes to no box, which is what an opening balance
 * should do.
 */
function membership(start: Date, end: Date, scheme: VatScheme): Prisma.Sql {
  return Prisma.sql`
    t."status" = 'posted'
    AND (
      (${scheme}::text = 'accrual' AND t."tax_point_date" BETWEEN ${start}::date AND ${end}::date)
      OR
      (${scheme}::text = 'cash' AND t."settled_date" IS NOT NULL
                                AND t."settled_date" BETWEEN ${start}::date AND ${end}::date)
    )
  `
}

/**
 * One line's classification into boxes, written once and used by both the totals
 * query and the workings query, so the explanation cannot drift from the answer.
 *
 * Box 1 - VAT due on sales and other outputs.
 *   Income lines that carry no VAT (zero rated, exempt, NI dispatches, and the
 *   supplier side of a domestic reverse charge) have vat_amount = 0.00, so
 *   including them is a no-op rather than a special case. Written this way, a
 *   new zero-VAT income treatment cannot be forgotten out of box 1 later.
 *   Reverse-charge and postponed-import lines are recorded as expenses but
 *   generate output tax as well as input tax: they appear in box 1 and again in
 *   box 4, netting to nil, which is the whole design of a reverse charge.
 *
 * Box 2 - acquisitions from EU member states into Northern Ireland. Zero for a
 *   business outside the NI protocol, which is most of them, but it falls out of
 *   the model rather than being hardcoded to 0.00.
 *
 * Box 4 - VAT reclaimed on purchases and other inputs. is_capital does NOT
 *   exclude a line: capital purchases carry recoverable input tax.
 *
 * Box 6 - includes zero-rated and exempt sales, excludes anything outside the
 *   scope of VAT, and includes reverse-charge services bought from overseas,
 *   which appear in box 6 and box 7 both.
 *
 * Box 7 - includes capital purchases, and the net value of reverse-charge and
 *   postponed-import lines.
 *
 * Box 8 - goods only, never services. Also in box 6.
 * Box 9 - also in box 7.
 */
const CLASSIFY = Prisma.sql`
  (
    (t."direction" = 'income'  AND l."vat_treatment" <> 'outside_scope')
    OR (t."direction" = 'expense' AND l."vat_treatment" IN
        ('reverse_charge_services', 'import_pva', 'domestic_reverse_charge'))
  ) AS in_box1,
  (t."direction" = 'expense' AND l."vat_treatment" = 'ni_eu_acquisition') AS in_box2,
  (t."direction" = 'expense' AND l."vat_treatment" IN
    ('domestic', 'ni_eu_acquisition', 'reverse_charge_services',
     'import_pva', 'domestic_reverse_charge')) AS in_box4,
  (
    (t."direction" = 'income' AND l."vat_treatment" <> 'outside_scope'
                             AND l."vat_rate_code" <> 'outside_scope')
    OR (t."direction" = 'expense' AND l."vat_treatment" = 'reverse_charge_services')
  ) AS in_box6,
  (t."direction" = 'expense' AND l."vat_treatment" <> 'outside_scope'
                            AND l."vat_rate_code" <> 'outside_scope') AS in_box7,
  (t."direction" = 'income'  AND l."vat_treatment" = 'ni_eu_dispatch') AS in_box8,
  (t."direction" = 'expense' AND l."vat_treatment" = 'ni_eu_acquisition') AS in_box9
`

export type BoxComputation = {
  boxes: VatBoxes
  /** Boxes 6 to 9 before the whole-pound rounding, kept so a snapshot can show its working. */
  unrounded: Record<string, string>
  lines: SnapshotLine[]
}

type TotalsRow = {
  box1: Prisma.Decimal
  box2: Prisma.Decimal
  box4: Prisma.Decimal
  box6: Prisma.Decimal
  box7: Prisma.Decimal
  box8: Prisma.Decimal
  box9: Prisma.Decimal
}

/**
 * The totals. One statement, four SUMs over numeric, all of it exact - there is
 * no code path anywhere in this module where a total is built by adding
 * JavaScript numbers together.
 */
export async function computeVatTotals(
  start: Date,
  end: Date,
  scheme: VatScheme,
): Promise<TotalsRow> {
  const rows = await prisma.$queryRaw<TotalsRow[]>`
    WITH in_period AS (
      SELECT l."net_amount", l."vat_amount", ${CLASSIFY}
      FROM "bk_transaction_lines" l
      JOIN "bk_transactions" t ON t."id" = l."transaction_id"
      WHERE ${membership(start, end, scheme)}
    )
    SELECT
      COALESCE(SUM("vat_amount") FILTER (WHERE in_box1), 0)::numeric AS box1,
      COALESCE(SUM("vat_amount") FILTER (WHERE in_box2), 0)::numeric AS box2,
      COALESCE(SUM("vat_amount") FILTER (WHERE in_box4), 0)::numeric AS box4,
      COALESCE(SUM("net_amount") FILTER (WHERE in_box6), 0)::numeric AS box6,
      COALESCE(SUM("net_amount") FILTER (WHERE in_box7), 0)::numeric AS box7,
      COALESCE(SUM("net_amount") FILTER (WHERE in_box8), 0)::numeric AS box8,
      COALESCE(SUM("net_amount") FILTER (WHERE in_box9), 0)::numeric AS box9
    FROM in_period
  `
  const zero = new Prisma.Decimal(0)
  return (
    rows[0] ?? { box1: zero, box2: zero, box4: zero, box6: zero, box7: zero, box8: zero, box9: zero }
  )
}

type WorkingRow = {
  transaction_id: string
  line_id: string
  direction: 'income' | 'expense'
  vat_treatment: SnapshotLine['vatTreatment']
  vat_rate_code: SnapshotLine['vatRateCode']
  net_amount: Prisma.Decimal
  vat_amount: Prisma.Decimal
  in_box1: boolean
  in_box2: boolean
  in_box4: boolean
  in_box6: boolean
  in_box7: boolean
  in_box8: boolean
  in_box9: boolean
}

/**
 * The workings: exactly which rows, at exactly which values, landed in which
 * boxes. Built from the same CLASSIFY fragment as the totals, so "why is box 6
 * that number" is answered from the same rule that produced the number.
 */
export async function computeVatWorkings(
  start: Date,
  end: Date,
  scheme: VatScheme,
): Promise<SnapshotLine[]> {
  const rows = await prisma.$queryRaw<WorkingRow[]>`
    SELECT l."transaction_id", l."id" AS line_id, t."direction",
           l."vat_treatment", l."vat_rate_code", l."net_amount", l."vat_amount",
           ${CLASSIFY}
    FROM "bk_transaction_lines" l
    JOIN "bk_transactions" t ON t."id" = l."transaction_id"
    WHERE ${membership(start, end, scheme)}
    ORDER BY t."tax_point_date" ASC, t."id" ASC, l."position" ASC
  `

  return rows.map((row) => {
    const boxes: string[] = []
    if (row.in_box1) boxes.push('1')
    if (row.in_box2) boxes.push('2')
    if (row.in_box4) boxes.push('4')
    if (row.in_box6) boxes.push('6')
    if (row.in_box7) boxes.push('7')
    if (row.in_box8) boxes.push('8')
    if (row.in_box9) boxes.push('9')
    return {
      transactionId: row.transaction_id,
      lineId: row.line_id,
      direction: row.direction,
      vatTreatment: row.vat_treatment,
      vatRateCode: row.vat_rate_code,
      netAmount: formatMoney(row.net_amount),
      vatAmount: formatMoney(row.vat_amount),
      boxes,
    }
  })
}

/**
 * Boxes 3 and 5 from boxes 1, 2 and 4, and the whole-pound reduction of 6 to 9.
 *
 * Box 3 is box 1 plus box 2, never summed independently.
 * Box 5 is the ABSOLUTE difference between box 3 and box 4: HMRC's field is
 * non-negative and its direction is implied by whether box 3 exceeds box 4.
 * Sending a negative value there is rejected outright. The screen says which way
 * it goes in words; the payload sends the absolute value.
 *
 * Rounding happens exactly here, once, and identically to all four whole-pound
 * boxes. See roundWholePounds in lib/money.ts for why it is a setting.
 */
export function assembleBoxes(totals: TotalsRow, rounding: BoxRounding): BoxComputation['boxes'] {
  const box1 = toMoney(totals.box1)
  const box2 = toMoney(totals.box2)
  const box4 = toMoney(totals.box4)
  const box3 = box1.plus(box2)
  const box5 = box3.minus(box4).abs()

  return {
    vatDueSales: formatMoney(box1),
    vatDueAcquisitions: formatMoney(box2),
    totalVatDue: formatMoney(box3),
    vatReclaimedCurrPeriod: formatMoney(box4),
    netVatDue: formatMoney(box5),
    totalValueSalesExVAT: formatMoney(roundWholePounds(totals.box6, rounding)),
    totalValuePurchasesExVAT: formatMoney(roundWholePounds(totals.box7, rounding)),
    totalValueGoodsSuppliedExVAT: formatMoney(roundWholePounds(totals.box8, rounding)),
    totalAcquisitionsExVAT: formatMoney(roundWholePounds(totals.box9, rounding)),
  }
}

export async function computeVatReturn(
  start: Date,
  end: Date,
  scheme: VatScheme,
  rounding: BoxRounding,
): Promise<BoxComputation> {
  const totals = await computeVatTotals(start, end, scheme)
  const lines = await computeVatWorkings(start, end, scheme)
  return {
    boxes: assembleBoxes(totals, rounding),
    unrounded: {
      totalValueSalesExVAT: formatMoney(totals.box6),
      totalValuePurchasesExVAT: formatMoney(totals.box7),
      totalValueGoodsSuppliedExVAT: formatMoney(totals.box8),
      totalAcquisitionsExVAT: formatMoney(totals.box9),
    },
    lines,
  }
}

/**
 * Which way box 5 goes, in words. The absolute value is what HMRC wants; a site
 * owner wants to know whether they are writing a cheque.
 */
export function netVatDirection(boxes: VatBoxes): 'pay' | 'reclaim' | 'nil' {
  const due = toMoney(boxes.totalVatDue)
  const reclaimed = toMoney(boxes.vatReclaimedCurrPeriod)
  if (due.equals(reclaimed)) return 'nil'
  return due.greaterThan(reclaimed) ? 'pay' : 'reclaim'
}

/** True when two sets of boxes are identical, value for value. */
export function boxesMatch(a: VatBoxes, b: VatBoxes): boolean {
  return (Object.keys(a) as (keyof VatBoxes)[]).every((key) => a[key] === b[key])
}
