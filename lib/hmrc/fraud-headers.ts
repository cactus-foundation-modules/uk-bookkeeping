import { createHash } from 'crypto'
import { promises as dns } from 'dns'
import type { SessionUser } from '@/lib/auth/session'
import { getSettings } from '../settings'
import {
  CONNECTION_METHOD,
  fraudTimestamp,
  keyValueHeader,
  percentEncode,
} from './fraud-spec'
import manifest from '../../cactus.module.json'

// Assembling the Gov-* headers on the server.
//
// Two facts about this deployment make it fiddly, and both shape what follows.
//
// The API call happens in a serverless function, but almost all of the client
// data only exists in the browser - so the browser collects what only it can see
// (lib/hmrc/fraud-client.ts) and hands it over in the request body.
//
// Gov-Client-Public-IP must be the USER's public address, not the function's. It
// therefore comes from x-forwarded-for on the incoming request, leftmost entry,
// and never from anything the browser claims about itself. A value a client can
// choose is not evidence of anything.

/** What the browser collected. Anything missing simply omits its header. */
export type FraudBag = {
  deviceId?: string
  timezoneOffsetMinutes?: number
  screens?: { width: number; height: number; scalingFactor: number; colourDepth: number }[]
  windowWidth?: number
  windowHeight?: number
  userAgent?: string
}

export type FraudRequestInfo = {
  /** Every value on the incoming x-forwarded-for, in order. */
  forwardedFor: string[]
  /** x-real-ip, where the platform sets one. */
  realIp: string | null
  /** The host the browser asked for, used to work out the vendor's public IP. */
  host: string | null
}

export function readRequestInfo(request: Request): FraudRequestInfo {
  const forwarded = request.headers.get('x-forwarded-for') ?? ''
  return {
    forwardedFor: forwarded
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    realIp: request.headers.get('x-real-ip'),
    host: request.headers.get('host'),
  }
}

/**
 * The end user's public IP: the LEFTMOST entry on x-forwarded-for.
 *
 * Every hop appends itself, so the leftmost is the client and everything after
 * it is infrastructure. Taking the last entry gives the address of whichever
 * proxy spoke to the function, which is a fact about our own hosting and no use
 * to anybody looking for fraud.
 */
export function clientPublicIp(info: FraudRequestInfo): string | null {
  return info.forwardedFor[0] ?? info.realIp ?? null
}

/**
 * Gov-Vendor-Public-IP on serverless hosting.
 *
 * HMRC wants "the public IP address of the servers the originating device sent
 * their requests to" - the address the browser connected to, which on Vercel is
 * the edge that answers for the site's own hostname, not the function's egress
 * address (which has no stable value and would be the wrong answer anyway).
 *
 * So it is resolved from the site's own hostname and cached for the life of the
 * warm function. An operator behind a static-IP proxy, or one HMRC has asked a
 * specific question of, can override it in Settings.
 */
let cachedVendorIp: { host: string; ip: string } | null = null

export async function vendorPublicIp(host: string | null, override: string | null): Promise<string | null> {
  if (override) return override
  if (!host) return null
  const hostname = host.split(':')[0]!
  if (cachedVendorIp?.host === hostname) return cachedVendorIp.ip
  try {
    const [address] = await dns.resolve4(hostname)
    if (!address) return null
    cachedVendorIp = { host: hostname, ip: address }
    return address
  } catch {
    // A site on a hostname that will not resolve to an A record (IPv6-only, or a
    // local development machine) simply omits the header rather than sending a
    // guess. HMRC's own page allows for a value that cannot be collected.
    return null
  }
}

export type BuildFraudHeadersInput = {
  request: Request
  bag: FraudBag
  user: SessionUser | null
  /** True where the admin signed in with a passkey, which genuinely is a second factor. */
  usedMultiFactor?: boolean
  multiFactorAt?: Date | null
}

export async function buildFraudHeaders(
  input: BuildFraudHeadersInput,
): Promise<Record<string, string>> {
  const settings = await getSettings()
  const info = readRequestInfo(input.request)
  const now = new Date()

  const headers: Record<string, string> = {
    'Gov-Client-Connection-Method': CONNECTION_METHOD,
    'Gov-Client-Public-IP-Timestamp': fraudTimestamp(now),
    'Gov-Vendor-Product-Name': percentEncode('Cactus Bookkeeping'),
    'Gov-Vendor-Version': keyValueHeader({ 'uk-bookkeeping': manifest.version }),
  }

  const publicIp = clientPublicIp(info)
  if (publicIp) headers['Gov-Client-Public-IP'] = publicIp

  if (input.bag.deviceId) headers['Gov-Client-Device-ID'] = input.bag.deviceId
  if (input.bag.userAgent) headers['Gov-Client-Browser-JS-User-Agent'] = input.bag.userAgent

  if (typeof input.bag.timezoneOffsetMinutes === 'number') {
    const total = -input.bag.timezoneOffsetMinutes
    const sign = total < 0 ? '-' : '+'
    const absolute = Math.abs(total)
    headers['Gov-Client-Timezone'] =
      `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
  }

  if (input.bag.screens?.length) {
    headers['Gov-Client-Screens'] = input.bag.screens
      .map((screen) =>
        keyValueHeader({
          width: Math.round(screen.width),
          height: Math.round(screen.height),
          'scaling-factor': screen.scalingFactor,
          'colour-depth': Math.round(screen.colourDepth),
        }),
      )
      .join(',')
  }

  if (input.bag.windowWidth && input.bag.windowHeight) {
    headers['Gov-Client-Window-Size'] = keyValueHeader({
      width: Math.round(input.bag.windowWidth),
      height: Math.round(input.bag.windowHeight),
    })
  }

  if (input.user) {
    headers['Gov-Client-User-IDs'] = keyValueHeader({ cactus: input.user.id })
  }

  if (input.usedMultiFactor) {
    // The reference is a hash, never the identifier itself, and the timestamp is
    // to the minute because that is the least precision HMRC's format allows.
    const at = input.multiFactorAt ?? now
    const reference = createHash('sha256')
      .update(`${input.user?.id ?? 'unknown'}:${at.toISOString().slice(0, 16)}`)
      .digest('hex')
    headers['Gov-Client-Multi-Factor'] = keyValueHeader({
      type: 'OTHER',
      timestamp: `${at.toISOString().slice(0, 16)}Z`,
      'unique-reference': reference,
    })
  }

  const vendorIp = await vendorPublicIp(info.host, settings.vendor_public_ip)
  if (vendorIp) headers['Gov-Vendor-Public-IP'] = vendorIp

  // Gov-Vendor-Forwarded: the hops between services that terminate TLS, each as
  // by=<receiver>&for=<sender>. Private-network hops are left out, and with one
  // public entry there is one hop to describe: the edge that answered for us,
  // receiving from the user.
  if (vendorIp && publicIp) {
    headers['Gov-Vendor-Forwarded'] = keyValueHeader({ by: vendorIp, for: publicIp })
  }

  return headers
}

/**
 * Which of HMRC's headers we could not fill in, and why, in plain English.
 * Shown in the settings tab so a missing value is something the owner can see
 * and ask about, rather than something that only surfaces ten working days into
 * a production approval application.
 */
export function describeMissingHeaders(headers: Record<string, string>): string[] {
  const notes: string[] = []
  if (!headers['Gov-Client-Public-IP']) {
    notes.push('Your own network address could not be read from this request.')
  }
  if (!headers['Gov-Vendor-Public-IP']) {
    notes.push('Your site’s public address could not be looked up from its web address.')
  }
  if (!headers['Gov-Client-Device-ID']) {
    notes.push('This browser has not been given a device identifier yet.')
  }
  if (!headers['Gov-Client-Multi-Factor']) {
    notes.push('This sign-in did not use a second factor, so none was declared.')
  }
  // Never sent, and this is not an oversight: the browser's own source port is
  // not visible to a serverless function, and HMRC's own specification allows
  // for a value that cannot be collected. Said out loud so nobody spends an
  // afternoon looking for where it went.
  notes.push('The port your browser connected from is not something this hosting can see, so it is left out.')
  return notes
}
