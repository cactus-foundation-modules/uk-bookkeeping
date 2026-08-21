'use client'

import { useCallback, useEffect, useState } from 'react'
import { ErrorNotice, TriggerHealthNotice, type TriggerHealth } from './Notices'
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
  hmrcEnvironment: 'sandbox' | 'production'
  errorThresholdFixed: string
  errorThresholdPercent: string
  errorThresholdCap: string
  boxRounding: 'nearest' | 'down'
  attachmentMaxBytes: number
  retentionYears: number
  vendorPublicIp: string | null
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
  settings: Settings
  hmrc: Hmrc
  health: TriggerHealth
  chainHead: string | null
}

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

function toDateValue(value: string | null): string {
  return value ? String(value).slice(0, 10) : ''
}

export function BookkeepingSettingsTab() {
  const [data, setData] = useState<Payload | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [verdict, setVerdict] = useState<HeaderVerdict | null>(null)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/m/uk-bookkeeping/admin/settings')
      if (!response.ok) {
        setError('The bookkeeping settings could not be loaded.')
        return
      }
      const payload: Payload = await response.json()
      setData(payload)
      setSettings(payload.settings)
    } catch {
      setError('The bookkeeping settings could not be loaded. Check the connection and reload the page.')
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- delegating to an async helper; every setState is after an await
    load()
  }, [load])

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

  const { hmrc } = data

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
          <label htmlFor="bk-first">Your first VAT period starts</label>
          <input id="bk-first" type="date" style={input} value={toDateValue(settings.firstPeriodStart)} onChange={(e) => set('firstPeriodStart', e.target.value || null)} />
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
            <p style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-sm)' }}>
              Add <code>HMRC_CLIENT_ID</code> and <code>HMRC_CLIENT_SECRET</code> to your hosting
              environment variables, then redeploy.
            </p>
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
    </div>
  )
}
