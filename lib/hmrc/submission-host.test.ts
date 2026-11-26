import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSubmissionHost, submissionHostFor, WrongHostError } from './submission-host'
import { toErrorResponse } from '../errors'

const saved = process.env.CACTUS_HOST_DIRECT_HOSTS

function request(host: string, referer?: string): Request {
  const headers = new Headers({ host })
  if (referer) headers.set('referer', referer)
  return new Request(`https://${host}/api/m/uk-bookkeeping/admin/periods/p1/submit`, { method: 'POST', headers })
}

describe('submission host', () => {
  beforeEach(() => {
    process.env.CACTUS_HOST_DIRECT_HOSTS = 'Books.Example.co.uk, other.example.co.uk'
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.CACTUS_HOST_DIRECT_HOSTS
    else process.env.CACTUS_HOST_DIRECT_HOSTS = saved
  })

  it('does nothing when the site has no direct hostname', () => {
    delete process.env.CACTUS_HOST_DIRECT_HOSTS
    expect(submissionHostFor(new Headers({ host: 'example.co.uk' }))).toBeNull()
    expect(() => assertSubmissionHost(request('example.co.uk'))).not.toThrow()
  })

  it('lets a call through from any listed direct hostname, port and case ignored', () => {
    expect(() => assertSubmissionHost(request('books.example.co.uk'))).not.toThrow()
    expect(submissionHostFor(new Headers({ host: 'OTHER.example.co.uk:443' }))).toBeNull()
  })

  it('refuses the proxied address and names the first direct hostname, back on the same screen', () => {
    try {
      assertSubmissionHost(request('example.co.uk', 'https://example.co.uk/hq/m/uk-bookkeeping/vat/p1?x=1'))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(WrongHostError)
      expect((error as WrongHostError).url).toBe('https://books.example.co.uk/hq/m/uk-bookkeeping/vat/p1?x=1')
      expect((error as WrongHostError).message).toContain('books.example.co.uk')
    }
  })

  it('falls back to the home page when there is no referer, and hands the link to the screen', async () => {
    let caught: unknown
    try {
      assertSubmissionHost(request('www.example.co.uk'))
    } catch (error) {
      caught = error
    }
    const response = toErrorResponse(caught)
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe('wrong_host')
    expect(body.url).toBe('https://books.example.co.uk/')
  })
})
