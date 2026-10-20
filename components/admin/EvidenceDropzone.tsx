'use client'

import { useState } from 'react'
import { useAdminConfirm } from '@/components/admin/useAdminConfirm'
import DocumentPicker from './DocumentPicker'
import DropArea from './DropArea'
import { type UnfiledDocument } from './documents-shared'
import { ErrorNotice } from './Notices'
import { preflightFileError } from '@/modules/uk-bookkeeping/lib/file-kinds'

// Receipts and invoices on a SAVED entry. Drag them on, or pick them.
//
// The type and size are checked here before anything is uploaded, so a rejection
// is instant and says what to do about it. The same rules run again at the
// route, plus a look at the actual bytes - a check only the browser does is not
// a check.
//
// Content only, no card of its own: the entry page and the edit form each put it
// in their own side column, under their own heading.

export type Attachment = {
  id: string
  name: string
  filename: string
  mime_type: string
  size: number
  locked_period_id: string | null
}

export function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A small picture for a photo, a plain tag for anything else. */
export function Thumb({ mime, id }: { mime: string; id?: string }) {
  if (id && mime.startsWith('image/')) {
    return (
      <span className="bkx-thumb">
        {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated admin route, not a public image the optimiser could fetch */}
        <img src={`/api/m/uk-bookkeeping/admin/attachments/${id}`} alt="" loading="lazy" />
      </span>
    )
  }
  return (
    <span className="bkx-thumb">
      {mime === 'application/pdf' ? 'PDF' : mime.startsWith('image/') ? 'IMG' : 'FILE'}
    </span>
  )
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
  const [askConfirm, confirmNode] = useAdminConfirm()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped after a receipt is filed from the inbox, so the picker drops the one
  // that has just gone. Filing here happens straight away - the entry already
  // exists, so there is nothing to hold anything back for.
  const [pickerKey, setPickerKey] = useState(0)

  async function upload(files: File[]) {
    setError(null)
    setBusy(true)

    try {
      for (const file of files) {
        const reason = preflightFileError(file)
        if (reason) {
          setError(reason)
          continue
        }
        const body = new FormData()
        body.append('file', file)
        body.append('name', file.name)

        try {
          const response = await fetch(
            `/api/m/uk-bookkeeping/admin/transactions/${transactionId}/attachments`,
            { method: 'POST', body },
          )
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            setError(payload.error ?? `“${file.name}” could not be uploaded.`)
          }
        } catch {
          setError(`“${file.name}” did not reach the server. Check the connection and try again.`)
        }
      }
    } finally {
      // Whatever happened, "Uploading…" must not be the permanent state of the
      // page, and the list should show what DID land.
      setBusy(false)
      onChange()
    }
  }

  async function remove(id: string) {
    if (!(await askConfirm({ title: 'Remove this receipt?', message: 'It is taken off the entry.', confirmLabel: 'Remove' }))) return
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/attachments/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That could not be removed.')
        return
      }
      onChange()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    }
  }

  async function attachFromInbox(document: UnfiledDocument) {
    setError(null)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/documents/${document.id}/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'That receipt could not be attached.')
        return
      }
      setPickerKey((key) => key + 1)
      onChange()
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    }
  }

  const editable = canRecord && !locked

  return (
    <div>
      {confirmNode}
      <ErrorNotice message={error} />

      {attachments.length === 0 && (
        <p className="bkx-muted" style={{ margin: '0 0 0.75rem' }}>
          No receipt on this one yet. HMRC expects you to keep them for six years, and the easiest
          time to attach one is now.
        </p>
      )}

      {attachments.length > 0 && (
        <ul className="bkx-files">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="bkx-file">
              <Thumb mime={attachment.mime_type} id={attachment.id} />
              <span className="bkx-file-body">
                {/* New tab, because the alternative is losing the entry you
                    were checking it against. PDFs and photographs open in the
                    browser; anything else the route still sends as a download,
                    whatever this link says. */}
                <a
                  href={`/api/m/uk-bookkeeping/admin/attachments/${attachment.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={attachment.name}
                >
                  {attachment.name}
                </a>
                <span className="bkx-tiny">
                  {readableSize(attachment.size)} ·{' '}
                  <a href={`/api/m/uk-bookkeeping/admin/attachments/${attachment.id}?download=1`}>Download</a>
                </span>
              </span>
              {attachment.locked_period_id ? (
                <span title="On a filed return">🔒</span>
              ) : (
                editable && (
                  <button type="button" className="btn btn-sm" onClick={() => remove(attachment.id)}>
                    Remove
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <>
          <DropArea onFiles={upload} busy={busy} />
          <DocumentPicker
            plain
            chosen={[]}
            reloadKey={pickerKey}
            onRelease={() => undefined}
            onChoose={attachFromInbox}
          />
        </>
      )}
    </div>
  )
}
