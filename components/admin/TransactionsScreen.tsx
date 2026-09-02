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
  /** Null on a transfer, which is neither money in nor money out. */
  direction: string | null
  /** Whether this row is an entry or a transfer between the business's own accounts. */
  entry_kind: 'entry' | 'transfer'
  transfer_from_name: string | null
  transfer_to_name: string | null
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
  evidence_not_required: boolean
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

const stickyHeader: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  background: 'var(--color-bg)',
  zIndex: 1,
}

const money: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

/** Placeholder rows while the first page loads, so the layout does not jump. */
function LoadingRows() {
  return (
    <div className="card" style={{ padding: '0.75rem' }} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          style={{
            height: '1.25rem',
            margin: '0.5rem 0',
            borderRadius: 6,
            background: 'var(--color-surface)',
            opacity: 1 - i * 0.15,
          }}
        />
      ))}
    </div>
  )
}

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
  const [notice, setNotice] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [filters, setFilters] = useState({
    from: '',
    to: '',
    direction: '',
    counterparty: '',
    status: '',
    locked: '',
    hasEvidence: '',
    evidenceNotRequired: '',
    categoryId: '',
  })
  // The text filter waits for the typing to pause rather than querying on every
  // keystroke; the abort below keeps it correct, this keeps it polite. The input
  // binds to this, and the debounce feeds it into the filter that queries.
  const [counterpartyInput, setCounterpartyInput] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0)
      setFilters((prev) =>
        prev.counterparty === counterpartyInput ? prev : { ...prev, counterparty: counterpartyInput },
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [counterpartyInput])

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/categories')
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((data) => setCategories(data.categories ?? []))
      .catch(() => setCategories([]))
  }, [])

  // Filters can arrive in the URL - the import screen links to ?status=draft -
  // read once on mount, before the first paint the user can act on.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if ([...params.keys()].length === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-off URL read on mount
    setFilters((prev) => ({
      from: params.get('from') ?? prev.from,
      to: params.get('to') ?? prev.to,
      direction: params.get('direction') ?? prev.direction,
      counterparty: params.get('counterparty') ?? prev.counterparty,
      status: params.get('status') ?? prev.status,
      locked: params.get('locked') ?? prev.locked,
      hasEvidence: params.get('hasEvidence') ?? prev.hasEvidence,
      evidenceNotRequired: params.get('evidenceNotRequired') ?? prev.evidenceNotRequired,
      categoryId: params.get('categoryId') ?? prev.categoryId,
    }))
    const counterparty = params.get('counterparty')
    if (counterparty) setCounterpartyInput(counterparty)
  }, [])

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(filters)) {
        if (value) query.set(key, value)
      }
      query.set('limit', String(PAGE))
      query.set('offset', String(offset))

      try {
        const response = await fetch(`/api/m/uk-bookkeeping/admin/transactions?${query.toString()}`, {
          signal,
        })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          setError(payload.error ?? 'The entries could not be loaded.')
          return
        }
        const data = await response.json()
        if (signal?.aborted) return
        setError(null)
        setList(data)
        setSelected(new Set())
      } catch (err) {
        // The abort is ours - typing in a filter cancels the fetch it outran.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError('The entries could not be loaded. Check the connection and try again.')
      }
    },
    [filters, offset],
  )

  useEffect(() => {
    // Aborting the stale request on every filter change means a slow response
    // can never land after a fast one and put the wrong rows under the inputs.
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  // Reviewing an import in bulk: only offered while the list is filtered to
  // drafts, so a stray tick can never post or delete a real record.
  const draftMode = canRecord && filters.status === 'draft'

  async function bulk(action: 'post' | 'delete') {
    if (selected.size === 0) return
    if (
      action === 'delete' &&
      !window.confirm(`Remove ${selected.size} draft entr${selected.size === 1 ? 'y' : 'ies'}? They have not been recorded, so nothing else changes.`)
    ) {
      return
    }
    setBulkBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/transactions/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids: [...selected] }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'That did not work.')
        return
      }
      const verb = action === 'post' ? 'recorded' : 'removed'
      setNotice(
        payload.failed?.length
          ? `${payload.done} ${verb}. ${payload.failed.length} could not be: ${payload.failed[0].error}`
          : `${payload.done} entr${payload.done === 1 ? 'y' : 'ies'} ${verb}.`,
      )
      await load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div>
      <BookkeepingNav active="transactions" />
      <SandboxBanner environment={environment} />
      <TriggerHealthNotice health={health} />
      <ErrorNotice message={error} />
      {notice && (
        <div
          className="card"
          role="status"
          style={{ padding: '0.75rem 1rem', marginBottom: '1rem', background: 'var(--color-surface)' }}
        >
          {notice}
        </div>
      )}

      <div
        className="card"
        style={{ padding: '0.875rem', marginBottom: '1rem', display: 'flex', gap: '0.625rem', flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div>
          <label htmlFor="bk-f-from" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>From</label>
          <input id="bk-f-from" type="date" style={input} value={filters.from} onChange={(e) => { setOffset(0); setFilters({ ...filters, from: e.target.value }) }} />
        </div>
        <div>
          <label htmlFor="bk-f-to" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>To</label>
          <input id="bk-f-to" type="date" style={input} value={filters.to} onChange={(e) => { setOffset(0); setFilters({ ...filters, to: e.target.value }) }} />
        </div>
        <div>
          <label htmlFor="bk-f-direction" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>In or out</label>
          <select id="bk-f-direction" style={input} value={filters.direction} onChange={(e) => { setOffset(0); setFilters({ ...filters, direction: e.target.value }) }}>
            <option value="">All of it</option>
            <option value="income">Money in</option>
            <option value="expense">Money out</option>
            <option value="transfer">Internal transfers</option>
          </select>
        </div>
        <div>
          <label htmlFor="bk-f-counterparty" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>Who with</label>
          <input id="bk-f-counterparty" style={input} value={counterpartyInput} placeholder="Any" onChange={(e) => setCounterpartyInput(e.target.value)} />
        </div>
        <div>
          <label htmlFor="bk-f-status" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>State</label>
          <select id="bk-f-status" style={input} value={filters.status} onChange={(e) => { setOffset(0); setFilters({ ...filters, status: e.target.value }) }}>
            <option value="">All</option>
            <option value="posted">Recorded</option>
            <option value="draft">Waiting for review</option>
          </select>
        </div>
        <div>
          <label htmlFor="bk-f-locked" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>Filed</label>
          <select id="bk-f-locked" style={input} value={filters.locked} onChange={(e) => { setOffset(0); setFilters({ ...filters, locked: e.target.value }) }}>
            <option value="">All</option>
            <option value="1">On a filed return</option>
            <option value="0">Not filed yet</option>
          </select>
        </div>
        <div>
          <label htmlFor="bk-f-evidence" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>Evidence</label>
          {/* One box, two filters underneath it. "Still needs one" is the
              question anybody actually asks, and it is not the same as "no
              receipt" now that an entry can say none is coming. */}
          <select
            id="bk-f-evidence"
            style={input}
            value={
              filters.evidenceNotRequired === '1'
                ? 'x'
                : filters.hasEvidence === '1'
                  ? '1'
                  : filters.hasEvidence === '0'
                    ? '0'
                    : ''
            }
            onChange={(e) => {
              const choice = e.target.value
              setOffset(0)
              setFilters({
                ...filters,
                hasEvidence: choice === '1' ? '1' : choice === '0' ? '0' : '',
                evidenceNotRequired: choice === 'x' ? '1' : choice === '0' ? '0' : '',
              })
            }}
          >
            <option value="">All</option>
            <option value="1">Has a receipt</option>
            <option value="0">Still needs one</option>
            <option value="x">None needed</option>
          </select>
        </div>
        <div>
          <label htmlFor="bk-f-category" style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>Category</label>
          <select id="bk-f-category" style={input} value={filters.categoryId} onChange={(e) => { setOffset(0); setFilters({ ...filters, categoryId: e.target.value }) }}>
            <option value="">All</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          <button
            className="btn btn-sm"
            onClick={() => {
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a file download endpoint, not a page - router.push would fetch it as RSC and download nothing
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

      {!list && !error && <LoadingRows />}

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

      {draftMode && list && list.rows.length > 0 && (
        <div
          className="card"
          style={{
            padding: '0.625rem 0.875rem',
            marginBottom: '1rem',
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 'var(--text-sm)' }}>
            {selected.size} of {list.rows.length} ticked
          </span>
          <span style={{ flex: 1 }} />
          <button
            className="btn btn-sm btn-primary"
            disabled={bulkBusy || selected.size === 0}
            onClick={() => bulk('post')}
          >
            {bulkBusy ? 'Working…' : `Record ${selected.size || ''}`.trim()}
          </button>
          <button
            className="btn btn-sm"
            disabled={bulkBusy || selected.size === 0}
            onClick={() => bulk('delete')}
          >
            Remove
          </button>
        </div>
      )}

      {list && list.rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                {draftMode && (
                  <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem', width: '2rem' }}>
                    <input
                      type="checkbox"
                      aria-label="Tick every entry on this page"
                      checked={selected.size > 0 && selected.size === list.rows.length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(list.rows.map((r) => r.id)) : new Set())
                      }
                    />
                  </th>
                )}
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem' }}>Date</th>
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem' }}>Who with</th>
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem' }}>What for</th>
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem', textAlign: 'right' }}>Before VAT</th>
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem', textAlign: 'right' }}>VAT</th>
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem', textAlign: 'right' }}>Total</th>
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem' }}>
                  <span role="img" aria-label="Evidence">📎</span>
                </th>
                <th style={{ ...stickyHeader, padding: '0.625rem 0.75rem' }}>
                  <span role="img" aria-label="Locked">🔒</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  {draftMode && (
                    <td style={{ padding: '0.5rem 0.75rem' }}>
                      {row.entry_kind === 'transfer' ? null : (
                      <input
                        type="checkbox"
                        aria-label={`Tick the entry for ${row.counterparty}`}
                        checked={selected.has(row.id)}
                        onChange={(e) => {
                          const next = new Set(selected)
                          if (e.target.checked) next.add(row.id)
                          else next.delete(row.id)
                          setSelected(next)
                        }}
                      />
                      )}
                    </td>
                  )}
                  <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>
                    {formatDate(row.tax_point_date)}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <a
                      href={
                        row.entry_kind === 'transfer'
                          ? `/${adminPath}/m/uk-bookkeeping/transfers/${row.id}`
                          : `/${adminPath}/m/uk-bookkeeping/transactions/${row.id}`
                      }
                    >
                      {row.counterparty}
                    </a>
                    {row.entry_kind === 'transfer' && (
                      <span style={{ marginLeft: '0.5rem', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
                        transfer
                      </span>
                    )}
                    {row.status === 'draft' && (
                      <span style={{ marginLeft: '0.5rem', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-warning, var(--color-text))' }}>
                        waiting for review
                      </span>
                    )}
                    {row.entry_type === 'adjustment' && (
                      <span style={{ marginLeft: '0.5rem', fontSize: 'var(--text-xs, 0.75rem)' }}>correction</span>
                    )}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    {row.entry_kind === 'transfer'
                      ? `${row.transfer_from_name ?? '?'} → ${row.transfer_to_name ?? '?'}`
                      : row.description || row.reference || '—'}
                  </td>
                  <td style={money}>
                    {row.entry_kind === 'transfer' ? '—' : (
                      <>
                        {row.direction === 'income' ? '' : '-'}
                        {poundsFromString(row.net_total)}
                      </>
                    )}
                  </td>
                  <td style={money}>{row.entry_kind === 'transfer' ? '—' : poundsFromString(row.vat_total)}</td>
                  <td style={money}>{poundsFromString(row.gross_total)}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    {row.attachment_count > 0 ? (
                      row.attachment_count
                    ) : row.evidence_not_required ? (
                      // Grey rather than red, and a cross rather than a blank:
                      // "dealt with, nothing to do" reads differently from
                      // "nobody has looked at this yet".
                      <span
                        title="No receipt needed for this one"
                        aria-label="No receipt needed"
                        style={{ color: 'var(--color-text-muted, var(--color-text))', opacity: 0.65 }}
                      >
                        ✕
                      </span>
                    ) : (
                      ''
                    )}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{row.locked_period_id ? '🔒' : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={draftMode ? 4 : 3} style={{ padding: '0.625rem 0.75rem', fontWeight: 600 }}>
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
