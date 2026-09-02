'use client'

import { useEffect, useRef, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { EmptyState, ErrorNotice } from './Notices'
import { formatDate, poundsFromString } from './format'

// Bringing a bank statement in.
//
// A panel on the Bank statements screen rather than a page of its own: the
// question "what have I already imported" and the act of importing the next one
// belong together, and putting importing behind its own tab meant the list of
// what you hold was somewhere else entirely.
//
// The screen shows what was read and asks one question: does this look like the
// statement. It does not ask what any of it was for. Saying that about two
// hundred lines, in one sitting, before a single one of them is saved, is the
// job nobody finishes - and an import abandoned halfway has kept nothing at all.
//
// So this keeps the bank's lines and hands over to the reconciliation screen,
// where they can be explained a few at a time, in any order, and in bulk when
// they are alike.

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
  covers: { from: string | null; to: string | null }
  existingStatement: {
    id: string
    filename: string
    importedAt: string
    updatedAt: string
    updateCount: number
    lineCount: number
    hasFile: boolean
  } | null
  lines: PreparedLine[]
  duplicates: number
  warnings: string[]
  checks: { label: string; statement: string; read: string; agrees: boolean }[]
}

type BankAccountOption = { id: string; name: string; kind: string; accountLast4: string | null }

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
  canRecord,
  onImported,
}: {
  canRecord: boolean
  /** Told when something has actually landed, so the list behind can catch up. */
  onImported?: () => void
}) {
  const adminPath = useAdminPath()
  const fileInput = useRef<HTMLInputElement>(null)

  const [presets, setPresets] = useState<{ id: string; label: string }[]>([])
  const [accounts, setAccounts] = useState<BankAccountOption[]>([])
  const [preset, setPreset] = useState('')
  const [bankAccountId, setBankAccountId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  // The file itself is held on to, because the commit sends it back: the
  // statement is kept now, not just read, and the bytes only exist here.
  const [chosen, setChosen] = useState<File | null>(null)
  // Whether a statement already held for this period gets brought up to date or
  // is left alone with this one filed beside it. Updating is the answer nearly
  // everybody wants, so it is the one already chosen.
  const [replaceExisting, setReplaceExisting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{
    linesKept: number
    duplicates: number
    updated: boolean
    removed: number
    keptBecauseUsed: number
    fileNote: string | null
  } | null>(null)
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
  }, [])

  async function readFile(file: File) {
    setBusy(true)
    setError(null)
    setDone(null)
    setChosen(file)
    setReplaceExisting(true)

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
        setChosen(null)
        return
      }

      setPreview(payload)
      if (!bankAccountId && payload.bankAccountId) setBankAccountId(payload.bankAccountId)
    } catch {
      setError('The file did not reach the server. Check the connection and try again.')
      setPreview(null)
      setChosen(null)
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

    // Multipart, so the file travels with the lines and a copy of the statement
    // is kept beside them. Without the file this still imports - it just leaves
    // nothing to show anybody who asks where a line came from.
    const body = new FormData()
    body.append(
      'payload',
      JSON.stringify({
        filename: preview.filename,
        format: preview.format,
        bankAccountId,
        preset: preset || null,
        meta: preview.meta,
        mapping: preview.mapping,
        lines: preview.lines,
        replaceStatementId:
          replaceExisting && preview.existingStatement ? preview.existingStatement.id : null,
      }),
    )
    if (chosen) body.append('file', chosen)

    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/import', { method: 'PUT', body })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'Those could not be brought in.')
        return
      }
      setDone(payload)
      setPreview(null)
      setChosen(null)
      onImported?.()
    } catch {
      setError('The import did not reach the server. Check the connection and try again - nothing has been brought in.')
    } finally {
      setBusy(false)
    }
  }

  const fresh = preview ? preview.lines.length - preview.duplicates : 0
  const updating = !!preview?.existingStatement && replaceExisting

  return (
    <div>
      <ErrorNotice message={error} />

      {done && (
        <div className="card" role="status" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <strong>
            {done.updated
              ? `That statement has been brought up to date: ${done.linesKept} new line${done.linesKept === 1 ? '' : 's'}.`
              : `${done.linesKept} statement line${done.linesKept === 1 ? '' : 's'} brought in.`}
          </strong>{' '}
          {done.removed > 0 && (
            <>
              {done.removed} line{done.removed === 1 ? '' : 's'} that the old version had and this one
              does not {done.removed === 1 ? 'has' : 'have'} gone.{' '}
            </>
          )}
          {done.keptBecauseUsed > 0 && (
            <>
              {done.keptBecauseUsed}{' '}
              {done.keptBecauseUsed === 1 ? 'line is' : 'lines are'} not in the new file but{' '}
              {done.keptBecauseUsed === 1 ? 'has' : 'have'} already been explained, so{' '}
              {done.keptBecauseUsed === 1 ? 'it has' : 'they have'} been left alone.{' '}
            </>
          )}
          {done.fileNote && <>{done.fileNote} </>}
          {done.duplicates > 0 && (
            <>
              {done.duplicates}{' '}
              {done.duplicates === 1 ? 'was already here from an earlier import and was left alone' : 'were already here from an earlier import and were left alone'}
              .{' '}
            </>
          )}
          {done.linesKept > 0 && (
            <>
              Nothing has been recorded in the books yet - a statement says money moved, not what it was
              for.{' '}
              <a href={`/${adminPath}/m/uk-bookkeeping/reconcile`}>Go and say what each one was</a>, a few
              at a time or all the alike ones together.
            </>
          )}
          {done.linesKept === 0 && (
            <a href={`/${adminPath}/m/uk-bookkeeping/reconcile`}>See the reconciliation</a>
          )}
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
          there is no text in those to read. You will not be asked what any of it was for here; that
          happens afterwards, on the reconciliation screen, where you can do the alike ones in one go.
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

      {preview?.existingStatement && (
        <div
          className="card"
          style={{ padding: '0.875rem 1rem', marginBottom: '1rem', fontSize: 'var(--text-sm)' }}
        >
          <p style={{ margin: '0 0 0.5rem' }}>
            <strong>This period is already here.</strong> “{preview.existingStatement.filename}” was
            brought in on {formatDate(preview.existingStatement.importedAt.slice(0, 10))} with{' '}
            {preview.existingStatement.lineCount} line
            {preview.existingStatement.lineCount === 1 ? '' : 's'}
            {preview.existingStatement.updateCount > 0
              ? `, and has been brought up to date ${preview.existingStatement.updateCount} time${preview.existingStatement.updateCount === 1 ? '' : 's'} since`
              : ''}
            .
          </p>
          <label style={{ display: 'block', marginBottom: '0.25rem' }}>
            <input
              type="checkbox"
              checked={replaceExisting}
              onChange={(event) => setReplaceExisting(event.target.checked)}
              style={{ marginRight: '0.5rem' }}
            />
            Bring that statement up to date with this file
          </label>
          <p style={{ margin: 0, color: 'var(--color-text-muted, var(--color-text))' }}>
            {replaceExisting
              ? 'Anything new in this file is added, and anything the old version had that this one does not is dropped - unless you have already said what it was, in which case it stays put. This file becomes the copy we keep.'
              : 'This will be filed as a second statement for the same period. Only do that if it really is a different statement.'}
          </p>
        </div>
      )}

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
            {preview.duplicates > 0 ? (
              <>
                {preview.duplicates} of {preview.duplicates === 1 ? 'them is' : 'them are'} already here
                from an earlier import, so {preview.duplicates === 1 ? 'it will be' : 'they will be'} left
                alone. {fresh} would be new.
              </>
            ) : (
              <>None of them is one we already hold.</>
            )}
          </div>

          <div className="card" style={{ padding: 0, marginBottom: '1rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <th style={headStyle}>Date</th>
                  <th style={headStyle}>What the bank says</th>
                  <th style={{ ...headStyle, textAlign: 'right' }}>Amount</th>
                  <th style={{ ...headStyle, textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <tr
                    key={line.index}
                    style={{
                      borderBottom: '1px solid var(--color-border)',
                      opacity: line.duplicateOfId ? 0.55 : 1,
                    }}
                  >
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{formatDate(line.date)}</td>
                    <td style={cellStyle}>
                      <div>{line.counterparty || '—'}</div>
                      {line.details !== line.counterparty && (
                        <div style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
                          {line.details}
                        </div>
                      )}
                      {line.duplicateOfId && (
                        <div style={{ color: 'var(--color-text-muted, var(--color-text))', fontSize: 'var(--text-xs, 0.75rem)' }}>
                          Already brought in from an earlier statement.
                        </div>
                      )}
                    </td>
                    <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {poundsFromString(line.amount)}
                    </td>
                    <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--color-text-muted, var(--color-text))' }}>
                      {line.balance ? poundsFromString(line.balance) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canRecord && (
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !bankAccountId || (fresh === 0 && !updating)}
                onClick={commit}
              >
                {busy
                  ? 'Bringing in…'
                  : updating
                    ? `Update this statement${fresh > 0 ? ` (${fresh} new line${fresh === 1 ? '' : 's'})` : ''}`
                    : `Bring in ${fresh} line${fresh === 1 ? '' : 's'}`}
              </button>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
                {fresh === 0 && !updating
                  ? 'Every line in this file is already here.'
                  : fresh === 0
                    ? 'Every line is already here, so this replaces the copy of the statement we keep and tidies up anything the old version had that this one does not.'
                    : 'They go in as the bank wrote them. Nothing reaches your books, or a VAT return, until you say what each one was.'}
              </span>
            </div>
          )}
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
