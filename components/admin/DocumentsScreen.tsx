'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import { formatDate, poundsFromString } from './format'
import {
  confidenceWording,
  readableSize,
  scanWording,
  RATE_LABELS,
  type UnfiledDocument,
} from './documents-shared'
import { preflightFileError } from '@/modules/uk-bookkeeping/lib/file-kinds'

// The receipts nobody has filed yet.
//
// The order the paperwork actually arrives in is: invoice by email on the day,
// bank statement three weeks later, entry typed at the weekend. This screen is
// the first of those three. Drop the PDF here when it lands, and by the time the
// statement is imported the reconciliation screen already knows which payment it
// belongs to.
//
// Everything on a card is a guess and every guess is editable. Correcting one is
// not a chore imposed by the software failing - it is how the software learns:
// the wording on this document gets tied to the supplier's real name, and the
// next invoice from them is right first time.

const inputStyle: React.CSSProperties = {
  padding: '0.375rem 0.625rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  width: '100%',
  fontSize: 'var(--text-sm)',
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs, 0.75rem)',
  marginBottom: '0.25rem',
  color: 'var(--color-text-muted, var(--color-text))',
}

const mutedStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text-muted, var(--color-text))',
}

type Draft = {
  counterparty: string
  documentDate: string
  documentNumber: string
  net: string
  vat: string
  total: string
  vatRateCode: string
  direction: string
}

function draftFrom(document: UnfiledDocument): Draft {
  return {
    counterparty: document.guessed_counterparty ?? '',
    documentDate: document.guessed_document_date?.slice(0, 10) ?? '',
    documentNumber: document.guessed_document_number ?? '',
    net: document.guessed_net ?? '',
    vat: document.guessed_vat ?? '',
    total: document.guessed_total ?? '',
    vatRateCode: document.guessed_vat_rate_code ?? '',
    direction: document.guessed_direction ?? 'expense',
  }
}

export default function DocumentsScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const fileInput = useRef<HTMLInputElement>(null)
  const [documents, setDocuments] = useState<UnfiledDocument[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const query = new URLSearchParams({ unfiled: '1' })
      if (search.trim()) query.set('search', search.trim())
      const response = await fetch(`/api/m/uk-bookkeeping/admin/documents?${query}`)
      if (!response.ok) {
        setError('The receipts could not be loaded.')
        return
      }
      const data = await response.json()
      const rows: UnfiledDocument[] = data.rows ?? []
      setDocuments(rows)
      setTotal(data.total ?? rows.length)
      // Drafts are rebuilt from the server's answer every load, so an edit
      // somebody abandoned does not sit around looking saved.
      setDrafts(Object.fromEntries(rows.map((row) => [row.id, draftFrom(row)])))
      setError(null)
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, search])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    const collected: string[] = []

    try {
      for (const file of Array.from(files)) {
        const reason = preflightFileError(file)
        if (reason) {
          setError(reason)
          continue
        }
        setUploading(file.name)
        const body = new FormData()
        body.append('file', file)
        body.append('name', file.name)

        try {
          const response = await fetch('/api/m/uk-bookkeeping/admin/documents', {
            method: 'POST',
            body,
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            setError(payload.error ?? `“${file.name}” could not be uploaded.`)
            continue
          }
          // The note is the honest half of the feature: a photo cannot be read,
          // and saying so beside the file that could not be read beats a silent
          // empty card that looks like a bug.
          if (payload.reading?.scanNote) collected.push(`${file.name}: ${payload.reading.scanNote}`)
        } catch {
          setError(`“${file.name}” did not reach the server. Check the connection and try again.`)
        }
      }
    } finally {
      setUploading(null)
      if (fileInput.current) fileInput.current.value = ''
      setNotes(collected)
      load()
    }
  }

  async function saveDraft(document: UnfiledDocument) {
    const draft = drafts[document.id]
    if (!draft) return
    setBusyId(document.id)
    setError(null)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/documents/${document.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          counterparty: draft.counterparty || null,
          direction: draft.direction || null,
          documentDate: draft.documentDate || null,
          documentNumber: draft.documentNumber || null,
          net: draft.net || null,
          vat: draft.vat || null,
          total: draft.total || null,
          vatRateCode: draft.vatRateCode || null,
        }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That could not be saved.')
        return
      }
      setOpen(null)
      load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function reread(document: UnfiledDocument) {
    setBusyId(document.id)
    setError(null)
    try {
      const force = document.reading_confirmed ? '?force=1' : ''
      const response = await fetch(
        `/api/m/uk-bookkeeping/admin/documents/${document.id}/rescan${force}`,
        { method: 'POST' },
      )
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'That could not be read again.')
        return
      }
      if (payload.reading?.scanNote) setNotes([`${document.name}: ${payload.reading.scanNote}`])
      load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(document: UnfiledDocument) {
    if (!window.confirm(`Throw away “${document.name}”? The file itself stays in your media library.`)) {
      return
    }
    setBusyId(document.id)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/documents/${document.id}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That could not be removed.')
        return
      }
      load()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusyId(null)
    }
  }

  function patchDraft(id: string, patch: Partial<Draft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }))
  }

  return (
    <div>
      <BookkeepingNav active="documents" />
      <SandboxBanner environment={environment} />

      <div className="page-header">
        <h1 className="page-title">Receipts</h1>
      </div>

      <ErrorNotice message={error} />

      {notes.length > 0 && (
        <div
          className="card"
          style={{ padding: '0.875rem 1rem', marginBottom: '1rem', ...mutedStyle }}
          role="status"
        >
          {notes.map((note) => (
            <p key={note} style={{ margin: '0 0 0.25rem' }}>
              {note}
            </p>
          ))}
        </div>
      )}

      {canRecord && (
        <div
          className="card"
          style={{ padding: '1.25rem', marginBottom: '1rem' }}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            upload(e.dataTransfer.files)
          }}
        >
          <div
            style={{
              border: `2px dashed ${dragging ? 'var(--color-primary, var(--color-border))' : 'var(--color-border)'}`,
              borderRadius: 10,
              padding: '1.5rem',
              textAlign: 'center',
              color: 'var(--color-text-muted, var(--color-text))',
            }}
          >
            <p style={{ margin: '0 0 0.5rem' }}>
              {uploading ? `Reading “${uploading}”…` : 'Drop invoices and receipts here, or'}
            </p>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              style={{ display: 'none' }}
              onChange={(e) => upload(e.target.files)}
            />
            <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={!!uploading}>
              choose files
            </button>
            <p style={{ margin: '0.75rem 0 0', fontSize: 'var(--text-xs, 0.75rem)' }}>
              PDFs and photos, up to 15 MB each. A PDF is read as it arrives - who it is from, the
              invoice number, the date and the VAT - so it can be offered against the right payment
              when your statement comes in. A photograph has no text to read, so you fill that bit in
              yourself, once.
            </p>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '1rem' }}>
        <input
          style={{ ...inputStyle, maxWidth: 320 }}
          placeholder="Search by supplier, number or filename"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span style={mutedStyle}>
          {loading ? 'Loading…' : `${total} waiting to be filed`}
        </span>
      </div>

      {!loading && documents.length === 0 && (
        <EmptyState title={search ? 'Nothing matches that' : 'Nothing waiting'}>
          <p style={{ margin: 0 }}>
            {search
              ? 'No unfiled receipt matches what you typed.'
              : 'Every receipt you have uploaded has been filed against an entry. Drop the next one here the day it arrives and it will be waiting when the statement turns up.'}
          </p>
        </EmptyState>
      )}

      {documents.map((document) => {
        const draft = drafts[document.id] ?? draftFrom(document)
        const hedge = confidenceWording(document)
        const note = scanWording(document)
        const editing = open === document.id
        const busy = busyId === document.id

        return (
          <div key={document.id} className="card" style={{ padding: '1rem 1.25rem', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'baseline' }}>
              <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {document.guessed_counterparty ? (
                    <>
                      {hedge && <span style={mutedStyle}>{hedge} </span>}
                      {document.guessed_counterparty}
                    </>
                  ) : (
                    <span style={mutedStyle}>Who it is from is not known yet</span>
                  )}
                </div>
                <div style={{ ...mutedStyle, marginTop: '0.125rem' }}>
                  {[
                    document.guessed_document_number && `no. ${document.guessed_document_number}`,
                    document.guessed_document_date && formatDate(document.guessed_document_date),
                    document.guessed_total && poundsFromString(document.guessed_total),
                    document.guessed_vat &&
                      (document.guessed_vat === '0.00'
                        ? 'no VAT'
                        : `${poundsFromString(document.guessed_vat)} VAT`),
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'Nothing read off it yet'}
                </div>
                <div style={{ ...mutedStyle, marginTop: '0.25rem', fontSize: 'var(--text-xs, 0.75rem)' }}>
                  <a
                    href={`/api/m/uk-bookkeeping/admin/attachments/${document.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {document.name}
                  </a>{' '}
                  · {readableSize(document.size)} · added {formatDate(document.created_at)}
                </div>
                {note && (
                  <div style={{ ...mutedStyle, marginTop: '0.375rem' }}>{note}</div>
                )}
              </div>

              {canRecord && (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <a
                    className="btn btn-sm btn-primary"
                    href={`/${adminPath}/m/uk-bookkeeping/transactions/new?document=${document.id}`}
                  >
                    Record an entry
                  </a>
                  <button
                    className="btn btn-sm"
                    onClick={() => setOpen(editing ? null : document.id)}
                    disabled={busy}
                  >
                    {editing ? 'Close' : 'Fix details'}
                  </button>
                  {document.mime_type === 'application/pdf' && (
                    <button className="btn btn-sm" onClick={() => reread(document)} disabled={busy}>
                      Read again
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => remove(document)} disabled={busy}>
                    Throw away
                  </button>
                </div>
              )}
            </div>

            {editing && canRecord && (
              <div
                style={{
                  marginTop: '1rem',
                  paddingTop: '1rem',
                  borderTop: '1px solid var(--color-border)',
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                  gap: '0.75rem',
                }}
              >
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={labelStyle} htmlFor={`bk-doc-who-${document.id}`}>
                    Who it is from
                  </label>
                  <input
                    id={`bk-doc-who-${document.id}`}
                    style={inputStyle}
                    value={draft.counterparty}
                    placeholder="Supplier or customer"
                    onChange={(e) => patchDraft(document.id, { counterparty: e.target.value })}
                  />
                  <p style={{ ...mutedStyle, margin: '0.25rem 0 0', fontSize: 'var(--text-xs, 0.75rem)' }}>
                    Putting this right once is worth doing: the wording on this document gets tied to
                    that name, and the next one from them is read correctly on its own.
                  </p>
                </div>
                <div>
                  <label style={labelStyle} htmlFor={`bk-doc-date-${document.id}`}>
                    Invoice date
                  </label>
                  <input
                    id={`bk-doc-date-${document.id}`}
                    type="date"
                    style={inputStyle}
                    value={draft.documentDate}
                    onChange={(e) => patchDraft(document.id, { documentDate: e.target.value })}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor={`bk-doc-number-${document.id}`}>
                    Their invoice number
                  </label>
                  <input
                    id={`bk-doc-number-${document.id}`}
                    style={inputStyle}
                    value={draft.documentNumber}
                    onChange={(e) => patchDraft(document.id, { documentNumber: e.target.value })}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor={`bk-doc-direction-${document.id}`}>
                    Money in or out
                  </label>
                  <select
                    id={`bk-doc-direction-${document.id}`}
                    style={inputStyle}
                    value={draft.direction}
                    onChange={(e) => patchDraft(document.id, { direction: e.target.value })}
                  >
                    <option value="expense">Money out (something we bought)</option>
                    <option value="income">Money in (something we sold)</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle} htmlFor={`bk-doc-net-${document.id}`}>
                    Net
                  </label>
                  <input
                    id={`bk-doc-net-${document.id}`}
                    style={inputStyle}
                    inputMode="decimal"
                    value={draft.net}
                    onChange={(e) => patchDraft(document.id, { net: e.target.value })}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor={`bk-doc-vat-${document.id}`}>
                    VAT
                  </label>
                  <input
                    id={`bk-doc-vat-${document.id}`}
                    style={inputStyle}
                    inputMode="decimal"
                    value={draft.vat}
                    onChange={(e) => patchDraft(document.id, { vat: e.target.value })}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor={`bk-doc-total-${document.id}`}>
                    Total
                  </label>
                  <input
                    id={`bk-doc-total-${document.id}`}
                    style={inputStyle}
                    inputMode="decimal"
                    value={draft.total}
                    onChange={(e) => patchDraft(document.id, { total: e.target.value })}
                  />
                </div>
                <div>
                  <label style={labelStyle} htmlFor={`bk-doc-rate-${document.id}`}>
                    VAT rate
                  </label>
                  <select
                    id={`bk-doc-rate-${document.id}`}
                    style={inputStyle}
                    value={draft.vatRateCode}
                    onChange={(e) => patchDraft(document.id, { vatRateCode: e.target.value })}
                  >
                    <option value="">Not sure</option>
                    {Object.entries(RATE_LABELS).map(([code, text]) => (
                      <option key={code} value={code}>
                        {text}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem' }}>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => saveDraft(document)}
                    disabled={busy}
                  >
                    {busy ? 'Saving…' : 'Save what it says'}
                  </button>
                  <button className="btn btn-sm" onClick={() => setOpen(null)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
