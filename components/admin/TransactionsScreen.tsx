'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { useAdminConfirm } from '@/components/admin/useAdminConfirm'
import {
  BookkeepingNav,
  EmptyState,
  ErrorNotice,
  SandboxBanner,
  TriggerHealthNotice,
  useTriggerHealth,
} from './Notices'
import SearchableSelect from './SearchableSelect'
import { addStrings, formatDate, poundsFromString } from './format'
import {
  EMPTY_FILTERS,
  VAT_RATE_LABELS,
  activePresetKey,
  cleanAmount,
  datePresets,
  describeFilters,
  readFiltersFromUrl,
  toApiQuery,
  toUrlQuery,
  type Filters,
  type SortKey,
} from './transaction-filters'
import { preflightFileError } from '@/modules/uk-bookkeeping/lib/file-kinds'

type Row = {
  id: string
  entry_type: string
  /** Null on a transfer, which is neither money in nor money out. */
  direction: string | null
  /** Whether this row is an entry or a transfer between the business's own accounts. */
  entry_kind: 'entry' | 'transfer'
  transfer_from_name: string | null
  transfer_to_name: string | null
  category_names: string | null
  bank_account_name: string | null
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
  reconciled: boolean
}

type List = {
  rows: Row[]
  total: number
  totals: { net: string; vat: string; gross: string }
  summary: {
    income_gross: string
    income_vat: string
    expense_gross: string
    expense_vat: string
    entries: number
    drafts: number
    needing_evidence: number
  }
}

type SavedView = { name: string; query: string }

const VIEWS_KEY = 'bk-entries-saved-views'
const PAGE_SIZES = [25, 50, 100]

const input: React.CSSProperties = {
  padding: '0.375rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  font: 'inherit',
  fontSize: 'var(--text-sm)',
  minWidth: 0,
}

const label: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs, 0.75rem)',
  color: 'var(--color-text-muted, var(--color-text))',
  marginBottom: '0.1875rem',
}

const muted: React.CSSProperties = { color: 'var(--color-text-muted, var(--color-text))' }

const th: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  background: 'var(--color-surface)',
  zIndex: 1,
  padding: '0.625rem 0.75rem',
  textAlign: 'left',
  fontWeight: 600,
  fontSize: 'var(--text-xs, 0.75rem)',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--color-border)',
}

const money: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

const incomeColour = 'var(--color-success, var(--color-text))'

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

function Pill({ text, colour, title }: { text: string; colour: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        padding: '0 0.4375rem',
        borderRadius: 999,
        border: `1px solid ${colour}`,
        color: colour,
        fontSize: 'var(--text-xs, 0.75rem)',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  )
}

function Tile({
  title,
  value,
  sub,
  colour,
  onClick,
  active,
}: {
  title: string
  value: string
  sub: string
  colour?: string
  onClick?: () => void
  active?: boolean
}) {
  const body = (
    <>
      <span style={{ ...label, marginBottom: '0.25rem' }}>{title}</span>
      <span
        style={{
          display: 'block',
          fontSize: '1.375rem',
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: colour ?? 'var(--color-text)',
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
      <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', ...muted, marginTop: '0.125rem' }}>{sub}</span>
    </>
  )
  const style: React.CSSProperties = {
    padding: '0.75rem 1rem',
    textAlign: 'left',
    font: 'inherit',
    color: 'inherit',
    width: '100%',
    border: active ? '1px solid var(--color-primary, var(--color-text))' : undefined,
  }
  return onClick ? (
    <button type="button" className="card" style={{ ...style, cursor: 'pointer' }} onClick={onClick} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <div className="card" style={style}>
      {body}
    </div>
  )
}

function Chip({ text, onRemove, label: aria }: { text: string; onRemove: () => void; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.125rem 0.25rem 0.125rem 0.625rem',
        borderRadius: 999,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        fontSize: 'var(--text-xs, 0.75rem)',
      }}
    >
      {text}
      <button
        type="button"
        onClick={onRemove}
        aria-label={aria}
        style={{
          border: 0,
          background: 'transparent',
          color: 'var(--color-text-muted, var(--color-text))',
          cursor: 'pointer',
          font: 'inherit',
          padding: '0 0.375rem',
          lineHeight: 1.4,
        }}
      >
        ✕
      </button>
    </span>
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
  const [askConfirm, confirmNode] = useAdminConfirm()
  const health = useTriggerHealth()
  const [list, setList] = useState<List | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([])
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [sort, setSort] = useState<SortKey>('date')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [moreOpen, setMoreOpen] = useState(false)
  const [views, setViews] = useState<SavedView[]>([])
  const [ready, setReady] = useState(false)
  // Typed fields wait for the typing to pause rather than querying on every
  // keystroke; the abort below keeps the result correct, this keeps it polite.
  // The inputs bind to this, and the debounce feeds it into the filters.
  const [typed, setTyped] = useState({ search: '', counterparty: '', minAmount: '', maxAmount: '' })

  const presets = useMemo(() => datePresets(), [])

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = {
        search: typed.search.trim(),
        counterparty: typed.counterparty.trim(),
        minAmount: cleanAmount(typed.minAmount),
        maxAmount: cleanAmount(typed.maxAmount),
      }
      // A typed field only changes because somebody typed, so the page goes
      // back to the first either way; the equality check just spares a refetch.
      setOffset(0)
      setFilters((prev) =>
        prev.search === next.search &&
        prev.counterparty === next.counterparty &&
        prev.minAmount === next.minAmount &&
        prev.maxAmount === next.maxAmount
          ? prev
          : { ...prev, ...next },
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [typed])

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/categories')
      .then((r) => (r.ok ? r.json() : { categories: [] }))
      .then((data) => setCategories(data.categories ?? []))
      .catch(() => setCategories([]))
    fetch('/api/m/uk-bookkeeping/admin/bank-accounts')
      .then((r) => (r.ok ? r.json() : { accounts: [] }))
      .then((data) => setAccounts(data.accounts ?? []))
      .catch(() => setAccounts([]))
  }, [])

  // Filters arrive in the URL - the import screen links to ?status=draft, the
  // overview to ?hasEvidence=0 - and this screen writes them back, so a view is
  // a link. Read once on mount; nothing queries until it has.
  useEffect(() => {
    const read = readFiltersFromUrl(window.location.search)
    /* eslint-disable react-hooks/set-state-in-effect -- one-off URL read on mount */
    setFilters(read.filters)
    setSort(read.sort)
    setDir(read.dir)
    setTyped({
      search: read.filters.search,
      counterparty: read.filters.counterparty,
      minAmount: read.filters.minAmount,
      maxAmount: read.filters.maxAmount,
    })
    if (read.filters.categoryId || read.filters.vatRateCode || read.filters.bankAccountId || read.filters.minAmount || read.filters.maxAmount || read.filters.locked || read.filters.reconciled || read.filters.counterparty) {
      setMoreOpen(true)
    }
    try {
      const saved = JSON.parse(window.localStorage.getItem(VIEWS_KEY) ?? '[]')
      if (Array.isArray(saved)) {
        setViews(saved.filter((v): v is SavedView => typeof v?.name === 'string' && typeof v?.query === 'string'))
      }
    } catch {
      // Private window or blocked storage: saved views are a convenience, not a need.
    }
    setReady(true)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [])

  useEffect(() => {
    if (!ready) return
    const query = toUrlQuery(filters, sort, dir)
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`
    window.history.replaceState(null, '', url)
  }, [filters, sort, dir, ready])

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const query = toApiQuery(filters, sort, dir)
      query.set('limit', String(pageSize))
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
        // The abort is ours - changing a filter cancels the fetch it outran.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError('The entries could not be loaded. Check the connection and try again.')
      }
    },
    [filters, sort, dir, pageSize, offset],
  )

  useEffect(() => {
    if (!ready) return
    // Aborting the stale request on every filter change means a slow response
    // can never land after a fast one and put the wrong rows under the inputs.
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load(controller.signal)
    return () => controller.abort()
  }, [load, ready])

  function change(patch: Partial<Filters>) {
    setOffset(0)
    setFilters((prev) => ({ ...prev, ...patch }))
  }

  function clearAll() {
    setOffset(0)
    setFilters(EMPTY_FILTERS)
    setTyped({ search: '', counterparty: '', minAmount: '', maxAmount: '' })
  }

  function clear(keys: (keyof Filters)[]) {
    const patch: Partial<Filters> = {}
    for (const key of keys) patch[key] = '' as never
    change(patch)
    setTyped((prev) => ({
      search: keys.includes('search') ? '' : prev.search,
      counterparty: keys.includes('counterparty') ? '' : prev.counterparty,
      minAmount: keys.includes('minAmount') ? '' : prev.minAmount,
      maxAmount: keys.includes('maxAmount') ? '' : prev.maxAmount,
    }))
  }

  function sortBy(key: SortKey) {
    setOffset(0)
    if (sort === key) {
      setDir(dir === 'asc' ? 'desc' : 'asc')
    } else {
      setSort(key)
      // Dates and amounts are most useful newest/biggest first; names A to Z.
      setDir(key === 'who' ? 'asc' : 'desc')
    }
  }

  function persistViews(next: SavedView[]) {
    setViews(next)
    try {
      window.localStorage.setItem(VIEWS_KEY, JSON.stringify(next))
    } catch {
      // Not saved beyond this tab; the view still works.
    }
  }

  function saveView() {
    const name = window.prompt('Name this view')?.trim()
    if (!name) return
    persistViews([...views.filter((v) => v.name !== name), { name, query: toUrlQuery(filters, sort, dir) }])
  }

  function openView(view: SavedView) {
    const read = readFiltersFromUrl(`?${view.query}`)
    setOffset(0)
    setFilters(read.filters)
    setSort(read.sort)
    setDir(read.dir)
    setTyped({
      search: read.filters.search,
      counterparty: read.filters.counterparty,
      minAmount: read.filters.minAmount,
      maxAmount: read.filters.maxAmount,
    })
  }

  const lookups = useMemo(
    () => ({
      categories: new Map(categories.map((c) => [c.id, c.name])),
      accounts: new Map(accounts.map((a) => [a.id, a.name])),
    }),
    [categories, accounts],
  )
  const chips = describeFilters(filters, lookups, formatDate)
  const presetKey = activePresetKey(filters, presets)

  // Reviewing an import in bulk: only offered while the list is filtered to
  // drafts, so a stray tick can never post or delete a real record.
  const draftMode = canRecord && filters.status === 'draft'
  // Ticking is offered whenever entries can be changed at all, because attaching
  // one file to several of them is harmless on a recorded entry too - a monthly
  // statement of card fees belongs on every fee the payouts recorded. Recording
  // and removing stay behind draftMode.
  const ticking = canRecord
  // A transfer is a journal, not an entry, and an entry in a filed or finalised
  // VAT return keeps its evidence as it is - no tick box for either, so a tick
  // can only ever mean something that will work.
  const tickable = (row: Row): boolean =>
    row.entry_kind !== 'transfer' && !row.locked_period_id && !row.finalised_period_id
  const attachInput = useRef<HTMLInputElement | null>(null)

  /** One file, attached to every ticked entry, stored once. */
  async function attachToTicked(file: File | undefined) {
    if (attachInput.current) attachInput.current.value = ''
    if (!file || selected.size === 0) return
    const reason = preflightFileError(file)
    if (reason) {
      setError(reason)
      return
    }
    setBulkBusy(true)
    setError(null)
    setNotice(null)
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('name', file.name)
      body.append('ids', JSON.stringify([...selected]))
      const response = await fetch('/api/m/uk-bookkeeping/admin/transactions/bulk/attachments', {
        method: 'POST',
        body,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? `“${file.name}” could not be attached.`)
        return
      }
      const done = Number(payload.done ?? 0)
      const failed: { error: string }[] = payload.failed ?? []
      setNotice(
        `“${file.name}” attached to ${done} entr${done === 1 ? 'y' : 'ies'}.` +
          (failed.length ? ` ${failed.length} could not take it: ${failed[0]!.error}` : ''),
      )
      await load()
    } catch {
      setError(`“${file.name}” did not reach the server. Check the connection and try again.`)
    } finally {
      setBulkBusy(false)
    }
  }

  async function bulk(action: 'post' | 'delete') {
    if (selected.size === 0) return
    if (
      action === 'delete' &&
      !(await askConfirm({
        title: `Remove ${selected.size} draft entr${selected.size === 1 ? 'y' : 'ies'}?`,
        message: 'They have not been recorded, so nothing else changes.',
        confirmLabel: 'Remove',
      }))
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

  const summary = list?.summary
  const net = summary ? addStrings(summary.income_gross, `-${summary.expense_gross}`) : '0.00'
  const netNegative = net.startsWith('-')
  const pageCount = list ? Math.max(1, Math.ceil(list.total / pageSize)) : 1
  const pageNumber = Math.floor(offset / pageSize) + 1
  const sortMark = (key: SortKey) => (sort === key ? (dir === 'asc' ? ' ▲' : ' ▼') : '')
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
  const sortButton: React.CSSProperties = {
    border: 0,
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textTransform: 'inherit',
    letterSpacing: 'inherit',
    cursor: 'pointer',
    padding: 0,
  }
  const columns = 7 + (ticking ? 1 : 0)

  const directionTabs: { value: Filters['direction']; text: string }[] = [
    { value: '', text: 'All' },
    { value: 'income', text: 'Money in' },
    { value: 'expense', text: 'Money out' },
    { value: 'transfer', text: 'Transfers' },
  ]

  return (
    <div>
      {confirmNode}
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

      {/* What the filtered set adds up to. Always the whole set, not the page. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 11rem), 1fr))',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <Tile
          title="Money in"
          value={summary ? poundsFromString(summary.income_gross) : '…'}
          sub={summary ? `${poundsFromString(summary.income_vat)} VAT` : ' '}
          colour={incomeColour}
          onClick={() => change({ direction: filters.direction === 'income' ? '' : 'income' })}
          active={filters.direction === 'income'}
        />
        <Tile
          title="Money out"
          value={summary ? poundsFromString(summary.expense_gross) : '…'}
          sub={summary ? `${poundsFromString(summary.expense_vat)} VAT` : ' '}
          onClick={() => change({ direction: filters.direction === 'expense' ? '' : 'expense' })}
          active={filters.direction === 'expense'}
        />
        <Tile
          title="Difference"
          value={summary ? poundsFromString(net) : '…'}
          sub={summary ? (netNegative ? 'More out than in' : 'More in than out') : ' '}
          colour={netNegative ? 'var(--color-danger, var(--color-text))' : incomeColour}
        />
        <Tile
          title="Waiting for review"
          value={summary ? String(summary.drafts) : '…'}
          sub={summary && summary.drafts > 0 ? 'Show these' : 'Nothing to review'}
          colour={summary && summary.drafts > 0 ? 'var(--color-warning, var(--color-text))' : undefined}
          onClick={() => change({ status: filters.status === 'draft' ? '' : 'draft' })}
          active={filters.status === 'draft'}
        />
        <Tile
          title="Still need a receipt"
          value={summary ? String(summary.needing_evidence) : '…'}
          sub={summary && summary.needing_evidence > 0 ? 'Show these' : 'All covered'}
          colour={summary && summary.needing_evidence > 0 ? 'var(--color-warning, var(--color-text))' : undefined}
          onClick={() => change({ evidence: filters.evidence === '0' ? '' : '0' })}
          active={filters.evidence === '0'}
        />
      </div>

      <div className="card" style={{ padding: '0.875rem', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.625rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 14rem' }}>
            <label htmlFor="bk-f-search" style={label}>Search</label>
            <input
              id="bk-f-search"
              type="search"
              style={{ ...input, width: '100%' }}
              value={typed.search}
              placeholder="Who, what for, reference…"
              onChange={(e) => setTyped({ ...typed, search: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="bk-f-range" style={label}>When</label>
            <select
              id="bk-f-range"
              style={input}
              value={presetKey}
              onChange={(e) => {
                const key = e.target.value
                if (key === 'all') change({ from: '', to: '' })
                else if (key === 'custom') setMoreOpen(true)
                else {
                  const preset = presets.find((p) => p.key === key)
                  if (preset) change({ from: preset.from, to: preset.to })
                }
              }}
            >
              <option value="all">All time</option>
              {presets.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
              {presetKey === 'custom' && <option value="custom">Custom dates</option>}
            </select>
          </div>
          <div>
            <label htmlFor="bk-f-from" style={label}>From</label>
            <input id="bk-f-from" type="date" style={input} value={filters.from} onChange={(e) => change({ from: e.target.value })} />
          </div>
          <div>
            <label htmlFor="bk-f-to" style={label}>To</label>
            <input id="bk-f-to" type="date" style={input} value={filters.to} onChange={(e) => change({ to: e.target.value })} />
          </div>
          <div>
            <label htmlFor="bk-f-category" style={label}>Category</label>
            <SearchableSelect
              id="bk-f-category"
              style={{ ...input, width: '14rem' }}
              value={filters.categoryId}
              onChange={(categoryId) => change({ categoryId })}
              emptyLabel="All"
              options={categories.map((category) => ({ value: category.id, label: category.name }))}
            />
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(!moreOpen)}
            >
              {moreOpen ? 'Fewer filters' : 'More filters'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              title="Download every entry as a spreadsheet"
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

        {moreOpen && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr))',
              gap: '0.625rem',
              marginTop: '0.75rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <div>
              <label htmlFor="bk-f-status" style={label}>State</label>
              <select id="bk-f-status" style={{ ...input, width: '100%' }} value={filters.status} onChange={(e) => change({ status: e.target.value as Filters['status'] })}>
                <option value="">All</option>
                <option value="posted">Recorded</option>
                <option value="draft">Waiting for review</option>
              </select>
            </div>
            <div>
              <label htmlFor="bk-f-evidence" style={label}>Receipt</label>
              {/* One box, two filters underneath it. "Still needs one" is the
                  question anybody actually asks, and it is not the same as "no
                  receipt" now that an entry can say none is coming. */}
              <select id="bk-f-evidence" style={{ ...input, width: '100%' }} value={filters.evidence} onChange={(e) => change({ evidence: e.target.value as Filters['evidence'] })}>
                <option value="">All</option>
                <option value="1">Has a receipt</option>
                <option value="0">Still needs one</option>
                <option value="x">None needed</option>
              </select>
            </div>
            <div>
              <label htmlFor="bk-f-reconciled" style={label}>Bank statement</label>
              <select id="bk-f-reconciled" style={{ ...input, width: '100%' }} value={filters.reconciled} onChange={(e) => change({ reconciled: e.target.value as Filters['reconciled'] })}>
                <option value="">All</option>
                <option value="1">Reconciled</option>
                <option value="0">Not reconciled</option>
              </select>
            </div>
            <div>
              <label htmlFor="bk-f-locked" style={label}>Filed</label>
              <select id="bk-f-locked" style={{ ...input, width: '100%' }} value={filters.locked} onChange={(e) => change({ locked: e.target.value as Filters['locked'] })}>
                <option value="">All</option>
                <option value="1">On a filed return</option>
                <option value="0">Not filed yet</option>
              </select>
            </div>
            <div>
              <label htmlFor="bk-f-vat" style={label}>VAT rate</label>
              <select id="bk-f-vat" style={{ ...input, width: '100%' }} value={filters.vatRateCode} onChange={(e) => change({ vatRateCode: e.target.value })}>
                <option value="">All</option>
                {Object.entries(VAT_RATE_LABELS).map(([code, text]) => (
                  <option key={code} value={code}>{text}</option>
                ))}
              </select>
            </div>
            {accounts.length > 0 && (
              <div>
                <label htmlFor="bk-f-account" style={label}>Bank account</label>
                <select id="bk-f-account" style={{ ...input, width: '100%' }} value={filters.bankAccountId} onChange={(e) => change({ bankAccountId: e.target.value })}>
                  <option value="">All</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>{account.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="bk-f-counterparty" style={label}>Who with</label>
              <input id="bk-f-counterparty" style={{ ...input, width: '100%' }} value={typed.counterparty} placeholder="Any" onChange={(e) => setTyped({ ...typed, counterparty: e.target.value })} />
            </div>
            <div>
              <label htmlFor="bk-f-min" style={label}>Total from (£)</label>
              <input id="bk-f-min" inputMode="decimal" style={{ ...input, width: '100%' }} value={typed.minAmount} placeholder="0.00" onChange={(e) => setTyped({ ...typed, minAmount: e.target.value })} />
            </div>
            <div>
              <label htmlFor="bk-f-max" style={label}>Total up to (£)</label>
              <input id="bk-f-max" inputMode="decimal" style={{ ...input, width: '100%' }} value={typed.maxAmount} placeholder="Any" onChange={(e) => setTyped({ ...typed, maxAmount: e.target.value })} />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div role="group" aria-label="Money in or out" style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
          {directionTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={filters.direction === tab.value}
              onClick={() => change({ direction: tab.value })}
              style={{
                border: 0,
                borderRight: '1px solid var(--color-border)',
                padding: '0.3125rem 0.75rem',
                font: 'inherit',
                fontSize: 'var(--text-sm)',
                cursor: 'pointer',
                background: filters.direction === tab.value ? 'var(--color-primary, var(--color-text))' : 'var(--color-bg)',
                color: filters.direction === tab.value ? 'var(--color-bg)' : 'var(--color-text)',
              }}
            >
              {tab.text}
            </button>
          ))}
        </div>
        {chips.map((chip) => (
          <Chip key={chip.key + chip.label} text={chip.label} label={`Remove the filter: ${chip.label}`} onRemove={() => clear(chip.clears)} />
        ))}
        {chips.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={clearAll}>Clear all</button>
        )}
        <span style={{ flex: 1 }} />
        {views.length > 0 && (
          <select
            aria-label="Saved views"
            style={input}
            value=""
            onChange={(e) => {
              const view = views.find((v) => v.name === e.target.value)
              if (view) openView(view)
            }}
          >
            <option value="">Saved views…</option>
            {views.map((view) => (
              <option key={view.name} value={view.name}>{view.name}</option>
            ))}
          </select>
        )}
        {chips.length > 0 && (
          <button type="button" className="btn btn-sm" onClick={saveView}>Save this view</button>
        )}
        {views.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            title="Delete a saved view"
            onClick={() => {
              const name = window.prompt(`Delete which view?\n${views.map((v) => v.name).join('\n')}`)?.trim()
              if (name) persistViews(views.filter((v) => v.name !== name))
            }}
          >
            Delete a view
          </button>
        )}
      </div>

      {!list && !error && <LoadingRows />}

      {list && list.rows.length === 0 && chips.length > 0 && (
        <EmptyState title="Nothing matches those filters.">
          <button type="button" className="btn btn-sm" onClick={clearAll}>Clear the filters</button>
        </EmptyState>
      )}

      {list && list.rows.length === 0 && chips.length === 0 && (
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

      {(draftMode || selected.size > 0) && list && list.rows.length > 0 && (
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
            {selected.size > 0 &&
              ` - ${poundsFromString(
                list.rows.filter((r) => selected.has(r.id)).reduce((sum, r) => addStrings(sum, r.gross_total), '0'),
              )} total`}
          </span>
          <span style={{ flex: 1 }} />
          <input
            ref={attachInput}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            aria-label="File to attach to the ticked entries"
            style={{ display: 'none' }}
            onChange={(e) => attachToTicked(e.target.files?.[0])}
          />
          <button
            className="btn btn-sm"
            disabled={bulkBusy || selected.size === 0}
            title="One file - a monthly statement, say - as evidence for every ticked entry"
            onClick={() => attachInput.current?.click()}
          >
            Attach a file to these
          </button>
          {draftMode && (
            <>
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
            </>
          )}
        </div>
      )}

      {list && list.rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: '52rem', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr>
                {ticking && (
                  <th style={{ ...th, width: '2rem' }}>
                    <input
                      type="checkbox"
                      aria-label="Tick every entry on this page"
                      checked={selected.size > 0 && selected.size === list.rows.filter(tickable).length}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(list.rows.filter(tickable).map((r) => r.id)) : new Set())
                      }
                    />
                  </th>
                )}
                <th style={th} aria-sort={ariaSort('date')}>
                  <button type="button" style={sortButton} onClick={() => sortBy('date')}>Date{sortMark('date')}</button>
                </th>
                <th style={th} aria-sort={ariaSort('who')}>
                  <button type="button" style={sortButton} onClick={() => sortBy('who')}>Who and what for{sortMark('who')}</button>
                </th>
                <th style={th}>Category</th>
                <th style={{ ...th, textAlign: 'right' }}>Before VAT</th>
                <th style={{ ...th, textAlign: 'right' }}>VAT</th>
                <th style={{ ...th, textAlign: 'right' }} aria-sort={ariaSort('amount')}>
                  <button type="button" style={sortButton} onClick={() => sortBy('amount')}>Total{sortMark('amount')}</button>
                </th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => {
                const isTransfer = row.entry_kind === 'transfer'
                const sign = row.direction === 'income' ? '' : '-'
                const colour = isTransfer ? undefined : row.direction === 'income' ? incomeColour : undefined
                return (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)', verticalAlign: 'top' }}>
                    {ticking && (
                      <td style={{ padding: '0.5rem 0.75rem' }}>
                        {!tickable(row) ? null : (
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
                    <td style={{ padding: '0.5rem 0.75rem', maxWidth: '26rem' }}>
                      <a
                        href={
                          isTransfer
                            ? `/${adminPath}/m/uk-bookkeeping/transfers/${row.id}`
                            : `/${adminPath}/m/uk-bookkeeping/transactions/${row.id}`
                        }
                        style={{ fontWeight: 500 }}
                      >
                        {row.counterparty}
                      </a>
                      <div style={{ ...muted, fontSize: 'var(--text-xs, 0.75rem)', overflowWrap: 'anywhere' }}>
                        {isTransfer
                          ? `${row.transfer_from_name ?? '?'} → ${row.transfer_to_name ?? '?'}`
                          : [row.description, row.reference, row.bank_account_name].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem' }}>
                      {isTransfer ? <span style={muted}>Transfer</span> : (row.category_names ?? '—')}
                    </td>
                    <td style={{ ...money, color: colour }}>
                      {isTransfer ? '—' : `${sign}${poundsFromString(row.net_total)}`}
                    </td>
                    <td style={{ ...money, color: colour }}>
                      {isTransfer ? '—' : `${sign}${poundsFromString(row.vat_total)}`}
                    </td>
                    <td style={{ ...money, color: colour, fontWeight: 600 }}>
                      {isTransfer ? poundsFromString(row.gross_total) : `${sign}${poundsFromString(row.gross_total)}`}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem' }}>
                      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                        {row.status === 'draft' && (
                          <Pill text="Review" colour="var(--color-warning, var(--color-text))" title="Waiting for review - not recorded yet" />
                        )}
                        {row.entry_type === 'adjustment' && (
                          <Pill text="Correction" colour="var(--color-text-muted, var(--color-text))" />
                        )}
                        {row.locked_period_id && (
                          <Pill text="Filed" colour="var(--color-success, var(--color-text))" title="On a filed return" />
                        )}
                        {!isTransfer && (
                          <Pill
                            text={row.reconciled ? 'Reconciled' : 'Unreconciled'}
                            colour={row.reconciled ? 'var(--color-success, var(--color-text))' : 'var(--color-text-muted, var(--color-text))'}
                            title={row.reconciled ? 'Matched to a bank statement line' : 'Not matched to a bank statement line yet'}
                          />
                        )}
                        {isTransfer ? (
                          <Pill text="No receipt needed" colour="var(--color-text-muted, var(--color-text))" />
                        ) : (
                          row.attachment_count > 0 ? (
                            <Pill
                              text={`📎 ${row.attachment_count}`}
                              colour="var(--color-text-muted, var(--color-text))"
                              title={`${row.attachment_count} receipt${row.attachment_count === 1 ? '' : 's'} attached`}
                            />
                          ) : row.evidence_not_required ? (
                            // Grey rather than red: "dealt with, nothing to do"
                            // reads differently from "nobody has looked yet".
                            <Pill text="No receipt needed" colour="var(--color-text-muted, var(--color-text))" />
                          ) : (
                            <Pill text="Needs receipt" colour="var(--color-danger, var(--color-text))" />
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--color-surface)' }}>
                <td colSpan={columns - 4} style={{ padding: '0.625rem 0.75rem', fontWeight: 600 }}>
                  {list.total} entr{list.total === 1 ? 'y' : 'ies'}
                  {list.total > list.rows.length && <span style={{ ...muted, fontWeight: 400 }}> (totals cover all of them)</span>}
                </td>
                <td style={{ ...money, fontWeight: 600 }}>{poundsFromString(list.totals.net)}</td>
                <td style={{ ...money, fontWeight: 600 }}>{poundsFromString(list.totals.vat)}</td>
                <td style={{ ...money, fontWeight: 600 }}>{poundsFromString(list.totals.gross)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {list && list.total > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
            Back
          </button>
          <span style={{ fontSize: 'var(--text-sm)' }}>
            {offset + 1} to {Math.min(offset + pageSize, list.total)} of {list.total} (page {pageNumber} of {pageCount})
          </span>
          <button
            className="btn btn-sm"
            disabled={offset + pageSize >= list.total}
            onClick={() => setOffset(offset + pageSize)}
          >
            Next
          </button>
          <span style={{ flex: 1 }} />
          <label htmlFor="bk-f-size" style={{ ...label, margin: 0 }}>Per page</label>
          <select
            id="bk-f-size"
            style={input}
            value={pageSize}
            onChange={(e) => {
              setOffset(0)
              setPageSize(Number(e.target.value))
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
