'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import {
  DateField,
  Money,
  card,
  formatDay,
  input,
  muted,
  table,
  td,
  tdRight,
  th,
  thRight,
} from './ui'

// Financial years, and closing one.
//
// The screen is built round the decision rather than round the data: here is
// the year, here is the profit it made, here is the journal that would take
// that profit to reserves, and here is the button. Anything standing in the way
// is listed in plain English before the button rather than arriving as a
// refusal after it.

type Period = {
  id: string
  name: string
  start_date: string
  end_date: string
  status: 'open' | 'closed'
  closed_at: string | null
  notes: string | null
}

type Detail = {
  period: Period
  preview: {
    lines: { accountId: string; code: string; name: string; debit: string; credit: string }[]
    totalIncome: string
    totalExpenses: string
    profit: string
    reservesAccount: { id: string; name: string } | null
    blockers: string[]
  }
  profitAndLoss: { subtotals: { key: string; label: string; amount: string }[] }
  balanceSheet: { netAssets: string; totalEquity: string; balanced: boolean; difference: string }
}

export default function YearEndScreen({
  environment,
  canClose,
  canRecord,
}: {
  environment: string
  canClose: boolean
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const [periods, setPeriods] = useState<Period[]>([])
  const [suggestion, setSuggestion] = useState<{ startDate: string; endDate: string; name: string } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ startDate: '', endDate: '', name: '' })

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/m/uk-bookkeeping/admin/accounting-periods', { signal })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      setError(payload.error ?? 'The financial years could not be loaded.')
      return
    }
    const data = await response.json()
    if (signal?.aborted) return
    setError(null)
    setPeriods(data.periods)
    setSuggestion(data.suggestion)
    setDraft((current) =>
      current.startDate
        ? current
        : { startDate: data.suggestion.startDate, endDate: data.suggestion.endDate, name: data.suggestion.name },
    )
    setSelected((current) => current ?? data.periods[0]?.id ?? null)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState is after an await
    loadList(controller.signal).catch(() => setError('The financial years could not be loaded.'))
    return () => controller.abort()
  }, [loadList])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    fetch(`/api/m/uk-bookkeeping/admin/accounting-periods/${selected}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? 'Could not read that year.')
        return response.json()
      })
      .then((data) => setDetail(data))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'Could not read that year.')
      })
    return () => controller.abort()
  }, [selected])

  const send = async (url: string, method: string, body?: unknown) => {
    setBusy(true)
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'That did not work.')
        return null
      }
      setError(null)
      await loadList()
      if (selected) {
        const refreshed = await fetch(`/api/m/uk-bookkeeping/admin/accounting-periods/${selected}`)
        if (refreshed.ok) setDetail(await refreshed.json())
      }
      return payload
    } finally {
      setBusy(false)
    }
  }

  const profitLine = detail?.profitAndLoss.subtotals.find((row) => row.key === 'profit-after-tax')

  return (
    <div>
      <BookkeepingNav active="year-end" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'minmax(240px, 320px) 1fr', alignItems: 'start' }}>
        <div>
          <div style={{ ...card, padding: 0 }}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Financial years</th>
                  <th style={thRight}>State</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.id}>
                    <td style={td}>
                      <button
                        type="button"
                        onClick={() => setSelected(period.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          font: 'inherit',
                          cursor: 'pointer',
                          color: 'var(--color-text)',
                          fontWeight: selected === period.id ? 600 : 400,
                          textAlign: 'left',
                        }}
                      >
                        {period.name}
                        <span style={{ display: 'block', ...muted }}>
                          {formatDay(period.start_date)} to {formatDay(period.end_date)}
                        </span>
                      </button>
                    </td>
                    <td style={{ ...tdRight, ...muted }}>{period.status === 'closed' ? 'Closed' : 'Open'}</td>
                  </tr>
                ))}
                {periods.length === 0 && (
                  <tr>
                    <td style={{ ...td, ...muted }} colSpan={2}>
                      None yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {canRecord && (
            <div style={{ ...card, padding: '0.875rem' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Add a year</h3>
              {suggestion && (
                <p style={{ ...muted, margin: '0 0 0.625rem' }}>
                  Worked out from your year end and the last year on the books. Change it if that is
                  not right.
                </p>
              )}
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                <DateField id="bk-ye-start" label="From" value={draft.startDate} onChange={(startDate) => setDraft({ ...draft, startDate })} />
                <DateField id="bk-ye-end" label="To" value={draft.endDate} onChange={(endDate) => setDraft({ ...draft, endDate })} />
                <div>
                  <label htmlFor="bk-ye-name" style={{ display: 'block', ...muted }}>
                    Call it
                  </label>
                  <input
                    id="bk-ye-name"
                    style={{ ...input, width: '100%' }}
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !draft.startDate || !draft.endDate}
                  onClick={() => send('/api/m/uk-bookkeeping/admin/accounting-periods', 'POST', draft)}
                >
                  Add it
                </button>
              </div>
            </div>
          )}
        </div>

        <div>
          {!detail && (
            <EmptyState title="No financial year selected.">
              <p style={{ margin: 0 }}>
                A financial year is what a set of accounts and a corporation tax return are drawn up
                for. It is not the same thing as a VAT quarter, and it does not have to line up with
                one.
              </p>
            </EmptyState>
          )}

          {detail && (
            <>
              <div style={{ ...card, padding: '1.25rem' }}>
                <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.0625rem' }}>{detail.period.name}</h2>
                <p style={{ ...muted, margin: '0 0 1rem' }}>
                  {formatDay(detail.period.start_date)} to {formatDay(detail.period.end_date)}
                  {detail.period.status === 'closed' && detail.period.closed_at
                    ? ` · closed ${formatDay(detail.period.closed_at)}`
                    : ''}
                </p>

                <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                  <Figure label="Profit for the year" value={profitLine?.amount ?? '0.00'} emphasis />
                  <Figure label="Net assets at the year end" value={detail.balanceSheet.netAssets} />
                  <Figure label="Shareholders’ funds" value={detail.balanceSheet.totalEquity} />
                </div>

                {!detail.balanceSheet.balanced && (
                  <p style={{ margin: '0 0 1rem', color: 'var(--color-danger, var(--color-text))', fontSize: 'var(--text-sm)' }}>
                    The balance sheet for this year is out by <Money value={detail.balanceSheet.difference} />.
                    Sort that out before closing anything.
                  </p>
                )}

                <p style={{ ...muted, margin: 0 }}>
                  Closing a year moves every income and cost balance into retained profit, so the
                  next year starts from zero and the profit shows on the balance sheet where it
                  belongs. It also freezes the year: nothing dated inside it can be changed until it
                  is reopened, which you can do whenever you need to.
                </p>
              </div>

              {detail.preview.lines.length > 0 && (
                <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
                  <table style={table}>
                    <thead>
                      <tr>
                        <th style={th}>
                          {detail.period.status === 'closed' ? 'What closing it posted' : 'What closing it would post'}
                        </th>
                        <th style={thRight}>Debit</th>
                        <th style={thRight}>Credit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.preview.lines.map((line) => (
                        <tr key={line.accountId}>
                          <td style={td}>{line.name}</td>
                          <td style={tdRight}>{line.debit === '0.00' ? '' : <Money value={line.debit} />}</td>
                          <td style={tdRight}>{line.credit === '0.00' ? '' : <Money value={line.credit} />}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {detail.preview.blockers.length > 0 && detail.period.status === 'open' && (
                <div
                  role="status"
                  style={{
                    ...card,
                    padding: '0.75rem 1rem',
                    background: 'var(--color-warning-bg, var(--color-surface))',
                    borderColor: 'var(--color-warning, var(--color-border))',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  <strong>Not yet.</strong>
                  <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>
                    {detail.preview.blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {detail.period.status === 'open' && canClose && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || detail.preview.blockers.length > 0}
                    onClick={() =>
                      send(`/api/m/uk-bookkeeping/admin/accounting-periods/${detail.period.id}/close`, 'POST')
                    }
                  >
                    Close {detail.period.name}
                  </button>
                )}
                {detail.period.status === 'closed' && canClose && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() =>
                      send(`/api/m/uk-bookkeeping/admin/accounting-periods/${detail.period.id}/close`, 'DELETE')
                    }
                  >
                    Reopen it
                  </button>
                )}
                {detail.period.status === 'open' && canRecord && (
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      await send(`/api/m/uk-bookkeeping/admin/accounting-periods/${detail.period.id}`, 'DELETE')
                      setSelected(null)
                      setDetail(null)
                    }}
                  >
                    Remove this year
                  </button>
                )}
                <a className="btn" href={`/${adminPath}/m/uk-bookkeeping/corporation-tax`}>
                  Corporation tax
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Figure({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <div style={muted}>{label}</div>
      <div style={{ fontSize: emphasis ? '1.5rem' : '1.125rem', fontWeight: 600 }}>
        <Money value={value} negativeIsBad={emphasis} />
      </div>
    </div>
  )
}
