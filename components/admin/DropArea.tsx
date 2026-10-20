'use client'

import { useRef, useState } from 'react'

// The drag-or-choose box for receipts. Only the box: what happens to the files is
// the caller's business - the entry form HOLDS them until the entry has an id,
// the saved entry uploads them straight away.

export default function DropArea({
  onFiles,
  busy = false,
  disabled = false,
  compact = false,
}: {
  onFiles: (files: File[]) => void
  busy?: boolean
  disabled?: boolean
  compact?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function hand(list: FileList | null) {
    if (!list || list.length === 0) return
    onFiles(Array.from(list))
    if (input.current) input.current.value = ''
  }

  return (
    <div
      className="bkx-drop"
      data-dragging={dragging}
      onDragOver={(e) => {
        if (disabled) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (!disabled) hand(e.dataTransfer.files)
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept=".pdf,.jpg,.jpeg,.png,.webp"
        style={{ display: 'none' }}
        onChange={(e) => hand(e.target.files)}
        aria-label="Choose receipt files"
      />
      <div style={{ marginBottom: compact ? 0 : '0.5rem' }}>
        {busy ? 'Uploading…' : 'Drop receipts here, or '}
        {!busy && (
          <button
            type="button"
            className="bkx-linkbtn"
            style={{ fontSize: 'inherit' }}
            onClick={() => input.current?.click()}
            disabled={disabled}
          >
            browse
          </button>
        )}
      </div>
      {!compact && (
        <div className="bkx-tiny">
          PDFs and photos, up to 15 MB each. Stored as they are and never opened or run - there is
          no virus scanning, so only add files you trust.
        </div>
      )}
    </div>
  )
}
