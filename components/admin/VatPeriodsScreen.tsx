'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { hmrcFetch } from '@/modules/uk-bookkeeping/lib/hmrc/fraud-client'
import {
  BookkeepingNav,
  EmptyState,
  ErrorNotice,
  PeriodStatusBadge,
  SandboxBanner,
  TriggerHealthNotice,
  useTriggerHealth,
} from './Notices'
import { formatDate } from './format'

type Period = {
  id: string
  period_key: string | null
  start_date: string
  end_date: string
  due_date: string | null
  status: string
  scheme: string
  source: string
  submitted_externally: boolean
  overdue: boolean
}

type HmrcStatus = {
  configured: boolean
  status: string
  environment: string
  vrn: string | null
}

export default function VatPeriodsScreen({
  environment,
  canSubmit,
}: {
  environment: string
  canSubmit: boolean
}) {
  const adminPath = useAdminPath()
  const health = useTriggerHealth()
  const [periods, setPeriods] = useState<Period[] | null>(null)
  const [hmrc, setHmrc] = useState<HmrcStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastChecked, setLastChecked] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [periodsResponse, hmrcResponse] = await Promise.all([
      fetch('/api/m/uk-bookkeeping/admin/periods'),
      fetch('/api/m/uk-bookkeeping/admin/hmrc/status'),
    ])
    if (periodsResponse.ok) setPeriods((await periodsResponse.json()).periods)
    if (hmrcResponse.ok) setHmrc(await hmrcResponse.json())
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  async function refreshFromHmrc() {
    setBusy(true)
    setError(null)
    const response = await hmrcFetch('/api/m/uk-bookkeeping/admin/hmrc/obligations', {})
    const payload = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error ?? 'HMRC could not be reached.')
      return
    }
    setLastChecked(new Date().toLocaleString('en-GB'))
    setPeriods(payload.periods ?? [])
  }

  async function layOutPeriods() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/m/uk-bookkeeping/admin/periods', { method: 'POST' })
    const payload = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error ?? 'The periods could not be laid out.')
      return
    }
    setPeriods(payload.periods ?? [])
  }

  const connected = hmrc?.status === 'connected'

  return (
    <div>
      <BookkeepingNav active="vat" />
      <SandboxBanner environment={environment} />
      <TriggerHealthNotice health={health} />
      <ErrorNotice message={error} />

      {hmrc && !hmrc.configured && (
        <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <strong>Not connected to HMRC.</strong> Everything on this page still works - you can keep
          records, see the nine boxes, and mark a return as filed once you have sent it another way.
          To file from here, your site needs its own HMRC credentials.{' '}
          <a href={`/${adminPath}/config?tab=uk-bookkeeping`}>Set that up in Settings</a>.
        </div>
      )}

      {hmrc?.status === 'expired' && (
        <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          <strong>Your HMRC connection has expired.</strong> Everything except filing still works.{' '}
          <a href={`/${adminPath}/config?tab=uk-bookkeeping`}>Reconnect in Settings</a>.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {canSubmit && connected && (
          <button className="btn btn-sm" disabled={busy} onClick={refreshFromHmrc}>
            {busy ? 'Asking HMRC…' : 'Refresh from HMRC'}
          </button>
        )}
        {canSubmit && (
          <button className="btn btn-sm" disabled={busy} onClick={layOutPeriods}>
            Lay out periods from my settings
          </button>
        )}
        {lastChecked && (
          <span style={{ fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Last checked {lastChecked}
          </span>
        )}
      </div>

      {periods && periods.length === 0 && (
        <EmptyState title={connected ? 'HMRC has no open returns for this VAT number.' : 'No VAT periods yet.'}>
          <p style={{ margin: '0 0 0.75rem' }}>
            {connected
              ? 'Nothing is outstanding, which is either very good news or a sign the VAT number needs checking.'
              : 'Set your VAT scheme and how often you file, in Settings, and we will lay the periods out for you.'}
          </p>
          {!connected && (
            <a className="btn btn-sm" href={`/${adminPath}/config?tab=uk-bookkeeping`}>
              Open Settings
            </a>
          )}
        </EmptyState>
      )}

      {periods && periods.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ padding: '0.625rem 0.75rem' }}>Period</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>Due</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>Scheme</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>Where it came from</th>
                <th style={{ padding: '0.625rem 0.75rem' }}>State</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <a href={`/${adminPath}/m/uk-bookkeeping/vat/${period.id}`}>
                      {formatDate(period.start_date)} to {formatDate(period.end_date)}
                    </a>
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{formatDate(period.due_date)}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    {period.scheme === 'cash' ? 'Cash' : 'Standard'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    {period.source === 'hmrc' ? 'HMRC' : 'Your settings'}
                  </td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    <PeriodStatusBadge
                      status={period.status}
                      overdue={period.overdue}
                      submittedExternally={period.submitted_externally}
                    />
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
