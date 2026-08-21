'use client'

import { useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'

// The banners, and the tab strip.
//
// Colours are semantic tokens throughout. A hardcoded hex in module chrome is a
// defect on this platform, and these are all surfaces somebody reads in both
// light and dark mode.

const noticeBase: React.CSSProperties = {
  padding: '0.75rem 1rem',
  borderRadius: 8,
  border: '1px solid var(--color-border)',
  marginBottom: '1rem',
  fontSize: 'var(--text-sm)',
  lineHeight: 1.5,
}

export function SandboxBanner({ environment }: { environment: string }) {
  if (environment !== 'sandbox') return null
  // The one genuinely dangerous failure mode this module has is an owner
  // believing they have filed when they have filed against a test service. So
  // this does not go away, and it is not dismissible.
  return (
    <div
      style={{
        ...noticeBase,
        background: 'var(--color-warning-bg, var(--color-surface))',
        borderColor: 'var(--color-warning, var(--color-border))',
        color: 'var(--color-text)',
      }}
      role="status"
    >
      <strong>Test mode.</strong> Anything you file here goes to HMRC’s practice service, not to
      HMRC. Nothing you do on this page counts as a real VAT return.
    </div>
  )
}

export type TriggerHealth = {
  healthy: boolean
  missing: { name: string; table: string; protects: string }[]
  disabled: { name: string; table: string; protects: string }[]
}

export function TriggerHealthNotice({ health }: { health: TriggerHealth | null }) {
  if (!health || health.healthy) return null
  const affected = [...health.missing, ...health.disabled]
  return (
    <div
      style={{
        ...noticeBase,
        background: 'var(--color-danger-bg, var(--color-surface))',
        borderColor: 'var(--color-danger, var(--color-border))',
        color: 'var(--color-text)',
      }}
      role="alert"
    >
      <strong>Your records are not being protected.</strong> The safeguards that stop a filed VAT
      return being changed are missing or switched off in your database. Somebody with direct access
      to it has turned them off, or an update has not finished.
      <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
        {affected.map((item) => (
          <li key={item.name}>{item.protects}</li>
        ))}
      </ul>
      <p style={{ margin: '0.5rem 0 0' }}>
        Redeploy your site to put them back. Until then, treat anything filed as unprotected.
      </p>
    </div>
  )
}

export function LockedNotice({
  periodId,
  onCorrect,
}: {
  periodId: string
  onCorrect?: () => void
}) {
  const adminPath = useAdminPath()
  return (
    <div style={{ ...noticeBase, background: 'var(--color-surface)' }}>
      <strong>🔒 Filed, and locked.</strong> This entry was part of a VAT return that has been sent
      off, so it cannot be changed or deleted - that is rather the point of it. Anything that needs
      putting right goes in the current period as a correction.
      <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        {onCorrect && (
          <button type="button" className="btn btn-sm btn-primary" onClick={onCorrect}>
            Post a correction
          </button>
        )}
        <a
          className="btn btn-sm"
          href={`/${adminPath}/m/uk-bookkeeping/vat/${periodId}`}
        >
          See the return it went on
        </a>
      </div>
    </div>
  )
}

export function ErrorNotice({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div
      style={{
        ...noticeBase,
        background: 'var(--color-danger-bg, var(--color-surface))',
        borderColor: 'var(--color-danger, var(--color-border))',
      }}
      role="alert"
    >
      {message}
    </div>
  )
}

export function EmptyState({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
  return (
    <div
      style={{
        padding: '2.5rem 1.5rem',
        textAlign: 'center',
        border: '1px dashed var(--color-border)',
        borderRadius: 10,
        color: 'var(--color-text-muted, var(--color-text))',
      }}
    >
      <p style={{ margin: '0 0 0.5rem', fontWeight: 600, color: 'var(--color-text)' }}>{title}</p>
      {children}
    </div>
  )
}

export function PeriodStatusBadge({
  status,
  overdue = false,
  submittedExternally,
}: {
  status: string
  /** Worked out on the server - see isOverdue in lib/periods.ts for why. */
  overdue?: boolean
  submittedExternally?: boolean
}) {
  const label = overdue
    ? 'Overdue'
    : status === 'submitted'
      ? submittedExternally
        ? 'Filed elsewhere'
        : 'Filed'
      : status === 'finalised'
        ? 'Ready to file'
        : 'Open'

  const colour = overdue
    ? 'var(--color-danger, var(--color-text))'
    : status === 'submitted'
      ? 'var(--color-success, var(--color-text))'
      : status === 'finalised'
        ? 'var(--color-warning, var(--color-text))'
        : 'var(--color-text-muted, var(--color-text))'

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.125rem 0.5rem',
        borderRadius: 999,
        border: `1px solid ${colour}`,
        color: colour,
        fontSize: 'var(--text-xs, 0.75rem)',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'transactions', label: 'Entries' },
  { key: 'vat', label: 'VAT returns' },
  { key: 'reports', label: 'Reports' },
  { key: 'import', label: 'Import' },
]

/**
 * One sidebar link, tabs on the page. Links are built from useAdminPath rather
 * than a hardcoded /cactus-admin/, because the admin path is whatever the owner
 * renamed it to.
 */
export function BookkeepingNav({ active }: { active: string }) {
  const adminPath = useAdminPath()
  return (
    <nav
      style={{
        display: 'flex',
        gap: '0.25rem',
        borderBottom: '1px solid var(--color-border)',
        marginBottom: '1.25rem',
        flexWrap: 'wrap',
      }}
    >
      {TABS.map((tab) => (
        <a
          key={tab.key}
          href={`/${adminPath}/m/uk-bookkeeping/${tab.key}`}
          style={{
            padding: '0.5rem 0.875rem',
            textDecoration: 'none',
            color: active === tab.key ? 'var(--color-text)' : 'var(--color-text-muted, var(--color-text))',
            borderBottom:
              active === tab.key ? '2px solid var(--color-primary, var(--color-text))' : '2px solid transparent',
            fontWeight: active === tab.key ? 600 : 400,
          }}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  )
}

/** Health is checked once per screen and shown wherever it is not well. */
export function useTriggerHealth(): TriggerHealth | null {
  const [health, setHealth] = useState<TriggerHealth | null>(null)
  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/health')
      .then((r) => (r.ok ? r.json() : null))
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])
  return health
}
