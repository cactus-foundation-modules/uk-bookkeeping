import { allEntries } from './all-entries'
import { csvDocument, csvRow } from './csv'
import { nominalLedger, trialBalance } from './ledger'
import {
  agedAnalysis,
  balanceSheet,
  categorySummary,
  monthlyBreakdown,
  profitAndLoss,
  type AgedAnalysis,
} from './reports'

// Every report on the Reports screen, as a spreadsheet.
//
// Built from the same functions the screen reads, not a second copy of the
// sums, so a downloaded file cannot disagree with what was on screen a moment
// earlier. Money stays the two-place string it arrived as.

export const REPORT_CSV_KINDS = [
  'profit-and-loss',
  'balance-sheet',
  'trial-balance',
  'account-history',
  'aged-debtors',
  'aged-creditors',
  'monthly',
  'categories',
  'all-entries',
] as const

export type ReportCsvKind = (typeof REPORT_CSV_KINDS)[number]

export type ReportCsvInput = { from: Date; to: Date; accountId: string | null }

export type ReportCsv = { filename: string; body: string }

const stamp = (date: Date) => date.toISOString().slice(0, 10)

function document(rows: unknown[][]): string {
  return csvDocument(rows.map(csvRow))
}

function agedRows(data: AgedAnalysis): unknown[][] {
  return [
    ['Who', 'Not yet a month', '1 to 2 months', '2 to 3 months', '3 to 4 months', 'Older', 'Total', 'Oldest invoice'],
    ...data.rows.map((r) => [r.counterparty, r.current, r.days30, r.days60, r.days90, r.older, r.total, r.oldest]),
    ['Total', data.totals.current, data.totals.days30, data.totals.days60, data.totals.days90, data.totals.older, data.totals.total, ''],
  ]
}

export async function buildReportCsv(kind: ReportCsvKind, input: ReportCsvInput): Promise<ReportCsv | null> {
  const { from, to } = input
  const range = `${stamp(from)}-to-${stamp(to)}`

  switch (kind) {
    case 'profit-and-loss': {
      const pl = await profitAndLoss(from, to)
      const prior = pl.priorFrom !== null
      const rows: unknown[][] = [
        ['Section', 'Code', 'Account', `${pl.from} to ${pl.to}`, ...(prior ? [`${pl.priorFrom} to ${pl.priorTo}`] : [])],
      ]
      for (const section of pl.sections) {
        for (const line of section.lines) {
          rows.push([section.label, line.code, line.name, line.amount, ...(prior ? [line.priorAmount] : [])])
        }
        rows.push([section.label, '', `Total ${section.label.toLowerCase()}`, section.total, ...(prior ? [section.priorTotal] : [])])
      }
      for (const subtotal of pl.subtotals) {
        rows.push(['', '', subtotal.label, subtotal.amount, ...(prior ? [subtotal.priorAmount] : [])])
      }
      return { filename: `profit-and-loss-${range}.csv`, body: document(rows) }
    }

    case 'balance-sheet': {
      const bs = await balanceSheet(to)
      const prior = bs.priorAsAt !== null
      const rows: unknown[][] = [
        ['Section', 'Code', 'Account', `As at ${bs.asAt}`, ...(prior ? [`As at ${bs.priorAsAt}`] : [])],
      ]
      for (const section of bs.sections) {
        for (const line of section.lines) {
          rows.push([section.label, line.code, line.name, line.amount, ...(prior ? [line.priorAmount] : [])])
        }
        rows.push([section.label, '', `Total ${section.label.toLowerCase()}`, section.total, ...(prior ? [section.priorTotal] : [])])
      }
      for (const subtotal of bs.subtotals) {
        rows.push(['', '', subtotal.label, subtotal.amount, ...(prior ? [subtotal.priorAmount] : [])])
      }
      rows.push(['', '', bs.balanced ? 'Balanced' : `OUT OF BALANCE by ${bs.difference}`, '', ...(prior ? [''] : [])])
      return { filename: `balance-sheet-${stamp(to)}.csv`, body: document(rows) }
    }

    case 'trial-balance': {
      const tb = await trialBalance(stamp(to))
      const rows: unknown[][] = [
        ['Code', 'Account', 'Type', 'Debit', 'Credit'],
        ...tb.rows.map((r) => [r.code, r.name, r.kind, r.debit, r.credit]),
        ['', tb.balanced ? 'Balanced' : `OUT BY ${tb.difference}`, '', tb.totalDebits, tb.totalCredits],
      ]
      return { filename: `trial-balance-${stamp(to)}.csv`, body: document(rows) }
    }

    case 'account-history': {
      if (!input.accountId) return null
      const ledger = await nominalLedger(input.accountId, { from: stamp(from), to: stamp(to) })
      if (!ledger) return null
      const rows: unknown[][] = [
        ['Date', 'Source', 'Who', 'What', 'Reference', 'Debit', 'Credit', 'Balance'],
        ['', '', '', 'Brought forward', '', '', '', ledger.broughtForward],
        ...ledger.entries.map((e) => [e.date, e.sourceKind, e.counterparty, e.description, e.reference, e.debit, e.credit, e.balance]),
        ['', '', '', `Total ${ledger.name}`, '', ledger.totalDebits, ledger.totalCredits, ledger.closing],
      ]
      const slug = ledger.code.replace(/[^a-z0-9-]+/gi, '-')
      return { filename: `account-history-${slug}-${range}.csv`, body: document(rows) }
    }

    case 'aged-debtors':
      return { filename: `owed-to-the-business-${stamp(to)}.csv`, body: document(agedRows(await agedAnalysis('income', to))) }

    case 'aged-creditors':
      return { filename: `owed-by-the-business-${stamp(to)}.csv`, body: document(agedRows(await agedAnalysis('expense', to))) }

    case 'monthly': {
      const monthly = await monthlyBreakdown(from, to)
      const rows: unknown[][] = [
        ['Month', 'In', 'Out', 'Profit', 'VAT position', 'Entries'],
        ...monthly.map((m) => [m.month, m.income, m.expenses, m.profit, m.vat, m.entries]),
      ]
      return { filename: `month-by-month-${range}.csv`, body: document(rows) }
    }

    case 'categories': {
      const summary = await categorySummary(from, to)
      const rows: unknown[][] = [
        ['Code', 'Category', 'Direction', 'SA103 box', 'CT600 group', 'Trading', 'Capital', 'Net', 'VAT', 'Gross', 'Entries'],
        ...summary.map((c) => [
          c.code, c.name, c.direction, c.sa103Box, c.ct600Group,
          c.isTrading ? 'yes' : 'no', c.isCapital ? 'yes' : 'no', c.net, c.vat, c.gross, c.entries,
        ]),
      ]
      return { filename: `by-category-${range}.csv`, body: document(rows) }
    }

    case 'all-entries': {
      const all = await allEntries(from, to)
      const rows: unknown[][] = [
        [
          'Date', 'Paid date', 'Type', 'Entry type', 'Who', 'What', 'Reference', 'Category code',
          'Category', 'Ledger account', 'VAT treatment', 'VAT rate %', 'Net', 'VAT', 'Gross',
          'Debit', 'Credit', 'Status', 'Paid from / into', 'Source', 'Entry id',
        ],
        ...all.rows.map((r) => [
          r.date, r.settledDate, r.kind, r.entryType, r.counterparty, r.description, r.reference,
          r.categoryCode, r.categoryName, r.ledgerAccount, r.vatTreatment, r.vatRate, r.net, r.vat,
          r.gross, r.debit, r.credit, r.status, r.paidFrom, r.source, r.entryId,
        ]),
      ]
      return { filename: `all-entries-${range}.csv`, body: document(rows) }
    }
  }
}
