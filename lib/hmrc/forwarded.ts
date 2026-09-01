// Reading the originating device's address AND source port off a proxied request.
//
// Gov-Client-Public-Port is the port the user's browser opened the connection
// FROM, and HMRC are explicit that it is never a server port - which rules out
// x-forwarded-port, the one header whose name suggests otherwise. It is the
// listening port of whatever answered, and sending it would be a wrong answer
// dressed as a right one.
//
// Two headers do carry the real thing, where the hosting in front of the app
// sets them:
//
//   Forwarded: for="198.51.100.0:12345"   (RFC 7239, quoted, IPv6 in brackets)
//   X-Forwarded-For: 198.51.100.0:12345   (some proxies append the source port)
//
// Neither is guaranteed. Where the port is not there it is left out rather than
// guessed, and the settings tab says so in plain English.

export type ForwardedClient = {
  ip: string | null
  port: number | null
}

/** `1.2.3.4:56789`, `[2001:db8::1]:56789`, or an address on its own. */
export function splitAddress(entry: string): ForwardedClient {
  const value = entry.trim().replace(/^"|"$/g, '')
  if (!value) return { ip: null, port: null }

  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(value)
  if (bracketed) return { ip: bracketed[1]!, port: toPort(bracketed[2]) }

  // A bare IPv6 address is full of colons, so only a single colon can be a port
  // separator. Anything else is an address and is returned whole.
  const colons = (value.match(/:/g) ?? []).length
  if (colons === 1) {
    const [host, port] = value.split(':')
    return { ip: host || null, port: toPort(port) }
  }
  return { ip: value, port: null }
}

function toPort(raw: string | undefined): number | null {
  if (!raw) return null
  const port = Number(raw)
  // HMRC's range, and their "never a server port" rule is why 0 is not accepted
  // either: a zero here means something failed to parse, not a real port.
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/**
 * The leftmost `for=` on an RFC 7239 Forwarded header.
 *
 * Leftmost for the same reason as x-forwarded-for: every hop appends itself, so
 * the first element is the originating device and the rest are infrastructure.
 */
export function parseForwardedHeader(header: string | null): ForwardedClient {
  if (!header) return { ip: null, port: null }
  const firstHop = header.split(',')[0] ?? ''
  for (const part of firstHop.split(';')) {
    const [key, ...rest] = part.split('=')
    if (key?.trim().toLowerCase() === 'for') return splitAddress(rest.join('='))
  }
  return { ip: null, port: null }
}
