'use client'

import { useCallback, useEffect, useState } from 'react'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { poundsFromString } from './format'

type SummaryRow = {
  categoryId: string
  name: string
  direction: string
  isCapital: boolean
  net: string
  vat: string
  gross: string
  entries: number
}

type Report = {
  from: string
  to: string
  summary: SummaryRow[]
  profitAndLoss: {
    income: SummaryRow[]
    expenses: SummaryRow[]
    excluded: SummaryRow[]
    totalIncome: string
    totalExpenses: string
    profit: string
    businessType: string
  }
  taxGrouping: { key: string; label: string; net: string }[]
  records: {
    recordsFingerprint: string | null
    chain: { rows: number; intact: boolean; brokenAtIndex: number | null }
    counts: Record<string, number>
  }
}

const input: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
}

const EXPORTS = [
  ['transactions', 'Entries'],
  ['lines', 'Entry lines'],
  ['attachments', 'Evidence list'],
  ['periods', 'VAT periods'],
  ['audit', 'History log'],
]

function startOfYear(): string {
  return `${new Date().getUTCFullYear()}-01-01`
}

export default function ReportsScreen({ environment }: { environment: string }) {
  const [range, setRange] = useState({ from: startOfYear(), to: new Date().toISOString().slice(0, 10) })
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const query = new URLSearchParams(range)
    const response = await fetch(`/api/m/uk-bookkeeping/admin/reports?${query.toString()}`)
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      setError(payload.error ?? 'The report could not be worked out.')
      return
    }
    setError(null)
    setReport(await response.json())
  }, [range])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  const rows = (list: SummaryRow[]) =>
    list.map((row) => (
      <tr key={row.categoryId} style={{ borderBottom: '1px solid var(--color-border)' }}>
        <td style={{ padding: '0.5rem 0.75rem' }}>{row.name}</td>
        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{row.entries}</td>
        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{poundsFromString(row.net)}</td>
        <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{poundsFromString(row.vat)}</td>
      </tr>
    ))

  return (
    <div>
      <BookkeepingNav active="reports" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      <div className="card" style={{ padding: '0.875rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>From</div>
          <input type="date" style={input} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>To</div>
          <input type="date" style={input} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
      </div>

      {report && report.summary.length === 0 && (
        <EmptyState title="Nothing in that range.">
          <p style={{ margin: 0 }}>Try a wider set of dates, or record something first.</p>
        </EmptyState>
      )}

      {report && report.summary.length > 0 && (
        <>
          <div className="card" style={{ padding: 0, marginBottom: '1rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                  <th style={{ padding: '0.625rem 0.75rem' }}>Money in</th>
                  <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Entries</th>
                  <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Before VAT</th>
                  <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>VAT</th>
                </tr>
              </thead>
              <tbody>{rows(report.profitAndLoss.income)}</tbody>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                  <th style={{ padding: '0.625rem 0.75rem' }}>Money out</th>
                  <th colSpan={3} />
                </tr>
              </thead>
              <tbody>{rows(report.profitAndLoss.expenses)}</tbody>
              {report.profitAndLoss.excluded.length > 0 && (
                <>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                      <th style={{ padding: '0.625rem 0.75rem' }}>
                        Not part of profit (capital, drawings, tax and VAT payments)
                      </th>
                      <th colSpan={3} />
                    </tr>
                  </thead>
                  <tbody>{rows(report.profitAndLoss.excluded)}</tbody>
                </>
              )}
              <tfoot>
                <tr>
                  <td style={{ padding: '0.75rem', fontWeight: 600 }}>
                    {report.profitAndLoss.profit.startsWith('-') ? 'Loss' : 'Profit'} for the period
                  </td>
                  <td colSpan={2} style={{ padding: '0.75rem', textAlign: 'right', fontWeight: 600 }}>
                    {poundsFromString(report.profitAndLoss.profit)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {report.taxGrouping.length > 0 && (
            <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem', maxWidth: 640 }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>
                {report.profitAndLoss.businessType === 'sole_trader'
                  ? 'Grouped the way the self-assessment form asks for it'
                  : 'Grouped the way a company tax return asks for it'}
              </h3>
              <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
                A starting point for whoever prepares the return, not the return itself.
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                <tbody>
                  {report.taxGrouping.map((group) => (
                    <tr key={group.key} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '0.375rem 0' }}>{group.label}</td>
                      <td style={{ padding: '0.375rem 0', textAlign: 'right' }}>{poundsFromString(group.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="card" style={{ padding: '1.25rem', maxWidth: 640 }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Take a copy of everything</h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          Spreadsheet files, one per kind of record. Worth doing before you change anything big, and
          the thing to do before you ever remove this from your site.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {EXPORTS.map(([kind, label]) => (
            <a key={kind} className="btn btn-sm" href={`/api/m/uk-bookkeeping/admin/export/${kind}`}>
              {label}
            </a>
          ))}
        </div>
        {report?.records && (
          <p style={{ margin: '0.875rem 0 0', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            {report.records.counts.transactions} entries, {report.records.counts.attachments} files,{' '}
            {report.records.counts.periods} VAT periods.{' '}
            {report.records.chain.intact
              ? `History intact. Fingerprint ${report.records.recordsFingerprint?.slice(0, 16) ?? '—'}…`
              : `History does not add up from entry ${report.records.chain.brokenAtIndex}. Somebody has been in the database.`}
          </p>
        )}
      </div>
    </div>
  )
}
