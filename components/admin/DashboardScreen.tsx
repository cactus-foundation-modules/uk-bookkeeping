'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import DashboardStyles from './DashboardStyles'
import {
  BookkeepingNav,
  ErrorNotice,
  SandboxBanner,
  TriggerHealthNotice,
  useTriggerHealth,
} from './Notices'
import { formatDate, poundsFromString } from './format'

// The overview: where the VAT stands, what is due when, what is waiting on a
// human, and how the last six months have gone. Every figure links to the
// screen where it can be acted on - a dashboard nobody can act from is a
// screensaver.

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
  trend: { month: string; income: string; expenses: string; profit: string }[]
  year: { from: string; income: string; expenses: string; profit: string }
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

type IconName =
  | 'inbox'
  | 'bank'
  | 'receipt'
  | 'asset'
  | 'check'
  | 'chevron'
  | 'plus'
  | 'chart'
  | 'calendar'
  | 'book'

const ICON_PATHS: Record<IconName, string> = {
  inbox: 'M3 13l2.5-7.5A2 2 0 017.4 4h9.2a2 2 0 011.9 1.5L21 13v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5zm0 0h5l1 2h6l1-2h5',
  bank: 'M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6',
  asset: 'M4 7h16v12H4zM9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M4 12h16',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  book: 'M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4zM5 17a3 3 0 013-3h11',
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
}

/**
 * Chart geometry only. Every amount SHOWN is still the server's decimal string;
 * this turns one into a bar height and is never added to anything.
 */
function toScale(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0
}

function monthLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  return date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })
}

function compactPounds(value: string): string {
  const amount = Number.parseFloat(value)
  if (!Number.isFinite(amount) || Math.abs(amount) < 10000) return poundsFromString(value)
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  return abs >= 1_000_000
    ? `${sign}£${(abs / 1_000_000).toFixed(1)}m`
    : `${sign}£${(abs / 1000).toFixed(1)}k`
}

function periodProgress(start: string, end: string): number {
  const from = new Date(`${start}T00:00:00.000Z`).getTime()
  const to = new Date(`${end}T23:59:59.999Z`).getTime()
  if (!(to > from)) return 0
  return Math.max(0, Math.min(100, ((Date.now() - from) / (to - from)) * 100))
}

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function initial(name: string): string {
  const letter = name.trim().charAt(0).toUpperCase()
  return letter || '·'
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="bko">
      <div className="bko-top">
        <div className="bko-card bko-hero">
          <div className="bko-skel" style={{ height: 14, width: '30%' }} />
          <div className="bko-skel" style={{ height: 46, width: '45%' }} />
          <div className="bko-skel" style={{ height: 10, width: '100%' }} />
        </div>
        <div className="bko-card bko-card-pad">
          <div className="bko-skel" style={{ height: 14, width: '40%', marginBottom: 20 }} />
          <div className="bko-skel" style={{ height: 40, marginBottom: 12 }} />
          <div className="bko-skel" style={{ height: 40, marginBottom: 12 }} />
          <div className="bko-skel" style={{ height: 40 }} />
        </div>
      </div>
      <div className="bko-card" style={{ height: 96 }} />
      <div className="bko-low">
        <div className="bko-card" style={{ height: 280 }} />
        <div className="bko-card" style={{ height: 280 }} />
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
  // unmatched on the reconcile screen. An asset nobody finished off claims no
  // capital allowances, and the only place that shows up is a tax bill that is
  // too big, so it is said here, on the page people actually look at.
  const queue: { key: string; icon: IconName; count: number; href: string; label: string; hint: string }[] =
    data
      ? [
          {
            key: 'drafts',
            icon: 'inbox' as const,
            count: data.drafts,
            href: `${base}/transactions?status=draft`,
            label: `Imported entr${data.drafts === 1 ? 'y' : 'ies'} to review`,
            hint: 'Check, categorise and post',
          },
          {
            key: 'bank',
            icon: 'bank' as const,
            count: data.unreconciled,
            href: `${base}/reconcile`,
            label: `Bank line${data.unreconciled === 1 ? '' : 's'} to match up`,
            hint: 'The bank has it, the books do not',
          },
          {
            key: 'evidence',
            icon: 'receipt' as const,
            count: data.missingEvidence,
            href: `${base}/transactions?hasEvidence=0`,
            label: `Entr${data.missingEvidence === 1 ? 'y' : 'ies'} without a receipt`,
            hint: 'HMRC will ask for these',
          },
          {
            key: 'assets',
            icon: 'asset' as const,
            count: data.unfinishedAssets,
            href: `${base}/assets`,
            label: `Asset${data.unfinishedAssets === 1 ? '' : 's'} to finish off`,
            hint: 'Unfinished assets claim no allowances',
          },
        ].filter((item) => item.count > 0)
      : []

  const chartMax = data
    ? Math.max(1, ...data.trend.flatMap((m) => [toScale(m.income), toScale(m.expenses)]))
    : 1
  const thisMonthKey = data?.month.from

  const vatTone =
    data?.vat?.overdue || data?.nextDue?.overdue ? 'bad' : undefined

  return (
    <div>
      <DashboardStyles />
      <BookkeepingNav active="overview" />
      <SandboxBanner environment={environment} />
      <TriggerHealthNotice health={health} />
      <ErrorNotice message={error} />

      <div className="bko">
        <div className="bko-head">
          <div>
            <p className="bko-eyebrow">
              {new Date().toLocaleDateString('en-GB', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </p>
            <h1 className="bko-h1">{greeting()}</h1>
            <p className="bko-sub">
              {data
                ? queue.length === 0
                  ? 'The books are up to date. Nothing needs you right now.'
                  : `${queue.reduce((n, q) => n + q.count, 0)} thing${queue.reduce((n, q) => n + q.count, 0) === 1 ? '' : 's'} could do with your attention.`
                : 'Pulling the books together...'}
            </p>
          </div>
          {canRecord && (
            <div className="bko-actions">
              <a className="btn btn-primary" href={`${base}/transactions/new`}>
                <Icon name="plus" size={16} /> Record something
              </a>
              <a className="btn" href={`${base}/statements`}>
                Import a statement
              </a>
            </div>
          )}
        </div>

        {data?.hmrc && !data.hmrc.configured && (
          <div className="bko-notice">
            <span>
              <strong>Not connected to HMRC.</strong> Records, boxes and reports all work without it;
              only filing from here needs the connection.
            </span>
            <a className="bko-link" href={`/${adminPath}/config?tab=uk-bookkeeping`}>
              Set it up in Settings
            </a>
          </div>
        )}
        {data?.hmrc.status === 'expired' && (
          <div className="bko-notice">
            <span>
              <strong>Your HMRC connection has expired.</strong>
            </span>
            <a className="bko-link" href={`/${adminPath}/config?tab=uk-bookkeeping`}>
              Reconnect in Settings
            </a>
          </div>
        )}

        {!data && !error && <Skeleton />}

        {data && (
          <>
            <div className="bko-top">
              {/* VAT hero */}
              <section className="bko-card bko-hero" aria-label="VAT position">
                <div className="bko-card-head" style={{ margin: 0 }}>
                  <h2 className="bko-title">VAT this period</h2>
                  {data.vat && (
                    <span
                      className="bko-pill"
                      data-tone={data.vat.overdue ? 'bad' : data.vat.status === 'finalised' ? 'warn' : undefined}
                    >
                      {data.vat.overdue
                        ? 'Overdue'
                        : data.vat.status === 'finalised'
                          ? 'Ready to file'
                          : 'Open'}
                    </span>
                  )}
                </div>

                <div className="bko-hero-main">
                  <div>
                    <div className="bko-hero-figure" data-tone={data.vat?.overdue ? 'bad' : undefined}>
                      {data.vat ? poundsFromString(data.vat.netVatDue) : '—'}
                    </div>
                    <p className="bko-hero-note">
                      {data.vat
                        ? data.vat.direction === 'pay'
                          ? 'To pay HMRC so far, as it stands'
                          : data.vat.direction === 'reclaim'
                            ? 'To reclaim from HMRC so far, as it stands'
                            : 'Nothing either way yet'
                        : 'No period covers today. Lay periods out on the VAT returns tab.'}
                    </p>
                  </div>
                  <div className="bko-hero-side">
                    <span className="bko-mini-label">Next return due</span>
                    <span className="bko-due" data-tone={vatTone}>
                      {data.nextDue ? formatDate(data.nextDue.due) : '—'}
                    </span>
                    <span className="bko-mini-label">
                      {data.nextDue
                        ? data.nextDue.overdue
                          ? 'Overdue - HMRC is waiting'
                          : `${data.nextDue.daysLeft} day${data.nextDue.daysLeft === 1 ? '' : 's'} left`
                        : 'Nothing on the calendar'}
                    </span>
                  </div>
                </div>

                {data.vat && (
                  <div>
                    <div
                      className="bko-progress"
                      role="progressbar"
                      aria-label="How far through this VAT period we are"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(periodProgress(data.vat.start, data.vat.end))}
                    >
                      <span style={{ width: `${periodProgress(data.vat.start, data.vat.end)}%` }} />
                    </div>
                    <div className="bko-progress-labels">
                      <span>{formatDate(data.vat.start)}</span>
                      <span>{formatDate(data.vat.end)}</span>
                    </div>
                  </div>
                )}

                <div className="bko-split">
                  <div>
                    <span className="bko-mini-label">VAT charged on sales (box 1)</span>
                    <span className="bko-mini-value">
                      {data.vat ? poundsFromString(data.vat.box1) : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="bko-mini-label">VAT reclaimed on costs (box 4)</span>
                    <span className="bko-mini-value">
                      {data.vat ? poundsFromString(data.vat.box4) : '—'}
                    </span>
                  </div>
                </div>
              </section>

              {/* Attention queue */}
              <section className="bko-card" aria-label="Waiting on you" style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="bko-card-pad" style={{ paddingBottom: '.75rem' }}>
                  <div className="bko-card-head" style={{ margin: 0 }}>
                    <h2 className="bko-title">Waiting on you</h2>
                    {queue.length > 0 && <span className="bko-pill" data-tone="warn">{queue.length} to do</span>}
                  </div>
                </div>
                {queue.length === 0 ? (
                  <div className="bko-clear">
                    <span className="bko-clear-ico">
                      <Icon name="check" size={22} />
                    </span>
                    <strong>All caught up</strong>
                    <span className="bko-muted" style={{ fontSize: 'var(--text-sm)' }}>
                      No drafts, unmatched bank lines or missing receipts. Frankly suspicious.
                    </span>
                  </div>
                ) : (
                  <ul className="bko-queue">
                    {queue.map((item) => (
                      <li key={item.key}>
                        <a className="bko-qrow" href={item.href}>
                          <span className="bko-qico">
                            <Icon name={item.icon} />
                          </span>
                          <span className="bko-qbody">
                            <span className="bko-qlabel">{item.label}</span>
                            <span className="bko-qhint">{item.hint}</span>
                          </span>
                          <span className="bko-qcount">{item.count}</span>
                          <span className="bko-chev">
                            <Icon name="chevron" size={16} />
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {/* KPI strip */}
            <section className="bko-card bko-kpis" aria-label="Profit and loss at a glance">
              <a className="bko-kpi" href={`${base}/reports`}>
                <span className="bko-title">Profit this month</span>
                <span
                  className="bko-kpi-value"
                  data-tone={data.month.profit.startsWith('-') ? 'bad' : undefined}
                >
                  {poundsFromString(data.month.profit)}
                </span>
                <span className="bko-kpi-note">
                  {poundsFromString(data.month.income)} in · {poundsFromString(data.month.expenses)} out
                </span>
              </a>
              <a className="bko-kpi" href={`${base}/reports`}>
                <span className="bko-title">Money in, this year</span>
                <span className="bko-kpi-value">{poundsFromString(data.year.income)}</span>
                <span className="bko-kpi-note">Since {formatDate(data.year.from)}, before VAT</span>
              </a>
              <a className="bko-kpi" href={`${base}/reports`}>
                <span className="bko-title">Money out, this year</span>
                <span className="bko-kpi-value">{poundsFromString(data.year.expenses)}</span>
                <span className="bko-kpi-note">Since {formatDate(data.year.from)}, before VAT</span>
              </a>
              <a className="bko-kpi" href={`${base}/reports`}>
                <span className="bko-title">Profit this year</span>
                <span
                  className="bko-kpi-value"
                  data-tone={data.year.profit.startsWith('-') ? 'bad' : 'good'}
                >
                  {poundsFromString(data.year.profit)}
                </span>
                <span className="bko-kpi-note">Before tax</span>
              </a>
            </section>

            <div className="bko-low">
              {/* Trend */}
              <section className="bko-card bko-card-pad" aria-label="Last six months">
                <div className="bko-card-head">
                  <h2 className="bko-title">Last six months</h2>
                  <div className="bko-legend">
                    <span className="bko-key">
                      <span className="bko-swatch" /> Money in
                    </span>
                    <span className="bko-key">
                      <span className="bko-swatch" data-kind="out" /> Money out
                    </span>
                  </div>
                </div>
                <div className="bko-chart">
                  {data.trend.map((m) => (
                    <div
                      className="bko-col"
                      key={m.month}
                      title={`${monthLabel(m.month)}: ${poundsFromString(m.income)} in, ${poundsFromString(m.expenses)} out, profit ${poundsFromString(m.profit)}`}
                    >
                      <div className="bko-bars">
                        <span
                          className="bko-bar"
                          style={{ height: `${(toScale(m.income) / chartMax) * 100}%` }}
                        />
                        <span
                          className="bko-bar"
                          data-kind="out"
                          style={{ height: `${(toScale(m.expenses) / chartMax) * 100}%` }}
                        />
                      </div>
                      <span className="bko-month" data-now={m.month === thisMonthKey}>
                        {monthLabel(m.month)}
                      </span>
                      <span className="bko-profit" data-tone={m.profit.startsWith('-') ? 'bad' : undefined}>
                        {compactPounds(m.profit)}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="bko-kpi-note" style={{ margin: '1rem 0 0' }}>
                  Figures under each month are profit. Net of VAT, straight off the ledger.
                </p>
              </section>

              {/* Recent */}
              <section className="bko-card" aria-label="Latest entries">
                <div className="bko-card-pad" style={{ paddingBottom: '.5rem' }}>
                  <div className="bko-card-head" style={{ margin: 0 }}>
                    <h2 className="bko-title">Latest entries</h2>
                    <a className="bko-link" href={`${base}/transactions`}>
                      View all
                    </a>
                  </div>
                </div>
                {data.recent.length === 0 ? (
                  <div className="bko-clear">
                    <span className="bko-clear-ico" style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-muted, var(--color-text))' }}>
                      <Icon name="book" size={22} />
                    </span>
                    <strong>Nothing recorded yet</strong>
                    <span className="bko-muted" style={{ fontSize: 'var(--text-sm)' }}>
                      Record what you spend and what you take, and this page starts earning its keep.
                    </span>
                  </div>
                ) : (
                  <ul className="bko-feed">
                    {data.recent.map((row) => (
                      <li key={row.id}>
                        <a className="bko-item" href={`${base}/transactions/${row.id}`}>
                          <span className="bko-av">{initial(row.counterparty)}</span>
                          <span className="bko-ibody">
                            <span className="bko-iname">{row.counterparty}</span>
                            <span className="bko-imeta">
                              {formatDate(row.date)}
                              {row.kind === 'transfer' && <span>Transfer</span>}
                              {row.status === 'draft' && (
                                <span className="bko-pill" data-tone="warn">
                                  Needs review
                                </span>
                              )}
                              {row.locked && <span>Filed</span>}
                            </span>
                          </span>
                          {/* Neither sign belongs on a transfer: nothing was spent
                              or earned, it only went somewhere else. */}
                          <span
                            className="bko-amt"
                            data-tone={row.kind !== 'transfer' && row.direction === 'income' ? 'in' : undefined}
                          >
                            {row.kind === 'transfer' ? '↔ ' : row.direction === 'expense' ? '-' : '+'}
                            {poundsFromString(row.gross)}
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {/* Shortcuts */}
            <nav className="bko-shortcuts" aria-label="Shortcuts">
              <a className="bko-short" href={`${base}/reports`}>
                <Icon name="chart" /> Reports
              </a>
              <a className="bko-short" href={`${base}/reconcile`}>
                <Icon name="bank" /> Reconcile
              </a>
              <a className="bko-short" href={`${base}/vat`}>
                <Icon name="calendar" /> VAT returns
              </a>
              <a className="bko-short" href={`${base}/documents`}>
                <Icon name="receipt" /> Receipts
              </a>
              <a className="bko-short" href={`${base}/year-end`}>
                <Icon name="book" /> Year end
              </a>
            </nav>
          </>
        )}
      </div>
    </div>
  )
}
