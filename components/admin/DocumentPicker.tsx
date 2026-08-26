'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { formatDate, poundsFromString } from './format'
import { confidenceWording, type UnfiledDocument } from './documents-shared'

// Picking a receipt that is already uploaded, while typing an entry.
//
// The other half of the Receipts tab. A receipt dropped in three weeks ago is
// sitting there with the supplier, the invoice number, the date and the VAT
// already read off it - so choosing it fills the form in rather than being one
// more thing to do after saving.
//
// Nothing is attached here. The document is only WIRED to the entry once the
// entry exists and has an id, which is why the form holds a list and posts the
// links afterwards: attaching to an entry that has not been saved is not a
// thing, and pretending otherwise is how you get a receipt filed against
// nothing.

const mutedStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--color-text-muted, var(--color-text))',
}

function summarise(document: UnfiledDocument): string {
  const hedge = confidenceWording(document)
  const who = document.guessed_counterparty
    ? `${hedge && hedge !== 'checked by hand' ? `${hedge} ` : ''}${document.guessed_counterparty}`
    : 'Who it is from is not known'
  const bits = [
    document.guessed_document_number && `no. ${document.guessed_document_number}`,
    document.guessed_document_date && formatDate(document.guessed_document_date),
    document.guessed_total && poundsFromString(document.guessed_total),
  ].filter(Boolean)
  return bits.length ? `${who} · ${bits.join(' · ')}` : who
}

export default function DocumentPicker({
  chosen,
  onChoose,
  onRelease,
  disabled = false,
  reloadKey = 0,
}: {
  /** Held but not yet attached. Empty where the caller attaches immediately. */
  chosen: UnfiledDocument[]
  onChoose: (document: UnfiledDocument) => void
  onRelease: (id: string) => void
  disabled?: boolean
  /** Bumped by a caller that attaches immediately, to take the used one off the list. */
  reloadKey?: number
}) {
  const adminPath = useAdminPath()
  const [available, setAvailable] = useState<UnfiledDocument[]>([])
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ unfiled: '1', limit: '50' })
      if (search.trim()) query.set('search', search.trim())
      const response = await fetch(`/api/m/uk-bookkeeping/admin/documents?${query}`)
      if (!response.ok) return
      const data = await response.json()
      setAvailable(data.rows ?? [])
    } catch {
      // A picker that will not load is a picker that is not shown. Nothing to say.
    } finally {
      setLoaded(true)
    }
  }, [search])

  useEffect(() => {
    const timer = setTimeout(load, search ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, search, reloadKey])

  const chosenIds = new Set(chosen.map((document) => document.id))
  const offered = available.filter((document) => !chosenIds.has(document.id))

  // Nothing uploaded and nothing chosen: the card would be an empty box telling
  // somebody about a feature they are not using. It stays out of the way until
  // there is something in the inbox.
  if (loaded && offered.length === 0 && chosen.length === 0 && !search) return null

  return (
    <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
      <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Receipts already uploaded</h3>

      {chosen.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 0.75rem', padding: 0 }}>
          {chosen.map((document) => (
            <li
              key={document.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <a
                  href={`/api/m/uk-bookkeeping/admin/attachments/${document.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {document.name}
                </a>
                <span style={{ ...mutedStyle, display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>
                  {summarise(document)}
                </span>
              </span>
              {!disabled && (
                <button type="button" className="btn btn-sm" onClick={() => onRelease(document.id)}>
                  Take off
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {chosen.length > 0 && (
        <p style={{ ...mutedStyle, margin: '0 0 0.75rem' }}>
          {chosen.length === 1 ? 'This receipt is' : 'These receipts are'} attached when you save.
        </p>
      )}

      {!disabled && !open && offered.length > 0 && (
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
          {chosen.length > 0 ? 'Pick another' : `Pick one (${offered.length} waiting)`}
        </button>
      )}

      {!disabled && open && (
        <>
          <input
            style={{
              padding: '0.375rem 0.625rem',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              width: '100%',
              maxWidth: 320,
              marginBottom: '0.75rem',
              fontSize: 'var(--text-sm)',
            }}
            placeholder="Search by supplier, number or filename"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {offered.length === 0 ? (
            <p style={{ ...mutedStyle, margin: 0 }}>Nothing unfiled matches that.</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {offered.map((document) => (
                <li
                  key={document.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.5rem 0',
                    borderTop: '1px solid var(--color-border)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <a
                      href={`/api/m/uk-bookkeeping/admin/attachments/${document.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {document.name}
                    </a>
                    <span style={{ ...mutedStyle, display: 'block', fontSize: 'var(--text-xs, 0.75rem)' }}>
                      {summarise(document)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      onChoose(document)
                      setOpen(false)
                    }}
                  >
                    Use this
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: '0.75rem' }}
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </>
      )}

      <p style={{ ...mutedStyle, margin: '0.75rem 0 0', fontSize: 'var(--text-xs, 0.75rem)' }}>
        Uploaded but not yet filed against anything. Drop new ones on the{' '}
        <a href={`/${adminPath}/m/uk-bookkeeping/documents`}>Receipts</a> tab the day they arrive.
      </p>
    </div>
  )
}
