'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAdminPath } from '@/components/admin/AdminPathContext'
import { ErrorNotice, TriggerHealthNotice, type TriggerHealth } from './Notices'
import { formatDate, poundsFromString } from './format'
import { hmrcFetch } from '@/modules/uk-bookkeeping/lib/hmrc/fraud-client'

// Settings, as a tab under the site's own Settings page rather than another
// sidebar link.
//
// Also where the HMRC connection lives, in all four of its states, and where the
// exact redirect URI is printed with a copy button - a trailing slash is enough
// for HMRC to refuse the connection, so this is not a string anybody should be
// retyping.

type Settings = {
  businessName: string | null
  businessType: 'ltd' | 'sole_trader'
  vrn: string | null
  vatRegisteredFrom: string | null
  scheme: 'accrual' | 'cash'
  schemeChangedAt: string | null
  periodFrequency: 'monthly' | 'quarterly' | 'annual'
  firstPeriodStart: string | null
  firstPeriodEnd: string | null
  hmrcEnvironment: 'sandbox' | 'production'
  errorThresholdFixed: string
  errorThresholdPercent: string
  errorThresholdCap: string
  boxRounding: 'nearest' | 'down'
  attachmentMaxBytes: number
  retentionYears: number
  vendorPublicIp: string | null
  /** The year end is a month and a day - "31 March", every year - not a date. */
  yearEndMonth: number
  yearEndDay: number
}

/**
 * The settings as they arrive. Everything is camelCase except the year end,
 * which is new enough that a site running an older server may still answer with
 * the column's own spelling - so take either and settle it in one place, rather
 * than showing 31 March to somebody who set something else.
 */
type SettingsResponse = Omit<Settings, 'yearEndMonth' | 'yearEndDay'> & {
  yearEndMonth?: number
  yearEndDay?: number
  year_end_month?: number
  year_end_day?: number
}

type Hmrc = {
  configured: boolean
  status: 'never' | 'connected' | 'expired' | 'revoked'
  vrn: string | null
  environment: string
  connectedAt: string | null
  accessTokenExpiresAt: string | null
  refreshTokenExpiresAt: string | null
  lastRefreshError: string | null
  redirectUri: string | null
  fraudSpecReadOn: string
  fraudSpecSource: string
}

type HeaderVerdict = {
  code: 'VALID_HEADERS' | 'INVALID_HEADERS' | 'POTENTIALLY_INVALID_HEADERS' | 'UNAVAILABLE'
  message: string
  specVersion: string | null
  errors: { code: string; message: string; headers: string[] }[]
  warnings: { code: string; message: string; headers: string[] }[]
}

type Payload = {
  settings: SettingsResponse
  hmrc: Hmrc
  health: TriggerHealth
  chainHead: string | null
}

// Row shapes as JSON leaves the server: dates arrive as strings and every money
// value as a decimal string. Declared here rather than imported from lib/types,
// so this file never reaches for anything Prisma-shaped - the same rule the
// other bookkeeping screens keep.
type BankAccountKind = 'bank' | 'card' | 'cash'

type BankAccount = {
  id: string
  name: string
  kind: BankAccountKind
  bank_name: string | null
  account_last4: string | null
  sort_code: string | null
  opening_balance: string
  opening_date: string | null
  archived: boolean
  position: number
  position_summary: {
    openingBalance: string
    statementBalance: string
    lastStatementDate: string | null
    unreconciledCount: number
    unreconciledTotal: string
  }
}

type AccountKind = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

type AccountSubtype =
  | 'other'
  | 'bank'
  | 'cash'
  | 'director_loan'
  | 'vat_control'
  | 'debtors'
  | 'creditors'
  | 'fixed_assets'
  | 'depreciation'
  | 'share_capital'
  | 'reserves'
  | 'suspense'
  | 'profit_and_loss'

type LedgerAccount = {
  id: string
  code: string
  name: string
  kind: AccountKind
  subtype: AccountSubtype
  person_name: string | null
  position: number
  archived: boolean
  is_system: boolean
}

type NewBankAccount = {
  name: string
  kind: BankAccountKind
  bankName: string
  accountLast4: string
  sortCode: string
  openingBalance: string
  openingDate: string
}

type NewLedgerAccount = {
  name: string
  kind: AccountKind
  subtype: AccountSubtype
  personName: string
}

const EMPTY_BANK_ACCOUNT: NewBankAccount = {
  name: '',
  kind: 'bank',
  bankName: '',
  accountLast4: '',
  sortCode: '',
  openingBalance: '',
  openingDate: '',
}

const EMPTY_LEDGER_ACCOUNT: NewLedgerAccount = {
  name: '',
  kind: 'liability',
  subtype: 'other',
  personName: '',
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// 31 March, which is what a company incorporated without a thought about it ends
// up with often enough to be the least surprising thing to show.
const DEFAULT_YEAR_END_MONTH = 3
const DEFAULT_YEAR_END_DAY = 31

const BANK_KIND_LABELS: Record<BankAccountKind, string> = {
  bank: 'Bank account',
  card: 'Credit or charge card',
  cash: 'Cash',
}

// The same plain-English headings the accounts are grouped under on the journals
// screen, so the two lists read as one list.
const KIND_GROUPS: { kind: AccountKind; label: string }[] = [
  { kind: 'asset', label: 'Things the business owns or is owed' },
  { kind: 'liability', label: 'Things the business owes' },
  { kind: 'equity', label: 'The owners’ stake' },
  { kind: 'income', label: 'Income' },
  { kind: 'expense', label: 'Costs' },
]

const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  other: 'Nothing special',
  bank: 'Money in a bank account',
  cash: 'Cash',
  director_loan: 'Director’s loan',
  vat_control: 'VAT owed to HMRC',
  debtors: 'Money owed to the business',
  creditors: 'Money the business owes',
  fixed_assets: 'Equipment and other lasting things',
  depreciation: 'Wear and tear',
  share_capital: 'Shares',
  reserves: 'Profits kept in the business',
  suspense: 'Somewhere to park the unexplained',
  profit_and_loss: 'Profit and loss',
}

const SUBTYPE_ORDER: AccountSubtype[] = [
  'other',
  'director_loan',
  'bank',
  'cash',
  'vat_control',
  'debtors',
  'creditors',
  'fixed_assets',
  'depreciation',
  'share_capital',
  'reserves',
  'suspense',
  'profit_and_loss',
]

const input: React.CSSProperties = {
  padding: '0.375rem 0.625rem',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-bg)',
  color: 'var(--color-text)',
  width: '100%',
  maxWidth: 280,
}

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '0.625rem 0',
  borderBottom: '1px solid var(--color-border)',
}

const quiet: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs, 0.75rem)',
  color: 'var(--color-text-muted, var(--color-text))',
}

const headStyle: React.CSSProperties = { padding: '0.5rem 0.625rem', textAlign: 'left' }
const cellStyle: React.CSSProperties = { padding: '0.5rem 0.625rem', verticalAlign: 'top' }

function toDateValue(value: string | null): string {
  return value ? String(value).slice(0, 10) : ''
}

function withYearEnd(raw: SettingsResponse): Settings {
  return {
    ...raw,
    yearEndMonth: raw.yearEndMonth ?? raw.year_end_month ?? DEFAULT_YEAR_END_MONTH,
    yearEndDay: raw.yearEndDay ?? raw.year_end_day ?? DEFAULT_YEAR_END_DAY,
  }
}

export function BookkeepingSettingsTab() {
  const adminPath = useAdminPath()
  const [data, setData] = useState<Payload | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [verdict, setVerdict] = useState<HeaderVerdict | null>(null)
  const [checking, setChecking] = useState(false)

  // HMRC credentials are ordinary environment variables, stored through the
  // same core route as every other credential on the site. The GET returns
  // booleans only - whether each is set - never the values.
  const [envVars, setEnvVars] = useState<Record<string, boolean>>({})
  const [envLocalMode, setEnvLocalMode] = useState(false)
  const [envEditable, setEnvEditable] = useState(false)
  const [credClientId, setCredClientId] = useState('')
  const [credClientSecret, setCredClientSecret] = useState('')
  const [savingCreds, setSavingCreds] = useState(false)
  const [savedCreds, setSavedCreds] = useState(false)
  const [credError, setCredError] = useState<string | null>(null)

  // The two account lists save themselves as you go, rather than waiting for the
  // button at the bottom, so they keep their own errors and their own busy flag.
  const [bankAccounts, setBankAccounts] = useState<BankAccount[] | null>(null)
  const [bankError, setBankError] = useState<string | null>(null)
  const [bankNotice, setBankNotice] = useState<string | null>(null)
  const [bankBusy, setBankBusy] = useState(false)
  const [newBank, setNewBank] = useState<NewBankAccount>(EMPTY_BANK_ACCOUNT)

  // The categories, for the one dropdown that needs them: what sales handed over
  // by another module get filed under.
  const [categories, setCategories] = useState<{ id: string; name: string; direction: string }[] | null>(null)

  const [ledgerAccounts, setLedgerAccounts] = useState<LedgerAccount[] | null>(null)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [ledgerNotice, setLedgerNotice] = useState<string | null>(null)
  const [ledgerBusy, setLedgerBusy] = useState(false)
  const [newLedger, setNewLedger] = useState<NewLedgerAccount>(EMPTY_LEDGER_ACCOUNT)

  const load = useCallback(async () => {
    try {
      const [response, envResponse] = await Promise.all([
        fetch('/api/m/uk-bookkeeping/admin/settings'),
        fetch('/api/admin/env'),
      ])
      if (!response.ok) {
        setError('The bookkeeping settings could not be loaded.')
        return
      }
      const payload: Payload = await response.json()
      setData(payload)
      setSettings(withYearEnd(payload.settings))
      // Only site admins may manage credentials; anybody else keeps the
      // read-only view rather than a form that cannot save.
      if (envResponse.ok) {
        const env = (await envResponse.json()) as { vars?: Record<string, boolean>; localMode?: boolean }
        setEnvVars(env.vars ?? {})
        setEnvLocalMode(!!env.localMode)
        setEnvEditable(true)
      }
    } catch {
      setError('The bookkeeping settings could not be loaded. Check the connection and reload the page.')
    }
  }, [])

  const loadBankAccounts = useCallback(async () => {
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/bank-accounts')
      const payload = (await response.json().catch(() => ({}))) as {
        accounts?: BankAccount[]
        error?: string
      }
      if (!response.ok) {
        setBankError(payload.error ?? 'The bank accounts could not be loaded.')
        return
      }
      setBankAccounts(payload.accounts ?? [])
    } catch {
      setBankError('The bank accounts could not be loaded. Check the connection and reload the page.')
    }
  }, [])

  const loadLedgerAccounts = useCallback(async () => {
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/accounts')
      const payload = (await response.json().catch(() => ({}))) as {
        accounts?: LedgerAccount[]
        error?: string
      }
      if (!response.ok) {
        setLedgerError(payload.error ?? 'The accounts could not be loaded.')
        return
      }
      setLedgerAccounts(payload.accounts ?? [])
    } catch {
      setLedgerError('The accounts could not be loaded. Check the connection and reload the page.')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    loadBankAccounts()
  }, [loadBankAccounts])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    loadLedgerAccounts()
  }, [loadLedgerAccounts])

  useEffect(() => {
    fetch('/api/m/uk-bookkeeping/admin/categories')
      .then(async (response) => {
        if (!response.ok) return
        const payload = (await response.json()) as { categories?: { id: string; name: string; direction: string }[] }
        setCategories(payload.categories ?? [])
      })
      .catch(() => {})
  }, [])

  if (error && !data) return <ErrorNotice message={error} />
  if (!data || !settings) return <p>Loading…</p>

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function save() {
    if (!settings) return
    setError(null)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'Those settings could not be saved.')
        return
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      load()
    } catch {
      setError('The save did not reach the server. Check the connection and try again.')
    }
  }

  async function connect() {
    setError(null)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/hmrc/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A path, not the full href: the server only trusts a same-site path
        // through the OAuth round trip, and quite right too.
        body: JSON.stringify({ returnTo: `${window.location.pathname}${window.location.search}` }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        setError(payload.error ?? 'The connection could not be started.')
        return
      }
      window.location.href = payload.url
    } catch {
      setError('HMRC could not be reached to start the connection. Check the connection and try again.')
    }
  }

  async function checkHeaders() {
    setChecking(true)
    setVerdict(null)
    try {
      const response = await hmrcFetch('/api/m/uk-bookkeeping/admin/hmrc/check-headers', {})
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload) {
        setError(payload?.error ?? 'HMRC could not be asked to check the details just now.')
        return
      }
      setVerdict(payload)
    } catch {
      setError('HMRC could not be asked to check the details just now. Try again in a moment.')
    } finally {
      setChecking(false)
    }
  }

  async function saveCredentials() {
    setSavingCreds(true)
    setSavedCreds(false)
    setCredError(null)
    try {
      // Only non-blank fields are sent, so a blank box leaves the stored value
      // alone rather than wiping it.
      const vars = [
        { key: 'HMRC_CLIENT_ID', value: credClientId.trim() },
        { key: 'HMRC_CLIENT_SECRET', value: credClientSecret.trim() },
      ].filter((v) => v.value !== '')
      if (vars.length === 0) {
        throw new Error('Nothing to save - paste the client ID or the client secret first.')
      }
      const response = await fetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vars }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error ?? 'Those credentials could not be saved.')
      // Core only stores keys the installed modules declare. If it dropped
      // any, say so rather than show a green "Saved" over a credential that is
      // not there.
      if (Array.isArray(payload.skipped) && payload.skipped.length > 0) {
        throw new Error(
          `Not stored: ${payload.skipped.join(', ')}. Update the bookkeeping module to its latest version, then save again.`,
        )
      }
      setSavedCreds(true)
      setCredClientId('')
      setCredClientSecret('')
      await load()
    } catch (err) {
      setCredError(err instanceof Error ? err.message : 'Those credentials could not be saved.')
    } finally {
      setSavingCreds(false)
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect from HMRC? Your records stay exactly as they are.')) return
    setError(null)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/hmrc/status', { method: 'DELETE' })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        setError(payload.error ?? 'The disconnect did not go through.')
        return
      }
      load()
    } catch {
      setError('The disconnect did not reach the server. Check the connection and try again.')
    }
  }

  async function addBankAccount() {
    setBankError(null)
    setBankNotice(null)
    if (!newBank.name.trim()) {
      setBankError('The account needs a name, so you can tell it from the others.')
      return
    }
    setBankBusy(true)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/bank-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newBank.name.trim(),
          kind: newBank.kind,
          bankName: newBank.bankName.trim() || null,
          accountLast4: newBank.accountLast4.trim() || null,
          sortCode: newBank.sortCode.trim() || null,
          // A decimal string from the keystroke to the save, never a number: an
          // empty box means nothing was in the account on day one, so it is sent
          // as an amount rather than left for the server to guess at.
          openingBalance: newBank.openingBalance.trim() || '0.00',
          openingDate: newBank.openingDate || null,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setBankError(payload.error ?? 'That account could not be added.')
        return
      }
      setNewBank(EMPTY_BANK_ACCOUNT)
      await loadBankAccounts()
    } catch {
      setBankError('The save did not reach the server. Check the connection and try again.')
    } finally {
      setBankBusy(false)
    }
  }

  async function archiveBankAccount(account: BankAccount) {
    setBankError(null)
    setBankNotice(null)
    setBankBusy(true)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/bank-accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setBankError(payload.error ?? 'That account could not be put away.')
        return
      }
      setBankNotice(`${account.name} has been put away. Everything on it is kept.`)
      await loadBankAccounts()
    } catch {
      setBankError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBankBusy(false)
    }
  }

  async function removeBankAccount(account: BankAccount) {
    if (
      !window.confirm(
        `Remove ${account.name}? If a statement has ever been imported against it, it is put away instead.`,
      )
    ) {
      return
    }
    setBankError(null)
    setBankNotice(null)
    setBankBusy(true)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/bank-accounts/${account.id}`, {
        method: 'DELETE',
      })
      const payload = (await response.json().catch(() => ({}))) as {
        outcome?: 'deleted' | 'archived'
        error?: string
      }
      if (!response.ok) {
        setBankError(payload.error ?? 'That account could not be removed.')
        return
      }
      setBankNotice(
        payload.outcome === 'archived'
          ? `${account.name} has been put away rather than removed - a statement has been imported against it, and the lines behind your ticked-off entries hang off it.`
          : `${account.name} has been removed.`,
      )
      await loadBankAccounts()
    } catch {
      setBankError('That did not reach the server. Check the connection and try again.')
    } finally {
      setBankBusy(false)
    }
  }

  async function addLedgerAccount() {
    setLedgerError(null)
    setLedgerNotice(null)
    if (!newLedger.name.trim()) {
      setLedgerError('An account needs a name.')
      return
    }
    // The server refuses this one too. Saying so here saves a round trip and
    // keeps what has been typed.
    if (newLedger.subtype === 'director_loan' && !newLedger.personName.trim()) {
      setLedgerError('A director’s loan account needs to say whose it is.')
      return
    }
    setLedgerBusy(true)
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newLedger.name.trim(),
          kind: newLedger.kind,
          subtype: newLedger.subtype,
          personName: newLedger.personName.trim() || null,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setLedgerError(payload.error ?? 'That account could not be added.')
        return
      }
      setNewLedger(EMPTY_LEDGER_ACCOUNT)
      await loadLedgerAccounts()
    } catch {
      setLedgerError('The save did not reach the server. Check the connection and try again.')
    } finally {
      setLedgerBusy(false)
    }
  }

  async function archiveLedgerAccount(account: LedgerAccount) {
    setLedgerError(null)
    setLedgerNotice(null)
    setLedgerBusy(true)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setLedgerError(payload.error ?? 'That account could not be put away.')
        return
      }
      setLedgerNotice(`${account.name} has been put away. Old journals still show it.`)
      await loadLedgerAccounts()
    } catch {
      setLedgerError('That did not reach the server. Check the connection and try again.')
    } finally {
      setLedgerBusy(false)
    }
  }

  async function removeLedgerAccount(account: LedgerAccount) {
    if (
      !window.confirm(
        `Remove ${account.name}? If a journal has ever used it, it is put away instead.`,
      )
    ) {
      return
    }
    setLedgerError(null)
    setLedgerNotice(null)
    setLedgerBusy(true)
    try {
      const response = await fetch(`/api/m/uk-bookkeeping/admin/accounts/${account.id}`, {
        method: 'DELETE',
      })
      const payload = (await response.json().catch(() => ({}))) as {
        outcome?: 'deleted' | 'archived'
        error?: string
      }
      if (!response.ok) {
        setLedgerError(payload.error ?? 'That account could not be removed.')
        return
      }
      setLedgerNotice(
        payload.outcome === 'archived'
          ? `${account.name} has been put away rather than removed - a journal has used it, and a journal from years ago can only explain itself if the accounts it points at are still there.`
          : `${account.name} has been removed.`,
      )
      await loadLedgerAccounts()
    } catch {
      setLedgerError('That did not reach the server. Check the connection and try again.')
    } finally {
      setLedgerBusy(false)
    }
  }

  const { hmrc } = data

  const credentialsFields = envLocalMode ? (
    <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>
      This site is running in local development mode, so credentials live in <code>.env.local</code>:
      set <code>HMRC_CLIENT_ID</code> and <code>HMRC_CLIENT_SECRET</code> there and restart the dev
      server.
    </p>
  ) : !envEditable ? (
    <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>
      Storing the credentials needs a site administrator: ask them to paste{' '}
      <code>HMRC_CLIENT_ID</code> and <code>HMRC_CLIENT_SECRET</code> into this tab, or into the
      hosting environment variables.
    </p>
  ) : (
    <div>
      <div style={row}>
        <label htmlFor="bk-client-id">
          Client ID
          <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            {envVars.HMRC_CLIENT_ID ? 'Stored. Paste a new one to replace it.' : 'Not stored yet.'}
          </span>
        </label>
        <input
          id="bk-client-id"
          style={input}
          autoComplete="off"
          value={credClientId}
          onChange={(e) => setCredClientId(e.target.value)}
        />
      </div>
      <div style={row}>
        <label htmlFor="bk-client-secret">
          Client secret
          <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            {envVars.HMRC_CLIENT_SECRET ? 'Stored. Paste a new one to replace it.' : 'Not stored yet.'}
          </span>
        </label>
        <input
          id="bk-client-secret"
          type="password"
          style={input}
          autoComplete="new-password"
          value={credClientSecret}
          onChange={(e) => setCredClientSecret(e.target.value)}
        />
      </div>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '0.75rem', flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-primary" onClick={saveCredentials} disabled={savingCreds}>
          {savingCreds ? 'Saving…' : 'Save credentials'}
        </button>
        {savedCreds && (
          <span style={{ color: 'var(--color-success, var(--color-text))', fontSize: 'var(--text-sm)' }}>
            Saved. They take hold on the next deployment - the site will prompt for one.
          </span>
        )}
      </div>
      {credError && (
        <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-danger, var(--color-text))' }}>
          {credError}
        </p>
      )}
      <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
        Stored with the site&rsquo;s other credentials, never shown back here, and only ever sent to
        HMRC.
      </p>
    </div>
  )

  return (
    <div style={{ maxWidth: 720 }}>
      <ErrorNotice message={error} />
      <TriggerHealthNotice health={data.health} />

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>Your business</h3>
        <div style={row}>
          <label htmlFor="bk-name">Business name</label>
          <input id="bk-name" style={input} value={settings.businessName ?? ''} onChange={(e) => set('businessName', e.target.value || null)} />
        </div>
        <div style={row}>
          <label htmlFor="bk-type">What kind of business</label>
          <select id="bk-type" style={input} value={settings.businessType} onChange={(e) => set('businessType', e.target.value as Settings['businessType'])}>
            <option value="ltd">Limited company</option>
            <option value="sole_trader">Sole trader or partnership</option>
          </select>
        </div>
        <div style={row}>
          <label htmlFor="bk-vrn">VAT number</label>
          <input id="bk-vrn" style={input} placeholder="123456789" value={settings.vrn ?? ''} onChange={(e) => set('vrn', e.target.value || null)} />
        </div>
        <div style={row}>
          <label htmlFor="bk-registered">VAT registered from</label>
          <input id="bk-registered" type="date" style={input} value={toDateValue(settings.vatRegisteredFrom)} onChange={(e) => set('vatRegisteredFrom', e.target.value || null)} />
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>Your accounting year end</h3>
        <div style={row}>
          <label htmlFor="bk-year-end-month">Month</label>
          <select
            id="bk-year-end-month"
            style={input}
            value={settings.yearEndMonth}
            onChange={(e) => set('yearEndMonth', Number(e.target.value))}
          >
            {MONTHS.map((month, index) => (
              <option key={month} value={index + 1}>
                {month}
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <label htmlFor="bk-year-end-day">Day</label>
          <input
            id="bk-year-end-day"
            type="number"
            min={1}
            max={31}
            style={input}
            value={settings.yearEndDay}
            onChange={(e) => set('yearEndDay', Number(e.target.value))}
          />
        </div>
        <p style={{ margin: '0.75rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          The date your financial year ends - often 31 March, or the anniversary of the month the
          company was set up. The director&rsquo;s loan screen works out where the loan stood at this
          date, which is the figure that decides whether anything has to be paid back.
        </p>
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>How you do VAT</h3>
        <div style={row}>
          <label htmlFor="bk-scheme">Scheme</label>
          <select id="bk-scheme" style={input} value={settings.scheme} onChange={(e) => set('scheme', e.target.value as Settings['scheme'])}>
            <option value="accrual">Standard - by invoice date</option>
            <option value="cash">Cash accounting - by when the money moved</option>
          </select>
        </div>
        <div style={row}>
          <label htmlFor="bk-frequency">How often you file</label>
          <select id="bk-frequency" style={input} value={settings.periodFrequency} onChange={(e) => set('periodFrequency', e.target.value as Settings['periodFrequency'])}>
            <option value="quarterly">Every three months</option>
            <option value="monthly">Every month</option>
            <option value="annual">Once a year</option>
          </select>
        </div>
        <div style={row}>
          <label htmlFor="bk-first">
            Your first VAT period starts
            <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))', maxWidth: 340 }}>
              The day your VAT registration took effect.
            </span>
          </label>
          <input id="bk-first" type="date" style={input} value={toDateValue(settings.firstPeriodStart)} onChange={(e) => set('firstPeriodStart', e.target.value || null)} />
        </div>
        <div style={row}>
          <label htmlFor="bk-first-end">
            …and that first period ends
            <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))', maxWidth: 340 }}>
              From your registration letter or VAT account. HMRC ends every period on the last day of
              a month, so the first one is rarely a neat three months: registering on 10 July with
              periods ending October gives 10 July to 31 October. Every return after that follows
              calendar months, due one month and 7 days after each period ends. Left empty, we assume
              the nearest month end.
            </span>
          </label>
          <input id="bk-first-end" type="date" style={input} value={toDateValue(settings.firstPeriodEnd)} onChange={(e) => set('firstPeriodEnd', e.target.value || null)} />
        </div>
        <div style={row}>
          <label htmlFor="bk-rounding">
            Rounding for the four total boxes
            <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))', maxWidth: 340 }}>
              Boxes 6 to 9 are whole pounds. HMRC’s guidance does not say which way to round them, so
              pick whichever your accountant prefers. The unrounded figures are kept either way.
            </span>
          </label>
          <select id="bk-rounding" style={input} value={settings.boxRounding} onChange={(e) => set('boxRounding', e.target.value as Settings['boxRounding'])}>
            <option value="nearest">To the nearest pound</option>
            <option value="down">Down, ignoring the pence</option>
          </select>
        </div>
        {settings.schemeChangedAt && (
          <p style={{ margin: '0.75rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            You last changed scheme on {toDateValue(settings.schemeChangedAt)}. Moving between the two
            needs a one-off adjustment so nothing is counted twice or missed - worth a word with your
            accountant rather than a button here.
          </p>
        )}
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>HMRC</h3>

        {!hmrc.configured && (
          <div>
            <p style={{ margin: '0 0 0.75rem' }}>
              This site does not have its own HMRC credentials yet, so it cannot file returns. Everything
              else works: keep records, see all nine boxes, and mark a return as filed once you have sent
              it another way.
            </p>
            <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>
              Cactus is software you run yourself, so we cannot hand you a shared key - HMRC issues
              credentials to the business running the software, and that is you. It is about ten minutes
              of forms, then a wait.
            </p>
            <ol style={{ margin: '0 0 0.75rem', paddingLeft: '1.25rem', fontSize: 'var(--text-sm)' }}>
              <li style={{ marginBottom: '0.375rem' }}>
                Create an account on the{' '}
                <a href="https://developer.service.hmrc.gov.uk/developer/registration" target="_blank" rel="noreferrer">
                  HMRC Developer Hub
                </a>{' '}
                - a government service, free, separate from your Government Gateway login.
              </li>
              <li style={{ marginBottom: '0.375rem' }}>
                Under{' '}
                <a href="https://developer.service.hmrc.gov.uk/developer/applications" target="_blank" rel="noreferrer">
                  your applications
                </a>
                , add an application to the <em>sandbox</em> - that is HMRC&rsquo;s practice service,
                and where everybody has to start.
              </li>
              <li style={{ marginBottom: '0.375rem' }}>
                Subscribe the application to the <strong>VAT (MTD)</strong> API, and to{' '}
                <strong>Test Fraud Prevention Headers</strong> while you are practising.
              </li>
              <li style={{ marginBottom: '0.375rem' }}>
                Add the redirect URI shown below to the application, copied exactly.
              </li>
              <li style={{ marginBottom: '0.375rem' }}>
                Copy the application&rsquo;s client ID, generate a client secret, and paste both in
                below.
              </li>
              <li>
                When practice filing looks right, apply for <em>production credentials</em> from the
                same application page, and paste the new pair in here with the service switched to the
                real thing. HMRC take up to ten working days to approve.
              </li>
            </ol>
          </div>
        )}

        {hmrc.redirectUri && (
          <div style={{ marginBottom: '0.75rem' }}>
            <div style={{ fontSize: 'var(--text-sm)', marginBottom: '0.25rem' }}>
              Register this exact address with HMRC as your redirect URI. A trailing slash is enough for
              them to refuse the connection, so copy it rather than typing it.
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{ padding: '0.375rem 0.5rem', background: 'var(--color-surface)', borderRadius: 6, wordBreak: 'break-all' }}>
                {hmrc.redirectUri}
              </code>
              <button
                className="btn btn-sm"
                onClick={() => {
                  navigator.clipboard.writeText(hmrc.redirectUri!)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))', marginTop: '0.25rem' }}>
              It does not contain your admin address, on purpose, so renaming that never breaks it.
            </div>
          </div>
        )}

        {!hmrc.configured ? (
          credentialsFields
        ) : (
          <details style={{ marginBottom: '0.75rem' }}>
            <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
              Change the HMRC credentials
            </summary>
            <div style={{ paddingTop: '0.5rem' }}>{credentialsFields}</div>
          </details>
        )}

        <div style={row}>
          <label htmlFor="bk-env">Which HMRC service</label>
          <select id="bk-env" style={input} value={settings.hmrcEnvironment} onChange={(e) => set('hmrcEnvironment', e.target.value as Settings['hmrcEnvironment'])}>
            <option value="sandbox">Practice service (nothing is really filed)</option>
            <option value="production">The real thing</option>
          </select>
        </div>

        <div style={{ marginTop: '0.875rem' }}>
          {hmrc.status === 'connected' && (
            <p style={{ margin: '0 0 0.5rem' }}>
              Connected{hmrc.vrn ? ` for VAT number ${hmrc.vrn}` : ''} on the{' '}
              {hmrc.environment === 'sandbox' ? 'practice service' : 'real service'}, since{' '}
              {toDateValue(hmrc.connectedAt)}. You will be asked to reconnect around{' '}
              {toDateValue(hmrc.refreshTokenExpiresAt)}.
            </p>
          )}
          {hmrc.status === 'expired' && (
            <p style={{ margin: '0 0 0.5rem' }}>
              Your connection to HMRC has expired. Reconnect to carry on filing; everything else keeps
              working meanwhile.
              {hmrc.lastRefreshError && (
                <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
                  {hmrc.lastRefreshError}
                </span>
              )}
            </p>
          )}
          {hmrc.configured && hmrc.status === 'never' && (
            <p style={{ margin: '0 0 0.5rem' }}>
              Credentials are in place. Connecting sends you to the Government Gateway to sign in and
              give this site permission to see and file your VAT.
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {hmrc.configured && (
              <button className="btn btn-sm btn-primary" onClick={connect}>
                {hmrc.status === 'connected' ? 'Reconnect' : 'Connect to HMRC'}
              </button>
            )}
            {hmrc.status !== 'never' && (
              <button className="btn btn-sm" onClick={disconnect}>
                Disconnect
              </button>
            )}
          </div>
        </div>

        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: 'var(--text-sm)' }}>
            The technical bits HMRC asks about
          </summary>
          <div style={{ padding: '0.625rem 0', borderBottom: '1px solid var(--color-border)' }}>
            <p style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-sm)' }}>
              HMRC can check the details we send them before you apply for full access - which is
              worth doing, because getting them wrong is what an application comes back on, and they
              take up to ten working days to tell you.
            </p>
            <button className="btn btn-sm" onClick={checkHeaders} disabled={checking || !hmrc.configured}>
              {checking ? 'Asking HMRC…' : 'Have HMRC check the details we send'}
            </button>
            {verdict && (
              <div
                style={{
                  marginTop: '0.625rem',
                  padding: '0.625rem 0.75rem',
                  borderRadius: 6,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-surface)',
                  fontSize: 'var(--text-sm)',
                }}
              >
                <strong>
                  {verdict.code === 'VALID_HEADERS'
                    ? 'HMRC are happy with what we send.'
                    : verdict.code === 'UNAVAILABLE'
                      ? 'Not checked.'
                      : 'HMRC had something to say.'}
                </strong>
                <p style={{ margin: '0.25rem 0 0' }}>{verdict.message}</p>
                {verdict.errors.length > 0 && (
                  <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                    {verdict.errors.map((item, index) => (
                      <li key={`e-${index}`}>
                        {item.message}
                        {item.headers.length > 0 && ` (${item.headers.join(', ')})`}
                      </li>
                    ))}
                  </ul>
                )}
                {verdict.warnings.length > 0 && (
                  <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', color: 'var(--color-text-muted, var(--color-text))' }}>
                    {verdict.warnings.map((item, index) => (
                      <li key={`w-${index}`}>
                        {item.message}
                        {item.headers.length > 0 && ` (${item.headers.join(', ')})`}
                      </li>
                    ))}
                  </ul>
                )}
                {verdict.specVersion && (
                  <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
                    Checked against HMRC’s specification version {verdict.specVersion}.
                  </p>
                )}
              </div>
            )}
          </div>

          <div style={row}>
            <label htmlFor="bk-vendor-ip">
              Your site’s public address
              <span style={{ display: 'block', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))', maxWidth: 340 }}>
                Left empty we look this up from your web address, which is right for almost everybody.
                Fill it in only if HMRC has asked you to.
              </span>
            </label>
            <input id="bk-vendor-ip" style={input} value={settings.vendorPublicIp ?? ''} onChange={(e) => set('vendorPublicIp', e.target.value || null)} />
          </div>
          <p style={{ margin: '0.5rem 0 0', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Fraud prevention details are sent with every request to HMRC, following their published
            list as read on {hmrc.fraudSpecReadOn}.
          </p>
        </details>
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.75rem', fontSize: '0.9375rem' }}>Corrections and records</h3>
        <div style={row}>
          <label htmlFor="bk-threshold">Correct on the next return up to</label>
          <input id="bk-threshold" style={input} value={settings.errorThresholdFixed} onChange={(e) => set('errorThresholdFixed', e.target.value)} />
        </div>
        <div style={row}>
          <label htmlFor="bk-percent">Or this much of your sales figure (%)</label>
          <input id="bk-percent" style={input} value={settings.errorThresholdPercent} onChange={(e) => set('errorThresholdPercent', e.target.value)} />
        </div>
        <div style={row}>
          <label htmlFor="bk-cap">Never above</label>
          <input id="bk-cap" style={input} value={settings.errorThresholdCap} onChange={(e) => set('errorThresholdCap', e.target.value)} />
        </div>
        <div style={row}>
          <label htmlFor="bk-retention">Keep records for (years)</label>
          <input id="bk-retention" type="number" style={input} value={settings.retentionYears} onChange={(e) => set('retentionYears', Number(e.target.value))} />
        </div>
        <p style={{ margin: '0.75rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
          These are HMRC’s current limits for putting a mistake right on your next return rather than
          telling them separately. They are settings rather than fixed numbers so a rule change is a
          quick edit here.{' '}
          <a href="https://www.gov.uk/guidance/how-to-correct-vat-errors-and-make-adjustments-or-claims-vat-notice-70045" target="_blank" rel="noreferrer">
            HMRC’s guidance
          </a>
          .
        </p>
        {data.chainHead && (
          <p style={{ margin: '0.75rem 0 0', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Records fingerprint: <code>{data.chainHead}</code>. This changes whenever anything is
            recorded, and the same code goes on every filing receipt we email you - so a copy of it
            lives somewhere this software cannot reach.
          </p>
        )}
      </div>

      <button className="btn btn-primary" onClick={save}>
        Save settings
      </button>
      {saved && <span style={{ marginLeft: '0.75rem', color: 'var(--color-success, var(--color-text))', fontSize: 'var(--text-sm)' }}>Saved</span>}

      {/*
        Both lists below sit under the save button on purpose: everything above it
        is settings you save in one go, and these save themselves the moment you
        press a button. Mixing the two in one column is how somebody ends up
        adding an account, pressing Save, and wondering which of the two happened.
      */}
      <div className="card" style={{ padding: '1.25rem', margin: '1.5rem 0' }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Bank accounts</h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>
          A statement is imported against one particular account, so there has to be an account here
          before anything can be brought in. Changes on this card take effect straight away rather
          than waiting for the save button above.
        </p>
        <ErrorNotice message={bankError} />
        {bankNotice && (
          <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            {bankNotice}
          </p>
        )}

        {!bankAccounts ? (
          <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>Loading…</p>
        ) : bankAccounts.length === 0 ? (
          <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Nothing here yet. Add the account your statements come from, below.
          </p>
        ) : (
          <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <th style={headStyle}>Account</th>
                  <th style={headStyle}>Numbers</th>
                  <th style={{ ...headStyle, textAlign: 'right' }}>Statement balance</th>
                  <th style={headStyle}>Still to explain</th>
                  <th style={headStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {bankAccounts.map((account) => (
                  <tr key={account.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={cellStyle}>
                      {account.name}
                      <span style={quiet}>
                        {BANK_KIND_LABELS[account.kind]}
                        {account.bank_name ? ` at ${account.bank_name}` : ''}
                      </span>
                    </td>
                    <td style={cellStyle}>
                      {account.sort_code ?? '—'}
                      {account.account_last4 && <span style={quiet}>ending {account.account_last4}</span>}
                    </td>
                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                      {poundsFromString(account.position_summary.statementBalance)}
                      <span style={quiet}>
                        {account.position_summary.lastStatementDate
                          ? `to ${formatDate(account.position_summary.lastStatementDate)}`
                          : 'no statement yet'}
                      </span>
                    </td>
                    <td style={cellStyle}>
                      {account.position_summary.unreconciledCount > 0 ? (
                        <a href={`/${adminPath}/m/uk-bookkeeping/reconcile`}>
                          {account.position_summary.unreconciledCount} to explain
                          <span style={quiet}>
                            {poundsFromString(account.position_summary.unreconciledTotal)}
                          </span>
                        </a>
                      ) : (
                        <span style={{ color: 'var(--color-text-muted, var(--color-text))' }}>
                          Nothing waiting
                        </span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => archiveBankAccount(account)}
                          disabled={bankBusy}
                        >
                          Put away
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => removeBankAccount(account)}
                          disabled={bankBusy}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ margin: '0 0 0.5rem', fontSize: 'var(--text-xs, 0.75rem)', color: 'var(--color-text-muted, var(--color-text))' }}>
          An account a statement has ever been imported against is put away rather than removed. The
          statement lines behind every entry you have ticked off hang from it, so taking it away
          would take the tick with it.
        </p>

        <h4 style={{ margin: '1rem 0 0.25rem', fontSize: 'var(--text-sm)' }}>Add an account</h4>
        <div style={row}>
          <label htmlFor="bk-new-bank-name">
            What you call it
            <span style={quiet}>Required. Whatever you would say out loud: &ldquo;Current account&rdquo;.</span>
          </label>
          <input
            id="bk-new-bank-name"
            style={input}
            value={newBank.name}
            onChange={(e) => setNewBank({ ...newBank, name: e.target.value })}
          />
        </div>
        <div style={row}>
          <label htmlFor="bk-new-bank-kind">What sort</label>
          <select
            id="bk-new-bank-kind"
            style={input}
            value={newBank.kind}
            onChange={(e) => setNewBank({ ...newBank, kind: e.target.value as BankAccountKind })}
          >
            <option value="bank">Bank account</option>
            <option value="card">Credit or charge card</option>
            <option value="cash">Cash</option>
          </select>
        </div>
        <div style={row}>
          <label htmlFor="bk-new-bank-bank">Who it is with</label>
          <input
            id="bk-new-bank-bank"
            style={input}
            value={newBank.bankName}
            onChange={(e) => setNewBank({ ...newBank, bankName: e.target.value })}
          />
        </div>
        <div style={row}>
          <label htmlFor="bk-new-bank-last4">
            Last four digits
            <span style={quiet}>Only the last four are kept, whatever you type.</span>
          </label>
          <input
            id="bk-new-bank-last4"
            inputMode="numeric"
            style={input}
            value={newBank.accountLast4}
            onChange={(e) => setNewBank({ ...newBank, accountLast4: e.target.value })}
          />
        </div>
        <div style={row}>
          <label htmlFor="bk-new-bank-sort">Sort code</label>
          <input
            id="bk-new-bank-sort"
            inputMode="numeric"
            placeholder="00-00-00"
            style={input}
            value={newBank.sortCode}
            onChange={(e) => setNewBank({ ...newBank, sortCode: e.target.value })}
          />
        </div>
        <div style={row}>
          <label htmlFor="bk-new-bank-opening">
            What was in it to start with
            <span style={quiet}>Leave it empty if you are starting from nothing.</span>
          </label>
          <input
            id="bk-new-bank-opening"
            inputMode="decimal"
            placeholder="0.00"
            style={input}
            value={newBank.openingBalance}
            onChange={(e) => setNewBank({ ...newBank, openingBalance: e.target.value })}
          />
        </div>
        <div style={row}>
          <label htmlFor="bk-new-bank-opening-date">…as at</label>
          <input
            id="bk-new-bank-opening-date"
            type="date"
            style={input}
            value={newBank.openingDate}
            onChange={(e) => setNewBank({ ...newBank, openingDate: e.target.value })}
          />
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={addBankAccount}
            disabled={bankBusy}
          >
            {bankBusy ? 'Adding…' : 'Add account'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9375rem' }}>Ledger accounts</h3>
        <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>
          These are the pots a journal moves money between, and they arrive ready made - most people
          never need to add one. The exception is a director&rsquo;s loan account: if more than one
          director lends the company money, give each of them their own, so each running total is
          their own. Changes here take effect straight away.
        </p>
        <ErrorNotice message={ledgerError} />
        {ledgerNotice && (
          <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            {ledgerNotice}
          </p>
        )}

        {!ledgerAccounts ? (
          <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>Loading…</p>
        ) : ledgerAccounts.length === 0 ? (
          <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
            Nothing here yet.
          </p>
        ) : (
          KIND_GROUPS.map((group) => {
            const rows = ledgerAccounts.filter((account) => account.kind === group.kind)
            if (rows.length === 0) return null
            return (
              <div key={group.kind}>
                <h4 style={{ margin: '1rem 0 0', fontSize: 'var(--text-sm)', color: 'var(--color-text-muted, var(--color-text))' }}>
                  {group.label}
                </h4>
                {rows.map((account) => (
                  <div key={account.id} style={row}>
                    <span>
                      {account.name}
                      <span style={quiet}>
                        {account.person_name ? `${account.person_name} · ` : ''}
                        {SUBTYPE_LABELS[account.subtype]}
                        {account.is_system ? ' · built in' : ''}
                      </span>
                    </span>
                    <span style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => archiveLedgerAccount(account)}
                        disabled={ledgerBusy}
                      >
                        Put away
                      </button>
                      {!account.is_system && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => removeLedgerAccount(account)}
                          disabled={ledgerBusy}
                        >
                          Remove
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )
          })
        )}

        <h4 style={{ margin: '1rem 0 0.25rem', fontSize: 'var(--text-sm)' }}>Add an account</h4>
        <div style={row}>
          <label htmlFor="bk-new-account-name">
            Name
            <span style={quiet}>Required. What you would like to see it called on a journal.</span>
          </label>
          <input
            id="bk-new-account-name"
            style={input}
            value={newLedger.name}
            onChange={(e) => setNewLedger({ ...newLedger, name: e.target.value })}
          />
        </div>
        <div style={row}>
          <label htmlFor="bk-new-account-kind">What sort of account</label>
          <select
            id="bk-new-account-kind"
            style={input}
            value={newLedger.kind}
            onChange={(e) => setNewLedger({ ...newLedger, kind: e.target.value as AccountKind })}
          >
            {KIND_GROUPS.map((group) => (
              <option key={group.kind} value={group.kind}>
                {group.label}
              </option>
            ))}
          </select>
        </div>
        <div style={row}>
          <label htmlFor="bk-new-account-subtype">What it is for</label>
          <select
            id="bk-new-account-subtype"
            style={input}
            value={newLedger.subtype}
            onChange={(e) => setNewLedger({ ...newLedger, subtype: e.target.value as AccountSubtype })}
          >
            {SUBTYPE_ORDER.map((subtype) => (
              <option key={subtype} value={subtype}>
                {SUBTYPE_LABELS[subtype]}
              </option>
            ))}
          </select>
        </div>
        {newLedger.subtype === 'director_loan' && (
          <div style={row}>
            <label htmlFor="bk-new-account-person">
              Whose account is it
              <span style={quiet}>Required. The director whose money this account follows.</span>
            </label>
            <input
              id="bk-new-account-person"
              style={input}
              value={newLedger.personName}
              onChange={(e) => setNewLedger({ ...newLedger, personName: e.target.value })}
            />
          </div>
        )}
        <div style={{ marginTop: '0.75rem' }}>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={addLedgerAccount}
            disabled={ledgerBusy}
          >
            {ledgerBusy ? 'Adding…' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  )
}
