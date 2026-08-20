'use client'

import { useRef, useState } from 'react'
import { ErrorNotice } from './Notices'
import { preflightFileError } from '@/modules/uk-bookkeeping/lib/file-kinds'

// Receipts and invoices. Drag them on, or pick them.
//
// The type and size are checked here before anything is uploaded, so a rejection
// is instant and says what to do about it. The same rules run again at the
// route, plus a look at the actual bytes - a check only the browser does is not
// a check.

type Attachment = {
  id: string
  name: string
  filename: string
  mime_type: string
  size: number
  locked_period_id: string | null
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function EvidenceDropzone({
  transactionId,
  attachments,
  locked,
  canRecord,
  onChange,
}: {
  transactionId: string
  attachments: Attachment[]
  locked: boolean
  canRecord: boolean
  onChange: () => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    setBusy(true)

    for (const file of Array.from(files)) {
      const reason = preflightFileError(file)
      if (reason) {
        setError(reason)
        continue
      }
      const body = new FormData()
      body.append('file', file)
      body.append('name', file.name)

      const response = await fetch(
        `/api/m/uk-bookkeeping/admin/transactions/${transactionId}/attachments`,
        { method: 'POST', body },
      )
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? `“${file.name}” could not be uploaded.`)
      }
    }

    setBusy(false)
    if (fileInput.current) fileInput.current.value = ''
    onChange()
  }

  async function remove(id: string) {
    const response = await fetch(`/api/m/uk-bookkeeping/admin/attachments/${id}`, { method: 'DELETE' })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      setError(payload.error ?? 'That could not be removed.')
      return
    }
    onChange()
  }

  return (
    <div className="card" style={{ padding: '1.25rem', maxWidth: 900 }}>
      <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>Evidence</h3>
      <ErrorNotice message={error} />

      {attachments.length === 0 && (
        <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          No receipt on this one yet. HMRC expects you to keep them for six years, and the easiest
          time to attach one is now rather than in three years’ time.
        </p>
      )}

      {attachments.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '0 0 0.75rem', padding: 0 }}>
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--color-border)',
              }}
            >
              <span style={{ flex: 1 }}>
                <a href={`/api/m/uk-bookkeeping/admin/attachments/${attachment.id}`}>{attachment.name}</a>
                <span style={{ marginLeft: '0.5rem', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
                  {readableSize(attachment.size)}
                </span>
              </span>
              {attachment.locked_period_id ? (
                <span title="On a filed return">🔒</span>
              ) : (
                canRecord &&
                !locked && (
                  <button className="btn btn-sm" onClick={() => remove(attachment.id)}>
                    Remove
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {canRecord && !locked && (
        <div
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
          style={{
            border: `2px dashed ${dragging ? 'var(--color-primary, var(--color-border))' : 'var(--color-border)'}`,
            borderRadius: 10,
            padding: '1.25rem',
            textAlign: 'center',
            color: 'var(--color-text-muted, var(--color-text))',
          }}
        >
          <p style={{ margin: '0 0 0.5rem' }}>
            {busy ? 'Uploading…' : 'Drop a receipt here, or'}
          </p>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            style={{ display: 'none' }}
            onChange={(e) => upload(e.target.files)}
          />
          <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            choose a file
          </button>
          <p style={{ margin: '0.75rem 0 0', fontSize: 'var(--text-xs, 0.75rem)' }}>
            PDFs and photos, up to 15 MB each. Files are stored as they are and never opened or run.
            There is no virus scanning here, so only attach files you already trust.
          </p>
        </div>
      )}
    </div>
  )
}
