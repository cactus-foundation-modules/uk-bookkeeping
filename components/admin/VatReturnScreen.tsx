'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { hmrcFetch } from '@/modules/uk-bookkeeping/lib/hmrc/fraud-client'
import { BookkeepingNav, ErrorNotice, PeriodStatusBadge, SandboxBanner } from './Notices'
import { formatDate, poundsFromString } from './format'

// One VAT return.
//
// Every one of the nine boxes is computed output. There is no input field on
// this page for any of them, and there is no service function anywhere in this
// module that accepts a box value as an argument. That is the Making Tax Digital
// digital-links requirement and it is why this module exists in this shape.

type Boxes = Record<string, string>

type Line = {
  transactionId: string
  lineId: string
  direction: string
  vatTreatment: string
  vatRateCode: string
  netAmount: string
  vatAmount: string
  boxes: string[]
}

type Period = {
  id: string
  period_key: string | null
  start_date: string
  end_date: string
  due_date: string | null
  status: string
  scheme: string
  submitted_externally: boolean
  overdue: boolean
  submitted_at: string | null
  hmrc_form_bundle_number: string | null
  hmrc_receipt_id: string | null
  hmrc_charge_ref_number: string | null
}

type Detail = {
  period: Period
  boxes: Boxes
  unrounded: Record<string, string>
  lines: Line[]
  direction: 'pay' | 'reclaim' | 'nil'
  netErrors: { net: string; threshold: string; overThreshold: boolean; boxSixTurnover: string }
  comparison: { matches: boolean; differences: { box: string; frozen: string; current: string }[] } | null
  snapshots: { id: string; kind: string; createdAt: string; rowHash: string }[]
}

const BOX_LABELS: [string, number, string][] = [
  ['vatDueSales', 1, 'VAT due on sales and other outputs'],
  ['vatDueAcquisitions', 2, 'VAT due on acquisitions from EU member states into Northern Ireland'],
  ['totalVatDue', 3, 'Total VAT due (boxes 1 and 2 added together)'],
  ['vatReclaimedCurrPeriod', 4, 'VAT reclaimed on purchases and other inputs'],
  ['netVatDue', 5, 'Net VAT to pay HMRC or reclaim'],
  ['totalValueSalesExVAT', 6, 'Total value of sales and other outputs, excluding VAT'],
  ['totalValuePurchasesExVAT', 7, 'Total value of purchases and other inputs, excluding VAT'],
  ['totalValueGoodsSuppliedExVAT', 8, 'Goods supplied from Northern Ireland to EU member states'],
  ['totalAcquisitionsExVAT', 9, 'Goods acquired from EU member states into Northern Ireland'],
]

export default function VatReturnScreen({
  id,
  environment,
  canSubmit,
}: {
  id: string
  environment: string
  canSubmit: boolean
}) {
  const adminPath = useAdminPath()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [declaring, setDeclaring] = useState(false)
  const declarationRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The declaration is the legal moment of the page: when it opens, the
    // keyboard lands on it rather than staying somewhere off-screen.
    if (declaring) declarationRef.current?.focus()
  }, [declaring])

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/periods/${id}`)
      if (!response.ok) {
        setError('That VAT period could not be found.')
        return
      }
      setDetail(await response.json())
    } catch {
      setError('This VAT period could not be loaded. Check the connection and reload the page.')
    }
  }, [id])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  if (error && !detail) {
    return (
      <div>
        <BookkeepingNav active="vat" />
        <ErrorNotice message={error} />
      </div>
    )
  }
  if (!detail) return <p>Loading…</p>

  const { period, boxes } = detail
  const empty = detail.lines.length === 0

  async function act(
    path: string,
    method: 'POST' | 'DELETE',
    body?: Record<string, unknown>,
    networkErrorMessage?: string,
  ) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response =
        method === 'POST' && body !== undefined
          ? await hmrcFetch(path, body)
          : await fetch(path, { method })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        setError(payload.error ?? 'That did not work.')
        setDuplicate(payload.hmrcCode === 'DUPLICATE_SUBMISSION')
        return null
      }
      setDuplicate(false)
      await load()
      return payload
    } catch {
      // A connection that drops mid-call must not leave every button disabled
      // with no explanation - least of all on this page.
      setError(
        networkErrorMessage ??
          'That did not reach the server. Check the connection and try again.',
      )
      if (networkErrorMessage) setUncertain(true)
      return null
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <BookkeepingNav active="vat" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />
      {notice && (
        <div
          className="card"
          role="status"
          style={{ padding: '0.75rem 1rem', marginBottom: '1rem', background: 'var(--color-surface)' }}
        >
          {notice}
        </div>
      )}

      <div className="page-header" style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          {formatDate(period.start_date)} to {formatDate(period.end_date)}
        </h1>
        <PeriodStatusBadge
          status={period.status}
          overdue={period.overdue}
          submittedExternally={period.submitted_externally}
        />
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          {period.scheme === 'cash' ? 'Cash accounting' : 'Standard (invoice) accounting'}
          {period.due_date ? ` · due ${formatDate(period.due_date)}` : ''}
        </span>
      </div>

      {(duplicate || uncertain) && canSubmit && (
        <div
          className="card"
          style={{ padding: '0.875rem 1rem', marginBottom: '1rem', background: 'var(--color-surface)' }}
        >
          {duplicate ? (
            <>
              <strong>HMRC says this period has already been filed.</strong> That usually means an
              earlier attempt reached them and the answer never reached us.
            </>
          ) : (
            <>
              <strong>It is not certain whether the return reached HMRC.</strong> The connection
              dropped while they were being called.
            </>
          )}{' '}
          We can ask HMRC what they are holding and, if it matches your figures exactly, tidy the
          record up here. Nothing is sent again.
          <div style={{ marginTop: '0.5rem' }}>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={async () => {
                const result = await act(
                  `/api/m/uk-bookkeeping/admin/periods/${period.id}/reconcile`,
                  'POST',
                  {},
                )
                if (result) setUncertain(false)
                if (result && result.reconciled === false) {
                  setNotice(
                    'HMRC is holding a return for this period, but its figures are not the same as yours. Nothing has been changed here. This one needs a conversation with HMRC rather than another button.',
                  )
                }
              }}
            >
              Check with HMRC
            </button>
          </div>
        </div>
      )}

      {detail.comparison && !detail.comparison.matches && (
        <div
          className="card"
          style={{ padding: '0.875rem 1rem', marginBottom: '1rem', background: 'var(--color-surface)' }}
        >
          <strong>The records changed after this return was finalised.</strong> What would be sent no
          longer matches what you approved, so filing is blocked until you have looked again.
          <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', fontSize: 'var(--text-sm)' }}>
            {detail.comparison.differences.map((difference) => (
              <li key={difference.box}>
                Box {BOX_LABELS.find(([key]) => key === difference.box)?.[1]}: was{' '}
                {poundsFromString(difference.frozen)}, now {poundsFromString(difference.current)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {empty && (
        <div
          className="card"
          style={{ padding: '0.875rem 1rem', marginBottom: '1rem', background: 'var(--color-surface)' }}
        >
          There is nothing recorded in this period, so every box is zero. That is still a return, and
          HMRC still wants it - a nil return is a return.
        </div>
      )}

      <div className="card" style={{ padding: 0, marginBottom: '1rem', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
          <tbody>
            {BOX_LABELS.map(([key, number, description]) => {
              const contributing = detail.lines.filter((line) => line.boxes.includes(String(number)))
              const open = expanded === number
              return (
                <tr key={key} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '0.75rem', verticalAlign: 'top', width: '3rem', fontWeight: 600 }}>
                    {number}
                  </td>
                  <td style={{ padding: '0.75rem', verticalAlign: 'top' }}>
                    {description}
                    {contributing.length > 0 && (
                      <>
                        {' '}
                        <button
                          className="btn btn-sm"
                          style={{ marginLeft: '0.25rem' }}
                          onClick={() => setExpanded(open ? null : number)}
                        >
                          {open ? 'Hide' : `Show the ${contributing.length} entr${contributing.length === 1 ? 'y' : 'ies'}`}
                        </button>
                      </>
                    )}
                    {open && (
                      <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                        {contributing.map((line) => (
                          <li key={line.lineId}>
                            <a href={`/${adminPath}/m/uk-bookkeeping/transactions/${line.transactionId}`}>
                              {number <= 5
                                ? poundsFromString(line.vatAmount)
                                : poundsFromString(line.netAmount)}
                            </a>{' '}
                            <span style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
                              {line.direction === 'income' ? 'money in' : 'money out'} ·{' '}
                              {line.vatRateCode.replace('_', ' ')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {number >= 6 && detail.unrounded[key] && detail.unrounded[key] !== boxes[key] && (
                      <div style={{ fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
                        Before rounding to whole pounds: {poundsFromString(detail.unrounded[key]!)}
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      padding: '0.75rem',
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                      fontWeight: number === 5 ? 700 : 400,
                      verticalAlign: 'top',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {poundsFromString(boxes[key] ?? '0.00')}
                    {number === 5 && (
                      <div style={{ fontSize: 'var(--text-xs, 0.75rem)', fontWeight: 400 }}>
                        {detail.direction === 'pay'
                          ? 'to pay'
                          : detail.direction === 'reclaim'
                            ? 'to reclaim'
                            : 'nothing either way'}
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {detail.netErrors.net !== '0.00' && (
        <div className="card" style={{ padding: '0.875rem 1rem', marginBottom: '1rem' }}>
          Corrections to earlier returns come to <strong>{poundsFromString(detail.netErrors.net)}</strong>.
          {detail.netErrors.overThreshold ? (
            <>
              {' '}That is above the {poundsFromString(detail.netErrors.threshold)} you can put right on
              this return, so HMRC wants telling separately.{' '}
              <a
                href="https://www.gov.uk/guidance/how-to-correct-vat-errors-and-make-adjustments-or-claims-vat-notice-70045"
                target="_blank"
                rel="noreferrer"
              >
                How to tell them
              </a>
              .
            </>
          ) : (
            <> That is within the {poundsFromString(detail.netErrors.threshold)} you can simply adjust on this return.</>
          )}
        </div>
      )}

      {period.status === 'submitted' && (
        <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem', maxWidth: 640 }}>
          <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>Your receipt</h3>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.375rem 1.5rem', margin: 0, fontSize: 'var(--text-sm)' }}>
            <dt>Filed</dt>
            <dd style={{ margin: 0 }}>{formatDate(period.submitted_at)}</dd>
            {period.submitted_externally ? (
              <>
                <dt>How</dt>
                <dd style={{ margin: 0 }}>Recorded as filed through other software</dd>
              </>
            ) : (
              <>
                <dt>HMRC reference</dt>
                <dd style={{ margin: 0 }}>{period.hmrc_form_bundle_number ?? '—'}</dd>
                <dt>Receipt</dt>
                <dd style={{ margin: 0 }}>{period.hmrc_receipt_id ?? '—'}</dd>
                {period.hmrc_charge_ref_number && (
                  <>
                    <dt>Payment reference</dt>
                    <dd style={{ margin: 0 }}>{period.hmrc_charge_ref_number}</dd>
                  </>
                )}
              </>
            )}
          </dl>
          <p style={{ margin: '0.75rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Everything on this return is now locked. Anything that needs putting right goes on the
            current period as a correction.
          </p>
        </div>
      )}

      {declaring && period.status === 'finalised' && (
        <div
          className="card"
          role="alertdialog"
          aria-label="Declaration before sending to HMRC"
          ref={declarationRef}
          tabIndex={-1}
          style={{
            padding: '1.25rem',
            marginBottom: '1rem',
            maxWidth: 640,
            border: '1px solid var(--color-border)',
          }}
        >
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Before this is sent</h3>
          {/* HMRC's MTD guidance requires this declaration to be shown and
              affirmed immediately before submission. It is the legal moment of
              the whole page, so it gets a real dialog, not a browser confirm. */}
          <p style={{ margin: '0 0 0.75rem' }}>
            When you submit this VAT information you are making a legal declaration that the
            information is true and complete. A false declaration can result in prosecution.
          </p>
          <p style={{ margin: '0 0 1rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            The nine figures above, exactly as frozen when this return was finalised, will be filed
            against your VAT registration{environment === 'sandbox' ? ' on HMRC’s practice service' : ''}.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setDeclaring(false)
                await act(
                  `/api/m/uk-bookkeeping/admin/periods/${period.id}/submit`,
                  'POST',
                  {},
                  'The connection dropped while HMRC was being called, so it is not certain whether the return arrived. Do NOT try again yet - use “Check with HMRC” first, which asks them what they are holding without sending anything.',
                )
              }}
            >
              I agree - submit the return
            </button>
            <button className="btn" disabled={busy} onClick={() => setDeclaring(false)}>
              Not yet
            </button>
          </div>
        </div>
      )}

      {canSubmit && period.status !== 'submitted' && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {period.status === 'open' && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => act(`/api/m/uk-bookkeeping/admin/periods/${period.id}/finalise`, 'POST')}
            >
              Finalise these figures
            </button>
          )}
          {period.status === 'finalised' && (
            <>
              <button
                className="btn btn-primary"
                disabled={busy || !period.period_key}
                title={period.period_key ? undefined : 'Refresh your obligations from HMRC first'}
                onClick={() => setDeclaring(true)}
              >
                Send this to HMRC
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      'Record this as filed elsewhere? Everything on it locks, exactly as if it had been sent from here.',
                    )
                  ) {
                    act(`/api/m/uk-bookkeeping/admin/periods/${period.id}/mark-submitted`, 'POST')
                  }
                }}
              >
                I filed this somewhere else
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => act(`/api/m/uk-bookkeeping/admin/periods/${period.id}/finalise`, 'DELETE')}
              >
                Reopen it
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
