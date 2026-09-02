'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { addStrings, formatDate, poundsFromString, toDateInput, today } from './format'

// Journals: the side of the books where no money moves.
//
// The editor opens above the list rather than on a page of its own, because a
// journal is nearly always written while looking at the ones already there -
// this year's accrual gets typed with last year's on the screen underneath it.
//
// Every amount here is a decimal STRING from the first keystroke to the save.
// The running total goes through addStrings for that reason: a journal that
// balances to the penny in the browser and not in the database is the one bug
// this screen could plausibly have, and a float would be how it happened.

type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

// Row shapes as JSON leaves the server: dates arrive as strings, and every
// NUMERIC comes across as a decimal string. Declared here rather than imported
// from lib/types.ts so this file never reaches for anything Prisma-shaped.
type JournalRow = {
  id: string
  date: string
  /**
   * A transfer between two of the business's own accounts is a journal
   * underneath, and shows here so an accountant reading the journals sees all of
   * them - but it is changed on its own form, not in the editor below.
   */
  kind: 'journal' | 'transfer'
  reference: string | null
  narrative: string
  status: 'draft' | 'posted'
  reverses_journal_id: string | null
  reversed_by_journal_id: string | null
  locked_period_id: string | null
  total_debits: string
  line_count: number
  accounts: string
}

type Account = {
  id: string
  code: string
  name: string
  kind: AccountKind
  archived: boolean
  position: number
}

type Template = {
  id: string
  label: string
  description: string
  narrative: string
  debitCode: string
  creditCode: string
  reversing: boolean
  debitAccountId: string | null
  creditAccountId: string | null
}

type List = {
  rows: JournalRow[]
  total: number
  accounts: Account[]
  templates: Template[]
}

type JournalDetail = {
  id: string
  date: string
  reference: string | null
  narrative: string
  status: 'draft' | 'posted'
  lines: { account_id: string; description: string; debit: string; credit: string }[]
}

type EditorLine = {
  /** Client-side identity for React keys and input ids. Never sent to the server. */
  uid: string
  accountId: string
  description: string
  debit: string
  credit: string
}

type Editor = {
  id: string | null
  status: 'draft' | 'posted'
  date: string
  reference: string
  narrative: string
  lines: EditorLine[]
}

// Keys must survive a mid-list removal: keyed by index, removing line two hands
// line three's cursor to whatever has just slid into its place.
let lineUidCounter = 0
const nextLineUid = () => {
  lineUidCounter += 1
  return `jline-${lineUidCounter}`
}

const emptyLine = (): EditorLine => ({
  uid: nextLineUid(),
  accountId: '',
  description: '',
  debit: '',
  credit: '',
})

const input: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
}

const fieldInput: React.CSSProperties = { ...input, width: '100%' }

const label: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-sm)',
  marginBottom: '0.25rem',
  color: 'var(--color-text-muted, var(--color-text))',
}

const filterLabel: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs, 0.75rem)',
}

const cell: React.CSSProperties = { padding: '0.5rem 0.75rem' }

const money: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  textAlign: 'right',
  whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
}

const quiet: React.CSSProperties = {
  fontSize: 'var(--text-xs, 0.75rem)',
  color: 'var(--color-text-muted, var(--color-text))',
}

// The same plain-English headings the accounts themselves are grouped under.
const KIND_GROUPS: { kind: AccountKind; label: string }[] = [
  { kind: 'asset', label: 'Things the business owns or is owed' },
  { kind: 'liability', label: 'Things the business owes' },
  { kind: 'equity', label: 'The owners’ stake' },
  { kind: 'income', label: 'Income' },
  { kind: 'expense', label: 'Costs' },
]

/**
 * Flip the sign of a total that addStrings has already normalised, so the two
 * sides can be subtracted without a float and without addStrings being handed a
 * double minus.
 */
function negate(value: string): string {
  return value.startsWith('-') ? value.slice(1) : `-${value}`
}

const absolute = (value: string): string => (value.startsWith('-') ? value.slice(1) : value)

/** Placeholder rows while the first page loads, so the layout does not jump. */
function LoadingRows() {
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

function StatusPill({ status }: { status: 'draft' | 'posted' }) {
  const colour =
    status === 'posted' ? 'var(--color-success, var(--color-text))' : 'var(--color-warning, var(--color-text))'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.125rem 0.5rem',
        borderRadius: 999,
        border: `1px solid ${colour}`,
        color: colour,
        fontSize: 'var(--text-xs, 0.75rem)',
        whiteSpace: 'nowrap',
      }}
    >
      {status === 'posted' ? 'Posted' : 'Waiting'}
    </span>
  )
}

export default function JournalsScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const [list, setList] = useState<List | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [reversing, setReversing] = useState<{ id: string; narrative: string; date: string } | null>(null)
  const [filters, setFilters] = useState({ from: '', to: '', status: '', search: '' })

  // The text filter waits for the typing to pause rather than querying on every
  // keystroke. The input binds to this; the debounce feeds it to the filter.
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((prev) => (prev.search === searchInput ? prev : { ...prev, search: searchInput }))
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value)
    }

    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/journals?${query.toString()}`, { signal })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        setError(payload.error ?? 'The journals could not be loaded.')
        return
      }
      const data = (await response.json()) as List
      if (signal?.aborted) return
      setError(null)
      setList(data)
    } catch (err) {
      // The abort is ours - typing in a filter cancels the fetch it outran.
      if (err instanceof DOMException && err.name === 'AbortError') return
      setError('The journals could not be loaded. Check the connection and try again.')
    }
  }, [filters])

  useEffect(() => {
    // Aborting the stale request on every filter change means a slow response
    // can never land after a fast one and put the wrong rows under the inputs.
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  const accounts = useMemo(() => (list?.accounts ?? []).filter((account) => !account.archived), [list])

  const grouped = useMemo(
    () =>
      KIND_GROUPS.map((group) => ({
        ...group,
        accounts: accounts
          .filter((account) => account.kind === group.kind)
          .sort((a, b) => a.position - b.position || a.code.localeCompare(b.code)),
      })).filter((group) => group.accounts.length > 0),
    [accounts],
  )

  /**
   * The two sides, added as they are typed. Both totals go through addStrings,
   * which is tolerant of half-typed rubbish, so the figures on the screen are
   * exactly the figures that will be saved.
   */
  const balance = useMemo(() => {
    const lines = editor?.lines ?? []
    const debits = lines.reduce((total, line) => addStrings(total, line.debit || '0.00'), '0.00')
    const credits = lines.reduce((total, line) => addStrings(total, line.credit || '0.00'), '0.00')
    const difference = addStrings(debits, negate(credits))
    return {
      debits,
      credits,
      difference,
      balanced: difference === '0.00',
      empty: debits === '0.00' && credits === '0.00',
    }
  }, [editor])

  function setLine(uid: string, patch: Partial<EditorLine>) {
    setEditor((prev) =>
      prev ? { ...prev, lines: prev.lines.map((line) => (line.uid === uid ? { ...line, ...patch } : line)) } : prev,
    )
  }

  function startNew(template?: Template) {
    setNotice(null)
    setError(null)
    setReversing(null)
    const first = emptyLine()
    const second = emptyLine()
    setEditor({
      id: null,
      status: 'draft',
      date: today(),
      reference: '',
      narrative: template?.narrative ?? '',
      lines: [
        { ...first, accountId: template?.debitAccountId ?? '' },
        { ...second, accountId: template?.creditAccountId ?? '' },
      ],
    })
  }

  async function openExisting(id: string) {
    setNotice(null)
    setError(null)
    setReversing(null)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/journals/${id}`)
      const payload = (await response.json().catch(() => ({}))) as { journal?: JournalDetail; error?: string }
      if (!response.ok || !payload.journal) {
        setError(payload.error ?? 'That journal could not be opened.')
        return
      }
      const journal = payload.journal
      setEditor({
        id: journal.id,
        status: journal.status,
        date: toDateInput(journal.date),
        reference: journal.reference ?? '',
        narrative: journal.narrative,
        // Amounts come back as decimal strings that may not be carrying their
        // pence, so each one is put back through addStrings. The side with
        // nothing on it is left blank rather than showing a nought, because one
        // amount per line is the whole rule.
        lines: journal.lines.map((line) => {
          const debit = addStrings(line.debit, '0.00')
          const credit = addStrings(line.credit, '0.00')
          return {
            uid: nextLineUid(),
            accountId: line.account_id,
            description: line.description ?? '',
            debit: debit === '0.00' ? '' : debit,
            credit: credit === '0.00' ? '' : credit,
          }
        }),
      })
    } catch {
      setError('That journal could not be opened. Check the connection and try again.')
    }
  }

  async function save(status: 'draft' | 'posted') {
    if (!editor) return
    setBusy(true)
    setError(null)
    setNotice(null)

    const body = {
      date: editor.date,
      reference: editor.reference.trim() || null,
      narrative: editor.narrative.trim(),
      status,
      // Spare rows nobody filled in are dropped rather than sent as empty lines
      // for the server to refuse. Anything with an account or an amount on it
      // goes, so a half-finished line still gets its proper complaint back.
      lines: editor.lines
        .filter((line) => line.accountId || line.debit.trim() || line.credit.trim())
        .map((line) => ({
          accountId: line.accountId,
          description: line.description.trim(),
          debit: addStrings(line.debit || '0.00', '0.00'),
          credit: addStrings(line.credit || '0.00', '0.00'),
        })),
    }

    try {
      const response = await fetch(
        editor.id
          ? `/api/m/uk-bookkeeping/admin/journals/${editor.id}`
          : '/api/m/uk-bookkeeping/admin/journals',
        {
          method: editor.id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setError(payload.error ?? 'That could not be saved.')
        return
      }
      setEditor(null)
      setNotice(status === 'posted' ? 'Journal posted.' : 'Saved, and waiting for you to post it.')
      await load()
    } catch {
      // A dropped connection must not leave the buttons disabled with no
      // explanation. Nothing typed has been lost, so say so.
      setError('The save did not reach the server. Check the connection and try again - everything typed is still here.')
    } finally {
      setBusy(false)
    }
  }

  async function post(id: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/journals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setError(payload.error ?? 'That journal could not be posted.')
        return
      }
      setNotice('Journal posted.')
      await load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function reverse() {
    if (!reversing) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/journals/${reversing.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reverse', date: reversing.date }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setError(payload.error ?? 'That journal could not be reversed.')
        return
      }
      setReversing(null)
      setNotice('Reversed. The original stays exactly as it was, with the reversal beneath it.')
      await load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(row: JournalRow) {
    if (
      !window.confirm(
        `Delete the journal for "${row.narrative}"? It has not been filed, so nothing else changes - but it will not come back.`,
      )
    ) {
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/journals/${row.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        setError(payload.error ?? 'That journal could not be deleted.')
        return
      }
      if (editor?.id === row.id) setEditor(null)
      setNotice('Journal deleted.')
      await load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const usableTemplates = (list?.templates ?? []).filter(
    (template) => template.debitAccountId && template.creditAccountId,
  )

  return (
    <div>
      <BookkeepingNav active="journals" />
      <SandboxBanner environment={environment} />
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

      <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>What journals are for</h2>
        <p style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          Most of what goes in your books is money moving - something bought, something sold. Journals
          are for the rest of it: writing equipment down over the years you use it, putting a cost in
          the year it belongs to when the bill turns up late or early, moving something filed against
          the wrong thing, and money the director put in or took out other than through the bank.
        </p>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
          <strong>A journal never touches a VAT return.</strong> If there is VAT on it, it is a receipt
          or a sale, and it belongs under{' '}
          <a href={`/${adminPath}/m/uk-bookkeeping/transactions`}>Entries</a> instead.
        </p>
      </div>

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
        <div>
          <label htmlFor="bk-j-from" style={filterLabel}>From</label>
          <input
            id="bk-j-from"
            type="date"
            style={input}
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="bk-j-to" style={filterLabel}>To</label>
          <input
            id="bk-j-to"
            type="date"
            style={input}
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor="bk-j-status" style={filterLabel}>State</label>
          <select
            id="bk-j-status"
            style={input}
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">All</option>
            <option value="draft">Waiting to be posted</option>
            <option value="posted">Posted</option>
          </select>
        </div>
        <div>
          <label htmlFor="bk-j-search" style={filterLabel}>Search</label>
          <input
            id="bk-j-search"
            style={input}
            value={searchInput}
            placeholder="Note or reference"
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        {canRecord && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
            {usableTemplates.length > 0 && (
              <div>
                <label htmlFor="bk-j-template" style={filterLabel}>Start from a common one</label>
                <select
                  id="bk-j-template"
                  style={input}
                  value=""
                  onChange={(e) => {
                    const template = usableTemplates.find((t) => t.id === e.target.value)
                    if (template) startNew(template)
                  }}
                >
                  <option value="">Choose one…</option>
                  {usableTemplates.map((template) => (
                    <option key={template.id} value={template.id} title={template.description}>
                      {template.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button type="button" className="btn btn-sm btn-primary" onClick={() => startNew()}>
              New journal
            </button>
          </div>
        )}
      </div>

      {reversing && (
        <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
          <p style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
            Reversing <strong>{reversing.narrative}</strong> writes the same lines the other way round
            on a date you choose. The original is left exactly as it was, which is rather the point -
            the books show what was posted and what was then taken back, not neither.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label htmlFor="bk-j-reverse-date" style={label}>Date for the reversal</label>
              <input
                id="bk-j-reverse-date"
                type="date"
                style={input}
                value={reversing.date}
                onChange={(e) => setReversing({ ...reversing, date: e.target.value })}
              />
            </div>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={reverse}>
              {busy ? 'Working…' : 'Reverse it'}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setReversing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {editor && (
        <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          <h2 style={{ margin: '0 0 1rem', fontSize: '0.9375rem' }}>
            {editor.id ? 'Change this journal' : 'A new journal'}
          </h2>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '1rem',
              marginBottom: '1rem',
            }}
          >
            <div>
              <label style={label} htmlFor="bk-j-date">Date</label>
              <input
                id="bk-j-date"
                type="date"
                style={fieldInput}
                value={editor.date}
                onChange={(e) => setEditor({ ...editor, date: e.target.value })}
              />
            </div>
            <div>
              <label style={label} htmlFor="bk-j-reference">Reference (if it has one)</label>
              <input
                id="bk-j-reference"
                style={fieldInput}
                value={editor.reference}
                onChange={(e) => setEditor({ ...editor, reference: e.target.value })}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={label} htmlFor="bk-j-narrative">What this is for</label>
              <input
                id="bk-j-narrative"
                style={fieldInput}
                value={editor.narrative}
                placeholder="Written for whoever reads it in a year, including you"
                onChange={(e) => setEditor({ ...editor, narrative: e.target.value })}
              />
            </div>
          </div>

          <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Every line carries an amount on one side or the other, never both, and the two sides have
            to come to the same figure before it can be posted.
          </p>

          {editor.lines.map((line, index) => (
            <div
              key={line.uid}
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                padding: '0.875rem',
                marginBottom: '0.75rem',
              }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem' }}>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={label} htmlFor={`${line.uid}-account`}>Account</label>
                  <select
                    id={`${line.uid}-account`}
                    style={fieldInput}
                    value={line.accountId}
                    onChange={(e) => setLine(line.uid, { accountId: e.target.value })}
                  >
                    <option value="">Choose an account…</option>
                    {grouped.map((group) => (
                      <optgroup key={group.kind} label={group.label}>
                        {group.accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={label} htmlFor={`${line.uid}-description`}>Note for this line</label>
                  <input
                    id={`${line.uid}-description`}
                    style={fieldInput}
                    value={line.description}
                    onChange={(e) => setLine(line.uid, { description: e.target.value })}
                  />
                </div>
                <div>
                  <label style={label} htmlFor={`${line.uid}-debit`}>Debit</label>
                  <input
                    id={`${line.uid}-debit`}
                    style={fieldInput}
                    inputMode="decimal"
                    value={line.debit}
                    // One amount per line: typing on one side clears the other,
                    // rather than letting a line be built that the server will
                    // only refuse once it is finished.
                    onChange={(e) => setLine(line.uid, { debit: e.target.value, credit: '' })}
                  />
                </div>
                <div>
                  <label style={label} htmlFor={`${line.uid}-credit`}>Credit</label>
                  <input
                    id={`${line.uid}-credit`}
                    style={fieldInput}
                    inputMode="decimal"
                    value={line.credit}
                    onChange={(e) => setLine(line.uid, { credit: e.target.value, debit: '' })}
                  />
                </div>
              </div>

              {editor.lines.length > 2 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginTop: '0.5rem' }}
                  aria-label={`Remove line ${index + 1}`}
                  onClick={() =>
                    setEditor({ ...editor, lines: editor.lines.filter((other) => other.uid !== line.uid) })
                  }
                >
                  Remove this line
                </button>
              )}
            </div>
          ))}

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setEditor({ ...editor, lines: [...editor.lines, emptyLine()] })}
          >
            Add another line
          </button>

          <div
            style={{
              marginTop: '1rem',
              paddingTop: '0.75rem',
              borderTop: '1px solid var(--color-border)',
              display: 'flex',
              gap: '1.5rem',
              flexWrap: 'wrap',
            }}
            role="status"
          >
            <span>Debits: <strong>{poundsFromString(balance.debits)}</strong></span>
            <span>Credits: <strong>{poundsFromString(balance.credits)}</strong></span>
          </div>

          {!balance.balanced && (
            <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-danger, var(--color-text))' }}>
              The two sides are {poundsFromString(absolute(balance.difference))} apart. Put that right and
              it can be posted - you can save it and come back to it in the meantime.
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            {/* An already-posted journal is saved as it is. Offering "save as a
                draft" there would quietly unpost it, which nobody means. */}
            {!(editor.id && editor.status === 'posted') && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save('draft')}>
                {busy ? 'Saving…' : 'Save for now'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !balance.balanced || balance.empty || !editor.narrative.trim()}
              onClick={() => save('posted')}
            >
              {busy ? 'Saving…' : editor.id && editor.status === 'posted' ? 'Save changes' : 'Post it'}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setEditor(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!list && !error && <LoadingRows />}

      {list && list.rows.length === 0 && (
        <EmptyState title="No journals yet.">
          <p style={{ margin: '0 0 0.75rem' }}>
            Most small companies post a handful a year and no more - depreciation, the odd accrual, and
            putting something right that went to the wrong place.
          </p>
          {canRecord && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => startNew()}>
              Write the first one
            </button>
          )}
        </EmptyState>
      )}

      {list && list.rows.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ padding: '0.625rem 0.75rem' }}>Date</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>What it is</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>Accounts</th>
                <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Total</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>State</th>
                {canRecord && <th style={{ padding: '0.625rem 0.75rem' }}>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {list.rows.map((row) => {
                const locked = !!row.locked_period_id
                const reversed = !!row.reversed_by_journal_id
                const isTransfer = row.kind === 'transfer'
                return (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ ...cell, whiteSpace: 'nowrap' }}>{formatDate(row.date)}</td>
                    <td style={cell}>
                      <div>
                        {row.narrative}
                        {locked && (
                          <span style={{ marginLeft: '0.5rem' }} role="img" aria-label="On a filed return, and locked">
                            🔒
                          </span>
                        )}
                      </div>
                      {row.reference && <div style={quiet}>{row.reference}</div>}
                      {isTransfer && <div style={quiet}>between your own accounts</div>}
                      {reversed && <div style={quiet}>reversed</div>}
                      {row.reverses_journal_id && <div style={quiet}>reversal of an earlier journal</div>}
                    </td>
                    <td style={cell}>{row.accounts || '—'}</td>
                    <td style={money}>{poundsFromString(row.total_debits)}</td>
                    <td style={cell}><StatusPill status={row.status} /></td>
                    {canRecord && (
                      <td style={{ ...cell, whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                          {/* Locked and reversed journals are refused by the
                              server, so the buttons that would only produce that
                              refusal are not offered. Nor is a transfer offered
                              the editor here, which would refuse it for a
                              different reason - it has a form of its own. */}
                          {isTransfer && !locked && (
                            <a className="btn btn-sm" href={`/${adminPath}/m/uk-bookkeeping/transfers/${row.id}`}>
                              Open the transfer
                            </a>
                          )}
                          {!isTransfer && !locked && !reversed && (
                            <button type="button" className="btn btn-sm" onClick={() => openExisting(row.id)}>
                              Edit
                            </button>
                          )}
                          {!isTransfer && row.status === 'draft' && !locked && (
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => post(row.id)}>
                              Post
                            </button>
                          )}
                          {!isTransfer && row.status === 'posted' && !reversed && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => {
                                setEditor(null)
                                setReversing({ id: row.id, narrative: row.narrative, date: today() })
                              }}
                            >
                              Reverse
                            </button>
                          )}
                          {!isTransfer && !locked && !reversed && (
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => remove(row)}>
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {list && list.total > list.rows.length && (
        <p style={{ ...quiet, marginTop: '0.75rem' }}>
          The {list.rows.length} most recent of {list.total}. Narrow the dates down to see the rest.
        </p>
      )}
    </div>
  )
}
