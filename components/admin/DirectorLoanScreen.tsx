'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { formatDate, poundsFromString } from './format'

// The director's loan account, in words rather than in accounting.
//
// The one thing this screen has to get right is which way round the balance is.
// A bare "-1,234.50" tells an owner nothing useful and tells them the wrong
// thing half the time, so every figure on this page that could be read either
// way is spelled out: the company owes you, or you owe the company. The second
// one is the direction with a tax consequence, which is why it is dressed as a
// warning and never as an error - being lent money by your own company is
// perfectly legal, it just has a bill attached if it is still outstanding at the
// year end.

/**
 * Only the columns this screen reads. Dates come off the wire as strings rather
 * than the Date objects the server type carries, which is the other reason not
 * to import the server's row type into a client component.
 */
type LoanAccount = {
  id: string
  name: string
  person_name: string | null
}

type Movement = {
  kind: 'journal' | 'transaction'
  id: string
  date: string
  narrative: string
  reference: string | null
  /** Positive puts the company further into debt to the director; negative takes it back. */
  amount: string
  /** The balance after this movement, same convention. */
  balance: string
}

type YearEnd = {
  date: string
  balance: string
  overdrawn: boolean
  repayBy: string
  notes: string[]
}

type Statement = {
  account: LoanAccount
  movements: Movement[]
  /**
   * Where the account stands today. Positive: the company owes the director.
   * Negative: the director owes the company. Not affected by the date filter -
   * that narrows the movements below and nothing else.
   */
  balance: string
  overdrawn: boolean
  /** What the account already held before the first movement shown. */
  broughtForward: string
  yearEnd: YearEnd | null
}

type Data = {
  accounts: LoanAccount[]
  /** Every loan account's position at once. The overview tile is what consumes this. */
  summaries: {
    accountId: string
    name: string
    personName: string | null
    balance: string
    overdrawn: boolean
  }[]
  statement: Statement | null
}

const input: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
}

const fieldLabel: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs, 0.75rem)',
  color: 'var(--color-text-muted, var(--color-text))',
}

const cell: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  verticalAlign: 'top',
}

const money: React.CSSProperties = {
  ...cell,
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

const heading: React.CSSProperties = {
  margin: '0 0 0.5rem',
  fontSize: 'var(--text-sm)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: 'var(--color-text-muted, var(--color-text))',
}

const muted: React.CSSProperties = {
  fontSize: 'var(--text-xs, 0.75rem)',
  color: 'var(--color-text-muted, var(--color-text))',
}

// Money arrives as a two-place decimal string and stays one. Number() would turn
// "-1234.50" into a float that is only usually right, and these three questions
// are the only ones the screen ever asks of a balance.
function isNegative(value: string): boolean {
  return value.trim().startsWith('-')
}

function isZero(value: string): boolean {
  return /^-?0*(\.0*)?$/.test(value.trim())
}

function withoutSign(value: string): string {
  return value.trim().replace(/^-/, '')
}

/** Whose account it is, in the second person when nobody is named on it. */
function personOf(account: LoanAccount | null | undefined): string {
  return account?.person_name?.trim() || 'you'
}

/**
 * The sentence that stops anybody reading the balance backwards. Past tense for
 * the year-end card, present for the position card - same words either way, so
 * the two cards cannot end up saying it differently.
 */
function positionSentence(balance: string, person: string, past = false): string {
  const amount = poundsFromString(withoutSign(balance))
  if (isZero(balance)) {
    return past ? 'The loan account was clear.' : 'The loan account is clear.'
  }
  if (isNegative(balance)) {
    return person === 'you'
      ? `You ${past ? 'owed' : 'owe'} the company ${amount}.`
      : `${person} ${past ? 'owed' : 'owes'} the company ${amount}.`
  }
  return `The company ${past ? 'owed' : 'owes'} ${person} ${amount}.`
}

/** Placeholder card while the first load runs, so the page does not jump. */
function LoadingCard() {
  return (
    <div className="card" style={{ padding: '0.75rem' }} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
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

export default function DirectorLoanScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accountId, setAccountId] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const query = new URLSearchParams()
      if (accountId) query.set('accountId', accountId)
      if (range.from) query.set('from', range.from)
      if (range.to) query.set('to', range.to)

      try {
        const response = await fetch(
          `/api/m/uk-bookkeeping/admin/director-loan?${query.toString()}`,
          { signal },
        )
        if (!response.ok) {
          const problem = await response.json().catch(() => ({}))
          setError(problem.error ?? 'The loan account could not be loaded.')
          return
        }
        const payload = (await response.json()) as Data
        if (signal?.aborted) return
        setError(null)
        setData(payload)
      } catch (err) {
        // The abort is ours - changing the account or the dates cancels the
        // fetch it outran.
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError('The loan account could not be loaded. Check the connection and try again.')
      }
    },
    [accountId, range],
  )

  useEffect(() => {
    // Aborting the stale request means a slow answer can never land after a fast
    // one and put one director's balance under another director's name.
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const statement = data?.statement ?? null
  // With nothing picked the server chooses the first account, so the picker
  // follows what came back rather than the other way round.
  const selectedId = accountId || statement?.account.id || ''
  const person = personOf(statement?.account)
  const base = `/${adminPath}/m/uk-bookkeeping`

  // Where the account stands today, which is what somebody asking "how do I
  // stand?" means - never the balance of whatever date range happens to be in
  // the filter. Both the statement and the summaries answer that same question,
  // so either will do and the summary is only a fallback.
  const summary = data?.summaries.find((row) => row.accountId === selectedId) ?? null
  const position = statement?.balance ?? summary?.balance ?? '0.00'
  const overdrawn = statement ? statement.overdrawn : (summary?.overdrawn ?? false)
  const filtered = Boolean(range.from || range.to)

  return (
    <div>
      <BookkeepingNav active="director-loan" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {!data && !error && <LoadingCard />}

      {data && data.accounts.length === 0 && (
        <EmptyState title="There is no director’s loan account set up yet.">
          <p style={{ margin: '0 0 0.75rem' }}>
            This is where money you put into the company, and money you take out that is not wages
            or a dividend, is kept track of. Add a director’s loan account to your ledger accounts
            in the bookkeeping settings, say whose it is, and the balance builds itself from what
            you record after that.
          </p>
        </EmptyState>
      )}

      {data && data.accounts.length > 0 && (
        <>
          <div
            className="card"
            style={{
              padding: '0.875rem',
              marginBottom: '1rem',
              display: 'flex',
              gap: '0.625rem',
              flexWrap: 'wrap',
              alignItems: 'flex-end',
            }}
          >
            {data.accounts.length > 1 ? (
              <div>
                <label htmlFor="bk-dl-account" style={fieldLabel}>
                  Whose account
                </label>
                <select
                  id="bk-dl-account"
                  style={input}
                  value={selectedId}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  {data.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.person_name?.trim() || account.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <span style={fieldLabel}>Whose account</span>
                <span style={{ display: 'block', fontWeight: 600 }}>
                  {data.accounts[0]?.person_name?.trim() || data.accounts[0]?.name}
                </span>
              </div>
            )}

            <div>
              <label htmlFor="bk-dl-from" style={fieldLabel}>
                From
              </label>
              <input
                id="bk-dl-from"
                type="date"
                style={input}
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="bk-dl-to" style={fieldLabel}>
                To
              </label>
              <input
                id="bk-dl-to"
                type="date"
                style={input}
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </div>
            {(range.from || range.to) && (
              <button type="button" className="btn btn-sm" onClick={() => setRange({ from: '', to: '' })}>
                Show everything
              </button>
            )}
          </div>

          {statement && (
            <div
              className="card"
              style={{
                padding: '1.25rem',
                marginBottom: '1rem',
                background: overdrawn
                  ? 'var(--color-warning-bg, var(--color-surface))'
                  : 'var(--color-surface)',
                borderColor: overdrawn
                  ? 'var(--color-warning, var(--color-border))'
                  : 'var(--color-border)',
              }}
              role="status"
            >
              <p style={heading}>Where it stands today</p>
              <p
                style={{
                  margin: '0 0 0.375rem',
                  fontSize: '1.375rem',
                  fontWeight: 700,
                  color: 'var(--color-text)',
                }}
              >
                {positionSentence(position, person)}
              </p>
              <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text)' }}>
                {isZero(position)
                  ? 'Nothing is owed in either direction.'
                  : overdrawn
                    ? 'That is the direction worth watching. Money owed to the company at the year end can cost the company tax until it is paid back, so it is worth clearing before the year end rather than after it.'
                    : 'That is the harmless direction. The company can pay it back whenever it has the money, and there is no tax to pay on doing so.'}
              </p>
              {filtered && (
                <p style={{ ...muted, margin: '0.5rem 0 0' }}>
                  The dates above only narrow the list of movements below. This figure counts
                  everything on the account.
                </p>
              )}
            </div>
          )}

          {statement?.yearEnd && (
            <div
              className="card"
              style={{
                padding: '1.25rem',
                marginBottom: '1rem',
                borderColor: statement.yearEnd.overdrawn
                  ? 'var(--color-warning, var(--color-border))'
                  : 'var(--color-border)',
              }}
            >
              <p style={heading}>At your last year end</p>
              <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>
                {formatDate(statement.yearEnd.date)}
                {': '}
                {positionSentence(statement.yearEnd.balance, person, true)}
              </p>

              {statement.yearEnd.overdrawn && (
                <p
                  style={{
                    margin: '0 0 0.75rem',
                    padding: '0.5rem 0.75rem',
                    borderRadius: 8,
                    border: '1px solid var(--color-warning, var(--color-border))',
                    background: 'var(--color-warning-bg, var(--color-surface))',
                    color: 'var(--color-text)',
                    fontWeight: 600,
                  }}
                >
                  Pay it back by {formatDate(statement.yearEnd.repayBy)}.
                </p>
              )}

              <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', fontSize: 'var(--text-sm)' }}>
                {statement.yearEnd.notes.map((note) => (
                  <li key={note} style={{ marginBottom: '0.25rem' }}>
                    {note}
                  </li>
                ))}
              </ul>

              <p style={{ ...muted, margin: '0 0 0.5rem' }}>
                This is a summary of where the account stands, not tax advice - have your accountant
                confirm it before you act on it.
              </p>
              <a
                className="btn btn-sm"
                href="https://www.gov.uk/directors-loans"
                target="_blank"
                rel="noopener noreferrer"
              >
                Read HMRC’s guidance on director’s loans
              </a>
            </div>
          )}

          <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
            <p style={heading}>What moves this balance</p>
            <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', fontSize: 'var(--text-sm)' }}>
              <li style={{ marginBottom: '0.25rem' }}>
                Transfers to and from the director on a bank statement, once the entry is coded to
                the director’s loan category.
              </li>
              <li>
                Journals with a line on the loan account, which is how anything paid for personally,
                or taken out without going through the bank, gets on here.
              </li>
            </ul>
            {canRecord && (
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <a className="btn btn-sm" href={`${base}/transactions/new`}>
                  Record an entry
                </a>
                <a className="btn btn-sm" href={`${base}/journals`}>
                  Post a journal
                </a>
              </div>
            )}
          </div>

          {statement && statement.movements.length === 0 && (
            <EmptyState title="Nothing has moved on this account.">
              <p style={{ margin: 0 }}>
                {filtered
                  ? 'Nothing between those two dates, at any rate. Widen them and have another look.'
                  : 'Once money goes in or comes out, every movement shows up here with the balance after it.'}
              </p>
            </EmptyState>
          )}

          {statement && statement.movements.length > 0 && (
            <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                <caption style={{ ...muted, padding: '0.625rem 0.75rem', textAlign: 'left', captionSide: 'top' }}>
                  Oldest first, because the balance on the right is a running one - read it
                  downwards.
                  {filtered && statement.broughtForward !== '0.00'
                    ? ` It starts from the ${poundsFromString(statement.broughtForward)} the account already stood at before the first date you chose.`
                    : ''}
                </caption>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ padding: '0.625rem 0.75rem' }}>Date</th>
                    <th style={{ padding: '0.625rem 0.75rem' }}>What it was</th>
                    <th style={{ padding: '0.625rem 0.75rem' }}>Recorded as</th>
                    <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Amount</th>
                    <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Balance after</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.movements.map((movement) => {
                    const href =
                      movement.kind === 'journal'
                        ? `${base}/journals?id=${movement.id}`
                        : `${base}/transactions/${movement.id}`
                    return (
                      <tr
                        key={`${movement.kind}-${movement.id}`}
                        style={{ borderBottom: '1px solid var(--color-border)' }}
                      >
                        <td style={{ ...cell, whiteSpace: 'nowrap' }}>{formatDate(movement.date)}</td>
                        <td style={cell}>
                          <a href={href}>{movement.narrative}</a>
                          {movement.reference && (
                            <span style={{ ...muted, display: 'block' }}>{movement.reference}</span>
                          )}
                        </td>
                        <td style={cell}>
                          <span style={muted}>{movement.kind === 'journal' ? 'journal' : 'entry'}</span>
                        </td>
                        <td style={money}>
                          {poundsFromString(withoutSign(movement.amount))}
                          <span style={{ ...muted, display: 'block' }}>
                            {isNegative(movement.amount) ? 'taken out' : 'put in'}
                          </span>
                        </td>
                        <td style={money}>
                          {poundsFromString(withoutSign(movement.balance))}
                          <span style={{ ...muted, display: 'block' }}>
                            {isZero(movement.balance)
                              ? 'clear'
                              : isNegative(movement.balance)
                                ? 'owed to the company'
                                : 'owed by the company'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
