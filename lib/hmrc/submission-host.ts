// Which hostname HMRC calls have to come from.
//
// Gov-Client-Public-Port can only be sent when the browser's connection reaches
// the site directly, with no proxy in between (see forwarded.ts and the README).
// On a site served from its own server, cactus-host lists those direct hostnames
// in CACTUS_HOST_DIRECT_HOSTS - books.example.co.uk, say - and the site's main
// address stays behind Cloudflare, where the port is lost.
//
// Use the main address for a VAT return and the request still goes to HMRC, just
// without the port, and HMRC's monitoring flags it weeks later. So where a direct
// hostname exists, the HMRC screens send the browser to it and every HMRC call
// from anywhere else is refused with a sentence that names it. Where none exists
// (hosting that cannot offer one) nothing changes: there is nowhere better to
// send anybody.

import { BookkeepingError } from '../errors'

/** The site's direct hostnames, lower-cased, in the order cactus-host lists them. */
export function directHosts(): string[] {
  return (process.env.CACTUS_HOST_DIRECT_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

/** The hostname the browser asked for, without a port. Caddy passes Host through as given. */
export function requestHostname(headers: Headers): string {
  const raw = headers.get('x-forwarded-host') || headers.get('host') || ''
  return (raw.split(',')[0] ?? '').trim().toLowerCase().split(':')[0] ?? ''
}

/**
 * Where this request should have been made from, or null when it is already in
 * the right place (or there is no right place to send it).
 */
export function submissionHostFor(headers: Headers): string | null {
  const hosts = directHosts()
  if (hosts.length === 0) return null
  return hosts.includes(requestHostname(headers)) ? null : hosts[0]!
}

/** The same path on the direct hostname. */
export function onSubmissionHost(host: string, path: string): string {
  return `https://${host}${path.startsWith('/') ? path : `/${path}`}`
}

export class WrongHostError extends BookkeepingError {
  readonly url: string

  constructor(host: string, url: string) {
    super(
      'wrong_host',
      `VAT returns and anything else sent to HMRC have to be done from ${host}, not this address. HMRC check that every request carries details this address cannot pass on. Open ${url} and do it from there - nothing has been sent.`,
      409,
    )
    this.name = 'WrongHostError'
    this.url = url
  }
}

/** The screen the call came from, so the link lands them back on it. */
function refererPath(request: Request): string {
  try {
    const referer = request.headers.get('referer')
    if (!referer) return '/'
    const url = new URL(referer)
    return `${url.pathname}${url.search}`
  } catch {
    return '/'
  }
}

/** Refuse an HMRC call made from the wrong hostname, before anything is sent. */
export function assertSubmissionHost(request: Request): void {
  const host = submissionHostFor(request.headers)
  if (!host) return
  throw new WrongHostError(host, onSubmissionHost(host, refererPath(request)))
}
