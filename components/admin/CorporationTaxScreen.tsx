'use client'

import { useCallback, useEffect, useState } from 'react'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import {
  Money,
  card,
  formatDay,
  input,
  muted,
  table,
  td,
  tdRight,
  th,
  thRight,
} from './ui'

// Corporation tax.
//
// The screen is the computation, top to bottom, in the order an accountant
// works it: the profit in the accounts, the things added back, the capital
// allowances, the losses, the taxable profit, the rates. Every figure it
// produces came from a record somebody can go and look at, and the ones that
// came from a judgement are listed by name with the reason attached.
//
// It does not file anything, and it says so where somebody will read it. There
// is no HMRC API for a small company to self-file corporation tax through.

const ADJUSTMENT_KINDS = [
  { value: 'add_back', label: 'A cost the taxman will not allow' },
  { value: 'deduction', label: 'A deduction not in the accounts' },
  { value: 'capital_allowance', label: 'Extra capital allowances claimed' },
  { value: 'balancing_charge', label: 'A balancing charge' },
  { value: 'non_trade_income', label: 'Bank interest or other non-trading income' },
  { value: 'property_income', label: 'Income from property' },
  { value: 'other_income', label: 'Other income' },
  { value: 'chargeable_gain', label: 'A gain on selling an asset' },
  { value: 'loss_bf', label: 'Losses brought forward, how much to use' },
  { value: 'loss_cy', label: 'This year’s loss against other profits' },
  { value: 'group_relief', label: 'Group relief claimed' },
  { value: 'qualifying_donations', label: 'Charitable donations' },
  { value: 'management_expenses', label: 'Management expenses' },
  { value: 'franked_investment_income', label: 'Dividends received from other companies' },
]

type Rate = {
  financial_year: number
  main_rate: string
  small_profits_rate: string | null
  lower_limit: string | null
  upper_limit: string | null
  aia_limit: string
  main_pool_wda: string
  special_pool_wda: string
}

type Period = { id: string; name: string; start_date: string; end_date: string; status: string }
type Row = {
  id: string
  period_name: string
  start_date: string
  end_date: string
  status: 'draft' | 'final'
  associated_companies: number
  main_pool_bf: string
  special_pool_bf: string
  losses_bf: string
  claim_aia: boolean
  claim_full_expensing: boolean
  tax_due: string | null
}
type Adjustment = { id: string; kind: string; label: string; amount: string; note: string | null }

type WorkingLine = { label: string; amount: string; note?: string }
type Pool = {
  label: string
  broughtForward: string
  additions: string
  disposals: string
  beforeWda: string
  wdaRate: string
  wda: string
  balancingCharge: string
  smallPoolWriteOff: boolean
  carriedForward: string
}
type Computation = {
  start: string
  end: string
  days: number
  status: string
  profitPerAccounts: string
  turnover: string
  addBacks: WorkingLine[]
  totalAddBacks: string
  deductions: WorkingLine[]
  totalDeductions: string
  removedFromTrade: WorkingLine[]
  capitalAllowances: {
    aiaLimit: string
    aiaClaimed: string
    fullExpensing: string
    fyaSpecial: string
    mainPool: Pool
    specialPool: Pool
    fullExpensingBalancingCharge: string
    totalAllowances: string
    totalBalancingCharges: string
  }
  tradingProfit: string
  tradingLoss: string
  lossesBroughtForward: string
  lossesUsed: string
  netTradingProfit: string
  nonTradeIncome: string
  propertyIncome: string
  otherIncome: string
  chargeableGains: string
  profitsBeforeReliefs: string
  qualifyingDonations: string
  groupRelief: string
  taxableTotalProfits: string
  tax: {
    rows: {
      financialYear: number
      days: number
      profit: string
      rate: string
      tax: string
      marginalRelief: string
      lowerLimit: string | null
      upperLimit: string | null
      basis: string
    }[]
    totalTax: string
    totalMarginalRelief: string
    taxChargeable: string
    effectiveRate: string
  }
  lossesCarriedForward: string
  mainPoolCf: string
  specialPoolCf: string
  boxes: Record<string, string>
  warnings: string[]
}

const BOX_LABELS: [string, string][] = [
  ['145', 'Total turnover from trade'],
  ['155', 'Trading profits'],
  ['160', 'Trading losses brought forward set against trading profits'],
  ['165', 'Net trading profits'],
  ['170', 'Bank, building society or other interest, and non-trading loan relationships'],
  ['190', 'Income from a property business'],
  ['205', 'Income not falling under any other heading'],
  ['220', 'Net chargeable gains'],
  ['235', 'Profits before other deductions and reliefs'],
  ['245', 'Management expenses'],
  ['275', 'Total trading losses of this or a later accounting period'],
  ['295', 'Total of deductions and reliefs'],
  ['300', 'Profits before qualifying donations and group relief'],
  ['305', 'Qualifying donations'],
  ['310', 'Group relief'],
  ['315', 'Profits chargeable to Corporation Tax'],
  ['326', 'Number of associated companies in this period'],
  ['329', 'Small profit rate or marginal relief entitlement'],
  ['330', 'Financial year'],
  ['335', 'Amount of profit'],
  ['340', 'Rate of tax'],
  ['345', 'Tax'],
  ['380', 'Financial year (second)'],
  ['385', 'Amount of profit'],
  ['390', 'Rate of tax'],
  ['395', 'Tax'],
  ['430', 'Corporation Tax'],
  ['435', 'Marginal relief'],
  ['440', 'Corporation Tax chargeable'],
  ['475', 'Net Corporation Tax liability'],
  ['510', 'Tax chargeable'],
  ['525', 'Self-assessment of tax payable before restitution tax'],
  ['528', 'Self-assessment of tax payable'],
  ['620', 'Franked investment income / exempt ABGH distributions'],
  ['688', 'Full expensing'],
  ['690', 'Annual investment allowance'],
  ['693', 'Machinery and plant - special rate allowance'],
  ['695', 'Machinery and plant - special rate pool'],
  ['705', 'Machinery and plant - main pool'],
  ['780', 'Losses of trades carried on wholly or partly in the UK'],
]

export default function CorporationTaxScreen({
  environment,
  canRecord,
  canFinalise,
}: {
  environment: string
  canRecord: boolean
  canFinalise: boolean
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [periods, setPeriods] = useState<Period[]>([])
  const [rates, setRates] = useState<Rate[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [row, setRow] = useState<Row | null>(null)
  const [computation, setComputation] = useState<Computation | null>(null)
  const [adjustments, setAdjustments] = useState<Adjustment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showBoxes, setShowBoxes] = useState(false)
  const [newAdjustment, setNewAdjustment] = useState({ kind: 'add_back', label: '', amount: '', note: '' })

  const loadList = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/m/uk-bookkeeping/admin/corporation-tax', { signal })
    if (!response.ok) {
      setError('The tax computations could not be loaded.')
      return
    }
    const data = await response.json()
    if (signal?.aborted) return
    setRows(data.computations)
    setPeriods(data.periods)
    setRates(data.rates)
    setSelected((current) => current ?? data.computations[0]?.id ?? null)
  }, [])

  const loadOne = useCallback(async (id: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/m/uk-bookkeeping/admin/corporation-tax/${id}`, { signal })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      setError(payload.error ?? 'That computation could not be worked out.')
      return
    }
    const data = await response.json()
    if (signal?.aborted) return
    setError(null)
    setRow(data.row)
    setComputation(data.computation)
    setAdjustments(data.adjustments)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState is after an await
    loadList(controller.signal).catch(() => setError('The tax computations could not be loaded.'))
    return () => controller.abort()
  }, [loadList])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- every setState is after an await
    loadOne(selected, controller.signal).catch(() => undefined)
    return () => controller.abort()
  }, [selected, loadOne])

  const send = async (url: string, method: string, body?: unknown) => {
    setBusy(true)
    try {
      const response = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'That did not work.')
        return false
      }
      setError(null)
      await loadList()
      if (selected) await loadOne(selected)
      return true
    } finally {
      setBusy(false)
    }
  }

  const unstarted = periods.filter((period) => !rows.some((r) => r.period_name === period.name))

  return (
    <div>
      <BookkeepingNav active="corporation-tax" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      <div style={{ ...card, padding: '1.25rem' }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
          This works out what the company owes and gives you every figure the company tax return
          asks for, with the box numbers next to them. It does <strong>not</strong> send anything to
          HMRC: there is no way for a small company to file its corporation tax return straight from
          software like this, so the last step is copying these figures into HMRC’s own online
          service, or handing this page to whoever does that for you.
        </p>
      </div>

      {canRecord && unstarted.length > 0 && (
        <div style={{ ...card, padding: '0.875rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-sm)' }}>Start a computation for</span>
          {unstarted.map((period) => (
            <button
              key={period.id}
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() =>
                send('/api/m/uk-bookkeeping/admin/corporation-tax', 'POST', { accountingPeriodId: period.id })
              }
            >
              {period.name}
            </button>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No tax computations yet.">
          <p style={{ margin: 0 }}>
            Add a financial year on the year end page first. A computation is drawn up for one of
            those.
          </p>
        </EmptyState>
      ) : (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          {rows.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelected(item.id)}
              style={{
                padding: '0.375rem 0.75rem',
                borderRadius: 999,
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 'var(--text-sm)',
                border: '1px solid var(--color-border)',
                background: selected === item.id ? 'var(--color-text)' : 'var(--color-surface)',
                color: selected === item.id ? 'var(--color-bg)' : 'var(--color-text)',
              }}
            >
              {formatDay(item.start_date)} to {formatDay(item.end_date)}
              {item.status === 'final' ? ' · finished' : ''}
            </button>
          ))}
        </div>
      )}

      {row && computation && (
        <>
          {computation.warnings.length > 0 && (
            <div
              role="status"
              style={{
                ...card,
                padding: '0.75rem 1rem',
                background: 'var(--color-warning-bg, var(--color-surface))',
                borderColor: 'var(--color-warning, var(--color-border))',
                fontSize: 'var(--text-sm)',
              }}
            >
              <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                {computation.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ ...card, padding: '1.25rem', display: 'flex', gap: '2.5rem', flexWrap: 'wrap' }}>
            <div>
              <div style={muted}>Corporation tax due</div>
              <div style={{ fontSize: '2rem', fontWeight: 600 }}>
                <Money value={computation.tax.taxChargeable} />
              </div>
              <div style={muted}>
                {computation.tax.effectiveRate}% of the taxable profit, over {computation.days} days
              </div>
            </div>
            <div>
              <div style={muted}>Profit in the accounts</div>
              <div style={{ fontSize: '1.25rem' }}><Money value={computation.profitPerAccounts} /></div>
            </div>
            <div>
              <div style={muted}>Taxable profit</div>
              <div style={{ fontSize: '1.25rem' }}><Money value={computation.taxableTotalProfits} /></div>
            </div>
            <div>
              <div style={muted}>Losses to carry forward</div>
              <div style={{ fontSize: '1.25rem' }}><Money value={computation.lossesCarriedForward} /></div>
            </div>
          </div>

          <Workings computation={computation} />
          <CapitalAllowancesTable computation={computation} />
          <RateTable computation={computation} associated={row.associated_companies} />

          <Settings row={row} canRecord={canRecord} busy={busy} onSave={(patch) => send(`/api/m/uk-bookkeeping/admin/corporation-tax/${row.id}`, 'PATCH', patch)} />

          <Adjustments
            adjustments={adjustments}
            canRecord={canRecord && row.status === 'draft'}
            busy={busy}
            draft={newAdjustment}
            setDraft={setNewAdjustment}
            onAdd={async () => {
              if (await send(`/api/m/uk-bookkeeping/admin/corporation-tax/${row.id}/adjustments`, 'POST', newAdjustment)) {
                setNewAdjustment({ kind: 'add_back', label: '', amount: '', note: '' })
              }
            }}
            onRemove={(id) =>
              send(`/api/m/uk-bookkeeping/admin/corporation-tax/${row.id}/adjustments/${id}`, 'DELETE')
            }
          />

          <div style={{ ...card, padding: 0 }}>
            <button
              type="button"
              onClick={() => setShowBoxes((open) => !open)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '0.875rem 1.25rem',
                background: 'none',
                border: 'none',
                font: 'inherit',
                fontWeight: 600,
                color: 'var(--color-text)',
                cursor: 'pointer',
              }}
              aria-expanded={showBoxes}
            >
              {showBoxes ? '▾' : '▸'} The boxes to copy onto the return
            </button>
            {showBoxes && (
              <div style={{ padding: '0 1.25rem 1.25rem', overflowX: 'auto' }}>
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={th}>Box</th>
                      <th style={th}>What it is called on the form</th>
                      <th style={thRight}>Figure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BOX_LABELS.filter(([number]) => computation.boxes[number] !== undefined).map(
                      ([number, label]) => (
                        <tr key={number}>
                          <td style={{ ...td, fontVariantNumeric: 'tabular-nums' }}>{number}</td>
                          <td style={td}>{label}</td>
                          <td style={tdRight}>{computation.boxes[number]}</td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
                <p style={{ ...muted, margin: '0.75rem 0 0' }}>
                  Box numbers are from the current company tax return form. Profits are in whole
                  pounds, rounded down; the tax carries its pence.
                </p>
              </div>
            )}
          </div>

          <RatesInForce rates={rates} />

          {canFinalise && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {row.status === 'draft' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => send(`/api/m/uk-bookkeeping/admin/corporation-tax/${row.id}/finalise`, 'POST')}
                >
                  Mark it finished
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => send(`/api/m/uk-bookkeeping/admin/corporation-tax/${row.id}/finalise`, 'DELETE')}
                >
                  Put it back to a draft
                </button>
              )}
              <span style={{ ...muted, alignSelf: 'center' }}>
                {row.status === 'final'
                  ? 'The workings above are frozen as they were when you finished it.'
                  : 'Finishing it freezes these workings so they still read the same next year.'}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Workings({ computation }: { computation: Computation }) {
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={table}>
        <tbody>
          <Line label="Profit in the accounts, before tax" amount={computation.profitPerAccounts} bold />
          {computation.addBacks.length > 0 && <Heading label="Added back - costs the taxman does not allow" />}
          {computation.addBacks.map((line) => (
            <Line key={line.label} label={line.label} amount={line.amount} note={line.note} indent />
          ))}
          {computation.deductions.length > 0 && <Heading label="Taken off" />}
          {computation.deductions.map((line) => (
            <Line key={line.label} label={line.label} amount={`-${line.amount}`} note={line.note} indent />
          ))}
          {computation.removedFromTrade.length > 0 && (
            <Heading label="Taken out of the trade, taxed on their own line" />
          )}
          {computation.removedFromTrade.map((line) => (
            <Line key={line.label} label={line.label} amount={`-${line.amount}`} note={line.note} indent />
          ))}
          <Line
            label="Capital allowances instead of depreciation"
            amount={`-${computation.capitalAllowances.totalAllowances}`}
            indent
          />
          {computation.capitalAllowances.totalBalancingCharges !== '0.00' && (
            <Line
              label="Balancing charges on things sold"
              amount={computation.capitalAllowances.totalBalancingCharges}
              indent
            />
          )}
          <Line label="Trading profit" amount={computation.tradingProfit} bold rule />
          {computation.lossesUsed !== '0.00' && (
            <Line label="Losses brought forward, used" amount={`-${computation.lossesUsed}`} indent />
          )}
          {computation.nonTradeIncome !== '0.00' && (
            <Line label="Interest and other non-trading income" amount={computation.nonTradeIncome} indent />
          )}
          {computation.propertyIncome !== '0.00' && (
            <Line label="Income from property" amount={computation.propertyIncome} indent />
          )}
          {computation.otherIncome !== '0.00' && (
            <Line label="Other income" amount={computation.otherIncome} indent />
          )}
          {computation.chargeableGains !== '0.00' && (
            <Line label="Gains on selling assets" amount={computation.chargeableGains} indent />
          )}
          {computation.qualifyingDonations !== '0.00' && (
            <Line label="Charitable donations" amount={`-${computation.qualifyingDonations}`} indent />
          )}
          {computation.groupRelief !== '0.00' && (
            <Line label="Group relief" amount={`-${computation.groupRelief}`} indent />
          )}
          <Line label="Profit the tax is worked out on" amount={computation.taxableTotalProfits} bold rule />
          <Line label="Corporation tax" amount={computation.tax.totalTax} indent />
          {computation.tax.totalMarginalRelief !== '0.00' && (
            <Line label="Less marginal relief" amount={`-${computation.tax.totalMarginalRelief}`} indent />
          )}
          <Line label="Corporation tax due" amount={computation.tax.taxChargeable} bold rule emphasis />
        </tbody>
      </table>
    </div>
  )
}

function Heading({ label }: { label: string }) {
  return (
    <tr>
      <td colSpan={2} style={{ ...td, paddingTop: '1rem', fontWeight: 600 }}>
        {label}
      </td>
    </tr>
  )
}

function Line({
  label,
  amount,
  note,
  indent = false,
  bold = false,
  rule = false,
  emphasis = false,
}: {
  label: string
  amount: string
  note?: string
  indent?: boolean
  bold?: boolean
  rule?: boolean
  emphasis?: boolean
}) {
  return (
    <tr style={rule ? { borderTop: `${emphasis ? 2 : 1}px solid var(--color-border)` } : undefined}>
      <td style={{ ...td, paddingLeft: indent ? '1.5rem' : undefined, fontWeight: bold ? 600 : undefined }}>
        {label}
        {note && <span style={{ ...muted, marginLeft: '0.5rem' }}>{note}</span>}
      </td>
      <td style={tdRight}>
        <Money value={amount} bold={bold} />
      </td>
    </tr>
  )
}

function CapitalAllowancesTable({ computation }: { computation: Computation }) {
  const ca = computation.capitalAllowances
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Capital allowances</th>
            <th style={thRight}>Main pool</th>
            <th style={thRight}>Special rate pool</th>
          </tr>
        </thead>
        <tbody>
          <PoolRow label="Brought forward" main={ca.mainPool.broughtForward} special={ca.specialPool.broughtForward} />
          <PoolRow label="Bought this period" main={ca.mainPool.additions} special={ca.specialPool.additions} />
          <PoolRow label="Sold this period" main={`-${ca.mainPool.disposals}`} special={`-${ca.specialPool.disposals}`} />
          <PoolRow
            label={`Written down (${ca.mainPool.wdaRate}% / ${ca.specialPool.wdaRate}%)`}
            main={`-${ca.mainPool.wda}`}
            special={`-${ca.specialPool.wda}`}
          />
          <PoolRow label="Carried forward" main={ca.mainPool.carriedForward} special={ca.specialPool.carriedForward} bold />
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--color-border)' }}>
            <td style={{ ...td, borderBottom: 'none' }} colSpan={3}>
              <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                <span>
                  Annual investment allowance <strong><Money value={ca.aiaClaimed} /></strong>{' '}
                  <span style={muted}>of a <Money value={ca.aiaLimit} /> cap</span>
                </span>
                {ca.fullExpensing !== '0.00' && (
                  <span>Full expensing <strong><Money value={ca.fullExpensing} /></strong></span>
                )}
                {ca.fyaSpecial !== '0.00' && (
                  <span>50% first year <strong><Money value={ca.fyaSpecial} /></strong></span>
                )}
                <span>
                  Total claimed <strong><Money value={ca.totalAllowances} /></strong>
                </span>
              </div>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function PoolRow({
  label,
  main,
  special,
  bold = false,
}: {
  label: string
  main: string
  special: string
  bold?: boolean
}) {
  return (
    <tr>
      <td style={{ ...td, fontWeight: bold ? 600 : undefined }}>{label}</td>
      <td style={tdRight}><Money value={main} bold={bold} /></td>
      <td style={tdRight}><Money value={special} bold={bold} /></td>
    </tr>
  )
}

function RateTable({ computation, associated }: { computation: Computation; associated: number }) {
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Financial year</th>
            <th style={thRight}>Days</th>
            <th style={thRight}>Profit</th>
            <th style={thRight}>Rate</th>
            <th style={thRight}>Tax</th>
            <th style={thRight}>Marginal relief</th>
            <th style={th}>Why that rate</th>
          </tr>
        </thead>
        <tbody>
          {computation.tax.rows.map((rate) => (
            <tr key={rate.financialYear}>
              <td style={td}>
                1 April {rate.financialYear} to 31 March {rate.financialYear + 1}
              </td>
              <td style={tdRight}>{rate.days}</td>
              <td style={tdRight}><Money value={rate.profit} /></td>
              <td style={tdRight}>{rate.rate}%</td>
              <td style={tdRight}><Money value={rate.tax} /></td>
              <td style={tdRight}><Money value={rate.marginalRelief} /></td>
              <td style={{ ...td, ...muted }}>
                {rate.basis === 'single' && 'One rate for everybody that year.'}
                {rate.basis === 'small' && `Profit is under the ${rate.lowerLimit} threshold.`}
                {rate.basis === 'main' && `Profit is over the ${rate.upperLimit} threshold.`}
                {rate.basis === 'marginal' &&
                  `Between ${rate.lowerLimit} and ${rate.upperLimit}, so the main rate less marginal relief.`}
              </td>
            </tr>
          ))}
        </tbody>
        {associated > 0 && (
          <tfoot>
            <tr>
              <td colSpan={7} style={{ ...td, ...muted, borderBottom: 'none' }}>
                The thresholds shown are already divided between this company and its {associated}{' '}
                associated {associated === 1 ? 'company' : 'companies'}.
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

function Settings({
  row,
  canRecord,
  busy,
  onSave,
}: {
  row: Row
  canRecord: boolean
  busy: boolean
  onSave: (patch: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState({
    associatedCompanies: String(row.associated_companies),
    mainPoolBf: row.main_pool_bf,
    specialPoolBf: row.special_pool_bf,
    lossesBf: row.losses_bf,
    claimAia: row.claim_aia,
    claimFullExpensing: row.claim_full_expensing,
  })
  const disabled = !canRecord || row.status === 'final'

  return (
    <div style={{ ...card, padding: '1.25rem' }}>
      <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Things only you know</h3>
      <p style={{ ...muted, margin: '0 0 0.875rem', maxWidth: 640 }}>
        Associated companies matter more than they look. If the same people control another company
        - even a dormant one - the £50,000 and £250,000 thresholds are shared between them, so tax
        starts biting a good deal sooner. The pool and loss figures carry over from last year on
        their own once you have done one of these.
      </p>
      <div style={{ display: 'grid', gap: '0.75rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div>
          <label htmlFor="bk-ct-assoc" style={{ display: 'block', ...muted }}>
            Associated companies
          </label>
          <input
            id="bk-ct-assoc"
            inputMode="numeric"
            disabled={disabled}
            style={{ ...input, width: '100%' }}
            value={draft.associatedCompanies}
            onChange={(event) => setDraft({ ...draft, associatedCompanies: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="bk-ct-main" style={{ display: 'block', ...muted }}>
            Main pool brought forward
          </label>
          <input
            id="bk-ct-main"
            inputMode="decimal"
            disabled={disabled}
            style={{ ...input, width: '100%' }}
            value={draft.mainPoolBf}
            onChange={(event) => setDraft({ ...draft, mainPoolBf: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="bk-ct-special" style={{ display: 'block', ...muted }}>
            Special rate pool brought forward
          </label>
          <input
            id="bk-ct-special"
            inputMode="decimal"
            disabled={disabled}
            style={{ ...input, width: '100%' }}
            value={draft.specialPoolBf}
            onChange={(event) => setDraft({ ...draft, specialPoolBf: event.target.value })}
          />
        </div>
        <div>
          <label htmlFor="bk-ct-losses" style={{ display: 'block', ...muted }}>
            Losses brought forward
          </label>
          <input
            id="bk-ct-losses"
            inputMode="decimal"
            disabled={disabled}
            style={{ ...input, width: '100%' }}
            value={draft.lossesBf}
            onChange={(event) => setDraft({ ...draft, lossesBf: event.target.value })}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', margin: '0.875rem 0' }}>
        <label style={{ fontSize: 'var(--text-sm)' }}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={draft.claimAia}
            onChange={(event) => setDraft({ ...draft, claimAia: event.target.checked })}
          />{' '}
          Claim the annual investment allowance
        </label>
        <label style={{ fontSize: 'var(--text-sm)' }}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={draft.claimFullExpensing}
            onChange={(event) => setDraft({ ...draft, claimFullExpensing: event.target.checked })}
          />{' '}
          Claim full expensing
        </label>
      </div>
      {!disabled && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy}
          onClick={() =>
            onSave({
              associatedCompanies: Number.parseInt(draft.associatedCompanies, 10) || 0,
              mainPoolBf: draft.mainPoolBf,
              specialPoolBf: draft.specialPoolBf,
              lossesBf: draft.lossesBf,
              claimAia: draft.claimAia,
              claimFullExpensing: draft.claimFullExpensing,
            })
          }
        >
          Save and work it out again
        </button>
      )}
    </div>
  )
}

function Adjustments({
  adjustments,
  canRecord,
  busy,
  draft,
  setDraft,
  onAdd,
  onRemove,
}: {
  adjustments: Adjustment[]
  canRecord: boolean
  busy: boolean
  draft: { kind: string; label: string; amount: string; note: string }
  setDraft: (draft: { kind: string; label: string; amount: string; note: string }) => void
  onAdd: () => void
  onRemove: (id: string) => void
}) {
  return (
    <div style={{ ...card, padding: '1.25rem' }}>
      <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Adjustments</h3>
      <p style={{ ...muted, margin: '0 0 0.875rem', maxWidth: 640 }}>
        Depreciation and client entertaining are added back on their own, from what the accounts
        already say. This is for everything else: a fine, a bit of a cost that was really personal,
        a relief nobody could work out from the books. Each one wants a reason, because an
        unexplained figure is exactly what an enquiry asks about.
      </p>

      {adjustments.length > 0 && (
        <table style={{ ...table, marginBottom: '1rem' }}>
          <tbody>
            {adjustments.map((adjustment) => (
              <tr key={adjustment.id}>
                <td style={td}>
                  {adjustment.label}
                  <span style={{ display: 'block', ...muted }}>
                    {ADJUSTMENT_KINDS.find((kind) => kind.value === adjustment.kind)?.label ?? adjustment.kind}
                    {adjustment.note ? ` · ${adjustment.note}` : ''}
                  </span>
                </td>
                <td style={tdRight}><Money value={adjustment.amount} /></td>
                <td style={{ ...td, width: 1 }}>
                  {canRecord && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onRemove(adjustment.id)}>
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canRecord && (
        <div style={{ display: 'grid', gap: '0.5rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="bk-ct-kind" style={{ display: 'block', ...muted }}>
              What sort
            </label>
            <select
              id="bk-ct-kind"
              style={{ ...input, width: '100%' }}
              value={draft.kind}
              onChange={(event) => setDraft({ ...draft, kind: event.target.value })}
            >
              {ADJUSTMENT_KINDS.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bk-ct-label" style={{ display: 'block', ...muted }}>
              Call it
            </label>
            <input
              id="bk-ct-label"
              style={{ ...input, width: '100%' }}
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="bk-ct-amount" style={{ display: 'block', ...muted }}>
              How much
            </label>
            <input
              id="bk-ct-amount"
              inputMode="decimal"
              style={{ ...input, width: '100%' }}
              value={draft.amount}
              onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor="bk-ct-note" style={{ display: 'block', ...muted }}>
              Why
            </label>
            <input
              id="bk-ct-note"
              style={{ ...input, width: '100%' }}
              value={draft.note}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
          </div>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !draft.label.trim() || !draft.amount}
            onClick={onAdd}
          >
            Add it
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * What the rates and thresholds actually are, so the bill above is explicable.
 *
 * Most small company owners could not tell you this year's thresholds, and the
 * thresholds are most of the explanation for the figure. Read only: they are
 * seeded from HMRC's published rates and a change to them belongs in an update
 * rather than in a text box on a screen.
 */
function RatesInForce({ rates }: { rates: Rate[] }) {
  if (rates.length === 0) return null
  return (
    <details style={{ ...card, padding: '0.875rem 1.25rem' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--text-sm)' }}>
        The rates and thresholds these figures use
      </summary>
      <div style={{ overflowX: 'auto', marginTop: '0.75rem' }}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Year to 31 March</th>
              <th style={thRight}>Small profits</th>
              <th style={thRight}>Main rate</th>
              <th style={thRight}>Lower threshold</th>
              <th style={thRight}>Upper threshold</th>
              <th style={thRight}>Investment allowance</th>
              <th style={thRight}>Main pool</th>
              <th style={thRight}>Special pool</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <tr key={rate.financial_year}>
                <td style={td}>{rate.financial_year + 1}</td>
                <td style={tdRight}>{rate.small_profits_rate ? `${rate.small_profits_rate}%` : '—'}</td>
                <td style={tdRight}>{rate.main_rate}%</td>
                <td style={tdRight}>{rate.lower_limit ? <Money value={rate.lower_limit} /> : '—'}</td>
                <td style={tdRight}>{rate.upper_limit ? <Money value={rate.upper_limit} /> : '—'}</td>
                <td style={tdRight}><Money value={rate.aia_limit} /></td>
                <td style={tdRight}>{rate.main_pool_wda}%</td>
                <td style={tdRight}>{rate.special_pool_wda}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ ...muted, margin: '0.75rem 0 0' }}>
        Thresholds are for a full twelve months and one company. A shorter period gets a share of
        them, and so does each associated company.
      </p>
    </details>
  )
}
