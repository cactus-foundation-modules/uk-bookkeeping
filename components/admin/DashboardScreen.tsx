'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import {
  BookkeepingNav,
  EmptyState,
  ErrorNotice,
  PeriodStatusBadge,
  SandboxBanner,
  TriggerHealthNotice,
  useTriggerHealth,
} from './Notices'
import { formatDate, poundsFromString } from './format'

// The overview: where the VAT stands, what is due when, what is waiting on a
// human, and what has moved lately. Every figure links to the screen where it
// can be acted on - a dashboard nobody can act from is a screensaver.

type Data = {
  environment: string
  hmrc: { configured: boolean; status: string }
  vat: {
    periodId: string
    start: string
    end: string
    due: string | null
    status: string
    overdue: boolean
    netVatDue: string
    direction: 'pay' | 'reclaim' | 'nil'
    box1: string
    box4: string
  } | null
  nextDue: {
    periodId: string
    start: string
    end: string
    due: string
    status: string
    overdue: boolean
    daysLeft: number
  } | null
  month: { from: string; income: string; expenses: string; profit: string }
  drafts: number
  unreconciled: number
  missingEvidence: number
  unfinishedAssets: number
  recent: {
    id: string
    date: string
    counterparty: string
    /** Null on a transfer, which is neither in nor out. */
    direction: string | null
    kind: 'entry' | 'transfer'
    status: string
    gross: string
    locked: boolean
  }[]
}

const tile: React.CSSProperties = {
  padding: '1rem 1.25rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  minWidth: 0,
}

const tileLabel: React.CSSProperties = {
  fontSize: 'var(--text-xs, 0.75rem)',
  color: 'var(--color-text-muted, var(--color-text))',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const tileValue: React.CSSProperties = {
  fontSize: '1.375rem',
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--color-text)',
}

const tileNote: React.CSSProperties = {
  fontSize: 'var(--text-xs, 0.75rem)',
  color: 'var(--color-text-muted, var(--color-text))',
}

function TileSkeleton() {
  return (
    <div className="card" style={tile} aria-hidden="true">
      <div style={{ ...tileLabel, background: 'var(--color-surface)', borderRadius: 4, width: '60%' }}>
        &nbsp;
      </div>
      <div style={{ ...tileValue, background: 'var(--color-surface)', borderRadius: 6, width: '45%' }}>
        &nbsp;
      </div>
      <div style={{ ...tileNote, background: 'var(--color-surface)', borderRadius: 4, width: '75%' }}>
        &nbsp;
      </div>
    </div>
  )
}

export default function DashboardScreen({
  environment,
  canRecord,
}: {
  environment: string
  canRecord: boolean
}) {
  const adminPath = useAdminPath()
  const health = useTriggerHealth()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/dashboard')
      if (!response.ok) {
        setError('The overview could not be loaded.')
        return
      }
      setData(await response.json())
    } catch {
      setError('The overview could not be loaded. Check the connection and reload the page.')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  const base = `/${adminPath}/m/uk-bookkeeping`

  // Everything a human still has to look at, each queue with its own count and
  // its own screen. Drafts and unmatched statement lines are separate piles in
  // separate tables, and the headline used to be the drafts alone - which read
  // as "nothing to do" on a site with a fortnight of statement lines sat
  // unmatched on the reconcile screen.
  const waiting = data
    ? [
        {
          key: 'drafts',
          count: data.drafts,
          href: `${base}/transactions?status=draft`,
          label: `imported entr${data.drafts === 1 ? 'y' : 'ies'} to review`,
        },
        {
          key: 'bank',
          count: data.unreconciled,
          href: `${base}/reconcile`,
          label: `bank line${data.unreconciled === 1 ? '' : 's'} to match up`,
        },
        {
          key: 'evidence',
          count: data.missingEvidence,
          href: `${base}/transactions?hasEvidence=0`,
          label: 'without a receipt',
        },
        {
          key: 'assets',
          count: data.unfinishedAssets,
          href: `${base}/assets`,
          label: `asset${data.unfinishedAssets === 1 ? '' : 's'} to finish off`,
        },
      ].filter((item) => item.count > 0)
    : []
  // The two review queues. A missing receipt or an unfinished asset is worth
  // saying, but neither is a row sitting in a queue with a tick box next to it.
  const toReview = data ? data.drafts + data.unreconciled : 0

  return (
    <div>
      <BookkeepingNav active="overview" />
      <SandboxBanner environment={environment} />
      <TriggerHealthNotice health={health} />
      <ErrorNotice message={error} />

      {data?.hmrc && !data.hmrc.configured && (
        <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <strong>Not connected to HMRC.</strong> Records, boxes and reports all work without it; only
          filing from here needs the connection.{' '}
          <a href={`/${adminPath}/config?tab=uk-bookkeeping`}>Set it up in Settings</a>.
        </div>
      )}
      {data?.hmrc.status === 'expired' && (
        <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <strong>Your HMRC connection has expired.</strong>{' '}
          <a href={`/${adminPath}/config?tab=uk-bookkeeping`}>Reconnect in Settings</a>.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '0.875rem',
          marginBottom: '1.25rem',
        }}
      >
        {!data && (
          <>
            <TileSkeleton />
            <TileSkeleton />
            <TileSkeleton />
            <TileSkeleton />
          </>
        )}

        {data && (
          <>
            <a className="card" style={{ ...tile, textDecoration: 'none' }} href={data.vat ? `${base}/vat/${data.vat.periodId}` : `${base}/vat`}>
              <span style={tileLabel}>VAT this period</span>
              <span style={tileValue}>
                {data.vat ? poundsFromString(data.vat.netVatDue) : '—'}
              </span>
              <span style={tileNote}>
                {data.vat
                  ? data.vat.direction === 'pay'
                    ? 'to pay so far, as it stands'
                    : data.vat.direction === 'reclaim'
                      ? 'to reclaim so far, as it stands'
                      : 'nothing either way yet'
                  : 'No period covers today - lay periods out on the VAT returns tab.'}
              </span>
            </a>

            <a
              className="card"
              style={{ ...tile, textDecoration: 'none' }}
              href={data.nextDue ? `${base}/vat/${data.nextDue.periodId}` : `${base}/vat`}
            >
              <span style={tileLabel}>Next return due</span>
              <span
                style={{
                  ...tileValue,
                  color: data.nextDue?.overdue
                    ? 'var(--color-danger, var(--color-text))'
                    : 'var(--color-text)',
                }}
              >
                {data.nextDue ? formatDate(data.nextDue.due) : '—'}
              </span>
              <span style={tileNote}>
                {data.nextDue
                  ? data.nextDue.overdue
                    ? 'Overdue - HMRC is waiting for this one.'
                    : `${data.nextDue.daysLeft} day${data.nextDue.daysLeft === 1 ? '' : 's'} left · ${formatDate(data.nextDue.start)} to ${formatDate(data.nextDue.end)}`
                  : 'Nothing on the calendar yet.'}
              </span>
            </a>

            <a className="card" style={{ ...tile, textDecoration: 'none' }} href={`${base}/reports`}>
              <span style={tileLabel}>This month</span>
              <span style={tileValue}>{poundsFromString(data.month.profit)}</span>
              <span style={tileNote}>
                {poundsFromString(data.month.income)} in · {poundsFromString(data.month.expenses)} out,
                before VAT
              </span>
            </a>

            <div className="card" style={tile}>
              <span style={tileLabel}>Waiting on you</span>
              <span
                style={{
                  ...tileValue,
                  color:
                    toReview > 0 ? 'var(--color-warning, var(--color-text))' : 'var(--color-text)',
                }}
              >
                {toReview}
              </span>
              <span style={tileNote}>
                {/*
                  An asset nobody finished off claims no capital allowances, and
                  the only place that shows up is a tax bill that is too big.
                  Said here because this is the page people actually look at.
                */}
                {waiting.length === 0 && 'Nothing waiting.'}
                {waiting.map((item, index) => (
                  <span key={item.key}>
                    {index > 0 && ' · '}
                    <a href={item.href}>
                      {item.count} {item.label}
                    </a>
                  </span>
                ))}
              </span>
            </div>
          </>
        )}
      </div>

      <div
        className="page-header"
        style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Latest entries</h2>
        <span style={{ flex: 1 }} />
        {canRecord && (
          <>
            <a className="btn btn-sm btn-primary" href={`${base}/transactions/new`}>
              Record something
            </a>
            <a className="btn btn-sm" href={`${base}/statements`}>
              Import a statement
            </a>
          </>
        )}
      </div>

      {data && data.recent.length === 0 && (
        <EmptyState title="Nothing recorded yet.">
          <p style={{ margin: 0 }}>
            Record what you spend and what you take, and this page starts earning its keep.
          </p>
        </EmptyState>
      )}

      {data && data.recent.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <tbody>
              {data.recent.map((row) => (
                <tr key={row.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '0.5rem 0.75rem', whiteSpace: 'nowrap' }}>
                    {formatDate(row.date)}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <a href={`${base}/transactions/${row.id}`}>{row.counterparty}</a>
                    {row.status === 'draft' && (
                      <span
                        style={{
                          marginLeft: '0.5rem',
                          fontSize: 'var(--text-xs, 0.75rem)',
                          color: 'var(--color-warning, var(--color-text))',
                        }}
                      >
                        waiting for review
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '0.5rem 0.75rem',
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {/* Neither sign belongs on a transfer: nothing was spent or
                        earned, it only went somewhere else. */}
                    {row.kind === 'transfer' ? '↔ ' : row.direction === 'expense' ? '-' : ''}
                    {poundsFromString(row.gross)}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem', width: '2rem' }}>
                    {row.locked ? '🔒' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
