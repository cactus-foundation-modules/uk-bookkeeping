'use client'

import { useCallback, useEffect, useState } from 'react'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import {
  DateField,
  Money,
  card,
  formatDay,
  input,
  localToday,
  muted,
  startOfYear,
  table,
  td,
  tdRight,
  th,
  thRight,
} from './ui'

// The fixed asset register.
//
// Two things on one screen because they are two halves of one decision. What an
// asset costs the ACCOUNTS is depreciation, spread over the years it is useful
// for. What it saves in TAX is capital allowances, on HMRC's rules, which
// ignore depreciation entirely. Both come off the same row, which is what stops
// them drifting apart the way a spreadsheet next to a bookkeeping package
// always eventually does.

const DEPRECIATION_METHODS = [
  { value: 'straight_line', label: 'Same amount every year' },
  { value: 'reducing_balance', label: 'A percentage of what is left each year' },
  { value: 'none', label: 'Do not depreciate' },
]

const CA_POOLS = [
  { value: 'aia', label: 'Annual investment allowance - the whole cost, up to the yearly cap' },
  { value: 'full_expensing', label: 'Full expensing - the whole cost, brand new equipment only' },
  { value: 'fya_special', label: '50% first year - new integral features and long-life assets' },
  { value: 'main', label: 'Main pool - 18% a year' },
  { value: 'special', label: 'Special rate pool - 6% a year, including cars' },
  { value: 'none', label: 'No tax allowances at all' },
]

type Asset = {
  id: string
  description: string
  reference: string | null
  acquired_date: string
  cost: string
  depreciation_method: string
  depreciation_rate: string
  residual_value: string
  ca_pool: string
  disposed_date: string | null
  disposal_proceeds: string | null
  accumulated_depreciation: string
  net_book_value: string
  archived: boolean
}

type Run = {
  from: string
  to: string
  lines: { assetId: string; description: string; charge: string; netBookValue: string; basis: string }[]
  total: string
  skipped: { assetId: string; description: string; reason: string }[]
  alreadyRun: boolean
}

const EMPTY_DRAFT = {
  description: '',
  reference: '',
  acquiredDate: localToday(),
  cost: '',
  depreciationMethod: 'straight_line',
  depreciationRate: '25',
  residualValue: '0',
  caPool: 'aia',
  notes: '',
}

export default function FixedAssetsScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [adding, setAdding] = useState(false)
  const [range, setRange] = useState({ from: startOfYear(), to: localToday() })
  const [run, setRun] = useState<Run | null>(null)
  const [disposing, setDisposing] = useState<{ id: string; date: string; proceeds: string } | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/m/uk-bookkeeping/admin/fixed-assets', { signal })
    if (!response.ok) {
      setError('The asset register could not be loaded.')
      return
    }
    const data = await response.json()
    if (signal?.aborted) return
    setAssets(data.assets)
  }, [])

  const loadRun = useCallback(
    async (signal?: AbortSignal) => {
      const query = new URLSearchParams(range)
      const response = await fetch(`/api/m/uk-bookkeeping/admin/depreciation?${query.toString()}`, { signal })
      if (!response.ok) return
      const data = await response.json()
      if (signal?.aborted) return
      setRun(data)
    },
    [range],
  )

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState is after an await
    load(controller.signal).catch(() => setError('The asset register could not be loaded.'))
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState is after an await
    loadRun(controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [loadRun])

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
        return false
      }
      setError(null)
      await Promise.all([load(), loadRun()])
      return true
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <BookkeepingNav active="assets" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      <div style={{ ...card, padding: '1.25rem' }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
          Anything the business bought that it will still have next year belongs here: vans,
          computers, machinery, furniture. Two things follow from it. The accounts spread the cost
          over the years you use it for, which is depreciation. The taxman ignores that completely
          and gives capital allowances on his own rules instead, which is usually a good deal better
          in the first year. Both come off the same entry, so you only tell it once.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {canRecord && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding((open) => !open)}>
            {adding ? 'Never mind' : 'Add an asset'}
          </button>
        )}
      </div>

      {adding && canRecord && (
        <div style={{ ...card, padding: '1.25rem' }}>
          <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <Field label="What is it" id="bk-fa-desc">
              <input
                id="bk-fa-desc"
                style={{ ...input, width: '100%' }}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder="Transit van, 22 plate"
              />
            </Field>
            <Field label="Reference" id="bk-fa-ref">
              <input
                id="bk-fa-ref"
                style={{ ...input, width: '100%' }}
                value={draft.reference}
                onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
                placeholder="Registration, serial number"
              />
            </Field>
            <DateField
              id="bk-fa-date"
              label="Bought on"
              value={draft.acquiredDate}
              onChange={(acquiredDate) => setDraft({ ...draft, acquiredDate })}
            />
            <Field label="What it cost, before VAT" id="bk-fa-cost">
              <input
                id="bk-fa-cost"
                inputMode="decimal"
                style={{ ...input, width: '100%' }}
                value={draft.cost}
                onChange={(event) => setDraft({ ...draft, cost: event.target.value })}
                placeholder="12500.00"
              />
            </Field>
            <Field label="How to spread the cost" id="bk-fa-method">
              <select
                id="bk-fa-method"
                style={{ ...input, width: '100%' }}
                value={draft.depreciationMethod}
                onChange={(event) => setDraft({ ...draft, depreciationMethod: event.target.value })}
              >
                {DEPRECIATION_METHODS.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Percent a year" id="bk-fa-rate">
              <input
                id="bk-fa-rate"
                inputMode="decimal"
                style={{ ...input, width: '100%' }}
                value={draft.depreciationRate}
                onChange={(event) => setDraft({ ...draft, depreciationRate: event.target.value })}
              />
            </Field>
            <Field label="Worth at the end" id="bk-fa-residual">
              <input
                id="bk-fa-residual"
                inputMode="decimal"
                style={{ ...input, width: '100%' }}
                value={draft.residualValue}
                onChange={(event) => setDraft({ ...draft, residualValue: event.target.value })}
              />
            </Field>
            <Field label="Tax allowances" id="bk-fa-pool" wide>
              <select
                id="bk-fa-pool"
                style={{ ...input, width: '100%' }}
                value={draft.caPool}
                onChange={(event) => setDraft({ ...draft, caPool: event.target.value })}
              >
                {CA_POOLS.map((pool) => (
                  <option key={pool.value} value={pool.value}>
                    {pool.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p style={{ ...muted, margin: '0.75rem 0' }}>
            If you are not sure about the tax allowances, the annual investment allowance is the
            right answer for most things most of the time. Cars are the big exception: they always
            go in the special rate pool.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !draft.description.trim() || !draft.cost}
            onClick={async () => {
              if (await send('/api/m/uk-bookkeeping/admin/fixed-assets', 'POST', draft)) {
                setDraft(EMPTY_DRAFT)
                setAdding(false)
              }
            }}
          >
            Add it
          </button>
        </div>
      )}

      {assets.length === 0 ? (
        <EmptyState title="Nothing in the register yet.">
          <p style={{ margin: 0 }}>Add the first thing the business bought and still owns.</p>
        </EmptyState>
      ) : (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>What</th>
                <th style={th}>Bought</th>
                <th style={thRight}>Cost</th>
                <th style={thRight}>Written off so far</th>
                <th style={thRight}>Worth now</th>
                <th style={th}>Tax allowances</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => (
                <tr key={asset.id}>
                  <td style={td}>
                    {asset.description}
                    {asset.reference && <span style={{ ...muted, marginLeft: '0.5rem' }}>{asset.reference}</span>}
                    {asset.disposed_date && (
                      <span style={{ display: 'block', ...muted }}>
                        Sold {formatDay(asset.disposed_date)} for {asset.disposal_proceeds}
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatDay(asset.acquired_date)}</td>
                  <td style={tdRight}><Money value={asset.cost} /></td>
                  <td style={tdRight}><Money value={asset.accumulated_depreciation} /></td>
                  <td style={tdRight}><Money value={asset.net_book_value} /></td>
                  <td style={{ ...td, ...muted }}>
                    {CA_POOLS.find((pool) => pool.value === asset.ca_pool)?.label.split(' - ')[0] ?? asset.ca_pool}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {canRecord && !asset.disposed_date && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setDisposing({ id: asset.id, date: localToday(), proceeds: '' })}
                      >
                        Sold it
                      </button>
                    )}
                    {canRecord && asset.disposed_date && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => send(`/api/m/uk-bookkeeping/admin/fixed-assets/${asset.id}/dispose`, 'DELETE')}
                      >
                        Not sold after all
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {disposing && (
        <div style={{ ...card, padding: '1.25rem' }}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>Record the sale</h3>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <DateField
              id="bk-fa-sold"
              label="Sold on"
              value={disposing.date}
              onChange={(date) => setDisposing({ ...disposing, date })}
            />
            <Field label="What you got for it" id="bk-fa-proceeds">
              <input
                id="bk-fa-proceeds"
                inputMode="decimal"
                style={input}
                value={disposing.proceeds}
                onChange={(event) => setDisposing({ ...disposing, proceeds: event.target.value })}
              />
            </Field>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !disposing.proceeds}
              onClick={async () => {
                const ok = await send(`/api/m/uk-bookkeeping/admin/fixed-assets/${disposing.id}/dispose`, 'POST', {
                  disposedDate: disposing.date,
                  proceeds: disposing.proceeds,
                })
                if (ok) setDisposing(null)
              }}
            >
              Save it
            </button>
            <button type="button" className="btn" onClick={() => setDisposing(null)}>
              Never mind
            </button>
          </div>
          <p style={{ ...muted, margin: '0.75rem 0 0' }}>
            This takes the asset out of the capital allowances pool. The money coming in is an
            ordinary entry and should be recorded as one if it has not been already.
          </p>
        </div>
      )}

      <h2 style={{ fontSize: '1rem', margin: '1.5rem 0 0.75rem' }}>Depreciation</h2>

      <div style={{ ...card, padding: '0.875rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField id="bk-dep-from" label="From" value={range.from} onChange={(from) => setRange({ ...range, from })} />
        <DateField id="bk-dep-to" label="To" value={range.to} onChange={(to) => setRange({ ...range, to })} />
        {canRecord && run && run.lines.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => send('/api/m/uk-bookkeeping/admin/depreciation', 'POST', range)}
          >
            Post {run.total === '0.00' ? 'it' : `£${run.total}`}
          </button>
        )}
      </div>

      {run && run.lines.length === 0 && (
        <EmptyState title="Nothing to charge for those dates.">
          <p style={{ margin: 0 }}>
            {run.skipped.length > 0
              ? 'Every asset was skipped - see the reasons below.'
              : 'Add an asset first, or widen the dates.'}
          </p>
        </EmptyState>
      )}

      {run && run.lines.length > 0 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Asset</th>
                <th style={th}>Worked out as</th>
                <th style={thRight}>Charge</th>
                <th style={thRight}>Worth after</th>
              </tr>
            </thead>
            <tbody>
              {run.lines.map((line) => (
                <tr key={line.assetId}>
                  <td style={td}>{line.description}</td>
                  <td style={{ ...td, ...muted }}>{line.basis}</td>
                  <td style={tdRight}><Money value={line.charge} /></td>
                  <td style={tdRight}><Money value={line.netBookValue} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--color-border)' }}>
                <td style={{ ...td, fontWeight: 600, borderBottom: 'none' }} colSpan={2}>
                  Total
                </td>
                <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={run.total} bold /></td>
                <td style={{ ...tdRight, borderBottom: 'none' }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {run && run.skipped.length > 0 && (
        <div style={{ ...card, padding: '1rem 1.25rem' }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.875rem' }}>Left out of this run</h3>
          <ul style={{ margin: 0, paddingLeft: '1.25rem', ...muted }}>
            {run.skipped.map((item) => (
              <li key={item.assetId}>
                {item.description} - {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  id,
  wide = false,
  children,
}: {
  label: string
  id: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <label htmlFor={id} style={{ display: 'block', ...muted }}>
        {label}
      </label>
      {children}
    </div>
  )
}
