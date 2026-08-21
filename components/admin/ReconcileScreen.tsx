'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { formatDate, poundsFromString } from './format'

// Reconciliation: does what the bank says match what the books say.
//
// The screen answers one question per line - "what is this?" - and shows the
// running score at the top. A line is only ticked off when the entries matched to
// it account for the whole of it, because "£2 of this is unexplained" is exactly
// the kind of thing that turns out to be a £2,000 typo.

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

type Feed = {
  rows: BankTransaction[]
  total: number
  suggestions: Record<string, MatchCandidate[]>
  summary: Summary | null
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
  const [accountId, setAccountId] = useState('')
  const [status, setStatus] = useState<'unreconciled' | 'reconciled' | 'ignored' | ''>('unreconciled')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [feed, setFeed] = useState<Feed | null>(null)
  const [matches, setMatches] = useState<Record<string, MatchedEntry[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openLine, setOpenLine] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/bank-accounts')
      .then((response) => (response.ok ? response.json() : { accounts: [] }))
      .then((data) => {
        setAccounts(data.accounts ?? [])
        if ((data.accounts ?? []).length > 0) setAccountId(data.accounts[0].id)
      })
      .catch(() => undefined)
  }, [])

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!accountId) return
      const params = new URLSearchParams({ bankAccountId: accountId })
      if (status) params.set('status', status)
      if (from) params.set('from', from)
      if (to) params.set('to', to)

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
      } catch (error_) {
        // The abort is ours - changing a filter cancels the fetch it outran.
        if (error_ instanceof DOMException && error_.name === 'AbortError') return
        setError('The statement lines did not load. Check the connection and try again.')
      }
    },
    [accountId, status, from, to],
  )

  useEffect(() => {
    // Aborting the stale request on every filter change means a slow response
    // can never land after a fast one and put the wrong lines under the inputs.
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load(controller.signal)
    return () => controller.abort()
  }, [load])

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
      // The line's status has moved, so the list it belongs in has changed with
      // it. Reload rather than patching the row in place and hoping.
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

      <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>Account</span>
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)} style={controlStyle}>
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
              onChange={(event) => setStatus(event.target.value as typeof status)}
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
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} style={controlStyle} />
          </label>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>To</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} style={controlStyle} />
          </label>
        </div>
      </div>

      {account && feed?.summary && <Position account={account} summary={feed.summary} />}

      {feed && feed.rows.length === 0 && (
        <EmptyState title={status === 'unreconciled' ? 'Nothing left to explain.' : 'Nothing here.'}>
          <p style={{ margin: 0 }}>
            {status === 'unreconciled'
              ? 'Every line on this account is either ticked off against an entry or set aside. That is the whole point of the exercise, so: well done.'
              : 'Try a different filter, or import a statement for this account.'}
          </p>
        </EmptyState>
      )}

      {feed && feed.rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={headStyle}>Date</th>
                <th style={headStyle}>What the bank says</th>
                <th style={{ ...headStyle, textAlign: 'right' }}>Amount</th>
                <th style={headStyle}>What it is</th>
              </tr>
            </thead>
            <tbody>
              {feed.rows.map((row) => (
                <StatementRow
                  key={row.id}
                  row={row}
                  suggestions={feed.suggestions[row.id] ?? []}
                  matched={matches[row.id] ?? []}
                  open={openLine === row.id}
                  busy={busy}
                  canRecord={canRecord}
                  adminPath={adminPath}
                  onToggle={() => openMatches(row.id)}
                  onAct={(body) => act(row.id, body)}
                />
              ))}
            </tbody>
          </table>
        </div>
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

function StatementRow({
  row,
  suggestions,
  matched,
  open,
  busy,
  canRecord,
  adminPath,
  onToggle,
  onAct,
}: {
  row: BankTransaction
  suggestions: MatchCandidate[]
  matched: MatchedEntry[]
  open: boolean
  busy: boolean
  canRecord: boolean
  adminPath: string
  onToggle: () => void
  onAct: (body: Record<string, unknown>) => void
}) {
  const [reason, setReason] = useState('')

  return (
    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
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

            {suggestions.length === 0 && (
              <span style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
                Nothing in the books looks like this one.
              </span>
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

            {canRecord && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  aria-label={`Why the ${formatDate(row.date)} line is being set aside`}
                  placeholder="Why it needs no entry"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  style={{ ...controlStyle, minWidth: 200 }}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => onAct({ action: 'ignore', reason })}
                >
                  Set it aside
                </button>
                <a className="btn btn-sm" href={`/${adminPath}/m/uk-bookkeeping/transactions/new`}>
                  Record it as a new entry
                </a>
              </div>
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
