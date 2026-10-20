'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import SearchableSelect from './SearchableSelect'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import BalanceCheckPanel from './BalanceCheckPanel'
import ReconcileStyles from './ReconcileStyles'
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
  /** Null when what is matched is a transfer rather than an entry. */
  transactionId: string | null
  journalId: string | null
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
  kind: 'bank' | 'card' | 'cash'
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

/**
 * The other half of a movement between two of the business's own accounts,
 * already recorded. Accepting one ties this line to that transfer - it does not
 * write anything new, because the transfer itself already exists.
 */
type TransferCandidate = {
  journalId: string
  date: string
  narrative: string
  reference: string | null
  amount: string
  fromBankName: string
  toBankName: string
  side: 'out' | 'in'
  daysApart: number
}

type Feed = {
  rows: BankTransaction[]
  total: number
  suggestions: Record<string, MatchCandidate[]>
  documentSuggestions: Record<string, DocumentCandidate[]>
  transferSuggestions?: Record<string, TransferCandidate[]>
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


// Handed to SearchableSelect, whose trigger button takes its look from this.
const controlStyle: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 8,
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
      <div className="bkr">
        <ReconcileStyles />
        <BookkeepingNav active="reconcile" />
        <SandboxBanner environment={environment} />
        <div className="bkr-empty">
          <div className="bkr-empty-ico">
            <Icon name="bank" size={22} />
          </div>
          <p className="bkr-empty-title">No accounts yet.</p>
          <p>
            Add the account your money sits in under{' '}
            <a href={`/${adminPath}/settings?tab=uk-bookkeeping`}>the bookkeeping settings</a>, then{' '}
            <a href={`/${adminPath}/m/uk-bookkeeping/statements`}>import a statement</a> for it. Once there is
            a statement to compare against, this is where you tick it off.
          </p>
        </div>
      </div>
    )
  }

  const account = accounts.find((item) => item.id === accountId)
  const summary = feed?.summary ?? null
  const allTicked = rows.length > 0 && selected.size === rows.length

  const statusTabs: { key: typeof status; label: string; count: number | null }[] = [
    { key: 'unreconciled', label: 'Still to explain', count: summary?.unreconciledLines ?? null },
    { key: 'reconciled', label: 'Ticked off', count: summary?.reconciledLines ?? null },
    { key: 'ignored', label: 'Set aside', count: summary?.ignoredLines ?? null },
    { key: '', label: 'Everything', count: summary?.statementLines ?? null },
  ]

  return (
    <div className="bkr">
      <ReconcileStyles />
      <BookkeepingNav active="reconcile" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {accounts.length > 1 && (
        <div className="bkr-accts" role="group" aria-label="Which account to reconcile">
          {accounts.map((item) => (
            <button
              key={item.id}
              type="button"
              className="bkr-acct"
              aria-pressed={item.id === accountId}
              onClick={() => changeView(() => setAccountId(item.id))}
            >
              <span className="bkr-acct-ico">
                <Icon name={item.kind === 'card' ? 'card' : item.kind === 'cash' ? 'cash' : 'bank'} />
              </span>
              <span className="bkr-acct-body">
                <span className="bkr-acct-name">{item.name}</span>
                <span className="bkr-tiny">
                  {item.kind === 'card' ? 'Card' : item.kind === 'cash' ? 'Cash' : 'Bank account'}
                  {item.account_last4 ? ` ending ${item.account_last4}` : ''}
                </span>
              </span>
              {item.position_summary.unreconciledCount > 0 && (
                <span className="bkr-count" data-hot="true" title="Lines still to explain">
                  {item.position_summary.unreconciledCount}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/*
        Said out loud rather than swallowed. A cap that quietly stops looking
        reads as "there is no invoice for this payment", which is a different
        and much worse statement than "we did not look at all of them".
      */}
      {feed?.documentsTruncated && (
        <div className="bkr-note" data-tone="warn" role="status">
          <span className="bkr-note-ico">
            <Icon name="info" size={14} />
          </span>
          <div className="bkr-note-body">
            There are more unfiled receipts than we look through in one go, so only the most recent few
            hundred were offered against these lines. Filing some of them from the Receipts tab will bring
            the rest into view.
          </div>
        </div>
      )}

      {outcome && <Outcome outcome={outcome} rows={rows} onDismiss={() => setOutcome(null)} />}

      {account?.kind === 'cash' && (
        <BalanceCheckPanel key={account.id} bankAccountId={account.id} accountName={account.name} canRecord={canRecord} />
      )}

      {account && summary && <Position account={account} summary={summary} />}

      <div className="bkr-card">
        <div className="bkr-toolbar">
          <div className="bkr-seg" role="group" aria-label="Which lines to show">
            {statusTabs.map((tab) => (
              <button
                key={tab.key || 'all'}
                type="button"
                aria-pressed={status === tab.key}
                onClick={() => changeView(() => setStatus(tab.key))}
              >
                {tab.label}
                {tab.count !== null && <small>{tab.count}</small>}
              </button>
            ))}
          </div>

          <div className="bkr-grow">
            <Icon name="search" size={15} />
            <input
              type="search"
              className="bkr-input"
              aria-label="Find a statement line"
              value={search}
              placeholder="Search what the bank printed"
              onChange={(event) => changeView(() => setSearch(event.target.value))}
            />
          </div>

          <div className="bkr-dates">
            <label>
              From
              <input
                type="date"
                className="bkr-input"
                value={from}
                onChange={(event) => changeView(() => setFrom(event.target.value))}
              />
            </label>
            <label>
              To
              <input
                type="date"
                className="bkr-input"
                value={to}
                onChange={(event) => changeView(() => setTo(event.target.value))}
              />
            </label>
          </div>
        </div>
        <p className="bkr-tiny" style={{ margin: 0, padding: '0 1rem .75rem' }}>
          Searching is how you get all the alike ones together: type the name the bank prints on your
          director&rsquo;s loan payments, tick the lot, and code them in one go.
        </p>
      </div>

      {!feed && !error && (
        <div className="bkr-card" aria-busy="true" aria-label="Loading statement lines">
          <div className="bkr-skel" />
          <div className="bkr-skel" />
          <div className="bkr-skel" />
        </div>
      )}

      {feed && rows.length === 0 && (
        <div className="bkr-empty" data-tone={status === 'unreconciled' ? 'good' : undefined}>
          <div className="bkr-empty-ico">
            <Icon name={status === 'unreconciled' ? 'check' : 'search'} size={22} />
          </div>
          <p className="bkr-empty-title">
            {status === 'unreconciled' ? 'Nothing left to explain.' : 'Nothing here.'}
          </p>
          <p>
            {status === 'unreconciled'
              ? 'Every line on this account is either ticked off against an entry or set aside. That is the whole point of the exercise, so: well done.'
              : 'Try a different filter, or import a statement for this account.'}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="bkr-card">
          <div className="bkr-list-head">
            {canRecord && (
              <label>
                <input
                  type="checkbox"
                  className="bkr-tick"
                  style={{ marginTop: 0 }}
                  aria-label="Tick every line on this page"
                  checked={allTicked}
                  ref={(element) => {
                    if (element) element.indeterminate = selected.size > 0 && !allTicked
                  }}
                  onChange={(event) =>
                    setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())
                  }
                />
                <span>
                  {selected.size > 0 ? `${selected.size} of ${rows.length} ticked` : 'Tick all'}
                </span>
              </label>
            )}
            <span className="bkr-muted">
              {feed && feed.total > rows.length
                ? `${offset + 1} to ${offset + rows.length} of ${feed.total} lines`
                : `${rows.length} line${rows.length === 1 ? '' : 's'}`}
            </span>

            {/* Not tied to a selection: the per-line "Record" buttons use this
                rate and this tick box too, so locking them to a selection would
                mean a single line could only ever be recorded with no VAT on it. */}
            {canRecord && (
              <div className="bkr-defaults">
                <label>
                  VAT on what you record
                  <select value={vatRateCode} onChange={(event) => setVatRateCode(event.target.value)}>
                    {VAT_CHOICES.map((choice) => (
                      <option key={choice.code} value={choice.code}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label title="Entries go in as drafts and reach no VAT return until you post them.">
                  <input
                    type="checkbox"
                    checked={leaveForReview}
                    onChange={(event) => setLeaveForReview(event.target.checked)}
                  />
                  Save as drafts for review
                </label>
              </div>
            )}
          </div>

          {rows.map((row) => (
            <StatementRow
              key={row.id}
              row={row}
              suggestions={feed?.suggestions[row.id] ?? []}
              documents={feed?.documentSuggestions?.[row.id] ?? []}
              transfers={feed?.transferSuggestions?.[row.id] ?? []}
              matched={matches[row.id] ?? []}
              categories={categories}
              categoryId={rowCategory[row.id] ?? ''}
              ticked={selected.has(row.id)}
              open={openLine === row.id}
              settleOpen={settleLine === row.id}
              vatRateCode={vatRateCode}
              leaveForReview={leaveForReview}
              busy={busy}
              canRecord={canRecord}
              adminPath={adminPath}
              onTick={(ticked) => {
                const next = new Set(selected)
                if (ticked) next.add(row.id)
                else next.delete(row.id)
                setSelected(next)
              }}
              onCategory={(categoryId) => setRowCategory((current) => ({ ...current, [row.id]: categoryId }))}
              onToggle={() => openMatches(row.id)}
              onSettleToggle={() => setSettleLine(settleLine === row.id ? null : row.id)}
              onAct={(body) => act(row.id, body)}
              onBulk={(body, what, leftNote) => bulk([row.id], body, what, leftNote)}
              onRecordFromDocument={(documentId, categoryId) =>
                recordFromDocument(row.id, documentId, categoryId)
              }
            />
          ))}
        </div>
      )}

      {feed && feed.total > PAGE_SIZE && (
        <div className="bkr-pager">
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
          <span className="bkr-muted bkr-num">
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

      {canRecord && selected.size > 0 && (
        <div className="bkr-bulk" role="region" aria-label="Actions for the ticked lines">
          <div className="bkr-bulk-row">
            <span className="bkr-bulk-count">{selected.size} ticked</span>

            <SearchableSelect
              aria-label="What they were for"
              value={bulkCategory}
              onChange={setBulkCategory}
              style={{ ...controlStyle, minWidth: '14rem', minHeight: '2.25rem' }}
              emptyLabel="What they were for"
              options={bulkCategories.map((category) => ({ value: category.id, label: category.name }))}
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !bulkCategory}
              onClick={() =>
                bulk(
                  [...selected],
                  { action: 'record', categoryId: bulkCategory, vatRateCode, leaveForReview },
                  'recorded',
                  'were left as they were',
                )
              }
            >
              {busy ? 'Working…' : `Record ${selected.size}`}
            </button>

            <span className="bkr-bulk-sep" aria-hidden="true" />

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
              Tick off the sure ones{suggestedInSelection > 0 ? ` (${suggestedInSelection})` : ''}
            </button>

            <button
              type="button"
              className="btn btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>

          <div className="bkr-bulk-row">
            <input
              className="bkr-input"
              aria-label="Why these lines are being set aside"
              placeholder="Why they need no entry"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              style={{ minWidth: '14rem', flex: '1 1 14rem' }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
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
                disabled={busy}
                onClick={() =>
                  bulk([...selected], { action: 'unignore' }, 'put back', 'were not set aside anyway')
                }
              >
                Put back
              </button>
            )}
          </div>
          <p className="bkr-tiny" style={{ margin: 0 }}>
            Recording takes the date, the name and the amount straight off the bank&rsquo;s own line.
          </p>
        </div>
      )}
    </div>
  )
}

type IconName = 'bank' | 'card' | 'cash' | 'check' | 'swap' | 'clip' | 'search' | 'info' | 'alert'

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    bank: (
      <>
        <path d="M3 21h18" />
        <path d="M5 21V10" />
        <path d="M9 21V10" />
        <path d="M15 21V10" />
        <path d="M19 21V10" />
        <path d="m3 10 9-6 9 6" />
      </>
    ),
    card: (
      <>
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </>
    ),
    cash: (
      <>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <circle cx="12" cy="12" r="2.5" />
      </>
    ),
    check: <path d="M20 6 9 17l-5-5" />,
    swap: (
      <>
        <path d="M7 4 3 8l4 4" />
        <path d="M3 8h14" />
        <path d="m17 20 4-4-4-4" />
        <path d="M21 16H7" />
      </>
    ),
    clip: (
      <path d="m21.4 11.6-9.2 9.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5" />
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4.3-4.3" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </>
    ),
    alert: (
      <>
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </>
    ),
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
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
  const rest = outcome.attempted - outcome.done - outcome.failed.length

  return (
    <div className="bkr-note" data-tone={outcome.failed.length > 0 ? 'warn' : 'good'} role="status">
      <span className="bkr-note-ico">
        <Icon name={outcome.failed.length > 0 ? 'alert' : 'check'} size={14} />
      </span>
      <div className="bkr-note-body">
        <strong>
          {outcome.done} line{outcome.done === 1 ? '' : 's'} {outcome.what}.
        </strong>
        {rest > 0 && (
          <p>
            The other {rest} {outcome.leftNote}.
          </p>
        )}
        {outcome.failed.length > 0 && (
          <>
            <p>
              {outcome.failed.length} {outcome.failed.length === 1 ? 'was' : 'were'} left alone:
            </p>
            <ul>
              {outcome.failed.map((failure) => (
                <li key={failure.id}>
                  {describe(failure.id)} - {failure.error}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <button type="button" className="btn btn-sm" onClick={onDismiss}>
        Right you are
      </button>
    </div>
  )
}

/**
 * The score at the top. Figures that answer different questions: what the bank
 * last said the account held, how much of that nobody has explained, and how far
 * through the statement the work has got.
 */
function Position({ account, summary }: { account: BankAccount; summary: Summary }) {
  const position = account.position_summary
  const clear = summary.unreconciledLines === 0
  const dealtWith = summary.reconciledLines + summary.ignoredLines
  const percent =
    summary.statementLines === 0 ? 0 : Math.round((dealtWith / summary.statementLines) * 100)

  return (
    <div className="bkr-card" style={{ overflow: 'hidden' }}>
      <div className="bkr-stats">
        <div className="bkr-stat">
          <span className="bkr-stat-label">According to the bank</span>
          <span className="bkr-stat-value">{poundsFromString(position.statementBalance)}</span>
          <span className="bkr-tiny">
            {position.lastStatementDate
              ? `as at ${formatDate(position.lastStatementDate)}`
              : 'no statement imported yet'}
          </span>
        </div>
        <div className="bkr-stat">
          <span className="bkr-stat-label">Still to explain</span>
          <span className="bkr-stat-value" data-tone={clear ? 'good' : undefined}>
            {summary.unreconciledLines} line{summary.unreconciledLines === 1 ? '' : 's'}
          </span>
          <span className="bkr-tiny">
            {clear ? 'all caught up' : `${poundsFromString(summary.unreconciledTotal)} between them`}
          </span>
        </div>
        <div className="bkr-stat">
          <span className="bkr-stat-label">Ticked off</span>
          <span className="bkr-stat-value">
            {summary.reconciledLines}
            <span className="bkr-muted" style={{ fontSize: '1rem', fontWeight: 500 }}>
              {' '}
              of {summary.statementLines}
            </span>
          </span>
          <span className="bkr-tiny">{poundsFromString(summary.reconciledTotal)} matched to entries</span>
        </div>
        <div className="bkr-stat">
          <span className="bkr-stat-label">Dealt with</span>
          <span className="bkr-stat-value" data-tone={clear ? 'good' : undefined}>
            {percent}%
          </span>
          <span className="bkr-tiny">
            {summary.ignoredLines > 0
              ? `including ${summary.ignoredLines} set aside`
              : 'of the lines on this account'}
          </span>
          <div
            className="bkr-progress"
            data-clear={clear}
            role="progressbar"
            aria-label="Share of statement lines dealt with"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      </div>

      {summary.unmatchedEntryCount > 0 && (
        <div className="bkr-stats-foot">
          There {summary.unmatchedEntryCount === 1 ? 'is' : 'are'} also {summary.unmatchedEntryCount} entr
          {summary.unmatchedEntryCount === 1 ? 'y' : 'ies'} in your books, worth{' '}
          {poundsFromString(summary.unmatchedEntryTotal)}, with no statement line behind{' '}
          {summary.unmatchedEntryCount === 1 ? 'it' : 'them'} at all. Either the statement they belong to has
          not been imported yet, or they have not actually gone through the bank.
        </div>
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
    <div className="bkr-sub">
      <p className="bkr-sub-title">Pick a receipt</p>
      <input
        className="bkr-input"
        aria-label="Search receipts"
        placeholder="Search receipts by supplier, number or filename"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="bkr-scroll">
        {rows === null && <div className="bkr-pick bkr-tiny">Loading…</div>}
        {rows !== null && rows.length === 0 && (
          <div className="bkr-pick bkr-tiny">Nothing unfiled matches that.</div>
        )}
        {(rows ?? []).map((candidate) => (
          <div key={candidate.documentId} className="bkr-pick">
            <div className="bkr-pick-main">
              <a
                href={`/api/m/uk-bookkeeping/admin/attachments/${candidate.documentId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {candidate.counterparty ?? candidate.name}
              </a>
              <span className="bkr-tiny">
                {[
                  candidate.documentNumber && `no. ${candidate.documentNumber}`,
                  candidate.documentDate && formatDate(candidate.documentDate),
                  candidate.total && poundsFromString(candidate.total),
                ]
                  .filter(Boolean)
                  .join(' · ') || 'nothing read off it'}
              </span>
            </div>
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
      </div>
      <div>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

function StatementRow({
  row,
  suggestions,
  documents,
  transfers,
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
  transfers: TransferCandidate[]
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
  const hasCandidates = transfers.length + suggestions.length + documents.length > 0

  return (
    <div className="bkr-line" data-selected={ticked}>
      <div className="bkr-bank" data-check={canRecord}>
        {canRecord && (
          <input
            type="checkbox"
            className="bkr-tick"
            aria-label={`Tick the ${formatDate(row.date)} line for ${row.counterparty || 'an unnamed counterparty'}`}
            checked={ticked}
            onChange={(event) => onTick(event.target.checked)}
          />
        )}
        <div className="bkr-bank-main">
          <p className="bkr-date">{formatDate(row.date)}</p>
          <div className="bkr-who">{row.counterparty || row.details || 'No name on the line'}</div>
          {row.counterparty && row.details && row.details !== row.counterparty && (
            <div className="bkr-tiny bkr-det">{row.details}</div>
          )}
          {(row.transaction_type || row.reference) && (
            <div className="bkr-chips">
              {row.transaction_type && <span className="bkr-pill">{row.transaction_type}</span>}
              {row.reference && <span className="bkr-pill">Ref {row.reference}</span>}
            </div>
          )}
        </div>
        <div className="bkr-amount">
          <div className="bkr-amt" data-dir={direction}>
            {direction === 'income' ? '+' : ''}
            {poundsFromString(row.amount)}
          </div>
          {row.statement_balance !== null && (
            <div className="bkr-tiny bkr-num">Balance {poundsFromString(row.statement_balance)}</div>
          )}
        </div>
      </div>

      <div className="bkr-books">
        {row.status === 'reconciled' && (
          <>
            <p className="bkr-kicker">In your books</p>
            <div className="bkr-done">
              <span className="bkr-pill bkr-pill-good">
                <Icon name="check" size={12} /> Ticked off
              </span>
              <button type="button" className="bkr-linkbtn" onClick={onToggle}>
                {open ? 'Hide' : `Show what it is matched to (${row.match_count})`}
              </button>
            </div>
          </>
        )}

        {row.status === 'ignored' && (
          <>
            <p className="bkr-kicker">Set aside</p>
            <div className="bkr-done">
              <span className="bkr-muted">
                {row.ignored_reason ? `Set aside: ${row.ignored_reason}` : 'Set aside, no entry needed.'}
              </span>
              {canRecord && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => onAct({ action: 'unignore' })}
                >
                  Put it back
                </button>
              )}
            </div>
          </>
        )}

        {row.status === 'unreconciled' && (
          <>
            {row.match_count > 0 && (
              <div>
                <span className="bkr-pill bkr-pill-bad">
                  <Icon name="alert" size={12} /> Only {poundsFromString(row.matched_total)} of this is
                  explained so far
                </span>
              </div>
            )}

            {hasCandidates && <p className="bkr-kicker">Looks like</p>}

            {transfers.map((candidate) => (
              <div key={candidate.journalId} className="bkr-match">
                <span className="bkr-match-ico">
                  <Icon name="swap" size={15} />
                </span>
                <div className="bkr-match-body">
                  <div className="bkr-match-title">
                    <a href={`/${adminPath}/m/uk-bookkeeping/transfers/${candidate.journalId}`}>
                      {candidate.fromBankName} to {candidate.toBankName}
                    </a>
                  </div>
                  <div className="bkr-tiny">
                    {formatDate(candidate.date)} · {poundsFromString(candidate.amount)} · the{' '}
                    {candidate.side === 'out' ? 'money leaving' : 'money arriving'} on a transfer you have
                    already recorded
                  </div>
                </div>
                {canRecord && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy}
                    onClick={() =>
                      onAct({ action: 'match-transfer', journalId: candidate.journalId, method: 'suggested' })
                    }
                  >
                    Match
                  </button>
                )}
              </div>
            ))}

            {suggestions.map((candidate) => (
              <div key={candidate.transactionId} className="bkr-match">
                <span className="bkr-match-ico">
                  <Icon name="check" size={15} />
                </span>
                <div className="bkr-match-body">
                  <div className="bkr-match-title">
                    <a href={`/${adminPath}/m/uk-bookkeeping/transactions/${candidate.transactionId}`}>
                      {candidate.counterparty}
                    </a>
                  </div>
                  <div className="bkr-tiny">
                    {formatDate(candidate.date)} · {poundsFromString(candidate.gross)}
                    {candidate.status === 'draft' ? ' · waiting for review' : ''}
                  </div>
                  {candidate.reasons.length > 0 && (
                    <div className="bkr-chips" style={{ marginTop: '.25rem' }}>
                      {candidate.reasons.map((why) => (
                        <span key={why} className="bkr-pill">
                          {why}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {canRecord && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy}
                    onClick={() =>
                      onAct({ action: 'match', transactionId: candidate.transactionId, method: 'suggested' })
                    }
                  >
                    Match
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
              <div key={candidate.documentId} className="bkr-match">
                <span className="bkr-match-ico">
                  <Icon name="clip" size={15} />
                </span>
                <div className="bkr-match-body">
                  <div className="bkr-match-title">
                    <a
                      href={`/api/m/uk-bookkeeping/admin/attachments/${candidate.documentId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {candidate.counterparty ?? candidate.name}
                      {candidate.documentNumber ? ` · no. ${candidate.documentNumber}` : ''}
                    </a>
                  </div>
                  <div className="bkr-tiny">
                    Unfiled receipt
                    {candidate.total ? ` · ${poundsFromString(candidate.total)}` : ''}
                    {candidate.vat !== null &&
                      (candidate.vat === '0.00' ? ' · no VAT on it' : ` · ${poundsFromString(candidate.vat)} VAT`)}
                  </div>
                  {candidate.reasons.length > 0 && (
                    <div className="bkr-chips" style={{ marginTop: '.25rem' }}>
                      {candidate.reasons.map((why) => (
                        <span key={why} className="bkr-pill">
                          {why}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
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
                    Use this invoice
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
              <>
                <p className="bkr-kicker">{hasCandidates ? 'Or record it as something new' : 'What was this for?'}</p>
                <div className="bkr-record">
                  <SearchableSelect
                    aria-label={`What the ${formatDate(row.date)} line was for`}
                    value={categoryId}
                    onChange={onCategory}
                    style={{ ...controlStyle, minWidth: '13rem', minHeight: '2.25rem' }}
                    emptyLabel="Choose a category"
                    options={usable.map((category) => ({ value: category.id, label: category.name }))}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busy || !categoryId}
                    onClick={() =>
                      onBulk(
                        { action: 'record', categoryId, vatRateCode, leaveForReview },
                        'recorded',
                        'were left as they were',
                      )
                    }
                  >
                    Record it
                  </button>
                </div>
                <div className="bkr-more">
                  {/*
                    For when the right receipt is in the pile but was not offered -
                    a part payment, a photograph nothing could be read off, an
                    invoice dated months from the payment. None of those should be
                    suggested, and all of them are things a human can recognise.
                  */}
                  <button
                    type="button"
                    className="bkr-linkbtn"
                    disabled={busy || !categoryId}
                    title={categoryId ? undefined : 'Choose what it was for first.'}
                    onClick={() => setPickingReceipt(!pickingReceipt)}
                  >
                    {pickingReceipt ? 'Never mind' : 'Pick a receipt'}
                  </button>
                  <button type="button" className="bkr-linkbtn" disabled={busy} onClick={onSettleToggle}>
                    {settleOpen ? 'Never mind' : 'It paid several invoices'}
                  </button>
                  <button
                    type="button"
                    className="bkr-linkbtn"
                    disabled={busy}
                    onClick={() => onAct({ action: 'ignore', reason: '' })}
                  >
                    Set it aside
                  </button>
                </div>
              </>
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
          </>
        )}

        {open && matched.length > 0 && (
          <ul className="bkr-matched">
            {matched.map((entry) => (
              // A transfer is a journal, so it links to the transfer form rather
              // than to an entry page, and it comes off by its journal id.
              <li key={entry.transactionId ?? entry.journalId}>
                <span className="bkr-grow-text">
                  <a
                    href={
                      entry.journalId
                        ? `/${adminPath}/m/uk-bookkeeping/transfers/${entry.journalId}`
                        : `/${adminPath}/m/uk-bookkeeping/transactions/${entry.transactionId}`
                    }
                  >
                    {entry.counterparty}
                  </a>{' '}
                  <span className="bkr-tiny">{formatDate(entry.date)}</span>
                </span>
                <span className="bkr-num">{poundsFromString(entry.amount)}</span>
                {entry.locked && (
                  <span className="bkr-pill" title="Part of a filed VAT return">
                    Filed
                  </span>
                )}
                {canRecord && !entry.locked && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() =>
                      onAct(
                        entry.journalId
                          ? { action: 'unmatch', journalId: entry.journalId }
                          : { action: 'unmatch', transactionId: entry.transactionId },
                      )
                    }
                  >
                    Not that one
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * A part-payment amount as typed, read strictly: a positive figure, at most two
 * decimal places, and no more than is still outstanding on the entry. Null when
 * it is not one, which holds the settle back rather than sending the server
 * something it would only refuse.
 */
function readPart(typed: string, outstanding: string): string | null {
  const cleaned = typed.replace(/[£,\s]/g, '')
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(cleaned)) return null
  const value = addStrings(cleaned, '0')
  if (value === '0.00') return null
  if (addStrings(outstanding, negated(value)).startsWith('-')) return null
  return value
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
  // What was typed for an entry this line only paid part of - one invoice the
  // customer paid in two goes, each in its own payout. No entry here means the
  // whole of what is outstanding, which is the answer nearly every time.
  const [parts, setParts] = useState<Record<string, string>>({})
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
      <p role="alert" className="bkr-pill bkr-pill-bad" style={{ alignSelf: 'flex-start' }}>
        The entries this line might have paid for could not be loaded.
      </p>
    )
  }
  if (!view) {
    return <p className="bkr-tiny">Looking for what this might have paid for…</p>
  }

  const needle = find.trim().toLowerCase()
  const shown = needle
    ? view.candidates.filter(
        (candidate) =>
          candidate.counterparty.toLowerCase().includes(needle) ||
          (candidate.reference ?? '').toLowerCase().includes(needle),
      )
    : view.candidates

  // How much of each picked entry this line is paying, signed the way the bank
  // sees it. Null where what was typed is not a usable amount.
  const appliedFor = (candidate: SettlementCandidate): string | null => {
    const typed = parts[candidate.transactionId]
    const value = typed === undefined ? candidate.outstanding : readPart(typed, candidate.outstanding)
    if (value === null) return null
    return candidate.direction === 'income' ? value : negated(value)
  }
  const pickedCandidates = view.candidates.filter((candidate) => picked.has(candidate.transactionId))
  const badPart = pickedCandidates.some((candidate) => appliedFor(candidate) === null)
  const total = pickedCandidates.reduce((sum, candidate) => addStrings(sum, appliedFor(candidate) ?? '0.00'), '0.00')
  // Only the ones that differ from the whole are sent: an entry not named is
  // taken whole by the server, so the ordinary case sends nothing extra.
  const amounts: Record<string, string> = {}
  for (const candidate of pickedCandidates) {
    const typed = parts[candidate.transactionId]
    if (typed === undefined) continue
    const value = readPart(typed, candidate.outstanding)
    if (value !== null && value !== candidate.outstanding) amounts[candidate.transactionId] = value
  }
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
    <div className="bkr-sub">
      <p className="bkr-sub-title">Which invoices did this line pay?</p>

      {view.candidates.length === 0 && (
        <p className="bkr-muted" style={{ margin: 0 }}>
          There is nothing unaccounted for in your books around this date for it to have paid.
        </p>
      )}

      {view.candidates.length > 0 && (
        <>
          <input
            type="search"
            className="bkr-input"
            aria-label="Find an entry this line paid for"
            placeholder="Find an entry"
            value={find}
            onChange={(event) => setFind(event.target.value)}
          />

          <div className="bkr-scroll">
            {shown.map((candidate) => {
              const isPicked = picked.has(candidate.transactionId)
              const partIsBad = isPicked && appliedFor(candidate) === null
              return (
                <div key={candidate.transactionId} className="bkr-pick">
                  <label>
                    <input
                      type="checkbox"
                      className="bkr-tick"
                      style={{ marginTop: 0 }}
                      checked={isPicked}
                      onChange={(event) => {
                        const next = new Set(picked)
                        if (event.target.checked) next.add(candidate.transactionId)
                        else next.delete(candidate.transactionId)
                        setPicked(next)
                        // Unticked and ticked again starts from the whole amount,
                        // not from a part typed for a payout it turned out not to be.
                        if (!event.target.checked && parts[candidate.transactionId] !== undefined) {
                          const rest = { ...parts }
                          delete rest[candidate.transactionId]
                          setParts(rest)
                        }
                      }}
                    />
                    <span className="bkr-tiny" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(candidate.date)}
                    </span>
                    <a href={`/${adminPath}/m/uk-bookkeeping/transactions/${candidate.transactionId}`}>
                      {candidate.counterparty}
                    </a>
                    {candidate.reference && <span className="bkr-tiny">{candidate.reference}</span>}
                    {candidate.status === 'draft' && (
                      <span className="bkr-pill bkr-pill-warn">waiting for review</span>
                    )}
                  </label>
                  {isPicked ? (
                    <span style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', whiteSpace: 'nowrap' }}>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="bkr-input bkr-part"
                        aria-label={`How much of ${candidate.counterparty} this line paid`}
                        aria-invalid={partIsBad}
                        value={parts[candidate.transactionId] ?? candidate.outstanding}
                        onChange={(event) => setParts({ ...parts, [candidate.transactionId]: event.target.value })}
                        style={{
                          borderColor: partIsBad ? 'var(--color-danger, var(--color-border))' : undefined,
                        }}
                      />
                      <span className="bkr-tiny">of {poundsFromString(candidate.contribution)}</span>
                    </span>
                  ) : (
                    <span className="bkr-num" style={{ whiteSpace: 'nowrap' }}>
                      {poundsFromString(candidate.contribution)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          <div className="bkr-sum" data-settled={settled}>
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
          </div>

          {picked.size > 0 && (
            <p className="bkr-tiny" style={{ margin: 0 }}>
              If this line only paid part of one, change its amount. The rest stays unpaid on it, ready for the
              payout that brought the rest.
            </p>
          )}

          {badPart && (
            <p role="alert" className="bkr-pill bkr-pill-bad" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>
              One of those amounts will not do: it has to be more than nothing, and no more than is still unpaid
              on that entry.
            </p>
          )}

          {!settled && picked.size > 0 && (
            <div className="bkr-record">
              <span className="bkr-tiny">Record that difference as</span>
              <SearchableSelect
                aria-label="What the difference was"
                value={differenceCategoryId}
                onChange={setChosenDifferenceCategory}
                style={{ ...controlStyle, minWidth: '12rem', minHeight: '2.25rem' }}
                emptyLabel="Choose a category"
                options={usable.map((category) => ({ value: category.id, label: category.name }))}
              />
              <select
                aria-label="VAT on the difference"
                className="bkr-input"
                value={differenceVatRateCode}
                onChange={(event) => setDifferenceVatRateCode(event.target.value)}
              >
                {VAT_CHOICES.map((choice) => (
                  <option key={choice.code} value={choice.code}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || picked.size === 0 || badPart || (!settled && !differenceCategoryId)}
              onClick={() =>
                onSettle({
                  action: 'settle',
                  transactionIds: [...picked],
                  amounts,
                  differenceCategoryId: settled ? null : differenceCategoryId,
                  differenceVatRateCode,
                  leaveForReview,
                })
              }
            >
              Settle this line
            </button>
          </div>
        </>
      )}
    </div>
  )
}
