import { BookkeepingError } from '../errors'

// The limits HMRC's VAT (MTD) API puts on what you may ask it, checked against
// the published spec on 2026-08-21. Kept here, pure and tested, because every
// one of them is a 400 rather than a graceful answer and finding that out in
// production is an expensive way to read a specification.

/**
 * Obligations, liabilities and payments all cap the date range.
 *
 * The documented cap is 366 days. We use **365**, deliberately: HMRC's own
 * issue tracker carries a leap-year bug where a genuine 366-day range across a
 * leap year is rejected as INVALID_DATE_RANGE anyway. A day of extra history is
 * worth less than a request that works every February.
 */
export const MAX_RANGE_DAYS = 365

/** Nothing exists before MTD did; HMRC rejects an earlier `from` outright. */
export const EARLIEST_FROM = '2017-12-01'

const DAY_MS = 24 * 60 * 60 * 1000

export function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10)
}

export function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS)
}

export type DateRange = { from: string; to: string }

/**
 * Bring a range inside what HMRC will accept, rather than sending it and
 * getting a 400 with a message about date ranges.
 *
 * `to` is pulled back to today at the latest, `from` forward to the earliest
 * date the service knows about, and then the window is trimmed from the FAR end
 * - keeping the most recent days, which is what anybody looking at their VAT
 * account actually wants.
 */
export function clampRange(input: DateRange, today = new Date()): DateRange {
  const from = parseDateOnly(input.from)
  const to = parseDateOnly(input.to)
  if (!from || !to) {
    throw new BookkeepingError('invalid', 'Those dates are not ones we can read. Use YYYY-MM-DD.')
  }
  if (to.getTime() < from.getTime()) {
    throw new BookkeepingError('invalid', 'The end of that range comes before the start of it.')
  }

  const earliest = parseDateOnly(EARLIEST_FROM)!
  const latest = parseDateOnly(toDateOnly(today))!

  const clampedTo = to.getTime() > latest.getTime() ? latest : to
  let clampedFrom = from.getTime() < earliest.getTime() ? earliest : from

  if (daysBetween(clampedFrom, clampedTo) > MAX_RANGE_DAYS) {
    clampedFrom = new Date(clampedTo.getTime() - MAX_RANGE_DAYS * DAY_MS)
    if (clampedFrom.getTime() < earliest.getTime()) clampedFrom = earliest
  }

  return { from: toDateOnly(clampedFrom), to: toDateOnly(clampedTo) }
}

/**
 * A period key is exactly four characters, and some of them contain a `#`.
 *
 * Checked before a call rather than after one: an invalid key costs a round
 * trip and comes back as PERIOD_KEY_INVALID, which tells the owner nothing they
 * can act on. (The `#` is also why every key goes through encodeURIComponent on
 * its way into a URL path - unencoded it starts a fragment and silently
 * truncates the request.)
 */
export const PERIOD_KEY_PATTERN = /^[A-Za-z0-9#]{4}$/

export function assertValidPeriodKey(periodKey: string): void {
  if (!PERIOD_KEY_PATTERN.test(periodKey)) {
    throw new BookkeepingError(
      'invalid_period_key',
      `HMRC’s reference for this period ("${periodKey}") is not one they will accept. Refresh your obligations from HMRC and try again. Nothing has been sent.`,
    )
  }
}

/** Nine digits, no spaces. HMRC answers VRN_INVALID to anything else. */
export const VRN_PATTERN = /^\d{9}$/

export function assertValidVrn(vrn: string): void {
  if (!VRN_PATTERN.test(vrn)) {
    throw new BookkeepingError(
      'invalid_vrn',
      `"${vrn}" is not a VAT number HMRC will recognise - it should be nine digits. Check it in Settings. Nothing has been sent.`,
    )
  }
}
