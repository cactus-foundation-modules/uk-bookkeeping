'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'

// A drop-in for a native <select> that can be searched.
//
// Categories run to dozens and nobody scrolls a list of forty to find "Bank
// charges". Click it, type a few letters, press Enter. It keeps a select's
// contract - a value string in, a value string out, an optional empty choice -
// so replacing one is a swap of the element, not a rethink of the screen.
//
// The list is position: fixed rather than absolute, because these sit inside
// tables and cards with overflow: auto, which would clip an absolute one at the
// card's edge.

export type SearchableOption = { value: string; label: string }

type Props = {
  id?: string
  value: string
  onChange: (value: string) => void
  options: SearchableOption[]
  /** A first choice that means "none" and sends ''. Leave out for a required field. */
  emptyLabel?: string
  disabled?: boolean
  style?: React.CSSProperties
  'aria-label'?: string
}

const LIST_MAX = 288
const GAP = 4

export default function SearchableSelect({
  id,
  value,
  onChange,
  options,
  emptyLabel,
  disabled,
  style,
  'aria-label': ariaLabel,
}: Props) {
  const reactId = useId()
  const listId = `${reactId}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [box, setBox] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const search = useRef<HTMLInputElement | null>(null)

  const all = useMemo<SearchableOption[]>(
    () => (emptyLabel !== undefined ? [{ value: '', label: emptyLabel }, ...options] : options),
    [options, emptyLabel],
  )
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return all
    return all.filter((option) => {
      const text = option.label.toLowerCase()
      return words.every((word) => text.includes(word))
    })
  }, [all, query])

  const current = all.find((option) => option.value === value)

  function openList() {
    if (disabled || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - GAP - 8
    const above = rect.top - GAP - 8
    // Open upwards only when there is clearly more room there.
    const up = below < 200 && above > below
    const room = Math.max(120, Math.min(LIST_MAX, up ? above : below))
    setBox({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 220) - 8)),
      width: Math.max(rect.width, 220),
      ...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
      maxHeight: room,
    })
    setQuery('')
    setActive(Math.max(0, all.findIndex((option) => option.value === value)))
    setOpen(true)
  }

  function close(refocus: boolean) {
    setOpen(false)
    if (refocus) trigger.current?.focus()
  }

  function choose(option: SearchableOption | undefined) {
    if (!option) return
    onChange(option.value)
    close(true)
  }

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (popover.current?.contains(target) || trigger.current?.contains(target)) return
      setOpen(false)
    }
    // The list is fixed, so it would float away from its box if the page moved
    // underneath it. Scrolling inside the list itself is fine.
    const moved = (event: Event) => {
      if (event.target instanceof Node && popover.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', moved)
    return () => {
      document.removeEventListener('mousedown', outside)
      window.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', moved)
    }
  }, [open])

  // Keep the highlighted row on screen as the arrow keys move it.
  useEffect(() => {
    if (!open) return
    popover.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  function onKey(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(shown.length - 1, i + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(shown[active])
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            openList()
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
          textAlign: 'left',
          font: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          // A native select's own look: the caller's field style, then ours for
          // anything it left out.
          padding: '0.375rem 0.5rem',
          border: '1px solid var(--color-border)',
          borderRadius: 6,
          background: 'var(--color-bg)',
          color: 'var(--color-text)',
          ...style,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current?.label ?? ''}
        </span>
        <span aria-hidden="true" style={{ flex: 'none', fontSize: '0.75em', opacity: 0.7 }}>▾</span>
      </button>

      {open && box && (
        <div
          ref={popover}
          style={{
            position: 'fixed',
            left: box.left,
            width: box.width,
            top: box.top,
            bottom: box.bottom,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: box.maxHeight,
            background: 'var(--color-bg)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            overflow: 'hidden',
          }}
        >
          <input
            ref={search}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            aria-label="Search the list"
            placeholder="Type to search…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={onKey}
            style={{
              flex: 'none',
              margin: 6,
              padding: '0.375rem 0.5rem',
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              font: 'inherit',
              fontSize: 'var(--text-sm)',
            }}
          />
          <ul
            id={listId}
            role="listbox"
            style={{ listStyle: 'none', margin: 0, padding: '0 0 4px', overflowY: 'auto', fontSize: 'var(--text-sm)' }}
          >
            {shown.length === 0 && (
              <li style={{ padding: '0.5rem 0.75rem', color: 'var(--color-text-muted, var(--color-text))' }}>
                Nothing matches “{query}”.
              </li>
            )}
            {shown.map((option, index) => (
              <li
                key={option.value || '__empty'}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={option.value === value}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                style={{
                  padding: '0.375rem 0.75rem',
                  cursor: 'pointer',
                  background: index === active ? 'var(--color-surface)' : 'transparent',
                  fontWeight: option.value === value ? 600 : 400,
                }}
              >
                {option.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
