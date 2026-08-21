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
import { formatDate, poundsFromString } from './format'

type Liability = {
  taxPeriodFrom: string | null
  taxPeriodTo: string | null
  type: string
  originalAmount: string
  outstandingAmount: string | null
  due: string | null
}

type Payment = { amount: string; received: string | null }

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
  const [money, setMoney] = useState<{ liabilities: Liability[]; payments: Payment[] } | null>(null)
  const [moneyBusy, setMoneyBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [periodsResponse, hmrcResponse] = await Promise.all([
        fetch('/api/m/uk-bookkeeping/admin/periods'),
        fetch('/api/m/uk-bookkeeping/admin/hmrc/status'),
      ])
      if (periodsResponse.ok) setPeriods((await periodsResponse.json()).periods)
      if (hmrcResponse.ok) setHmrc(await hmrcResponse.json())
    } catch {
      setError('The periods could not be loaded. Check the connection and reload the page.')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  async function refreshFromHmrc() {
    setBusy(true)
    setError(null)
    try {
      const response = await hmrcFetch('/api/m/uk-bookkeeping/admin/hmrc/obligations', {})
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'HMRC could not be reached.')
        return
      }
      setLastChecked(new Date().toLocaleString('en-GB'))
      setPeriods(payload.periods ?? [])
    } catch {
      setError('HMRC could not be reached. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function layOutPeriods() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/periods', { method: 'POST' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'The periods could not be laid out.')
        return
      }
      setPeriods(payload.periods ?? [])
    } catch {
      setError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function loadMoney() {
    setMoneyBusy(true)
    setError(null)
    try {
      const to = new Date()
      const from = new Date(to.getTime())
      from.setUTCFullYear(from.getUTCFullYear() - 1)
      const range = {
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
      }
      const [liabilitiesResponse, paymentsResponse] = await Promise.all([
        hmrcFetch('/api/m/uk-bookkeeping/admin/hmrc/liabilities', range),
        hmrcFetch('/api/m/uk-bookkeeping/admin/hmrc/payments', range),
      ])
      const liabilitiesPayload = await liabilitiesResponse.json().catch(() => ({}))
      const paymentsPayload = await paymentsResponse.json().catch(() => ({}))
      if (!liabilitiesResponse.ok || !paymentsResponse.ok) {
        setError(
          liabilitiesPayload.error ?? paymentsPayload.error ?? 'HMRC could not be asked just now.',
        )
        return
      }
      setMoney({
        liabilities: liabilitiesPayload.liabilities ?? [],
        payments: paymentsPayload.payments ?? [],
      })
    } catch {
      setError('HMRC could not be reached. Check the connection and try again.')
    } finally {
      setMoneyBusy(false)
    }
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

      {canSubmit && connected && (
        <div className="card" style={{ padding: '1rem 1.25rem', marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: '0.9375rem' }}>Money with HMRC</h3>
            <span style={{ fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
              What HMRC says is owed and what it has received, over the last year. Their figures,
              shown beside yours - never merged with them.
            </span>
            <span style={{ flex: 1 }} />
            <button className="btn btn-sm" disabled={moneyBusy} onClick={loadMoney}>
              {moneyBusy ? 'Asking HMRC…' : money ? 'Refresh' : 'Show'}
            </button>
          </div>

          {money && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '1rem',
                marginTop: '0.875rem',
              }}
            >
              <div>
                <h4 style={{ margin: '0 0 0.375rem', fontSize: 'var(--text-sm)' }}>Owed</h4>
                {money.liabilities.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
                    Nothing outstanding. Long may it continue.
                  </p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                    <tbody>
                      {money.liabilities.map((liability, index) => (
                        <tr key={index} style={{ borderBottom: '1px solid var(--color-border)' }}>
                          <td style={{ padding: '0.375rem 0.5rem 0.375rem 0' }}>
                            {liability.taxPeriodFrom && liability.taxPeriodTo
                              ? `${formatDate(liability.taxPeriodFrom)} to ${formatDate(liability.taxPeriodTo)}`
                              : liability.type}
                            {liability.due && (
                              <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
                                due {formatDate(liability.due)}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '0.375rem 0', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            {poundsFromString(liability.outstandingAmount ?? liability.originalAmount)}
                            {liability.outstandingAmount &&
                              liability.outstandingAmount !== liability.originalAmount && (
                                <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
                                  of {poundsFromString(liability.originalAmount)}
                                </span>
                              )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.375rem', fontSize: 'var(--text-sm)' }}>Payments received</h4>
                {money.payments.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
                    None in the last year.
                  </p>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                    <tbody>
                      {money.payments.map((payment, index) => (
                        <tr key={index} style={{ borderBottom: '1px solid var(--color-border)' }}>
                          <td style={{ padding: '0.375rem 0.5rem 0.375rem 0' }}>
                            {payment.received ? formatDate(payment.received) : 'Date not given'}
                          </td>
                          <td style={{ padding: '0.375rem 0', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            {poundsFromString(payment.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
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
