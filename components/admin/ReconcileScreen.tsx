'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { addStrings, formatDate, poundsFromString } from './format'

// Reconciliation: does what the bank says match what the books say.
//
// This is where a statement is turned into a set of books, so it carries the
// whole of that job rather than half of it. Per line: tick it off against an
// entry already recorded, record a new entry from it, or set it aside. And the
// same three things for a whole selection at once, because a statement is full
// of lines that are alike - nine director's loan repayments, a year of the same
// subscription - and coding those one at a time is what made people give up.
//
// A line is only ticked off when the entries matched to it account for the whole
// of it, because "£2 of this is unexplained" is exactly the kind of thing that
// turns out to be a £2,000 typo.

type MatchCandidate = {
  transactionId: string
  counterparty: string
  date: string
  reference: string | null
  status: 'draft' | 'posted'
  gross: string
  score: number
  reasons: string[]
}

type BankTransaction = {
  id: string
  date: string
  details: string
  counterparty: string
  reference: string | null
  transaction_type: string | null
  amount: string
  statement_balance: string | null
  status: 'unreconciled' | 'reconciled' | 'ignored'
  ignored_reason: string | null
  matched_total: string
  match_count: number
}

type MatchedEntry = {
  transactionId: string
  counterparty: string
  date: string
  amount: string
  method: string
  locked: boolean
}

type Summary = {
  statementLines: number
  reconciledLines: number
  ignoredLines: number
  unreconciledLines: number
  statementTotal: string
  reconciledTotal: string
  unreconciledTotal: string
  unmatchedEntryCount: number
  unmatchedEntryTotal: string
}

type BankAccount = {
  id: string
  name: string
  account_last4: string | null
  position_summary: {
    openingBalance: string
    statementBalance: string
    lastStatementDate: string | null
    unreconciledCount: number
    unreconciledTotal: string
  }
}

/**
 * A receipt sitting unfiled in the inbox that might be what this payment was
 * for. Different from a MatchCandidate in the one way that matters: accepting a
 * MatchCandidate ties this line to an entry that already exists, whereas
 * accepting one of these WRITES the entry, from what the document says, with
 * the document attached to it.
 */
type DocumentCandidate = {
  documentId: string
  name: string
  scanStatus: string
  counterparty: string | null
  counterpartyConfidence: number
  documentDate: string | null
  documentNumber: string | null
  net: string | null
  vat: string | null
  total: string | null
  vatRateCode: string | null
  direction: 'income' | 'expense' | null
  score: number
  reasons: string[]
}

type Feed = {
  rows: BankTransaction[]
  total: number
  suggestions: Record<string, MatchCandidate[]>
  documentSuggestions: Record<string, DocumentCandidate[]>
  documentsTruncated?: boolean
  categoryGuesses: Record<string, string>
  summary: Summary | null
}

type Category = { id: string; code: string; name: string; direction: string }

type SettlementCandidate = {
  transactionId: string
  counterparty: string
  date: string
  reference: string | null
  status: 'draft' | 'posted'
  direction: 'income' | 'expense'
  outstanding: string
  /** Signed the way the bank sees it: a refund netted off a payout is negative. */
  contribution: string
}

type BulkOutcome = { done: number; failed: { id: string; error: string }[] }

const PAGE_SIZE = 100

const VAT_CHOICES: { code: string; label: string }[] = [
  { code: 'zero', label: 'No VAT' },
  { code: 'standard', label: 'Standard rate (20%)' },
  { code: 'reduced', label: 'Reduced rate (5%)' },
  { code: 'exempt', label: 'Exempt' },
  { code: 'outside_scope', label: 'Outside the scope of VAT' },
]

/** Decimal strings only, never a float - the same rule the server keeps. */
function negated(value: string): string {
  return value.startsWith('-') ? value.slice(1) : `-${value}`
}

const headStyle: React.CSSProperties = { padding: '0.625rem 0.75rem', textAlign: 'left' }
const cellStyle: React.CSSProperties = { padding: '0.625rem 0.75rem', verticalAlign: 'top' }
const controlStyle: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontSize: 'var(--text-sm)',
  maxWidth: '100%',
}

export default function ReconcileScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const [accounts, setAccounts] = useState<BankAccount[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accountId, setAccountId] = useState('')
  const [status, setStatus] = useState<'unreconciled' | 'reconciled' | 'ignored' | ''>('unreconciled')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [feed, setFeed] = useState<Feed | null>(null)
  const [matches, setMatches] = useState<Record<string, MatchedEntry[]>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [rowCategory, setRowCategory] = useState<Record<string, string>>({})
  const [bulkCategory, setBulkCategory] = useState('')
  const [vatRateCode, setVatRateCode] = useState('zero')
  const [leaveForReview, setLeaveForReview] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<
    (BulkOutcome & { what: string; attempted: number; leftNote: string }) | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [openLine, setOpenLine] = useState<string | null>(null)
  const [settleLine, setSettleLine] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/bank-accounts')
      .then((response) => (response.ok ? response.json() : { accounts: [] }))
      .then((data) => {
        setAccounts(data.accounts ?? [])
        if ((data.accounts ?? []).length > 0) setAccountId(data.accounts[0].id)
      })
      .catch(() => undefined)

    fetch('/api/m/uk-bookkeeping/admin/categories')
      .then((response) => (response.ok ? response.json() : { categories: [] }))
      .then((data) => setCategories(data.categories ?? []))
      .catch(() => undefined)
  }, [])

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!accountId) return
      const params = new URLSearchParams({
        bankAccountId: accountId,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      })
      if (status) params.set('status', status)
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (search.trim()) params.set('search', search.trim())

      try {
        const response = await fetch(`/api/m/uk-bookkeeping/admin/bank-transactions?${params}`, { signal })
        const payload = await response.json().catch(() => ({}))
        if (signal?.aborted) return
        if (!response.ok) {
          setError(payload.error ?? 'Those could not be loaded.')
          return
        }
        setError(null)
        setFeed(payload)
        // A category already picked on every line we have a guess for, so the
        // commonest case is one click rather than a rummage through the list.
        setRowCategory((current) => ({ ...(payload.categoryGuesses ?? {}), ...current }))
      } catch (error_) {
        // The abort is ours - changing a filter cancels the fetch it outran.
        if (error_ instanceof DOMException && error_.name === 'AbortError') return
        setError('The statement lines did not load. Check the connection and try again.')
      }
    },
    [accountId, status, from, to, search, offset],
  )

  useEffect(() => {
    // Aborting the stale request on every filter change means a slow response
    // can never land after a fast one and put the wrong lines under the inputs.
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  /**
   * Changing what is listed clears the ticks and goes back to the first page.
   *
   * A selection made against the old list is a set of ids that may not be on
   * screen any more, and acting on those is how the wrong nine payments get
   * coded as director's loan.
   */
  function changeView(apply: () => void): void {
    apply()
    setOffset(0)
    setSelected(new Set())
  }

  async function act(id: string, body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/bank-transactions/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'That could not be done.')
        return
      }
      setMatches((current) => ({ ...current, [id]: payload.matches ?? [] }))
      if (payload.settled) {
        setSettleLine(null)
        setOutcome({
          done: payload.settled.matched,
          failed: [],
          what: 'settled against this line',
          attempted: payload.settled.matched,
          leftNote: 'were left as they were',
        })
      }
      // The line's status has moved, so the list it belongs in has changed with
      // it. Reload rather than patching the row in place and hoping.
      await load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Every bulk action, and the single-line buttons that share their code path.
   *
   * `leftNote` covers the lines that were neither done nor refused - the ones a
   * given action simply had nothing to do to. Those are not failures and are not
   * listed one by one, but they are still counted out loud, because "38 done"
   * out of 40 with no word about the other two is how lines go missing.
   */
  async function bulk(ids: string[], body: Record<string, unknown>, what: string, leftNote: string) {
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/bank-transactions/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ids }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'That could not be done.')
        return
      }
      setOutcome({
        done: payload.done ?? 0,
        failed: payload.failed ?? [],
        what,
        attempted: ids.length,
        leftNote,
      })
      setSelected(new Set())
      setReason('')
      await load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  /**
   * "That invoice is what this was." One click, one finished entry.
   *
   * The amount and the day the money moved come from the bank; the supplier, the
   * invoice number, the tax point and the VAT come from the document; the
   * category comes from whichever one is showing on the row. The document ends
   * up attached to the entry it paid for.
   */
  async function recordFromDocument(rowId: string, documentId: string, categoryId: string) {
    setBusy(true)
    setError(null)
    setOutcome(null)
    try {
      const response = await fetch(
        `/api/m/uk-bookkeeping/admin/bank-transactions/${rowId}/record-from-document`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            documentId,
            categoryId,
            vatRateCode,
            status: leaveForReview ? 'draft' : 'posted',
          }),
        },
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'That could not be recorded.')
        return
      }
      setOutcome({
        done: 1,
        failed: [],
        // Worth saying out loud which way the VAT went: a figure taken off the
        // supplier's own invoice and a figure worked out from a rate are two
        // different claims about box 4.
        what: payload.usedDocumentFigures
          ? 'recorded, with the VAT exactly as the invoice has it'
          : 'recorded from the receipt',
        attempted: 1,
        leftNote: 'were left as they were',
      })
      await load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function openMatches(id: string) {
    setOpenLine(openLine === id ? null : id)
    if (matches[id]) return
    const response = await fetch(`/api/m/uk-bookkeeping/admin/bank-transactions/${id}`)
    if (!response.ok) return
    const payload = await response.json()
    setMatches((current) => ({ ...current, [id]: payload.matches ?? [] }))
  }

  const rows = feed?.rows ?? []
  const selectedRows = rows.filter((row) => selected.has(row.id))

  // Which categories every selected line could take. A selection with money in
  // and money out in it can only be coded to something that takes both, and
  // offering the rest would only produce refusals a line at a time.
  const bulkCategories = useMemo(() => {
    const directions = new Set<string>(
      selectedRows.map((row) => (row.amount.startsWith('-') ? 'expense' : 'income')),
    )
    return categories.filter(
      (category) =>
        category.direction === 'both' ||
        (directions.size === 1 && directions.has(category.direction)),
    )
  }, [categories, selectedRows])

  const suggestedInSelection = selectedRows.filter(
    (row) => row.status === 'unreconciled' && (feed?.suggestions[row.id]?.length ?? 0) > 0,
  ).length

  if (accounts.length === 0) {
    return (
      <div>
        <BookkeepingNav active="reconcile" />
        <SandboxBanner environment={environment} />
        <EmptyState title="No accounts yet.">
          <p style={{ margin: 0 }}>
            Add the account your money sits in under{' '}
            <a href={`/${adminPath}/settings?tab=uk-bookkeeping`}>the bookkeeping settings</a>, then{' '}
            <a href={`/${adminPath}/m/uk-bookkeeping/import`}>import a statement</a> for it. Once there is
            a statement to compare against, this is where you tick it off.
          </p>
        </EmptyState>
      </div>
    )
  }

  const account = accounts.find((item) => item.id === accountId)

  return (
    <div>
      <BookkeepingNav active="reconcile" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {/*
        Said out loud rather than swallowed. A cap that quietly stops looking
        reads as "there is no invoice for this payment", which is a different
        and much worse statement than "we did not look at all of them".
      */}
      {feed?.documentsTruncated && (
        <div
          className="card"
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            fontSize: 'var(--text-sm)',
            color: 'var(--color-text-muted, var(--color-text))',
          }}
          role="status"
        >
          There are more unfiled receipts than we look through in one go, so only the most recent
          few hundred were offered against these lines. Filing some of them from the Receipts tab
          will bring the rest into view.
        </div>
      )}

      {outcome && <Outcome outcome={outcome} rows={rows} onDismiss={() => setOutcome(null)} />}

      <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>Account</span>
            <select
              value={accountId}
              onChange={(event) => changeView(() => setAccountId(event.target.value))}
              style={controlStyle}
            >
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.account_last4 ? ` (…${item.account_last4})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>Show</span>
            <select
              value={status}
              onChange={(event) => changeView(() => setStatus(event.target.value as typeof status))}
              style={controlStyle}
            >
              <option value="unreconciled">Still to explain</option>
              <option value="reconciled">Ticked off</option>
              <option value="ignored">Set aside</option>
              <option value="">Everything</option>
            </select>
          </label>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>From</span>
            <input
              type="date"
              value={from}
              onChange={(event) => changeView(() => setFrom(event.target.value))}
              style={controlStyle}
            />
          </label>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>To</span>
            <input
              type="date"
              value={to}
              onChange={(event) => changeView(() => setTo(event.target.value))}
              style={controlStyle}
            />
          </label>
          <label style={{ fontSize: 'var(--text-sm)', flex: '1 1 14rem' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>Find</span>
            <input
              type="search"
              value={search}
              placeholder="Part of what the bank printed"
              onChange={(event) => changeView(() => setSearch(event.target.value))}
              style={{ ...controlStyle, width: '100%' }}
            />
          </label>
        </div>
        <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
          Searching is how you get all the alike ones together - type the name the bank prints on your
          director&rsquo;s loan payments, tick the lot, and code them in one go.
        </p>
      </div>

      {account && feed?.summary && <Position account={account} summary={feed.summary} />}

      {canRecord && rows.length > 0 && (
        <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <span style={{ fontSize: 'var(--text-sm)', alignSelf: 'center' }}>
              <strong>{selected.size}</strong> of {rows.length} ticked
            </span>

            <label style={{ fontSize: 'var(--text-sm)' }}>
              <span style={{ display: 'block', marginBottom: '0.25rem' }}>What they were for</span>
              <select
                value={bulkCategory}
                onChange={(event) => setBulkCategory(event.target.value)}
                disabled={selected.size === 0}
                style={controlStyle}
              >
                <option value="">Choose a category</option>
                {bulkCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Not disabled with an empty selection: the per-line "Record it as
                this" buttons use this rate and this tick box too, so locking them
                out would mean a single line could only ever be recorded with no
                VAT on it. */}
            <label style={{ fontSize: 'var(--text-sm)' }}>
              <span style={{ display: 'block', marginBottom: '0.25rem' }}>VAT on what you record</span>
              <select
                value={vatRateCode}
                onChange={(event) => setVatRateCode(event.target.value)}
                style={controlStyle}
              >
                {VAT_CHOICES.map((choice) => (
                  <option key={choice.code} value={choice.code}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || selected.size === 0 || !bulkCategory}
              onClick={() =>
                bulk(
                  [...selected],
                  { action: 'record', categoryId: bulkCategory, vatRateCode, leaveForReview },
                  'recorded',
                  'were left as they were',
                )
              }
            >
              {busy ? 'Working…' : `Record ${selected.size || ''}`.trim()}
            </button>

            <label style={{ fontSize: 'var(--text-sm)', alignSelf: 'center', display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={leaveForReview}
                onChange={(event) => setLeaveForReview(event.target.checked)}
              />
              Leave them for review
            </label>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.75rem' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || suggestedInSelection === 0}
              onClick={() =>
                bulk(
                  [...selected],
                  { action: 'accept-suggested' },
                  'ticked off',
                  'had nothing in the books sure enough to match, so they are still waiting',
                )
              }
            >
              Tick off the ones we are sure about
              {suggestedInSelection > 0 ? ` (${suggestedInSelection})` : ''}
            </button>
            <input
              aria-label="Why these lines are being set aside"
              placeholder="Why they need no entry"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              style={{ ...controlStyle, minWidth: 200 }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || selected.size === 0}
              onClick={() =>
                bulk([...selected], { action: 'ignore', reason }, 'set aside', 'were already set aside')
              }
            >
              Set aside
            </button>
            {status === 'ignored' && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || selected.size === 0}
                onClick={() =>
                  bulk([...selected], { action: 'unignore' }, 'put back', 'were not set aside anyway')
                }
              >
                Put back
              </button>
            )}
          </div>

          <p style={{ margin: '0.625rem 0 0', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Recording takes the date, the name and the amount straight off the bank&rsquo;s own line. The
            VAT rate and &ldquo;leave them for review&rdquo; apply to the buttons on the lines below as
            well as to a whole selection. Left for review, entries go in as drafts and reach no VAT return
            until you post them.
          </p>
        </div>
      )}

      {feed && rows.length === 0 && (
        <EmptyState title={status === 'unreconciled' ? 'Nothing left to explain.' : 'Nothing here.'}>
          <p style={{ margin: 0 }}>
            {status === 'unreconciled'
              ? 'Every line on this account is either ticked off against an entry or set aside. That is the whole point of the exercise, so: well done.'
              : 'Try a different filter, or import a statement for this account.'}
          </p>
        </EmptyState>
      )}

      {rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                {canRecord && (
                  <th style={{ ...headStyle, width: '2rem' }}>
                    <input
                      type="checkbox"
                      aria-label="Tick every line on this page"
                      checked={selected.size > 0 && selected.size === rows.length}
                      onChange={(event) =>
                        setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())
                      }
                    />
                  </th>
                )}
                <th style={headStyle}>Date</th>
                <th style={headStyle}>What the bank says</th>
                <th style={{ ...headStyle, textAlign: 'right' }}>Amount</th>
                <th style={headStyle}>What it is</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <StatementRow
                  key={row.id}
                  row={row}
                  suggestions={feed?.suggestions[row.id] ?? []}
                  documents={feed?.documentSuggestions?.[row.id] ?? []}
                  matched={matches[row.id] ?? []}
                  categories={categories}
                  categoryId={rowCategory[row.id] ?? ''}
                  vatRateCode={vatRateCode}
                  leaveForReview={leaveForReview}
                  ticked={selected.has(row.id)}
                  open={openLine === row.id}
                  settleOpen={settleLine === row.id}
                  busy={busy}
                  canRecord={canRecord}
                  adminPath={adminPath}
                  onTick={(ticked) => {
                    const next = new Set(selected)
                    if (ticked) next.add(row.id)
                    else next.delete(row.id)
                    setSelected(next)
                  }}
                  onCategory={(categoryId) =>
                    setRowCategory((current) => ({ ...current, [row.id]: categoryId }))
                  }
                  onToggle={() => openMatches(row.id)}
                  onSettleToggle={() => setSettleLine(settleLine === row.id ? null : row.id)}
                  onAct={(body) => act(row.id, body)}
                  onBulk={(body, what, leftNote) => bulk([row.id], body, what, leftNote)}
                  onRecordFromDocument={(documentId, categoryId) =>
                    recordFromDocument(row.id, documentId, categoryId)
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {feed && feed.total > PAGE_SIZE && (
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1rem', fontSize: 'var(--text-sm)' }}>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || offset === 0}
            onClick={() => {
              setSelected(new Set())
              setOffset(Math.max(0, offset - PAGE_SIZE))
            }}
          >
            Previous
          </button>
          <span>
            {offset + 1} to {Math.min(offset + PAGE_SIZE, feed.total)} of {feed.total}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || offset + PAGE_SIZE >= feed.total}
            onClick={() => {
              setSelected(new Set())
              setOffset(offset + PAGE_SIZE)
            }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * What a bulk action actually did, including the lines it would not touch.
 *
 * One refusal never stops the rest, so the ones that were refused have to be
 * said out loud and named - a silent count of "38 done" out of 40 is how two
 * lines go missing from a set of books.
 */
function Outcome({
  outcome,
  rows,
  onDismiss,
}: {
  outcome: BulkOutcome & { what: string; attempted: number; leftNote: string }
  rows: BankTransaction[]
  onDismiss: () => void
}) {
  const describe = (id: string): string => {
    const row = rows.find((item) => item.id === id)
    if (!row) return 'One line'
    return `${formatDate(row.date)} · ${row.counterparty || row.details} · ${poundsFromString(row.amount)}`
  }

  return (
    <div
      className="card"
      role="status"
      style={{
        padding: '0.875rem 1rem',
        marginBottom: '1rem',
        fontSize: 'var(--text-sm)',
        borderColor: outcome.failed.length > 0 ? 'var(--color-warning, var(--color-border))' : 'var(--color-border)',
      }}
    >
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline' }}>
        <strong style={{ flex: 1 }}>
          {outcome.done} line{outcome.done === 1 ? '' : 's'} {outcome.what}.
        </strong>
        <button type="button" className="btn btn-sm" onClick={onDismiss}>
          Right you are
        </button>
      </div>
      {outcome.attempted > outcome.done + outcome.failed.length && (
        <p style={{ margin: '0.5rem 0 0' }}>
          The other {outcome.attempted - outcome.done - outcome.failed.length} {outcome.leftNote}.
        </p>
      )}
      {outcome.failed.length > 0 && (
        <>
          <p style={{ margin: '0.5rem 0 0.25rem' }}>
            {outcome.failed.length} {outcome.failed.length === 1 ? 'was' : 'were'} left alone:
          </p>
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {outcome.failed.map((failure) => (
              <li key={failure.id}>
                {describe(failure.id)} - {failure.error}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * The score at the top. Two figures that answer different questions: what the
 * bank last said the account held, and how much of that nobody has explained.
 */
function Position({ account, summary }: { account: BankAccount; summary: Summary }) {
  const position = account.position_summary
  const clear = summary.unreconciledLines === 0

  return (
    <div
      className="card"
      style={{
        padding: '0.875rem 1rem',
        marginBottom: '1rem',
        fontSize: 'var(--text-sm)',
        borderColor: clear ? 'var(--color-success, var(--color-border))' : 'var(--color-border)',
      }}
    >
      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: 'var(--color-text-muted, var(--color-text))' }}>According to the bank</div>
          <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>
            {poundsFromString(position.statementBalance)}
          </div>
          {position.lastStatementDate && (
            <div style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
              as at {formatDate(position.lastStatementDate)}
            </div>
          )}
        </div>
        <div>
          <div style={{ color: 'var(--color-text-muted, var(--color-text))' }}>Still to explain</div>
          <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>
            {summary.unreconciledLines} line{summary.unreconciledLines === 1 ? '' : 's'}
          </div>
          <div style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
            {poundsFromString(summary.unreconciledTotal)} between them
          </div>
        </div>
        <div>
          <div style={{ color: 'var(--color-text-muted, var(--color-text))' }}>Ticked off</div>
          <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>
            {summary.reconciledLines} of {summary.statementLines}
          </div>
          {summary.ignoredLines > 0 && (
            <div style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
              {summary.ignoredLines} set aside
            </div>
          )}
        </div>
      </div>

      {summary.unmatchedEntryCount > 0 && (
        <p style={{ margin: '0.75rem 0 0' }}>
          There {summary.unmatchedEntryCount === 1 ? 'is' : 'are'} also {summary.unmatchedEntryCount} entr
          {summary.unmatchedEntryCount === 1 ? 'y' : 'ies'} in your books, worth{' '}
          {poundsFromString(summary.unmatchedEntryTotal)}, with no statement line behind{' '}
          {summary.unmatchedEntryCount === 1 ? 'it' : 'them'} at all. Either the statement they belong to
          has not been imported yet, or they have not actually gone through the bank.
        </p>
      )}
    </div>
  )
}

/**
 * Every unfiled receipt, for the line the matcher had nothing to say about.
 *
 * The suggestions above this are the ones that agree on the amount or the name.
 * They are the common case and not the only one: a supplier who invoices £180
 * and takes £150 on account, a photograph nothing could be read off, a receipt
 * whose date is months from the payment. None of those should be OFFERED - a
 * plausible wrong match is the one failure worth designing against - but all of
 * them are things a human can look at and know.
 *
 * Compact on purpose. It opens inside a table cell, and the thing being decided
 * is one row of it.
 */
function PickReceipt({
  onPick,
  onClose,
  disabled,
}: {
  onPick: (documentId: string) => void
  onClose: () => void
  disabled: boolean
}) {
  const [rows, setRows] = useState<DocumentCandidate[] | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ unfiled: '1', limit: '50' })
      if (search.trim()) query.set('search', search.trim())
      fetch(`/api/m/uk-bookkeeping/admin/documents?${query}`)
        .then((response) => (response.ok ? response.json() : { rows: [] }))
        .then((data) => {
          if (cancelled) return
          setRows(
            (data.rows ?? []).map((row: Record<string, unknown>) => ({
              documentId: row.id as string,
              name: row.name as string,
              scanStatus: row.scan_status as string,
              counterparty: (row.guessed_counterparty as string | null) ?? null,
              counterpartyConfidence: (row.counterparty_confidence as number) ?? 0,
              documentDate: (row.guessed_document_date as string | null) ?? null,
              documentNumber: (row.guessed_document_number as string | null) ?? null,
              net: (row.guessed_net as string | null) ?? null,
              vat: (row.guessed_vat as string | null) ?? null,
              total: (row.guessed_total as string | null) ?? null,
              vatRateCode: (row.guessed_vat_rate_code as string | null) ?? null,
              direction: (row.guessed_direction as 'income' | 'expense' | null) ?? null,
              score: 0,
              reasons: [],
            })),
          )
        })
        .catch(() => {
          if (!cancelled) setRows([])
        })
    }, search ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search])

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '0.5rem' }}>
      <input
        style={{ ...controlStyle, width: '100%', marginBottom: '0.5rem' }}
        placeholder="Search receipts by supplier, number or filename"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {rows === null && <div style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>Loading…</div>}
      {rows !== null && rows.length === 0 && (
        <div style={{ fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
          Nothing unfiled matches that.
        </div>
      )}
      {(rows ?? []).map((candidate) => (
        <div
          key={candidate.documentId}
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'baseline',
            flexWrap: 'wrap',
            padding: '0.25rem 0',
            borderTop: '1px solid var(--color-border)',
          }}
        >
          <a
            href={`/api/m/uk-bookkeeping/admin/attachments/${candidate.documentId}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {candidate.counterparty ?? candidate.name}
          </a>
          <span style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
            {[
              candidate.documentNumber && `no. ${candidate.documentNumber}`,
              candidate.documentDate && formatDate(candidate.documentDate),
              candidate.total && poundsFromString(candidate.total),
            ]
              .filter(Boolean)
              .join(' · ') || 'nothing read off it'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled}
            onClick={() => onPick(candidate.documentId)}
          >
            Use this one
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" style={{ marginTop: '0.5rem' }} onClick={onClose}>
        Close
      </button>
    </div>
  )
}

function StatementRow({
  row,
  suggestions,
  documents,
  matched,
  categories,
  categoryId,
  vatRateCode,
  leaveForReview,
  ticked,
  open,
  settleOpen,
  busy,
  canRecord,
  adminPath,
  onTick,
  onCategory,
  onToggle,
  onSettleToggle,
  onAct,
  onBulk,
  onRecordFromDocument,
}: {
  row: BankTransaction
  suggestions: MatchCandidate[]
  documents: DocumentCandidate[]
  matched: MatchedEntry[]
  categories: Category[]
  categoryId: string
  vatRateCode: string
  leaveForReview: boolean
  ticked: boolean
  open: boolean
  settleOpen: boolean
  busy: boolean
  canRecord: boolean
  adminPath: string
  onTick: (ticked: boolean) => void
  onCategory: (categoryId: string) => void
  onToggle: () => void
  onSettleToggle: () => void
  onAct: (body: Record<string, unknown>) => void
  onBulk: (body: Record<string, unknown>, what: string, leftNote: string) => void
  onRecordFromDocument: (documentId: string, categoryId: string) => void
}) {
  const direction = row.amount.startsWith('-') ? 'expense' : 'income'
  const usable = categories.filter(
    (category) => category.direction === 'both' || category.direction === direction,
  )
  const [pickingReceipt, setPickingReceipt] = useState(false)

  return (
    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
      {canRecord && (
        <td style={cellStyle}>
          <input
            type="checkbox"
            aria-label={`Tick the ${formatDate(row.date)} line for ${row.counterparty || 'an unnamed counterparty'}`}
            checked={ticked}
            onChange={(event) => onTick(event.target.checked)}
          />
        </td>
      )}
      <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{formatDate(row.date)}</td>
      <td style={cellStyle}>
        <div>{row.counterparty || '—'}</div>
        {row.details !== row.counterparty && (
          <div style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
            {row.details}
          </div>
        )}
        {row.transaction_type && (
          <div style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
            {row.transaction_type}
          </div>
        )}
      </td>
      <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {poundsFromString(row.amount)}
      </td>
      <td style={cellStyle}>
        {row.status === 'reconciled' && (
          <div>
            <span style={{ color: 'var(--color-success, var(--color-text))' }}>Ticked off.</span>{' '}
            <button
              type="button"
              className="btn btn-sm"
              onClick={onToggle}
              style={{ marginLeft: '0.25rem' }}
            >
              {open ? 'Hide' : `Show what it is matched to (${row.match_count})`}
            </button>
          </div>
        )}

        {row.status === 'ignored' && (
          <div>
            <span style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
              Set aside{row.ignored_reason ? `: ${row.ignored_reason}` : '.'}
            </span>{' '}
            {canRecord && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onAct({ action: 'unignore' })}>
                Put it back
              </button>
            )}
          </div>
        )}

        {row.status === 'unreconciled' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {row.match_count > 0 && (
              <div style={{ color: 'var(--color-danger, var(--color-text))' }}>
                Only {poundsFromString(row.matched_total)} of this is explained so far.
              </div>
            )}

            {suggestions.map((candidate) => (
              <div key={candidate.transactionId} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <a href={`/${adminPath}/m/uk-bookkeeping/transactions/${candidate.transactionId}`}>
                  {formatDate(candidate.date)} · {candidate.counterparty} · {poundsFromString(candidate.gross)}
                </a>
                <span style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
                  {candidate.reasons.join(', ')}
                </span>
                {canRecord && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy}
                    onClick={() => onAct({ action: 'match', transactionId: candidate.transactionId, method: 'suggested' })}
                  >
                    That is what it is
                  </button>
                )}
              </div>
            ))}

            {/*
              Paperwork nobody has typed up yet. Above the category picker on
              purpose: if the invoice is sitting right there, coding the line by
              hand is the slower way round AND the one that loses the receipt.
            */}
            {documents.map((candidate) => (
              <div
                key={candidate.documentId}
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'baseline',
                  flexWrap: 'wrap',
                  padding: '0.375rem 0.5rem',
                  borderRadius: 6,
                  border: '1px solid var(--color-border)',
                }}
              >
                <span aria-hidden="true">📎</span>
                <a
                  href={`/api/m/uk-bookkeeping/admin/attachments/${candidate.documentId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {candidate.counterparty ?? candidate.name}
                  {candidate.documentNumber ? ` · no. ${candidate.documentNumber}` : ''}
                </a>
                <span style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
                  {candidate.reasons.join(', ')}
                  {candidate.vat !== null &&
                    (candidate.vat === '0.00'
                      ? ' · no VAT on it'
                      : ` · ${poundsFromString(candidate.vat)} VAT`)}
                </span>
                {canRecord && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy || !categoryId}
                    title={
                      categoryId
                        ? undefined
                        : 'Choose what it was for first - the invoice knows the supplier and the VAT, not what you spent it on.'
                    }
                    onClick={() => onRecordFromDocument(candidate.documentId, categoryId)}
                  >
                    That is the invoice
                  </button>
                )}
              </div>
            ))}

            {canRecord && pickingReceipt && (
              <PickReceipt
                disabled={busy || !categoryId}
                onPick={(documentId) => {
                  setPickingReceipt(false)
                  onRecordFromDocument(documentId, categoryId)
                }}
                onClose={() => setPickingReceipt(false)}
              />
            )}

            {canRecord && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <select
                  aria-label={`What the ${formatDate(row.date)} line was for`}
                  value={categoryId}
                  onChange={(event) => onCategory(event.target.value)}
                  style={controlStyle}
                >
                  <option value="">Choose a category</option>
                  {usable.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !categoryId}
                  onClick={() =>
                    onBulk(
                      { action: 'record', categoryId, vatRateCode, leaveForReview },
                      'recorded',
                      'were left as they were',
                    )
                  }
                >
                  Record it as this
                </button>
                {/*
                  For when the right receipt is in the pile but was not offered -
                  a part payment, a photograph nothing could be read off, an
                  invoice dated months from the payment. None of those should be
                  suggested, and all of them are things a human can recognise.
                */}
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy || !categoryId}
                  title={
                    categoryId ? undefined : 'Choose what it was for first.'
                  }
                  onClick={() => setPickingReceipt(!pickingReceipt)}
                >
                  {pickingReceipt ? 'Never mind' : 'Pick a receipt'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => onAct({ action: 'ignore', reason: '' })}
                >
                  Set it aside
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={onSettleToggle}>
                  {settleOpen ? 'Never mind' : 'It paid several invoices'}
                </button>
              </div>
            )}

            {canRecord && settleOpen && (
              <SettlePanel
                bankTransactionId={row.id}
                categories={categories}
                leaveForReview={leaveForReview}
                busy={busy}
                adminPath={adminPath}
                onSettle={onAct}
              />
            )}
          </div>
        )}

        {open && matched.length > 0 && (
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
            {matched.map((entry) => (
              <li key={entry.transactionId}>
                <a href={`/${adminPath}/m/uk-bookkeeping/transactions/${entry.transactionId}`}>
                  {formatDate(entry.date)} · {entry.counterparty}
                </a>{' '}
                {poundsFromString(entry.amount)}
                {entry.locked && ' 🔒'}
                {canRecord && !entry.locked && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    style={{ marginLeft: '0.5rem' }}
                    onClick={() => onAct({ action: 'unmatch', transactionId: entry.transactionId })}
                  >
                    Not that one
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  )
}

/**
 * Settling one bank line against several entries, less what was kept out of it.
 *
 * This is the card-processor case and it is the reason the ordinary matcher
 * finds nothing: GoCardless and Square batch a day's takings into one payout and
 * take their cut out of the middle, so the line never equals any invoice, or any
 * set of invoices, to the penny. Pick the ones it covers, and whatever is left
 * over gets recorded as the expense it actually is rather than quietly lost.
 *
 * No attempt is made to guess which invoices make up a payout. That is a
 * subset-sum problem and a machine would be confidently wrong at it often enough
 * to be worse than no help at all. A running total against the figure that
 * actually arrived is what makes it quick.
 */
function SettlePanel({
  bankTransactionId,
  categories,
  leaveForReview,
  busy,
  adminPath,
  onSettle,
}: {
  bankTransactionId: string
  categories: Category[]
  leaveForReview: boolean
  busy: boolean
  adminPath: string
  onSettle: (body: Record<string, unknown>) => void
}) {
  const [view, setView] = useState<{ remaining: string; candidates: SettlementCandidate[] } | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [find, setFind] = useState('')
  // Null means "not chosen yet", which is not the same as "chosen nothing": the
  // default is worked out below rather than written into state by an effect,
  // because state derived from a prop is state that goes stale.
  const [chosenDifferenceCategory, setChosenDifferenceCategory] = useState<string | null>(null)
  const [differenceVatRateCode, setDifferenceVatRateCode] = useState('exempt')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/m/uk-bookkeeping/admin/bank-transactions/${bankTransactionId}/candidates`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!live) return
        if (!data) {
          setFailed(true)
          return
        }
        setView({ remaining: data.remaining, candidates: data.candidates ?? [] })
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [bankTransactionId])

  if (failed) {
    return (
      <p style={{ margin: '0.5rem 0 0', color: 'var(--color-danger, var(--color-text))' }}>
        The entries this line might have paid for could not be loaded.
      </p>
    )
  }
  if (!view) {
    return <p style={{ margin: '0.5rem 0 0' }}>Looking for what this might have paid for…</p>
  }

  const needle = find.trim().toLowerCase()
  const shown = needle
    ? view.candidates.filter(
        (candidate) =>
          candidate.counterparty.toLowerCase().includes(needle) ||
          (candidate.reference ?? '').toLowerCase().includes(needle),
      )
    : view.candidates

  const total = view.candidates
    .filter((candidate) => picked.has(candidate.transactionId))
    .reduce((sum, candidate) => addStrings(sum, candidate.contribution), '0.00')
  // Positive: less arrived than these come to, so somebody kept the difference.
  const difference = addStrings(total, negated(view.remaining))
  const settled = difference === '0.00' || difference === '-0.00'
  const differenceDirection = difference.startsWith('-') ? 'income' : 'expense'
  const usable = categories.filter(
    (category) => category.direction === 'both' || category.direction === differenceDirection,
  )
  // Card and bank charges is where the difference goes almost every time, so it
  // is picked already - but only when it is one of the ones on offer, which it
  // is not when the difference turns out to be money IN rather than a fee.
  const fallbackCategory = usable.find((category) => category.code === 'bank-charges')?.id ?? ''
  const differenceCategoryId = chosenDifferenceCategory ?? fallbackCategory

  return (
    <div style={{ marginTop: '0.625rem', borderTop: '1px solid var(--color-border)', paddingTop: '0.625rem' }}>
      {view.candidates.length === 0 && (
        <p style={{ margin: 0 }}>
          There is nothing unaccounted for in your books around this date for it to have paid.
        </p>
      )}

      {view.candidates.length > 0 && (
        <>
          <input
            type="search"
            aria-label="Find an entry this line paid for"
            placeholder="Find an entry"
            value={find}
            onChange={(event) => setFind(event.target.value)}
            style={{ ...controlStyle, minWidth: 220, marginBottom: '0.5rem' }}
          />

          <div style={{ maxHeight: '15rem', overflowY: 'auto', border: '1px solid var(--color-border)', borderRadius: 6 }}>
            {shown.map((candidate) => (
              <label
                key={candidate.transactionId}
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'baseline',
                  padding: '0.375rem 0.5rem',
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <input
                  type="checkbox"
                  checked={picked.has(candidate.transactionId)}
                  onChange={(event) => {
                    const next = new Set(picked)
                    if (event.target.checked) next.add(candidate.transactionId)
                    else next.delete(candidate.transactionId)
                    setPicked(next)
                  }}
                />
                <span style={{ whiteSpace: 'nowrap' }}>{formatDate(candidate.date)}</span>
                <a
                  href={`/${adminPath}/m/uk-bookkeeping/transactions/${candidate.transactionId}`}
                  style={{ flex: 1 }}
                >
                  {candidate.counterparty}
                </a>
                {candidate.reference && (
                  <span style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
                    {candidate.reference}
                  </span>
                )}
                {candidate.status === 'draft' && (
                  <span style={{ fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-warning, var(--color-text))' }}>
                    waiting for review
                  </span>
                )}
                <span style={{ whiteSpace: 'nowrap' }}>{poundsFromString(candidate.contribution)}</span>
              </label>
            ))}
          </div>

          <p style={{ margin: '0.5rem 0 0.375rem' }}>
            {picked.size} picked, coming to <strong>{poundsFromString(total)}</strong>.{' '}
            {poundsFromString(view.remaining)} arrived.{' '}
            {settled ? (
              <span style={{ color: 'var(--color-success, var(--color-text))' }}>
                They account for this line exactly.
              </span>
            ) : (
              <strong>
                {poundsFromString(difference.replace('-', ''))}{' '}
                {differenceDirection === 'expense' ? 'was kept out of it' : 'more arrived than these come to'}.
              </strong>
            )}
          </p>

          {!settled && picked.size > 0 && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: 'var(--text-xs, 0.75rem)' }}>Record that difference as</span>
              <select
                aria-label="What the difference was"
                value={differenceCategoryId}
                onChange={(event) => setChosenDifferenceCategory(event.target.value)}
                style={controlStyle}
              >
                <option value="">Choose a category</option>
                {usable.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="VAT on the difference"
                value={differenceVatRateCode}
                onChange={(event) => setDifferenceVatRateCode(event.target.value)}
                style={controlStyle}
              >
                {VAT_CHOICES.map((choice) => (
                  <option key={choice.code} value={choice.code}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || picked.size === 0 || (!settled && !differenceCategoryId)}
            onClick={() =>
              onSettle({
                action: 'settle',
                transactionIds: [...picked],
                differenceCategoryId: settled ? null : differenceCategoryId,
                differenceVatRateCode,
                leaveForReview,
              })
            }
          >
            Settle this line
          </button>
        </>
      )}
    </div>
  )
}
