// HMRC fraud prevention headers - the specification, transcribed.
//
// SOURCE, and this citation is the point of the file:
//   HMRC Developer Hub, "Send fraud prevention data", connection method
//   WEB_APP_VIA_SERVER
//   https://developer.service.hmrc.gov.uk/guides/fraud-prevention/connection-method/web-app-via-server/
//   Read in full on 2026-08-20. Sixteen headers, listed below in the order the
//   page gives them, with the formats and examples that page specifies.
//
// This is not written from memory and must never be edited from memory. Getting
// it wrong does not fail a build; it fails a production approval application,
// ten working days later. Before changing anything here, re-read the page, note
// the date you read it, and validate a real request against HMRC's Test Fraud
// Prevention Headers endpoint.
//
// Note what is NOT in this set, because earlier drafts of this module's plan
// assumed otherwise: Gov-Client-Local-IPs, Gov-Client-Local-IPs-Timestamp,
// Gov-Client-Browser-Plugins and Gov-Client-Browser-Do-Not-Track do not appear
// on the WEB_APP_VIA_SERVER page at all. Sending headers this connection method
// does not ask for is not a way of being helpful.

export const FRAUD_SPEC_SOURCE =
  'https://developer.service.hmrc.gov.uk/guides/fraud-prevention/connection-method/web-app-via-server/'

/** The date the page above was last read in full and this file checked against it. */
export const FRAUD_SPEC_READ_ON = '2026-08-20'

export const CONNECTION_METHOD = 'WEB_APP_VIA_SERVER'

export type FraudHeaderSource = 'browser' | 'request' | 'server' | 'session' | 'static'

export type FraudHeaderSpec = {
  name: string
  source: FraudHeaderSource
  /**
   * False only where HMRC's page marks the value as one that cannot always be
   * collected (a connection over a private network, or software with no licence
   * keys). Everything else must be sent.
   */
  alwaysAvailable: boolean
  format: string
  example: string
}

export const FRAUD_HEADERS: FraudHeaderSpec[] = [
  {
    name: 'Gov-Client-Connection-Method',
    source: 'static',
    alwaysAvailable: true,
    format: 'One of HMRC’s connection method constants.',
    example: 'WEB_APP_VIA_SERVER',
  },
  {
    name: 'Gov-Client-Browser-JS-User-Agent',
    source: 'browser',
    alwaysAvailable: true,
    format: 'The user agent string as JavaScript on the originating device reports it.',
    example:
      'Mozilla/5.0 (iPad; U; CPU OS 3_2_1 like Mac OS X; en-us) AppleWebKit/531.21.10 (KHTML, like Gecko) Mobile/7B405',
  },
  {
    name: 'Gov-Client-Device-ID',
    source: 'browser',
    alwaysAvailable: true,
    format: 'A UUID, stored persistently on the device. It should not expire.',
    example: 'beec798b-b366-47fa-b1f8-92cede14a1ce',
  },
  {
    name: 'Gov-Client-Multi-Factor',
    source: 'session',
    alwaysAvailable: false,
    format:
      'Comma-separated key-value structures: type=TOTP|AUTH_CODE|OTHER, timestamp (UTC, at least yyyy-MM-ddThh:mmZ), unique-reference (hashed). Percent encode every key and value, never the separators.',
    example:
      'type=AUTH_CODE&timestamp=2021-11-21T13%3A23Z&unique-reference=fc4b5fd6816f75a7c81fc8eaa9499d6a299bd803397166e8c4cf9280b801d62c',
  },
  {
    name: 'Gov-Client-Public-IP',
    source: 'request',
    alwaysAvailable: false,
    format: 'The public IPv4 or IPv6 address the originating device made the request from.',
    example: '198.51.100.0',
  },
  {
    name: 'Gov-Client-Public-IP-Timestamp',
    source: 'request',
    alwaysAvailable: true,
    format: 'UTC, yyyy-MM-ddThh:mm:ss.sssZ, seconds and milliseconds included with trailing zeros.',
    example: '2020-09-21T14:30:05.123Z',
  },
  {
    name: 'Gov-Client-Public-Port',
    source: 'request',
    alwaysAvailable: false,
    format: 'The public TCP port the originating device used. 1 to 65535, and never a server port.',
    example: '12345',
  },
  {
    name: 'Gov-Client-Screens',
    source: 'browser',
    alwaysAvailable: true,
    format:
      'Comma-separated key-value structures: width, height (pixels, whole numbers), scaling-factor (decimal), colour-depth (bits).',
    example: 'width=1920&height=1080&scaling-factor=1&colour-depth=16',
  },
  {
    name: 'Gov-Client-Timezone',
    source: 'browser',
    alwaysAvailable: true,
    format: 'UTC±<hh>:<mm>.',
    example: 'UTC+00:00',
  },
  {
    name: 'Gov-Client-User-IDs',
    source: 'session',
    alwaysAvailable: true,
    format:
      'Key-value pairs, the key naming the account type. Percent encode every key and value, never the separators.',
    example: 'my-application=alice123',
  },
  {
    name: 'Gov-Client-Window-Size',
    source: 'browser',
    alwaysAvailable: true,
    format: 'width and height in pixels, both positive whole numbers.',
    example: 'width=1256&height=803',
  },
  {
    name: 'Gov-Vendor-Forwarded',
    source: 'request',
    alwaysAvailable: false,
    format:
      'Comma-separated hops, each by=<receiving server IP>&for=<sending IP>. Percent encode keys and values, never the separators. Hops inside a private network are left out.',
    example: 'by=203.0.113.6&for=198.51.100.0',
  },
  {
    name: 'Gov-Vendor-License-IDs',
    source: 'server',
    alwaysAvailable: false,
    format:
      'software-name=hashed-licence-value pairs, hashed consistently. Percent encode keys and values, never the separators.',
    example: 'my-licensed-software=8D7963490527D33716835EE7C195516D5E562E03B224E9B359836466EE40CDE1',
  },
  {
    name: 'Gov-Vendor-Product-Name',
    source: 'server',
    alwaysAvailable: true,
    format: 'The product name as it is marketed to end users, percent encoded.',
    example: 'Product%20Name',
  },
  {
    name: 'Gov-Vendor-Public-IP',
    source: 'server',
    alwaysAvailable: false,
    format: 'The public IP address of the servers the originating device sent its request to.',
    example: '203.0.113.6',
  },
  {
    name: 'Gov-Vendor-Version',
    source: 'server',
    alwaysAvailable: true,
    format:
      'software-name=version-number pairs. Percent encode every key and value, never the separators.',
    example: 'my-web-app=2.2.2',
  },
]

/** Headers that must be present on every call, whatever else is missing. */
export const REQUIRED_HEADER_NAMES = FRAUD_HEADERS.filter((h) => h.alwaysAvailable).map((h) => h.name)

/**
 * Percent encoding for one key or one value in a key-value header.
 *
 * encodeURIComponent leaves ! ' ( ) * alone, which HMRC's "percent encode every
 * key and value" does not, and a stray apostrophe in a product name is exactly
 * the sort of thing that fails an approval rather than a build.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** `key=value&key=value`, encoded per the rule above, separators left alone. */
export function keyValueHeader(pairs: Record<string, string | number | undefined | null>): string {
  return Object.entries(pairs)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(String(value))}`)
    .join('&')
}

/** The timestamp format HMRC asks for: milliseconds, with trailing zeros kept. */
export function fraudTimestamp(date: Date): string {
  return date.toISOString().replace(/(\.\d{3})Z$/, '$1Z')
}

/** `UTC+00:00` / `UTC-01:15` from a JavaScript offset in minutes. */
export function formatTimezoneOffset(offsetMinutes: number): string {
  // getTimezoneOffset is minutes BEHIND UTC, so its sign is the wrong way round.
  const total = -offsetMinutes
  const sign = total < 0 ? '-' : '+'
  const absolute = Math.abs(total)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}
