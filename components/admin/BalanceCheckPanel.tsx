'use client'

import { useEffect, useState } from 'react'
import { addStrings, formatDate, poundsFromString } from './format'

// Checking a cash account against the balance its supplier shows, for the ones
// with no statement to import. Shown above the statement feed for every cash
// account: one that does have statements gets a cross-check as well, and one
// that has none gets the only check there is. See lib/balance-checks.ts.

type Entry = {
  date: string
  counterparty: string
  description: string
  debit: string
  credit: string
  balance: string
}

type Check = {
  asAt: string
  booksBalance: string
  statedBalance: string
  difference: string
  note: string | null
}

type Position = {
  asAt: string
  booksBalance: string
  recent: Entry[]
  latest: Check | null
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

const mutedStyle: React.CSSProperties = { color: 'var(--color-text-muted, var(--color-text))' }

function negated(value: string): string {
  return value.startsWith('-') ? value.slice(1) : `-${value}`
}

/** What the box holds, if it is an amount; null while it is empty or half typed. */
function readAmount(typed: string): string | null {
  const cleaned = typed.replace(/[£,\s]/g, '')
  return /^-?\d{1,10}(\.\d{1,2})?$/.test(cleaned) ? cleaned : null
}

export default function BalanceCheckPanel({
  bankAccountId,
  accountName,
  canRecord,
}: {
  bankAccountId: string
  accountName: string
  canRecord: boolean
}) {
  const [asAt, setAsAt] = useState('')
  const [position, setPosition] = useState<Position | null>(null)
  const [typed, setTyped] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const [reload, setReload] = useState(0)

  useEffect(() => {
    const query = new URLSearchParams({ bankAccountId })
    if (asAt) query.set('asAt', asAt)
    let current = true
    fetch(`/api/m/uk-bookkeeping/admin/balance-checks?${query.toString()}`)
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (!current) return
        if (!ok) {
          setError(data.error ?? 'We could not work out the balance in the books.')
          setPosition(null)
          return
        }
        setError(null)
        setPosition(data as Position)
      })
      .catch(() => {
        if (current) setError('We could not work out the balance in the books.')
      })
    return () => {
      current = false
    }
  }, [bankAccountId, asAt, reload])

  const amount = readAmount(typed)
  const difference = position && amount ? addStrings(amount, negated(position.booksBalance)) : null
  const agrees = difference !== null && !/[1-9]/.test(difference)

  async function save() {
    if (!amount || !position) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/balance-checks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bankAccountId, asAt: position.asAt, statedBalance: amount, note: note || null }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(data.error ?? 'That check could not be saved.')
        return
      }
      setSaved(true)
      setTyped('')
      setNote('')
      setReload((count) => count + 1)
    } catch {
      setError('That check could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem', fontSize: 'var(--text-sm)' }}>
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Balance check</div>
      <p style={{ margin: '0 0 0.75rem', ...mutedStyle }}>
        For a balance held with a supplier that gives you a figure rather than a statement. Type in what{' '}
        {accountName} shows on their side and see whether the books agree.
      </p>

      {error && (
        <div className="alert alert-danger" role="alert" style={{ marginBottom: '0.75rem' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem' }}>As at</span>
          <input type="date" value={asAt || position?.asAt || ''} onChange={(event) => setAsAt(event.target.value)} style={controlStyle} />
        </label>
        <div>
          <div style={mutedStyle}>According to the books</div>
          <div style={{ fontSize: '1.125rem', fontWeight: 600 }}>
            {position ? poundsFromString(position.booksBalance) : '-'}
          </div>
        </div>
        <label>
          <span style={{ display: 'block', marginBottom: '0.25rem' }}>According to {accountName}</span>
          <input
            inputMode="decimal"
            value={typed}
            placeholder="0.00"
            onChange={(event) => {
              setTyped(event.target.value)
              setSaved(false)
            }}
            style={{ ...controlStyle, width: '9rem' }}
          />
        </label>
        <div>
          <div style={mutedStyle}>Difference</div>
          <div
            style={{
              fontSize: '1.125rem',
              fontWeight: 600,
              color: difference === null ? undefined : agrees ? 'var(--color-success, var(--color-text))' : 'var(--color-danger, var(--color-text))',
            }}
          >
            {difference === null ? '-' : agrees ? 'Agrees' : poundsFromString(difference)}
          </div>
        </div>
      </div>

      {difference !== null && !agrees && (
        <p style={{ margin: '0.75rem 0 0', ...mutedStyle }}>
          {difference.startsWith('-')
            ? `${accountName} shows less than the books. Look for a top-up that was recorded but never arrived, or a bill taken out of it that is not recorded as paid from here.`
            : `${accountName} shows more than the books. Look for a top-up that has not been recorded, or a bill recorded as paid from here that was not.`}
        </p>
      )}

      {canRecord && (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '0.75rem' }}>
          <label style={{ flex: '1 1 14rem' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>Note (optional)</span>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Read off the billing page"
              style={{ ...controlStyle, width: '100%' }}
            />
          </label>
          <button type="button" className="btn btn-sm btn-primary" disabled={!amount || busy} onClick={() => void save()}>
            {busy ? 'Saving...' : 'Save this check'}
          </button>
          {saved && <span role="status" style={mutedStyle}>Saved.</span>}
        </div>
      )}

      {position?.latest && (
        <p style={{ margin: '0.75rem 0 0', ...mutedStyle }}>
          Last checked for {formatDate(position.latest.asAt)}:{' '}
          {poundsFromString(position.latest.statedBalance)} stated against {poundsFromString(position.latest.booksBalance)} in the
          books
          {/[1-9]/.test(position.latest.difference) ? `, out by ${poundsFromString(position.latest.difference)}` : ', agreed'}.
        </p>
      )}

      {position && position.recent.length > 0 && (
        <details style={{ marginTop: '0.75rem' }}>
          <summary style={{ cursor: 'pointer' }}>Latest movements in this account</summary>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem' }}>
            <tbody>
              {position.recent.map((entry, index) => (
                <tr key={`${entry.date}-${index}`} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '0.375rem 0.5rem' }}>{formatDate(entry.date)}</td>
                  <td style={{ padding: '0.375rem 0.5rem' }}>{entry.counterparty}</td>
                  <td style={{ padding: '0.375rem 0.5rem', textAlign: 'right' }}>
                    {/[1-9]/.test(entry.debit) ? `+${poundsFromString(entry.debit)}` : `-${poundsFromString(entry.credit)}`}
                  </td>
                  <td style={{ padding: '0.375rem 0.5rem', textAlign: 'right' }}>{poundsFromString(entry.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}
