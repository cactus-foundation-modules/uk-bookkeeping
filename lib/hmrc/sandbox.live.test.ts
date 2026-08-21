import { describe, it, expect } from 'vitest'
import { HMRC_ACCEPT, HMRC_HOSTS, encodePeriodKey } from './endpoints'

// Live probes against HMRC's sandbox at test-api.service.hmrc.gov.uk.
//
// Gated on RUN_HMRC_SANDBOX=1, so plain `npm test` never reaches the network.
// Two tiers, and the difference matters:
//
//   TIER 1 - no credentials. Proves the things that are ours to get wrong: that
//   every path this module calls is a real resource, that our Accept header
//   names a version HMRC actually serve, and that /oauth/token behaves the way
//   their documented examples imply. An unauthenticated call to a REAL resource
//   is answered 401; a call to a path that does not exist is answered 404. That
//   difference is what makes these tests discriminating rather than decorative.
//
//   TIER 2 - needs HMRC_CLIENT_ID and HMRC_CLIENT_SECRET from a sandbox
//   application. Runs HMRC's own fraud prevention header validator against a
//   real header bag.
//
// WHAT NEITHER TIER CAN PROVE, said plainly rather than left implied: every VAT
// endpoint is user-restricted, so obligations, submission and viewing a return
// need an access token, and getting one means a human signing in to the
// Government Gateway as a Developer Hub test user. That leg cannot be automated
// from here and is not pretended at. See the wiki page for the manual script.

const RUN = process.env.RUN_HMRC_SANDBOX === '1'
const HOST = HMRC_HOSTS.sandbox.api
const TIMEOUT = 30_000

/** A VRN that is well-formed but belongs to nobody. */
const DUMMY_VRN = '123456789'

type Probe = { status: number; code: string | null; body: unknown }

async function probe(path: string, init: RequestInit = {}): Promise<Probe> {
  const response = await fetch(`${HOST}${path}`, {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT),
  })
  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* HMRC answer JSON on every path we ask about; a non-JSON body is itself a finding. */
  }
  const code =
    body && typeof body === 'object' && 'code' in body ? String((body as { code: unknown }).code) : null
  return { status: response.status, code, body }
}

describe.skipIf(!RUN)('HMRC sandbox - contract probes (no credentials needed)', () => {
  it('answers the obligations path as a real resource', async () => {
    // 401 means "this resource exists, you just have not authenticated". A typo
    // in the path would be 404 MATCHING_RESOURCE_NOT_FOUND instead - which the
    // control below proves HMRC really do send.
    const result = await probe(`/organisations/vat/${DUMMY_VRN}/obligations?status=O`, {
      headers: { Accept: HMRC_ACCEPT },
    })
    expect(result.status).toBe(401)
    expect(result.code).toBe('MISSING_CREDENTIALS')
  }, TIMEOUT)

  it('answers a path we made up with 404, so the 401s above mean something', async () => {
    const result = await probe(`/organisations/vat/${DUMMY_VRN}/obligation-nonsense`, {
      headers: { Accept: HMRC_ACCEPT },
    })
    expect(result.status).toBe(404)
    expect(result.code).toBe('MATCHING_RESOURCE_NOT_FOUND')
  }, TIMEOUT)

  it('serves the API version our Accept header asks for', async () => {
    const ours = await probe(`/organisations/vat/${DUMMY_VRN}/obligations?status=O`, {
      headers: { Accept: HMRC_ACCEPT },
    })
    const unserved = await probe(`/organisations/vat/${DUMMY_VRN}/obligations?status=O`, {
      headers: { Accept: 'application/vnd.hmrc.9.0+json' },
    })

    // Measured, not assumed: HMRC answer an unserved VERSION the same way they
    // answer a path that does not exist - 404 MATCHING_RESOURCE_NOT_FOUND, not
    // the 406 that content negotiation might lead you to expect. Which makes
    // this a clean discriminator all the same: ours reaches the resource, a
    // wrong version does not.
    expect(unserved.status).toBe(404)
    expect(unserved.code).toBe('MATCHING_RESOURCE_NOT_FOUND')
    expect(ours.status).toBe(401)
    expect(ours.code).toBe('MISSING_CREDENTIALS')
  }, TIMEOUT)

  it('answers the returns path as a real resource', async () => {
    const result = await probe(`/organisations/vat/${DUMMY_VRN}/returns`, {
      method: 'POST',
      headers: { Accept: HMRC_ACCEPT, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(result.status).toBe(401)
  }, TIMEOUT)

  it('answers the view-return, liabilities and payments paths as real resources', async () => {
    const view = await probe(
      `/organisations/vat/${DUMMY_VRN}/returns/${encodePeriodKey('18A1')}`,
      { headers: { Accept: HMRC_ACCEPT } },
    )
    const liabilities = await probe(
      `/organisations/vat/${DUMMY_VRN}/liabilities?from=2025-01-01&to=2025-12-31`,
      { headers: { Accept: HMRC_ACCEPT } },
    )
    const payments = await probe(
      `/organisations/vat/${DUMMY_VRN}/payments?from=2025-01-01&to=2025-12-31`,
      { headers: { Accept: HMRC_ACCEPT } },
    )
    for (const result of [view, liabilities, payments]) {
      expect(result.status).toBe(401)
    }
  }, TIMEOUT)

  it('answers the fraud header validator path as a real resource', async () => {
    const result = await probe('/test/fraud-prevention-headers/validate', {
      headers: { Accept: HMRC_ACCEPT },
    })
    // Application-restricted rather than open, which is what we expect - it
    // still needs a client_credentials token.
    expect(result.status).toBe(401)
  }, TIMEOUT)

  it('keeps all four characters of a period key containing a #', () => {
    // Not a network test, but it belongs beside them: an unencoded # is read as
    // the start of a URL fragment and never leaves the machine, silently
    // truncating the path to .../returns/18A. This is the assertion that would
    // fail if encodePeriodKey were ever dropped.
    const encoded = new URL(`${HOST}/organisations/vat/${DUMMY_VRN}/returns/${encodePeriodKey('18A#')}`)
    const raw = new URL(`${HOST}/organisations/vat/${DUMMY_VRN}/returns/18A#`)
    expect(encoded.pathname.endsWith('/18A%23')).toBe(true)
    // The whole point: unencoded, the key HMRC gave us arrives one character
    // short and pointing at a different period.
    expect(raw.pathname.endsWith('/18A')).toBe(true)
    expect(raw.pathname).not.toContain('18A%23')
  })

  it('reaches the token endpoint with the request shape HMRC document', async () => {
    // Junk credentials, so the expected answer is a credential complaint. What
    // is being proved is that the endpoint is reached and the request shape is
    // acceptable - `invalid_client` means HMRC read the request and disliked
    // only the secret.
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'not-a-real-client',
      client_secret: 'not-a-real-secret',
    }).toString()

    const documented = await probe('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    expect(documented.status).toBe(401)
    expect((documented.body as { error?: string }).error).toBe('invalid_client')

    // The shape this module used to send. Measured rather than assumed, and the
    // measurement says it made NO difference - HMRC answer both identically.
    // Sending the documented shape is still right, because deviating from a
    // published example for no reason is how a thing breaks quietly later. But
    // it was a tidy-up, not a defect, and the record should say so.
    const versioned = await probe('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: HMRC_ACCEPT },
      body: form,
    })
    expect(versioned.status).toBe(documented.status)
  }, TIMEOUT)
})

// ---------------------------------------------------------------------------
// Tier 2 - needs a sandbox application's credentials
// ---------------------------------------------------------------------------

const HAS_CREDENTIALS = !!process.env.HMRC_CLIENT_ID && !!process.env.HMRC_CLIENT_SECRET

describe.skipIf(!RUN || !HAS_CREDENTIALS)('HMRC sandbox - fraud prevention headers', () => {
  it('gets a client_credentials token with the documented request shape', async () => {
    const response = await fetch(`${HOST}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.HMRC_CLIENT_ID!,
        client_secret: process.env.HMRC_CLIENT_SECRET!,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(typeof body.access_token).toBe('string')
  }, TIMEOUT)

  it('has HMRC validate a real fraud prevention header bag', async () => {
    const tokenResponse = await fetch(`${HOST}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.HMRC_CLIENT_ID!,
        client_secret: process.env.HMRC_CLIENT_SECRET!,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const { access_token: token } = await tokenResponse.json()

    // The bag the module would send, built by hand here because
    // buildFraudHeaders reaches for the database and this test has none.
    // Anything that changes there must change here too - which is the point:
    // this file is where a header format gets checked against HMRC rather than
    // against our own reading of their page.
    const now = new Date()
    const headers: Record<string, string> = {
      Accept: HMRC_ACCEPT,
      Authorization: `Bearer ${token}`,
      'Gov-Client-Connection-Method': 'WEB_APP_VIA_SERVER',
      'Gov-Client-Public-IP': '198.51.100.0',
      'Gov-Client-Public-IP-Timestamp': now.toISOString(),
      'Gov-Client-Device-ID': 'beec798b-b366-47fa-b1f8-92cede14a1ce',
      'Gov-Client-User-IDs': 'cactus=test-user',
      'Gov-Client-Timezone': 'UTC+00:00',
      'Gov-Client-Screens': 'width=1920&height=1080&scaling-factor=1&colour-depth=24',
      'Gov-Client-Window-Size': 'width=1256&height=803',
      'Gov-Client-Browser-JS-User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      'Gov-Client-Multi-Factor': `type=OTHER&timestamp=${encodeURIComponent(`${now.toISOString().slice(0, 16)}Z`)}&unique-reference=0283da60063abfb3a87f1aed845d17fe2d9ba8c780b478dc4ae048f5ee97a6d5`,
      'Gov-Vendor-Product-Name': 'Cactus%20Bookkeeping',
      'Gov-Vendor-Version': 'uk-bookkeeping=0.1.1',
      'Gov-Vendor-Public-IP': '203.0.113.6',
      'Gov-Vendor-Forwarded': 'by=203.0.113.6&for=198.51.100.0',
    }

    const response = await fetch(`${HOST}/test/fraud-prevention-headers/validate`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT),
    })
    const verdict = await response.json()
    console.log('[hmrc-sandbox] fraud header verdict:', JSON.stringify(verdict, null, 2))

    expect(response.status).toBe(200)
    // Errors are a failure; warnings are reported and tolerated, because some of
    // them are about values a serverless host genuinely cannot collect.
    expect(verdict.errors ?? []).toEqual([])
  }, TIMEOUT)
})
