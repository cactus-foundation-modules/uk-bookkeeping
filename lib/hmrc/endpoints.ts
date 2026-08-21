import type { HmrcEnvironment } from '../types'

// Where HMRC lives, and the one string every install must register verbatim.

// The API host is `service.HMRC.gov.uk`; the sign-in host is `tax.service.gov.uk`
// with no `hmrc` in it. They are genuinely different shapes, which is exactly how
// the wrong one gets written down - `test-api.service.gov.uk` does not resolve at
// all, so every call would fail with a DNS error rather than anything that reads
// like a configuration problem. `lib/hmrc/sandbox.live.test.ts` reaches all four
// of these for real, which is how this was caught.
export const HMRC_HOSTS: Record<HmrcEnvironment, { authorize: string; api: string }> = {
  sandbox: {
    authorize: 'https://test-www.tax.service.gov.uk',
    api: 'https://test-api.service.hmrc.gov.uk',
  },
  production: {
    authorize: 'https://www.tax.service.gov.uk',
    api: 'https://api.service.hmrc.gov.uk',
  },
}

export const HMRC_SCOPE = 'read:vat write:vat'
export const HMRC_ACCEPT = 'application/vnd.hmrc.1.0+json'

/**
 * The OAuth redirect URI.
 *
 * A FIXED public route, deliberately outside the admin path. The admin path is
 * per-install configurable (/cactus-admin, /hq, /cacti, ...) and HMRC needs an
 * exact, pre-registered redirect URI: putting the admin path in it would mean
 * every install registered a different string, and renaming the admin path
 * afterwards would silently break the connection.
 *
 * This is the same string on every install, so the operator's setup guide can
 * print it verbatim - and the settings tab prints the site's own with a copy
 * button, because a trailing slash is enough for HMRC to refuse the connection.
 */
export const HMRC_CALLBACK_PATH = '/api/m/uk-bookkeeping/hmrc/callback'

export function callbackUrl(siteUrl: string): string {
  return `${siteUrl.replace(/\/+$/, '')}${HMRC_CALLBACK_PATH}`
}

/** Credentials come from the environment only. Never the database, never a page. */
export function hmrcCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.HMRC_CLIENT_ID
  const clientSecret = process.env.HMRC_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export function isHmrcConfigured(): boolean {
  return hmrcCredentials() !== null
}

/**
 * A period key goes in the URL PATH, and some of them contain a `#`.
 *
 * Unencoded, that `#` starts a fragment and silently truncates the path, which
 * is a well-known way to lose an afternoon. encodeURIComponent handles it; this
 * function exists so the reason is written down next to the call.
 */
export function encodePeriodKey(periodKey: string): string {
  return encodeURIComponent(periodKey)
}
