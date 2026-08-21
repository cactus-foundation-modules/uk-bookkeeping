'use client'

import { poundsFromString } from './format'

// The bits of chrome the accounts screens share.
//
// Four report screens all want the same table, the same right-aligned money
// column and the same subtotal rule, and four copies of those inline styles is
// four places for one of them to drift. Colours are semantic tokens throughout:
// a hardcoded hex in module chrome is a defect on this platform, and every one
// of these surfaces is read in both light and dark mode.

export const card: React.CSSProperties = {
  border: '1px solid var(--color-border)',
  borderRadius: 10,
  background: 'var(--color-surface)',
  marginBottom: '1rem',
}

export const input: React.CSSProperties = {
  padding: '0.3125rem 0.5rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  font: 'inherit',
}

export const table: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--text-sm)',
}

export const th: React.CSSProperties = {
  padding: '0.625rem 0.75rem',
  textAlign: 'left',
  fontWeight: 600,
  borderBottom: '1px solid var(--color-border)',
  whiteSpace: 'nowrap',
}

export const thRight: React.CSSProperties = { ...th, textAlign: 'right' }

export const td: React.CSSProperties = {
  padding: '0.4375rem 0.75rem',
  borderBottom: '1px solid var(--color-border)',
}

/** Money columns are tabular so the digits line up down the page. */
export const tdRight: React.CSSProperties = {
  ...td,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
}

export const muted: React.CSSProperties = {
  color: 'var(--color-text-muted, var(--color-text))',
  fontSize: 'var(--text-xs, 0.75rem)',
}

/**
 * An amount, in pounds, with a loss shown in the danger colour.
 *
 * `negativeIsBad` is off by default: a negative figure in a costs column is a
 * credit note and perfectly ordinary, and colouring every one of them red
 * trains people to ignore the colour by the time it means something.
 */
export function Money({
  value,
  negativeIsBad = false,
  bold = false,
}: {
  value: string | null | undefined
  negativeIsBad?: boolean
  bold?: boolean
}) {
  const negative = !!value && value.startsWith('-')
  return (
    <span
      style={{
        fontWeight: bold ? 600 : undefined,
        color: negative && negativeIsBad ? 'var(--color-danger, var(--color-text))' : undefined,
      }}
    >
      {poundsFromString(value)}
    </span>
  )
}

/** A subtotal rule: the line with a border above it that everyone looks at. */
export function SubtotalRow({
  label,
  amount,
  priorAmount,
  emphasis = false,
  columns = 2,
}: {
  label: string
  amount: string
  priorAmount?: string | null
  emphasis?: boolean
  columns?: number
}) {
  return (
    <tr
      style={{
        borderTop: `${emphasis ? 2 : 1}px solid var(--color-border)`,
        background: emphasis ? 'var(--color-bg)' : undefined,
      }}
    >
      <td style={{ ...td, borderBottom: 'none', fontWeight: 600 }}>{label}</td>
      <td style={{ ...tdRight, borderBottom: 'none' }}>
        <Money value={amount} bold negativeIsBad={emphasis} />
      </td>
      {columns > 2 && (
        <td style={{ ...tdRight, borderBottom: 'none' }}>
          {priorAmount != null ? <Money value={priorAmount} /> : null}
        </td>
      )}
    </tr>
  )
}

export function SectionHeadingRow({ label, columns }: { label: string; columns: number }) {
  return (
    <tr>
      <td
        colSpan={columns}
        style={{
          ...td,
          paddingTop: '1rem',
          fontWeight: 600,
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        {label}
      </td>
    </tr>
  )
}

/** The tab strip used inside a screen, as against BookkeepingNav between them. */
export function SubTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: T; label: string }[]
  active: T
  onChange: (key: T) => void
}) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: '0.25rem',
        flexWrap: 'wrap',
        marginBottom: '1rem',
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onChange(tab.key)}
          style={{
            padding: '0.375rem 0.75rem',
            borderRadius: 999,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 'var(--text-sm)',
            border: '1px solid var(--color-border)',
            background: active === tab.key ? 'var(--color-text)' : 'var(--color-surface)',
            color: active === tab.key ? 'var(--color-bg)' : 'var(--color-text)',
            fontWeight: active === tab.key ? 600 : 400,
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

/** A labelled date box. Four screens want one and they should all look the same. */
export function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div>
      <label htmlFor={id} style={{ display: 'block', ...muted }}>
        {label}
      </label>
      <input id={id} type="date" style={input} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

/** Today on the reader's wall clock, not UTC. */
export function localToday(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`
}

export function formatDay(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
