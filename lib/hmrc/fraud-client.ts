'use client'

// The browser half of the fraud prevention headers.
//
// Everything here is something only the originating device can see, and the
// server therefore cannot invent: the persistent device identifier, the
// timezone, the screens, the window, and the user agent as JavaScript reports
// it. It travels to our own API in the request body and is turned into headers
// server-side (lib/hmrc/fraud-headers.ts).
//
// Deliberately NOT collected: the public IP and port. Those come from the
// incoming request's own headers, because a value the client can choose is not
// evidence of anything.

const DEVICE_ID_KEY = 'cactus-bookkeeping-device-id'

export type FraudBag = {
  deviceId?: string
  timezoneOffsetMinutes?: number
  screens?: { width: number; height: number; scalingFactor: number; colourDepth: number }[]
  windowWidth?: number
  windowHeight?: number
  userAgent?: string
}

/**
 * A UUID kept in localStorage, generated once and never regenerated. HMRC's
 * specification says it "should not expire", so this is not a session value and
 * clearing it is the browser's business, not ours.
 */
export function getDeviceId(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY)
    if (existing) return existing
    const created =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
    window.localStorage.setItem(DEVICE_ID_KEY, created)
    return created
  } catch {
    // Private browsing with storage blocked. The header is simply not sent
    // rather than a fresh identifier being minted on every call, which would be
    // worse than none: it would look like a new device each time.
    return undefined
  }
}

export function collectFraudBag(): FraudBag {
  if (typeof window === 'undefined') return {}

  const screens = window.screen
    ? [
        {
          width: window.screen.width,
          height: window.screen.height,
          scalingFactor: window.devicePixelRatio || 1,
          colourDepth: window.screen.colorDepth || 24,
        },
      ]
    : undefined

  return {
    deviceId: getDeviceId(),
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    screens,
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    userAgent: window.navigator.userAgent,
  }
}

/**
 * Every call to this module's HMRC routes goes through here, so no caller has to
 * remember to attach the bag - and a caller that forgot would produce a call
 * missing half its headers, which fails an approval rather than a build.
 */
export async function hmrcFetch(path: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body ?? {}), fraudBag: collectFraudBag() }),
  })
}
