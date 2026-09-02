'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import ImportScreen from './ImportScreen'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { formatDate, poundsFromString } from './format'
import { readableSize } from './documents-shared'

// Every bank statement you have brought in.
//
// This used to be the Import tab, which showed you the act of importing and
// never once showed you the result. The lines went to Reconcile, the file went
// to the media library, and the statement itself - which months you hold, for
// which account, and whether there is a copy of the paperwork behind them - was
// written once and never read. "Have I imported August yet" had no answer
// anywhere in the books, and a month nobody imported looks exactly like a month
// with nothing in it.
//
// So the list is the page and importing is a panel on it, opened by the button
// in the corner. The two questions belong on one screen: you come here to find
// out what is missing, and the next thing you want is to put it in.

type StatementRow = {
  id: string
  bankAccountId: string
  bankAccountName: string
  bankAccountLast4: string | null
  filename: string
  format: 'csv' | 'pdf'
  periodStart: string | null
  periodEnd: string | null
  coversFrom: string | null
  coversTo: string | null
  openingBalance: string | null
  closingBalance: string | null
  totalPaidIn: string | null
  totalPaidOut: string | null
  lineCount: number
  reconciledCount: number
  unreconciledCount: number
  ignoredCount: number
  hasFile: boolean
  mimeType: string | null
  size: number
  importedAt: string
  updatedAt: string
  updateCount: number
}

type AccountOption = { id: string; name: string; kind: string; accountLast4: string | null }

const cellStyle: React.CSSProperties = { padding: '0.625rem 0.75rem', verticalAlign: 'top' }
const headStyle: React.CSSProperties = { padding: '0.625rem 0.75rem', textAlign: 'left' }
const mutedStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text-muted, var(--color-text))',
}
const controlStyle: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontSize: 'var(--text-sm)',
  maxWidth: '100%',
}

/** "1 to 31 August 2026", or as much of it as the statement actually said. */
function coverWording(row: StatementRow): string {
  if (row.coversFrom && row.coversTo) {
    return row.coversFrom === row.coversTo
      ? formatDate(row.coversFrom)
      : `${formatDate(row.coversFrom)} to ${formatDate(row.coversTo)}`
  }
  return 'Dates not known'
}

export default function StatementsScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const [rows, setRows] = useState<StatementRow[]>([])
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [total, setTotal] = useState(0)
  const [missingFiles, setMissingFiles] = useState(0)
  const [bankAccountId, setBankAccountId] = useState('')
  const [missingOnly, setMissingOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Shut to begin with. The list is what you came for; importing is the thing
  // you do next, and a form sitting open above it pushes the answer off screen.
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams()
      if (bankAccountId) query.set('bankAccountId', bankAccountId)
      if (missingOnly) query.set('missingFile', '1')
      const response = await fetch(`/api/m/uk-bookkeeping/admin/statements?${query}`)
      if (!response.ok) {
        setError('The statements could not be loaded.')
        return
      }
      const data = await response.json()
      setRows(data.rows ?? [])
      setTotal(data.total ?? 0)
      setMissingFiles(data.missingFiles ?? 0)
      setAccounts(data.accounts ?? [])
      setError(null)
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [bankAccountId, missingOnly])

  // Deferred by a tick rather than called straight out of the effect body: load
  // sets its own loading flag synchronously, and React's set-state-in-effect
  // rule rightly objects to that cascading a second render. Same shape the
  // receipts screen uses.
  useEffect(() => {
    const timer = setTimeout(load, 0)
    return () => clearTimeout(timer)
  }, [load])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Bank statements</h1>
        {canRecord && (
          <button
            type="button"
            className={importing ? 'btn' : 'btn btn-primary'}
            onClick={() => setImporting((open) => !open)}
          >
            {importing ? 'Close' : 'Import a statement'}
          </button>
        )}
      </div>

      <BookkeepingNav active="statements" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {importing && (
        <div style={{ marginBottom: '1.5rem' }}>
          <ImportScreen canRecord={canRecord} onImported={load} />
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        {accounts.length > 1 && (
          <select
            value={bankAccountId}
            onChange={(event) => setBankAccountId(event.target.value)}
            style={controlStyle}
          >
            <option value="">Every account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
                {account.accountLast4 ? ` (…${account.accountLast4})` : ''}
              </option>
            ))}
          </select>
        )}
        {missingFiles > 0 && (
          <label style={mutedStyle}>
            <input
              type="checkbox"
              checked={missingOnly}
              onChange={(event) => setMissingOnly(event.target.checked)}
              style={{ marginRight: '0.375rem' }}
            />
            Only the {missingFiles} with no copy of the file kept
          </label>
        )}
        <span style={{ ...mutedStyle, marginLeft: 'auto' }}>
          {loading ? 'Loading…' : `${total} statement${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {missingFiles > 0 && !missingOnly && (
        <div className="card" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', ...mutedStyle }}>
          {missingFiles} statement{missingFiles === 1 ? '' : 's'} here {missingFiles === 1 ? 'has' : 'have'}{' '}
          no copy of the file kept - {missingFiles === 1 ? 'it was' : 'they were'} imported before this
          site started keeping them, and there is nothing to fetch them back from. Import the same file
          again over the top and it will be kept this time; the lines are already here, so nothing is
          recorded twice.
        </div>
      )}

      {!loading && rows.length === 0 && (
        <EmptyState title={total === 0 ? 'No statements yet' : 'Nothing matches that'}>
          <p style={{ margin: 0 }}>
            {total === 0 ? (
              <>
                Nothing has been imported yet. Press <strong>Import a statement</strong> and drop a PDF
                or CSV from your online banking on it.
              </>
            ) : (
              'No statement matches what you have picked.'
            )}
          </p>
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={headStyle}>Period</th>
                <th style={headStyle}>Account</th>
                <th style={{ ...headStyle, textAlign: 'right' }}>In</th>
                <th style={{ ...headStyle, textAlign: 'right' }}>Out</th>
                <th style={{ ...headStyle, textAlign: 'right' }}>Closing</th>
                <th style={headStyle}>Lines</th>
                <th style={headStyle}>The file</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={cellStyle}>
                    <div style={{ fontWeight: 600 }}>{coverWording(row)}</div>
                    <div style={{ ...mutedStyle, fontSize: 'var(--text-xs, 0.75rem)' }}>
                      Imported {formatDate(row.importedAt.slice(0, 10))}
                      {row.updateCount > 0 &&
                        `, brought up to date ${row.updateCount === 1 ? 'once' : `${row.updateCount} times`}, last on ${formatDate(row.updatedAt.slice(0, 10))}`}
                    </div>
                  </td>
                  <td style={cellStyle}>
                    {row.bankAccountName}
                    {row.bankAccountLast4 && (
                      <span style={mutedStyle}> …{row.bankAccountLast4}</span>
                    )}
                  </td>
                  <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {row.totalPaidIn ? poundsFromString(row.totalPaidIn) : '—'}
                  </td>
                  <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {row.totalPaidOut ? poundsFromString(row.totalPaidOut) : '—'}
                  </td>
                  <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {row.closingBalance ? poundsFromString(row.closingBalance) : '—'}
                  </td>
                  <td style={cellStyle}>
                    <div>{row.lineCount}</div>
                    {row.unreconciledCount > 0 ? (
                      <a
                        href={`/${adminPath}/m/uk-bookkeeping/reconcile`}
                        style={{ fontSize: 'var(--text-xs, 0.75rem)' }}
                      >
                        {row.unreconciledCount} still to explain
                      </a>
                    ) : (
                      <div style={{ ...mutedStyle, fontSize: 'var(--text-xs, 0.75rem)' }}>
                        {row.lineCount === 0 ? 'All of them were already here' : 'All explained'}
                      </div>
                    )}
                  </td>
                  <td style={cellStyle}>
                    {row.hasFile ? (
                      <>
                        <a
                          href={`/api/m/uk-bookkeeping/admin/statements/${row.id}/file`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {row.filename}
                        </a>
                        <div style={{ ...mutedStyle, fontSize: 'var(--text-xs, 0.75rem)' }}>
                          {readableSize(row.size)} ·{' '}
                          <a
                            href={`/api/m/uk-bookkeeping/admin/statements/${row.id}/file?download=1`}
                          >
                            Download
                          </a>
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={mutedStyle}>No copy kept</div>
                        <div style={{ ...mutedStyle, fontSize: 'var(--text-xs, 0.75rem)' }}>
                          was “{row.filename}”
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
