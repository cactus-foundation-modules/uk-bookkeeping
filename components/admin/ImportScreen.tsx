'use client'

import { useEffect, useRef, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { formatDate, poundsFromString } from './format'

// Bringing a bank statement in.
//
// The screen is a review, not an upload. Three things can happen to a line and
// the reviewer decides which: it is something already recorded, and gets tied to
// it; it is new, and becomes a draft to code up later; or it is already here from
// a previous import and is left alone. Nothing becomes a record until somebody
// has looked at it, and nothing at all is written until the button at the bottom.

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

type LineAction = 'import' | 'match' | 'skip'

type PreparedLine = {
  index: number
  date: string
  details: string
  counterparty: string
  reference: string | null
  transactionType: string | null
  amount: string
  direction: 'income' | 'expense'
  gross: string
  balance: string | null
  duplicateOfId: string | null
  suggestions: MatchCandidate[]
  suggestedMatchId: string | null
  categoryId: string | null
  action: LineAction
}

type Preview = {
  format: 'csv' | 'pdf'
  filename: string
  meta: {
    bank: string | null
    accountLast4: string | null
    sortCode: string | null
    periodStart: string | null
    periodEnd: string | null
    openingBalance: string | null
    closingBalance: string | null
    totalPaidIn: string | null
    totalPaidOut: string | null
  }
  mapping: Record<string, unknown>
  bankAccountId: string | null
  matchedBankAccount: { id: string; name: string } | null
  lines: PreparedLine[]
  duplicates: number
  matches: number
  warnings: string[]
  checks: { label: string; statement: string; read: string; agrees: boolean }[]
}

type BankAccountOption = { id: string; name: string; kind: string; accountLast4: string | null }

type Decision = { action: LineAction; matchTransactionId?: string | null; categoryId?: string | null }

type Category = { id: string; name: string; direction: string }

const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', verticalAlign: 'top' }
const headStyle: React.CSSProperties = { padding: '0.625rem 0.75rem', textAlign: 'left' }
const controlStyle: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  fontSize: 'var(--text-sm)',
  maxWidth: '100%',
}

export default function ImportScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const fileInput = useRef<HTMLInputElement>(null)

  const [presets, setPresets] = useState<{ id: string; label: string }[]>([])
  const [accounts, setAccounts] = useState<BankAccountOption[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [preset, setPreset] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [decisions, setDecisions] = useState<Record<number, Decision>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ linesKept: number; entriesCreated: number; matched: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/import')
      .then((response) => (response.ok ? response.json() : { presets: [], accounts: [] }))
      .then((data) => {
        setPresets(data.presets ?? [])
        setAccounts(data.accounts ?? [])
        // One account and nothing chosen is not a decision worth asking about.
        if ((data.accounts ?? []).length === 1) setBankAccountId(data.accounts[0].id)
      })
      .catch(() => undefined)

    fetch('/api/m/uk-bookkeeping/admin/categories')
      .then((response) => (response.ok ? response.json() : { categories: [] }))
      .then((data) => setCategories(data.categories ?? []))
      .catch(() => undefined)
  }, [])

  async function readFile(file: File) {
    setBusy(true)
    setError(null)
    setDone(null)

    const body = new FormData()
    body.append('file', file)
    if (preset) body.append('preset', preset)
    if (bankAccountId) body.append('bankAccountId', bankAccountId)

    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/import', { method: 'POST', body })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(payload.error ?? 'That file could not be read.')
        setPreview(null)
        return
      }

      setPreview(payload)
      setDecisions(
        Object.fromEntries(
          (payload.lines as PreparedLine[]).map((line) => [
            line.index,
            {
              action: line.action,
              matchTransactionId: line.suggestedMatchId,
              categoryId: line.categoryId,
            },
          ]),
        ),
      )
      if (!bankAccountId && payload.bankAccountId) setBankAccountId(payload.bankAccountId)
    } catch {
      setError('The file did not reach the server. Check the connection and try again.')
      setPreview(null)
    } finally {
      setBusy(false)
      // Clear the input so choosing the SAME file again - a re-export under the
      // same name after fixing something - fires a change event instead of the
      // button appearing dead.
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  async function commit() {
    if (!preview) return
    if (!bankAccountId) {
      setError('Choose which account this statement is for first.')
      return
    }
    setBusy(true)
    setError(null)

    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/import', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: preview.filename,
          format: preview.format,
          bankAccountId,
          preset: preset || null,
          meta: preview.meta,
          mapping: preview.mapping,
          lines: preview.lines,
          decisions,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'Those could not be brought in.')
        return
      }
      setDone(payload)
      setPreview(null)
    } catch {
      setError('The import did not reach the server. Check the connection and try again - nothing has been brought in.')
    } finally {
      setBusy(false)
    }
  }

  const setDecision = (index: number, patch: Partial<Decision>): void => {
    setDecisions((current) => ({ ...current, [index]: { ...current[index]!, ...patch } }))
  }

  const counts = preview
    ? {
        import: preview.lines.filter((line) => decisions[line.index]?.action === 'import').length,
        match: preview.lines.filter((line) => decisions[line.index]?.action === 'match').length,
        skip: preview.lines.filter((line) => decisions[line.index]?.action === 'skip').length,
      }
    : { import: 0, match: 0, skip: 0 }

  return (
    <div>
      <BookkeepingNav active="import" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {done && (
        <div className="card" role="status" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <strong>
            {done.linesKept} statement line{done.linesKept === 1 ? '' : 's'} brought in.
          </strong>{' '}
          {done.matched > 0 && (
            <>
              {done.matched} of {done.matched === 1 ? 'them was' : 'them were'} already in your books and
              {done.matched === 1 ? ' has' : ' have'} been ticked off against{' '}
              {done.matched === 1 ? 'its entry' : 'their entries'}.{' '}
            </>
          )}
          {done.entriesCreated > 0 && (
            <>
              {done.entriesCreated} new entr{done.entriesCreated === 1 ? 'y is' : 'ies are'} waiting for
              review - none of them counts towards a VAT return until you have said what each one was for.{' '}
              <a href={`/${adminPath}/m/uk-bookkeeping/transactions?status=draft`}>Go and review them</a>.{' '}
            </>
          )}
          <a href={`/${adminPath}/m/uk-bookkeeping/reconcile`}>See the reconciliation</a>.
        </div>
      )}

      <div
        className="card"
        style={{
          padding: '1.25rem',
          marginBottom: '1rem',
          maxWidth: 760,
          border: dragging ? '2px dashed var(--color-primary, var(--color-border))' : undefined,
        }}
        onDragOver={(event) => {
          if (!canRecord) return
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (!canRecord) return
          event.preventDefault()
          setDragging(false)
          const file = event.dataTransfer.files?.[0]
          if (file) readFile(file)
        }}
      >
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Import a bank statement</h3>
        <p style={{ margin: '0 0 1rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          Drop a statement on this card, or choose one below. A PDF downloaded from your online banking
          works as well as a CSV - what will not work is a photograph or a scan of a paper one, because
          there is no text in those to read. Nothing is written until you have been through what we found.
        </p>

        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>Which account</span>
            <select
              value={bankAccountId}
              onChange={(event) => setBankAccountId(event.target.value)}
              style={controlStyle}
            >
              <option value="">Choose an account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                  {account.accountLast4 ? ` (…${account.accountLast4})` : ''}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 'var(--text-sm)' }}>
            <span style={{ display: 'block', marginBottom: '0.25rem' }}>Which bank the file came from</span>
            <select value={preset} onChange={(event) => setPreset(event.target.value)} style={controlStyle}>
              <option value="">Work it out from the file</option>
              {presets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>

          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,.pdf,application/pdf"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) readFile(file)
            }}
          />
          {canRecord && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              style={{ alignSelf: 'flex-end' }}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? 'Reading…' : 'Choose a file'}
            </button>
          )}
        </div>

        {accounts.length === 0 && (
          <p style={{ margin: '0.875rem 0 0', fontSize: 'var(--text-sm)' }}>
            There are no accounts set up yet. Add the account this statement belongs to under{' '}
            <a href={`/${adminPath}/settings?tab=uk-bookkeeping`}>the bookkeeping settings</a> first, so
            the statement has somewhere to live.
          </p>
        )}
      </div>

      {preview && <StatementSummary preview={preview} />}

      {preview && preview.lines.length === 0 && (
        <EmptyState title="Nothing in that statement we could use.">
          <p style={{ margin: 0 }}>
            Check it is the statement itself rather than a summary or a certificate of balance.
          </p>
        </EmptyState>
      )}

      {preview && preview.lines.length > 0 && (
        <>
          <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem', fontSize: 'var(--text-sm)' }}>
            {preview.lines.length} line{preview.lines.length === 1 ? '' : 's'} read.{' '}
            {preview.duplicates > 0 && (
              <>
                {preview.duplicates}{' '}
                {preview.duplicates === 1 ? 'is already here from a previous import, so it is' : 'are already here from a previous import, so they are'}{' '}
                set to be left alone.{' '}
              </>
            )}
            {preview.matches > 0 && (
              <>
                {preview.matches} look{preview.matches === 1 ? 's' : ''} like something you have already
                recorded, so {preview.matches === 1 ? 'it is' : 'they are'} set to be ticked off against{' '}
                {preview.matches === 1 ? 'that entry' : 'those entries'} rather than entered twice.
              </>
            )}
          </div>

          <div className="card" style={{ padding: 0, marginBottom: '1rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <th style={headStyle}>Date</th>
                  <th style={headStyle}>Who with</th>
                  <th style={{ ...headStyle, textAlign: 'right' }}>Amount</th>
                  <th style={headStyle}>What to do with it</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <LineRow
                    key={line.index}
                    line={line}
                    decision={decisions[line.index]!}
                    categories={categories}
                    onChange={(patch) => setDecision(line.index, patch)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !bankAccountId || counts.import + counts.match === 0}
              onClick={commit}
            >
              Bring in {counts.import + counts.match} line{counts.import + counts.match === 1 ? '' : 's'}
            </button>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
              {counts.import} new for review, {counts.match} ticked off against entries you already have,{' '}
              {counts.skip} left alone.
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * What the statement said about itself, and whether what we read out of it adds
 * up to the same thing. The checks are free - the statement did the arithmetic
 * already - and they catch a whole class of misreadings before anything is
 * written rather than at the year end.
 */
function StatementSummary({ preview }: { preview: Preview }) {
  const { meta, checks, warnings } = preview
  const hasMeta = meta.accountLast4 || meta.periodStart || meta.closingBalance

  if (!hasMeta && checks.length === 0 && warnings.length === 0) return null

  return (
    <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem', fontSize: 'var(--text-sm)' }}>
      {hasMeta && (
        <p style={{ margin: '0 0 0.5rem' }}>
          <strong>{preview.filename}</strong>
          {meta.bank ? ` from ${meta.bank}` : ''}
          {meta.accountLast4 ? `, account ending ${meta.accountLast4}` : ''}
          {meta.periodStart && meta.periodEnd
            ? `, covering ${formatDate(meta.periodStart)} to ${formatDate(meta.periodEnd)}`
            : ''}
          .
        </p>
      )}

      {checks.length > 0 && (
        <ul style={{ margin: '0 0 0.5rem', paddingLeft: '1.25rem' }}>
          {checks.map((check) => (
            <li key={check.label} style={{ color: check.agrees ? undefined : 'var(--color-danger, var(--color-text))' }}>
              {check.label}: the statement says {poundsFromString(check.statement)}, and what we read comes
              to {poundsFromString(check.read)}
              {check.agrees ? ' - they agree.' : ' - they do not agree, so check before bringing this in.'}
            </li>
          ))}
        </ul>
      )}

      {warnings.map((warning) => (
        <p key={warning} style={{ margin: '0.25rem 0 0', color: 'var(--color-danger, var(--color-text))' }}>
          {warning}
        </p>
      ))}
    </div>
  )
}

function LineRow({
  line,
  decision,
  categories,
  onChange,
}: {
  line: PreparedLine
  decision: Decision
  categories: Category[]
  onChange: (patch: Partial<Decision>) => void
}) {
  const muted = decision.action === 'skip'
  const usable = categories.filter(
    (category) => category.direction === 'both' || category.direction === line.direction,
  )

  return (
    <tr style={{ borderBottom: '1px solid var(--color-border)', opacity: muted ? 0.55 : 1 }}>
      <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{formatDate(line.date)}</td>
      <td style={cellStyle}>
        <div>{line.counterparty || '—'}</div>
        {line.details !== line.counterparty && (
          <div style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
            {line.details}
          </div>
        )}
      </td>
      <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {poundsFromString(line.amount)}
      </td>
      <td style={cellStyle}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <select
            aria-label={`What to do with the ${formatDate(line.date)} line for ${line.counterparty || 'an unnamed counterparty'}`}
            value={decision.action}
            onChange={(event) => onChange({ action: event.target.value as LineAction })}
            style={controlStyle}
          >
            <option value="import">Record it as a new entry</option>
            <option value="match" disabled={line.suggestions.length === 0}>
              Tick it off against an entry I already have
            </option>
            <option value="skip">Leave it alone</option>
          </select>

          {decision.action === 'import' && (
            <select
              aria-label={`Category for the ${formatDate(line.date)} line`}
              value={decision.categoryId ?? ''}
              onChange={(event) => onChange({ categoryId: event.target.value || null })}
              style={controlStyle}
            >
              <option value="">Choose a category</option>
              {usable.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          )}

          {decision.action === 'match' && (
            <select
              aria-label={`Which entry the ${formatDate(line.date)} line is`}
              value={decision.matchTransactionId ?? ''}
              onChange={(event) => onChange({ matchTransactionId: event.target.value || null })}
              style={controlStyle}
            >
              <option value="">Choose an entry</option>
              {line.suggestions.map((candidate) => (
                <option key={candidate.transactionId} value={candidate.transactionId}>
                  {formatDate(candidate.date)} · {candidate.counterparty} · {poundsFromString(candidate.gross)}
                </option>
              ))}
            </select>
          )}
        </div>

        {line.duplicateOfId && (
          <div style={{ marginTop: '0.25rem', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Already brought in from an earlier statement.
          </div>
        )}
        {decision.action === 'match' && decision.matchTransactionId && (
          <MatchReason
            candidate={line.suggestions.find((item) => item.transactionId === decision.matchTransactionId)}
          />
        )}
      </td>
    </tr>
  )
}

/** Why we think these are the same payment, so the reviewer can disagree. */
function MatchReason({ candidate }: { candidate: MatchCandidate | undefined }) {
  if (!candidate) return null
  return (
    <div style={{ marginTop: '0.25rem', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
      Because {candidate.reasons.join(', ')}.
    </div>
  )
}
