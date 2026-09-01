import { describe, expect, it } from 'vitest'
import { parseForwardedHeader, splitAddress } from '@/modules/uk-bookkeeping/lib/hmrc/forwarded'

// Gov-Client-Public-IP and Gov-Client-Public-Port both come out of the same
// string, and getting the split wrong is silent: a return files with an address
// of "198.51.100.0:54321", which is not an address, and nobody finds out until
// HMRC refuse a production approval months later.

describe('splitAddress', () => {
  it('takes an IPv4 address and its source port apart', () => {
    expect(splitAddress('198.51.100.0:54321')).toEqual({ ip: '198.51.100.0', port: 54321 })
  })

  it('leaves a bare IPv4 address alone', () => {
    expect(splitAddress('198.51.100.0')).toEqual({ ip: '198.51.100.0', port: null })
  })

  it('does not mistake an IPv6 address for an address and a port', () => {
    expect(splitAddress('2001:db8::1')).toEqual({ ip: '2001:db8::1', port: null })
  })

  it('reads a bracketed IPv6 address with a port', () => {
    expect(splitAddress('[2001:db8::1]:54321')).toEqual({ ip: '2001:db8::1', port: 54321 })
  })

  it('rejects a port outside HMRC’s 1 to 65535', () => {
    expect(splitAddress('198.51.100.0:0').port).toBeNull()
    expect(splitAddress('198.51.100.0:70000').port).toBeNull()
    expect(splitAddress('198.51.100.0:https').port).toBeNull()
  })

  it('has nothing to say about an empty entry', () => {
    expect(splitAddress('')).toEqual({ ip: null, port: null })
  })
})

describe('parseForwardedHeader', () => {
  it('reads a quoted RFC 7239 for= with a port', () => {
    expect(parseForwardedHeader('for="198.51.100.0:54321";proto=https')).toEqual({
      ip: '198.51.100.0',
      port: 54321,
    })
  })

  it('takes the leftmost hop, the one nearest the originating device', () => {
    expect(parseForwardedHeader('for="198.51.100.0:54321", for=203.0.113.6').ip).toBe('198.51.100.0')
  })

  it('returns nothing when the header is absent or carries no for=', () => {
    expect(parseForwardedHeader(null)).toEqual({ ip: null, port: null })
    expect(parseForwardedHeader('proto=https;host=example.com')).toEqual({ ip: null, port: null })
  })
})
