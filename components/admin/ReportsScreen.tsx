'use client'

import { useCallback, useEffect, useState } from 'react'
import { BookkeepingNav, EmptyState, ErrorNotice, SandboxBanner } from './Notices'
import {
  DateField,
  Money,
  SectionHeadingRow,
  SubTabs,
  SubtotalRow,
  card,
  formatDay,
  input,
  localToday,
  muted,
  startOfYear,
  table,
  td,
  tdRight,
  th,
  thRight,
} from './ui'

// The reports screen.
//
// Six of them behind one strip of tabs, rather than six sidebar links: they are
// all the same question asked six ways, and an owner comparing a profit figure
// against a balance sheet should not lose their date range walking between
// pages. The range lives up here and every tab reads it.
//
// Every figure arrives as a two-place decimal STRING and stays one. Nothing on
// this screen ever turns a money value into a JavaScript number.

type Line = { accountId: string; code: string; name: string; amount: string; priorAmount: string | null }
type Section = { key: string; label: string; sign: 1 | -1; lines: Line[]; total: string; priorTotal: string | null }
type Subtotal = { key: string; label: string; amount: string; priorAmount: string | null; emphasis?: boolean }

type Pl = {
  from: string
  to: string
  priorFrom: string | null
  priorTo: string | null
  sections: Section[]
  subtotals: Subtotal[]
  profit: string
  businessType: string
}

type Bs = {
  asAt: string
  priorAsAt: string | null
  sections: Section[]
  subtotals: Subtotal[]
  netAssets: string
  totalEquity: string
  balanced: boolean
  difference: string
}

type MonthlyRow = { month: string; income: string; expenses: string; profit: string; vat: string; entries: number }

type Report = {
  from: string
  to: string
  summary: { categoryId: string; name: string; net: string; vat: string; entries: number }[]
  monthly: MonthlyRow[]
  profitAndLoss: Pl
  balanceSheet: Bs
  taxGrouping: { key: string; label: string; net: string }[]
  records: {
    recordsFingerprint: string | null
    chain: { rows: number; intact: boolean; brokenAtIndex: number | null }
    counts: Record<string, number>
  }
}

type TrialBalancePayload = {
  trialBalance: {
    asAt: string | null
    rows: { accountId: string; code: string; name: string; kind: string; debit: string; credit: string }[]
    totalDebits: string
    totalCredits: string
    balanced: boolean
    difference: string
  }
  health: {
    healthy: boolean
    missingAccounts: string[]
    unmappedCategories: { id: string; code: string; name: string; entries: number }[]
    duplicateMappings: { code: string; name: string; accounts: number }[]
    suspenseBalance: string
    strandedSettlements: { entries: number; balance: string } | null
    balanced: boolean
    difference: string
  }
}

type Nominal = {
  accountId: string
  code: string
  name: string
  broughtForward: string
  entries: {
    date: string
    sourceKind: string
    sourceId: string
    counterparty: string
    description: string
    reference: string | null
    debit: string
    credit: string
    balance: string
  }[]
  totalDebits: string
  totalCredits: string
  closing: string
}

type Aged = {
  asAt: string
  rows: {
    counterparty: string
    current: string
    days30: string
    days60: string
    days90: string
    older: string
    total: string
    oldest: string | null
  }[]
  totals: { current: string; days30: string; days60: string; days90: string; older: string; total: string }
}

type Tab = 'pl' | 'bs' | 'tb' | 'nominal' | 'aged' | 'export'

const TABS: { key: Tab; label: string }[] = [
  { key: 'pl', label: 'Profit and loss' },
  { key: 'bs', label: 'Balance sheet' },
  { key: 'tb', label: 'Trial balance' },
  { key: 'nominal', label: 'Account history' },
  { key: 'aged', label: 'Who owes what' },
  { key: 'export', label: 'Take a copy' },
]

const EXPORTS = [
  ['transactions', 'Entries'],
  ['lines', 'Entry lines'],
  ['attachments', 'Evidence list'],
  ['periods', 'VAT periods'],
  ['snapshots', 'Filed figures (frozen)'],
  ['snapshot-lines', 'Filed workings'],
  ['hmrc-calls', 'HMRC call log'],
  ['audit', 'History log'],
]

export default function ReportsScreen({ environment }: { environment: string }) {
  const [tab, setTab] = useState<Tab>('pl')
  const [range, setRange] = useState({ from: startOfYear(), to: localToday() })
  const [report, setReport] = useState<Report | null>(null)
  const [tb, setTb] = useState<TrialBalancePayload | null>(null)
  const [nominal, setNominal] = useState<Nominal | null>(null)
  const [accountId, setAccountId] = useState('')
  const [aged, setAged] = useState<{ owedToUs: Aged; weOwe: Aged } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const get = useCallback(async (url: string, signal?: AbortSignal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error ?? 'That report could not be worked out.')
    }
    return response.json()
  }, [])

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const query = new URLSearchParams(range)
        const [main, balances, ageing] = await Promise.all([
          get(`/api/m/uk-bookkeeping/admin/reports?${query.toString()}`, signal),
          get(`/api/m/uk-bookkeeping/admin/reports/trial-balance?asAt=${range.to}`, signal),
          get(`/api/m/uk-bookkeeping/admin/reports/aged?asAt=${range.to}`, signal),
        ])
        if (signal.aborted) return
        setError(null)
        setReport(main)
        setTb(balances)
        setAged(ageing)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'The reports could not be loaded.')
      }
    },
    [get, range],
  )

  useEffect(() => {
    // Abort the stale request when the range changes, so a slow answer cannot
    // land after a fast one and show figures for dates the inputs no longer say.
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (!accountId) return
    const controller = new AbortController()
    const query = new URLSearchParams({ accountId, from: range.from, to: range.to })
    get(`/api/m/uk-bookkeeping/admin/reports/nominal?${query.toString()}`, controller.signal)
      .then((data) => setNominal(data))
      .catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : 'That account could not be read.')
      })
    return () => controller.abort()
  }, [accountId, get, range])

  const openAccount = (id: string) => {
    setAccountId(id)
    setTab('nominal')
  }

  return (
    <div>
      <BookkeepingNav active="reports" />
      <SandboxBanner environment={environment} />
      <ErrorNotice message={error} />

      {tb && !tb.health.healthy && <LedgerHealthNotice health={tb.health} />}

      <div style={{ ...card, padding: '0.875rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <DateField id="bk-r-from" label="From" value={range.from} onChange={(from) => setRange({ ...range, from })} />
        <DateField id="bk-r-to" label="To" value={range.to} onChange={(to) => setRange({ ...range, to })} />
        <p style={{ ...muted, margin: 0, maxWidth: 380 }}>
          The profit and loss account covers the range. The balance sheet, trial balance and who
          owes what are all as at the end of it.
        </p>
      </div>

      <SubTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'pl' && report && <ProfitAndLoss pl={report.profitAndLoss} monthly={report.monthly} taxGrouping={report.taxGrouping} onOpen={openAccount} />}
      {tab === 'bs' && report && <BalanceSheet bs={report.balanceSheet} onOpen={openAccount} />}
      {tab === 'tb' && tb && <TrialBalance payload={tb} onOpen={openAccount} />}
      {tab === 'nominal' && (
        <NominalLedger
          nominal={nominal}
          accounts={tb?.trialBalance.rows ?? []}
          accountId={accountId}
          onSelect={setAccountId}
        />
      )}
      {tab === 'aged' && aged && <AgedTables aged={aged} />}
      {tab === 'export' && <Exports records={report?.records} />}
    </div>
  )
}

// ---------------------------------------------------------------------------

function LedgerHealthNotice({ health }: { health: TrialBalancePayload['health'] }) {
  // Stranded settlements are a filing mistake, not an arithmetic one: the books
  // add up perfectly, the money is just sitting in an account the owner does not
  // keep. Telling somebody their reports do not add up when they do is how a
  // warning gets ignored, so it gets its own heading when it is the only thing
  // wrong.
  const onlyStranded =
    health.strandedSettlements !== null &&
    health.balanced &&
    health.suspenseBalance === '0.00' &&
    health.unmappedCategories.length === 0 &&
    health.duplicateMappings.length === 0 &&
    health.missingAccounts.length === 0

  return (
    <div
      role="alert"
      style={{
        ...card,
        padding: '0.75rem 1rem',
        background: 'var(--color-warning-bg, var(--color-surface))',
        borderColor: 'var(--color-warning, var(--color-border))',
        fontSize: 'var(--text-sm)',
        lineHeight: 1.5,
      }}
    >
      <strong>
        {onlyStranded
          ? 'One thing on these reports wants a look.'
          : 'These reports do not quite add up.'}
      </strong>
      <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
        {!health.balanced && (
          <li>
            The books are out by <Money value={health.difference} />. Something has been changed in
            the database directly.
          </li>
        )}
        {health.suspenseBalance !== '0.00' && (
          <li>
            <Money value={health.suspenseBalance} /> is sitting in suspense, which means some
            entries had nowhere else to go.
          </li>
        )}
        {health.strandedSettlements && (
          <li>
            {health.strandedSettlements.entries}{' '}
            {health.strandedSettlements.entries === 1 ? 'entry does' : 'entries do'} not say which
            account the money moved through, so{' '}
            <Money value={health.strandedSettlements.balance} /> is sitting on the main current
            account rather than on one of yours. Open each one and fill in the account it was paid
            from or into.
          </li>
        )}
        {health.unmappedCategories.map((category) => (
          <li key={category.id}>
            Nothing on the books says where “{category.name}” belongs, so its {category.entries}{' '}
            {category.entries === 1 ? 'entry has' : 'entries have'} gone to suspense.
          </li>
        ))}
        {health.duplicateMappings.map((duplicate) => (
          <li key={duplicate.code}>
            “{duplicate.name}” points at {duplicate.accounts} accounts. Only one of them will be used.
          </li>
        ))}
        {health.missingAccounts.length > 0 && (
          <li>
            Accounts the reports need are missing: {health.missingAccounts.join(', ')}. Redeploy the
            site to put them back.
          </li>
        )}
      </ul>
    </div>
  )
}

function StatementTable({
  sections,
  subtotals,
  showPrior,
  priorLabel,
  currentLabel,
  onOpen,
}: {
  sections: Section[]
  subtotals: Subtotal[]
  showPrior: boolean
  priorLabel: string
  currentLabel: string
  onOpen: (accountId: string) => void
}) {
  const columns = showPrior ? 3 : 2
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>{' '}</th>
            <th style={thRight}>{currentLabel}</th>
            {showPrior && <th style={thRight}>{priorLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            <SectionRows key={section.key} section={section} columns={columns} showPrior={showPrior} onOpen={onOpen} subtotals={subtotals} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A section's lines, its total, and any subtotal that belongs directly after
 * it.
 *
 * The subtotal placement is data rather than layout: SUBTOTAL_AFTER says which
 * section each running total follows, so adding a section to the report does
 * not mean rearranging this component.
 */
const SUBTOTAL_AFTER: Record<string, string> = {
  'cost-of-sales': 'gross-profit',
  depreciation: 'operating-profit',
  'finance-costs': 'profit-before-tax',
  tax: 'profit-after-tax',
  fixed_assets: 'fixed-assets',
  current_assets_cash: 'current-assets',
  creditors_short: 'total-less-current',
  provisions: 'net-assets',
  reserves: 'equity',
}

function SectionRows({
  section,
  columns,
  showPrior,
  onOpen,
  subtotals,
}: {
  section: Section
  columns: number
  showPrior: boolean
  onOpen: (accountId: string) => void
  subtotals: Subtotal[]
}) {
  const followingKey = SUBTOTAL_AFTER[section.key]
  const following = followingKey ? subtotals.find((subtotal) => subtotal.key === followingKey) : undefined
  return (
    <>
      <SectionHeadingRow label={section.label} columns={columns} />
      {section.lines.map((line) => (
        <tr key={line.accountId}>
          <td style={{ ...td, paddingLeft: '1.5rem' }}>
            {line.accountId === 'profit-for-period' ? (
              line.name
            ) : (
              <button
                type="button"
                onClick={() => onOpen(line.accountId)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  font: 'inherit',
                  color: 'var(--color-text)',
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                  cursor: 'pointer',
                }}
                title="See everything that went here"
              >
                {line.name}
              </button>
            )}
          </td>
          <td style={tdRight}>
            <Money value={line.amount} />
          </td>
          {showPrior && (
            <td style={tdRight}>
              <Money value={line.priorAmount} />
            </td>
          )}
        </tr>
      ))}
      <tr>
        <td style={{ ...td, paddingLeft: '1.5rem', fontWeight: 600 }}>Total {section.label.toLowerCase()}</td>
        <td style={tdRight}>
          <Money value={section.total} bold />
        </td>
        {showPrior && (
          <td style={tdRight}>
            <Money value={section.priorTotal} />
          </td>
        )}
      </tr>
      {following && (
        <SubtotalRow
          label={following.label}
          amount={following.amount}
          priorAmount={following.priorAmount}
          emphasis={following.emphasis}
          columns={columns}
        />
      )}
    </>
  )
}

function ProfitAndLoss({
  pl,
  monthly,
  taxGrouping,
  onOpen,
}: {
  pl: Pl
  monthly: MonthlyRow[]
  taxGrouping: { key: string; label: string; net: string }[]
  onOpen: (accountId: string) => void
}) {
  if (pl.sections.length === 0) {
    return (
      <EmptyState title="Nothing in that range.">
        <p style={{ margin: 0 }}>Try a wider set of dates, or record something first.</p>
      </EmptyState>
    )
  }
  return (
    <>
      <StatementTable
        sections={pl.sections}
        subtotals={pl.subtotals}
        showPrior={pl.priorFrom !== null}
        currentLabel={`${formatDay(pl.from)} to ${formatDay(pl.to)}`}
        priorLabel={pl.priorFrom ? `${formatDay(pl.priorFrom)} to ${formatDay(pl.priorTo)}` : ''}
        onOpen={onOpen}
      />

      {monthly.length > 1 && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Month by month</th>
                <th style={thRight}>In</th>
                <th style={thRight}>Out</th>
                <th style={thRight}>Profit</th>
                <th style={thRight}>VAT position</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((row) => (
                <tr key={row.month}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {new Date(`${row.month}T00:00:00.000Z`).toLocaleDateString('en-GB', {
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </td>
                  <td style={tdRight}><Money value={row.income} /></td>
                  <td style={tdRight}><Money value={row.expenses} /></td>
                  <td style={tdRight}><Money value={row.profit} negativeIsBad /></td>
                  <td style={tdRight}><Money value={row.vat} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pl.businessType === 'sole_trader' && taxGrouping.length > 0 && (
        <div style={{ ...card, padding: '1.25rem', maxWidth: 640 }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>
            Grouped the way the self-assessment form asks for it
          </h3>
          <p style={{ ...muted, margin: '0 0 0.75rem' }}>
            A starting point for whoever prepares the return, not the return itself.
          </p>
          <table style={table}>
            <tbody>
              {taxGrouping.map((group) => (
                <tr key={group.key}>
                  <td style={td}>{group.label}</td>
                  <td style={tdRight}><Money value={group.net} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function BalanceSheet({ bs, onOpen }: { bs: Bs; onOpen: (accountId: string) => void }) {
  if (bs.sections.length === 0) {
    return (
      <EmptyState title="Nothing to show yet.">
        <p style={{ margin: 0 }}>A balance sheet needs something on the books first.</p>
      </EmptyState>
    )
  }
  return (
    <>
      {!bs.balanced && (
        <div
          role="alert"
          style={{
            ...card,
            padding: '0.75rem 1rem',
            background: 'var(--color-danger-bg, var(--color-surface))',
            borderColor: 'var(--color-danger, var(--color-border))',
            fontSize: 'var(--text-sm)',
          }}
        >
          <strong>This balance sheet does not balance.</strong> It is out by{' '}
          <Money value={bs.difference} />. Both sides come from the same entries, so this means
          something has been changed in the database directly. Do not file anything from it.
        </div>
      )}
      <StatementTable
        sections={bs.sections}
        subtotals={bs.subtotals}
        showPrior={bs.priorAsAt !== null}
        currentLabel={`As at ${formatDay(bs.asAt)}`}
        priorLabel={bs.priorAsAt ? `As at ${formatDay(bs.priorAsAt)}` : ''}
        onOpen={onOpen}
      />
      <p style={{ ...muted, margin: '0 0 1rem' }}>
        Money the business owes is shown as a positive number under its own heading and taken off
        the totals. Net assets and total shareholders’ funds are the same figure looked at from
        each end, which is what makes it a balance sheet.
      </p>
    </>
  )
}

function TrialBalance({
  payload,
  onOpen,
}: {
  payload: TrialBalancePayload
  onOpen: (accountId: string) => void
}) {
  const tb = payload.trialBalance
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>Account</th>
            <th style={thRight}>Debit</th>
            <th style={thRight}>Credit</th>
          </tr>
        </thead>
        <tbody>
          {tb.rows.map((row) => (
            <tr key={row.accountId}>
              <td style={td}>
                <button
                  type="button"
                  onClick={() => onOpen(row.accountId)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    color: 'var(--color-text)',
                    textDecoration: 'underline',
                    textDecorationStyle: 'dotted',
                    cursor: 'pointer',
                  }}
                >
                  {row.name}
                </button>
              </td>
              <td style={tdRight}>{row.debit === '0.00' ? '' : <Money value={row.debit} />}</td>
              <td style={tdRight}>{row.credit === '0.00' ? '' : <Money value={row.credit} />}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--color-border)' }}>
            <td style={{ ...td, fontWeight: 600, borderBottom: 'none' }}>
              {tb.balanced ? 'Balanced' : `Out by ${tb.difference}`}
            </td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={tb.totalDebits} bold /></td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={tb.totalCredits} bold /></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function NominalLedger({
  nominal,
  accounts,
  accountId,
  onSelect,
}: {
  nominal: Nominal | null
  accounts: { accountId: string; name: string }[]
  accountId: string
  onSelect: (id: string) => void
}) {
  return (
    <>
      <div style={{ ...card, padding: '0.875rem' }}>
        <label htmlFor="bk-nominal-account" style={{ display: 'block', ...muted }}>
          Account
        </label>
        <select
          id="bk-nominal-account"
          style={{ ...input, minWidth: 280 }}
          value={accountId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">Pick an account…</option>
          {accounts.map((account) => (
            <option key={account.accountId} value={account.accountId}>
              {account.name}
            </option>
          ))}
        </select>
      </div>

      {!accountId && (
        <EmptyState title="Pick an account.">
          <p style={{ margin: 0 }}>
            Every single thing that went to it, oldest first, with a running balance.
          </p>
        </EmptyState>
      )}

      {accountId && nominal && (
        <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Who</th>
                <th style={th}>What</th>
                <th style={thRight}>Debit</th>
                <th style={thRight}>Credit</th>
                <th style={thRight}>Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={td} colSpan={5}>
                  <em>Brought forward</em>
                </td>
                <td style={tdRight}><Money value={nominal.broughtForward} /></td>
              </tr>
              {nominal.entries.map((entry, index) => (
                <tr key={`${entry.sourceId}-${index}`}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{formatDay(entry.date)}</td>
                  <td style={td}>{entry.counterparty}</td>
                  <td style={td}>{entry.description}</td>
                  <td style={tdRight}>{entry.debit === '0.00' ? '' : <Money value={entry.debit} />}</td>
                  <td style={tdRight}>{entry.credit === '0.00' ? '' : <Money value={entry.credit} />}</td>
                  <td style={tdRight}><Money value={entry.balance} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--color-border)' }}>
                <td style={{ ...td, fontWeight: 600, borderBottom: 'none' }} colSpan={3}>
                  {nominal.name}
                </td>
                <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={nominal.totalDebits} bold /></td>
                <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={nominal.totalCredits} bold /></td>
                <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={nominal.closing} bold /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}

function AgedTables({ aged }: { aged: { owedToUs: Aged; weOwe: Aged } }) {
  return (
    <>
      <AgedTable title="Owed to the business" data={aged.owedToUs} />
      <AgedTable title="Owed by the business" data={aged.weOwe} />
      <p style={{ ...muted, margin: 0 }}>
        Anything with no date against it as paid counts as outstanding, aged from the invoice date.
        These are the same entries the debtors and creditors lines on the balance sheet come from.
      </p>
    </>
  )
}

function AgedTable({ title, data }: { title: string; data: Aged }) {
  if (data.rows.length === 0) {
    return (
      <div style={{ ...card, padding: '1.25rem' }}>
        <h3 style={{ margin: 0, fontSize: '0.9375rem' }}>{title}</h3>
        <p style={{ ...muted, margin: '0.25rem 0 0' }}>Nothing outstanding. Rather nice, that.</p>
      </div>
    )
  }
  return (
    <div style={{ ...card, padding: 0, overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>{title}</th>
            <th style={thRight}>Not yet a month</th>
            <th style={thRight}>1 to 2 months</th>
            <th style={thRight}>2 to 3 months</th>
            <th style={thRight}>3 to 4 months</th>
            <th style={thRight}>Older</th>
            <th style={thRight}>Total</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.counterparty}>
              <td style={td}>
                {row.counterparty}
                {row.oldest && <span style={{ ...muted, marginLeft: '0.5rem' }}>since {formatDay(row.oldest)}</span>}
              </td>
              <td style={tdRight}><Money value={row.current} /></td>
              <td style={tdRight}><Money value={row.days30} /></td>
              <td style={tdRight}><Money value={row.days60} /></td>
              <td style={tdRight}><Money value={row.days90} /></td>
              <td style={tdRight}><Money value={row.older} /></td>
              <td style={tdRight}><Money value={row.total} bold /></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--color-border)' }}>
            <td style={{ ...td, fontWeight: 600, borderBottom: 'none' }}>Total</td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={data.totals.current} bold /></td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={data.totals.days30} bold /></td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={data.totals.days60} bold /></td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={data.totals.days90} bold /></td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={data.totals.older} bold /></td>
            <td style={{ ...tdRight, borderBottom: 'none' }}><Money value={data.totals.total} bold /></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function Exports({ records }: { records: Report['records'] | undefined }) {
  return (
    <div style={{ ...card, padding: '1.25rem', maxWidth: 640 }}>
      <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Take a copy of everything</h3>
      <p style={{ ...muted, margin: '0 0 0.75rem' }}>
        Spreadsheet files, one per kind of record. Worth doing before you change anything big, and
        the thing to do before you ever remove this from your site.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {EXPORTS.map(([kind, label]) => (
          <a key={kind} className="btn btn-sm" href={`/api/m/uk-bookkeeping/admin/export/${kind}`}>
            {label}
          </a>
        ))}
      </div>
      {records && (
        <p style={{ ...muted, margin: '0.875rem 0 0' }}>
          {records.counts.transactions} entries, {records.counts.attachments} files,{' '}
          {records.counts.periods} VAT periods.{' '}
          {records.chain.intact
            ? `History intact. Fingerprint ${records.recordsFingerprint?.slice(0, 16) ?? '—'}…`
            : `History does not add up from entry ${records.chain.brokenAtIndex}. Somebody has been in the database.`}
        </p>
      )}
    </div>
  )
}
