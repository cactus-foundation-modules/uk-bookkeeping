'use client'

import { useEffect, useRef, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { poundsFromString } from './format'

// Bringing a bank statement in.
//
// Everything lands as a draft and nothing else. A draft reaches no VAT box, and
// it becomes a record only when somebody has looked at it and said so. A
// statement line says money moved; it does not say what for, and guessing that
// is what makes a set of books wrong.

type Row = {
  index: number
  date: string
  counterparty: string
  reference: string | null
  direction: string
  gross: string
  duplicateOfId: string | null
  categoryId: string | null
  error: string | null
}

type Preview = {
  headers: string[]
  mapping: Record<string, string>
  rows: Row[]
  duplicates: number
  errors: number
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
  const [preset, setPreset] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [filename, setFilename] = useState('')
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ created: number } | null>(null)

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/import')
      .then((r) => (r.ok ? r.json() : { presets: [] }))
      .then((data) => setPresets(data.presets ?? []))
      .catch(() => setPresets([]))
  }, [])

  async function readFile(file: File) {
    setBusy(true)
    setError(null)
    setDone(null)
    setFilename(file.name)

    const body = new FormData()
    body.append('file', file)
    if (preset) body.append('preset', preset)

    const response = await fetch('/api/m/uk-bookkeeping/admin/import', { method: 'POST', body })
    const payload = await response.json().catch(() => ({}))
    setBusy(false)

    if (!response.ok) {
      setError(payload.error ?? 'That file could not be read.')
      setPreview(null)
      return
    }
    setPreview(payload)
    // Everything that can be imported starts ticked, except the ones that look
    // like a second copy of something already recorded.
    setChosen(
      new Set(
        payload.rows
          .filter((row: Row) => !row.error && !row.duplicateOfId)
          .map((row: Row) => row.index),
      ),
    )
  }

  async function commit() {
    if (!preview) return
    setBusy(true)
    setError(null)
    const response = await fetch('/api/m/uk-bookkeeping/admin/import', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename,
        preset: preset || null,
        mapping: preview.mapping,
        rows: preview.rows,
        include: [...chosen],
      }),
    })
    const payload = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error ?? 'Those could not be imported.')
      return
    }
    setDone({ created: payload.created })
    setPreview(null)
  }

  return (
    <div>
      <BookkeepingNav active="import" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {done && (
        <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <strong>{done.created} entr{done.created === 1 ? 'y' : 'ies'} brought in.</strong> They are
          waiting for review - none of them counts towards a VAT return until you have been through
          them and said what each one was for.{' '}
          <a href={`/${adminPath}/m/uk-bookkeeping/transactions?status=draft`}>Go and review them</a>.
        </div>
      )}

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem', maxWidth: 720 }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Import a bank statement</h3>
        <p style={{ margin: '0 0 1rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          Download a CSV from your bank and drop it in. Nothing becomes a record until you have
          reviewed it, so there is no harm in trying it and seeing what happens.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            style={{
              padding: '0.375rem 0.625rem',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
            }}
          >
            <option value="">Work it out from the file</option>
            {presets.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) readFile(file)
            }}
          />
          {canRecord && (
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => fileInput.current?.click()}>
              {busy ? 'Reading…' : 'Choose a file'}
            </button>
          )}
        </div>
      </div>

      {preview && preview.rows.length === 0 && (
        <EmptyState title="Nothing in that file we could use.">
          <p style={{ margin: 0 }}>Check you exported the transactions rather than a summary.</p>
        </EmptyState>
      )}

      {preview && preview.rows.length > 0 && (
        <>
          <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
            {preview.rows.length} rows read.{' '}
            {preview.duplicates > 0 && (
              <>
                {preview.duplicates} look like {preview.duplicates === 1 ? 'a copy' : 'copies'} of
                something already recorded, so {preview.duplicates === 1 ? 'it is' : 'they are'} left
                unticked.{' '}
              </>
            )}
            {preview.errors > 0 && <>{preview.errors} could not be read at all.</>}
          </div>

          <div className="card" style={{ padding: 0, marginBottom: '1rem', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                  <th style={{ padding: '0.625rem 0.75rem' }}>Bring in</th>
                  <th style={{ padding: '0.625rem 0.75rem' }}>Date</th>
                  <th style={{ padding: '0.625rem 0.75rem' }}>Who with</th>
                  <th style={{ padding: '0.625rem 0.75rem', textAlign: 'right' }}>Amount</th>
                  <th style={{ padding: '0.625rem 0.75rem' }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.index} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '0.5rem 0.75rem' }}>
                      <input
                        type="checkbox"
                        disabled={!!row.error}
                        checked={chosen.has(row.index)}
                        onChange={(e) => {
                          const next = new Set(chosen)
                          if (e.target.checked) next.add(row.index)
                          else next.delete(row.index)
                          setChosen(next)
                        }}
                      />
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>{row.date}</td>
                    <td style={{ padding: '0.5rem 0.75rem' }}>{row.counterparty || '—'}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right' }}>
                      {row.direction === 'expense' ? '-' : ''}
                      {poundsFromString(row.gross)}
                    </td>
                    <td style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-muted, var(--color-text))' }}>
                      {row.error ?? (row.duplicateOfId ? 'Looks like one you already have' : '')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="btn btn-primary" disabled={busy || chosen.size === 0} onClick={commit}>
            Bring in {chosen.size} for review
          </button>
        </>
      )}
    </div>
  )
}
