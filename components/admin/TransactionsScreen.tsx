'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import {
  BookkeepingNav,
  EmptyState,
  ErrorNotice,
  SandboxBanner,
  TriggerHealthNotice,
  useTriggerHealth,
} from './Notices'
import { formatDate, poundsFromString } from './format'

type Row = {
  id: string
  entry_type: string
  direction: string
  tax_point_date: string
  counterparty: string
  description: string
  reference: string | null
  status: string
  locked_period_id: string | null
  finalised_period_id: string | null
  net_total: string
  vat_total: string
  gross_total: string
  attachment_count: number
}

type List = {
  rows: Row[]
  total: number
  totals: { net: string; vat: string; gross: string }
}

const input: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
}

const PAGE = 50

export default function TransactionsScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const health = useTriggerHealth()
  const [list, setList] = useState<List | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [filters, setFilters] = useState({
    from: '',
    to: '',
    direction: '',
    counterparty: '',
    status: '',
    locked: '',
    hasEvidence: '',
  })

  const load = useCallback(async () => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value)
    }
    query.set('limit', String(PAGE))
    query.set('offset', String(offset))

    const response = await fetch(`/api/m/uk-bookkeeping/admin/transactions?${query.toString()}`)
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      setError(payload.error ?? 'The entries could not be loaded.')
      return
    }
    setError(null)
    setList(await response.json())
  }, [filters, offset])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  return (
    <div>
      <BookkeepingNav active="transactions" />
      <SandboxBanner environment={environment} />
      <TriggerHealthNotice health={health} />
      <ErrorNotice message={error} />

      <div
        className="card"
        style={{ padding: '0.875rem', marginBottom: '1rem', display: 'flex', gap: '0.625rem', flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>From</div>
          <input type="date" style={input} value={filters.from} onChange={(e) => { setOffset(0); setFilters({ ...filters, from: e.target.value }) }} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>To</div>
          <input type="date" style={input} value={filters.to} onChange={(e) => { setOffset(0); setFilters({ ...filters, to: e.target.value }) }} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>In or out</div>
          <select style={input} value={filters.direction} onChange={(e) => { setOffset(0); setFilters({ ...filters, direction: e.target.value }) }}>
            <option value="">Both</option>
            <option value="income">Money in</option>
            <option value="expense">Money out</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>Who with</div>
          <input style={input} value={filters.counterparty} placeholder="Any" onChange={(e) => { setOffset(0); setFilters({ ...filters, counterparty: e.target.value }) }} />
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>State</div>
          <select style={input} value={filters.status} onChange={(e) => { setOffset(0); setFilters({ ...filters, status: e.target.value }) }}>
            <option value="">All</option>
            <option value="posted">Recorded</option>
            <option value="draft">Waiting for review</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>Filed</div>
          <select style={input} value={filters.locked} onChange={(e) => { setOffset(0); setFilters({ ...filters, locked: e.target.value }) }}>
            <option value="">All</option>
            <option value="1">On a filed return</option>
            <option value="0">Not filed yet</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>Evidence</div>
          <select style={input} value={filters.hasEvidence} onChange={(e) => { setOffset(0); setFilters({ ...filters, hasEvidence: e.target.value }) }}>
            <option value="">All</option>
            <option value="1">Has a receipt</option>
            <option value="0">No receipt</option>
          </select>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <button
            className="btn btn-sm"
            onClick={() => {
              window.location.href = '/api/m/uk-bookkeeping/admin/export/transactions'
            }}
          >
            Export
          </button>
          {canRecord && (
            <a className="btn btn-sm btn-primary" href={`/${adminPath}/m/uk-bookkeeping/transactions/new`}>
              Record something
            </a>
          )}
        </div>
      </div>

      {list && list.rows.length === 0 && (
        <EmptyState title="Nothing recorded yet.">
          <p style={{ margin: '0 0 0.75rem' }}>
            This is where your income and expenses live. Record what you spend and what you take,
            keep the receipt with it, and the VAT return works itself out from what is here.
          </p>
          {canRecord && (
            <a className="btn btn-sm btn-primary" href={`/${adminPath}/m/uk-bookkeeping/transactions/new`}>
              Record the first one
            </a>
          )}
        </EmptyState>
      )}

      {list && list.rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ padding: '0.625rem 0.75rem' }}>Date</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>Who with</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>What for</th>
                <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Before VAT</th>
                <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>VAT</th>
                <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Total</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>📎</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>🔒</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>
                    {formatDate(row.tax_point_date)}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <a href={`/${adminPath}/m/uk-bookkeeping/transactions/${row.id}`}>{row.counterparty}</a>
                    {row.status === 'draft' && (
                      <span style={{ marginLeft: '0.5rem', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-warning, var(--color-text))' }}>
                        waiting for review
                      </span>
                    )}
                    {row.entry_type === 'adjustment' && (
                      <span style={{ marginLeft: '0.5rem', fontSize: 'var(--text-xs, 0.75rem)' }}>correction</span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{row.description || row.reference || '—'}</td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>
                    {row.direction === 'income' ? '' : '-'}
                    {poundsFromString(row.net_total)}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{poundsFromString(row.vat_total)}</td>
                  <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>{poundsFromString(row.gross_total)}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{row.attachment_count > 0 ? row.attachment_count : ''}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{row.locked_period_id ? '🔒' : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} style={{ padding: '0.625rem 0.75rem', fontWeight: 600 }}>
                  {list.total} entr{list.total === 1 ? 'y' : 'ies'}
                </td>
                <td style={{ padding: '0.625rem 0.75rem', textAlign: 'right', fontWeight: 600 }}>
                  {poundsFromString(list.totals.net)}
                </td>
                <td style={{ padding: '0.625rem 0.75rem', textAlign: 'right', fontWeight: 600 }}>
                  {poundsFromString(list.totals.vat)}
                </td>
                <td style={{ padding: '0.625rem 0.75rem', textAlign: 'right', fontWeight: 600 }}>
                  {poundsFromString(list.totals.gross)}
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {list && list.total > PAGE && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center' }}>
          <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Back
          </button>
          <span style={{ fontSize: 'var(--text-sm)' }}>
            {offset + 1} to {Math.min(offset + PAGE, list.total)} of {list.total}
          </span>
          <button
            className="btn btn-sm"
            disabled={offset + PAGE >= list.total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
