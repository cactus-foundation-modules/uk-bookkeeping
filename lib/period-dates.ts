import type { PeriodFrequency } from './types'

// Date arithmetic for laying out VAT periods. Pure functions, no database, so
// the calendar rules can be tested to death without provisioning anything.
//
// The rules, checked against gov.uk on 2026-08-21:
//
// - Return periods end on the LAST DAY of a calendar month. Quarterly filers
//   sit in one of three "stagger groups" (periods ending Mar/Jun/Sep/Dec,
//   Apr/Jul/Oct/Jan or May/Aug/Nov/Feb), and can ask HMRC for whichever suits
//   their year end. Monthly and annual periods are month-end aligned too.
//
// - The FIRST period is the odd one out: it runs from the effective date of
//   registration to the end of the first stagger month, so it is routinely
//   longer or shorter than the frequency suggests. Registering on 10 July with
//   periods ending Oct/Jan/Apr/Jul gives a first period of 10 July to
//   31 October - not 9 October, which is what stepping three months from the
//   start date produces and what HMRC never issues.
//
// - A return and its payment are due one calendar month and 7 days after the
//   period ends. "A calendar month after" a month end means the end of the
//   FOLLOWING month: 31 March's return is due 7 May, 30 April's is due 7 June
//   (not 6 June), 31 October's is due 7 December.
//
// - The annual accounting scheme differs: the return is due 2 months after the
//   period ends, or 1 month when the period ran shorter than 4 months.

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Month arithmetic anchored to a fixed date, clamped to the month's length.
 *
 * setUTCMonth rolls over - 31 Jan + 1 month is 3 March - so iterating with it
 * skews every boundary after a short month. Anchoring at `anchor + months` and
 * clamping the day keeps 31 Jan → 28 Feb → 31 Mar, which is what a calendar
 * means by "a month later".
 */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear()
  const month = anchor.getUTCMonth() + months
  const day = anchor.getUTCDate()
  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return new Date(Date.UTC(year, month, Math.min(day, lastDayOfTarget)))
}

export function monthsPerPeriod(frequency: PeriodFrequency): number {
  return frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12
}

export function isMonthEnd(date: Date): boolean {
  return (
    date.getUTCDate() ===
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
  )
}

/** The last day of the month `months` on from this date's month. */
export function endOfMonthLater(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months + 1, 0))
}

/**
 * A calendar month (or several) on from a date, holding to the month END when
 * the date is one. This is HMRC's reading: a month after 30 April is 31 May,
 * not 30 May - which is why April's return is due 7 June. A mid-month date
 * (which HMRC does not issue, but a hand-typed setting can) steps clamped.
 */
export function addCalendarMonths(date: Date, months: number): Date {
  return isMonthEnd(date) ? endOfMonthLater(date, months) : addMonthsClamped(date, months)
}

/**
 * Our best guess at the first period's end when the owner has not set one: run
 * the full frequency from the start date, then out to that month's end.
 * Registration on 10 July, quarterly, gives 31 October - a three-and-a-bit
 * month first period, which is the shape HMRC actually issues. The Settings
 * field exists because the guess can still be a month out either way: HMRC
 * lets you pick your stagger group, and only their letter says which you got.
 */
export function defaultFirstPeriodEnd(firstStart: Date, months: number): Date {
  const naiveEnd = new Date(addMonthsClamped(firstStart, months).getTime() - DAY_MS)
  return endOfMonthLater(naiveEnd, 0)
}

/**
 * When a return must reach HMRC, from the period it covers.
 *
 * Standard (monthly and quarterly): one calendar month and 7 days after the
 * period ends - and the payment deadline is the same day.
 *
 * Annual accounting: 2 months after the period ends, or 1 month when the
 * period ran shorter than 4 months (both from gov.uk's scheme pages).
 */
export function dueDateFor(start: Date, end: Date, frequency: PeriodFrequency): Date {
  if (frequency === 'annual') {
    const fourMonthsIn = new Date(addMonthsClamped(start, 4).getTime() - DAY_MS)
    const shorterThanFourMonths = end.getTime() < fourMonthsIn.getTime()
    return addCalendarMonths(end, shorterThanFourMonths ? 1 : 2)
  }
  return new Date(addCalendarMonths(end, 1).getTime() + 7 * DAY_MS)
}

export type PeriodRange = { start: Date; end: Date; due: Date }

/**
 * Lay periods out, up to and including one past today.
 *
 * The first period is exactly [firstStart, firstEnd]. Every later period picks
 * up the next day and ends a frequency's worth of months on, anchored to
 * firstEnd rather than iterated from the previous end so a short month cannot
 * skew every boundary after it - and held to month ends, because that is the
 * only shape HMRC issues.
 */
export function layOutPeriods(options: {
  firstStart: Date
  firstEnd: Date | null
  frequency: PeriodFrequency
  today?: Date
}): PeriodRange[] {
  const months = monthsPerPeriod(options.frequency)
  const firstEnd = options.firstEnd ?? defaultFirstPeriodEnd(options.firstStart, months)
  if (firstEnd.getTime() < options.firstStart.getTime()) {
    throw new Error('The first VAT period cannot end before it starts.')
  }

  const horizon = addMonthsClamped(options.today ?? new Date(), months)

  // A guard rather than `while (true)`: a first period start set to 1970 by
  // accident should produce a refusal, not four hundred rows.
  const out: PeriodRange[] = []
  let previousEnd: Date | null = null
  for (let i = 0; i < 200; i += 1) {
    const start = i === 0 ? options.firstStart : new Date(previousEnd!.getTime() + DAY_MS)
    if (start.getTime() > horizon.getTime()) break
    const end = i === 0 ? firstEnd : addCalendarMonths(firstEnd, i * months)
    out.push({ start, end, due: dueDateFor(start, end, options.frequency) })
    previousEnd = end
  }
  return out
}
