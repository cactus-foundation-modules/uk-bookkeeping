import { describe, expect, it } from 'vitest'
import {
  addCalendarMonths,
  addMonthsClamped,
  defaultFirstPeriodEnd,
  dueDateFor,
  isMonthEnd,
  layOutPeriods,
  monthsPerPeriod,
} from './period-dates'

// The calendar rules, tested without a database. Every date HMRC issues is a
// month end, so most of what can go wrong here is month-end arithmetic - the
// 30/31 day boundary, February, and leap years.

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`)
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

describe('addMonthsClamped', () => {
  it('clamps into short months instead of rolling over', () => {
    expect(iso(addMonthsClamped(d('2026-01-31'), 1))).toBe('2026-02-28')
    expect(iso(addMonthsClamped(d('2026-01-31'), 2))).toBe('2026-03-31')
    expect(iso(addMonthsClamped(d('2028-01-31'), 1))).toBe('2028-02-29') // leap
  })
})

describe('isMonthEnd', () => {
  it('knows every month end, including February', () => {
    expect(isMonthEnd(d('2026-02-28'))).toBe(true)
    expect(isMonthEnd(d('2028-02-28'))).toBe(false) // leap year: 29 days
    expect(isMonthEnd(d('2028-02-29'))).toBe(true)
    expect(isMonthEnd(d('2026-10-31'))).toBe(true)
    expect(isMonthEnd(d('2026-10-30'))).toBe(false)
  })
})

describe('addCalendarMonths', () => {
  it('holds to the month end when starting from one', () => {
    // A month after 30 April is 31 May - HMRC's reading, and why April's
    // return is due 7 June rather than 6 June.
    expect(iso(addCalendarMonths(d('2026-04-30'), 1))).toBe('2026-05-31')
    expect(iso(addCalendarMonths(d('2026-11-30'), 1))).toBe('2026-12-31')
    expect(iso(addCalendarMonths(d('2026-12-31'), 2))).toBe('2027-02-28')
  })

  it('steps mid-month dates clamped', () => {
    expect(iso(addCalendarMonths(d('2026-11-09'), 3))).toBe('2027-02-09')
  })
})

describe('defaultFirstPeriodEnd', () => {
  it('runs the frequency out from the start, then to that month end', () => {
    // Registration 10 July, quarterly: three months lands on 9 October, and
    // HMRC's first period runs to that month's end - 31 October.
    expect(iso(defaultFirstPeriodEnd(d('2026-07-10'), 3))).toBe('2026-10-31')
    // Registration on the 1st: an exact quarter, already month-end shaped.
    expect(iso(defaultFirstPeriodEnd(d('2026-07-01'), 3))).toBe('2026-09-30')
    expect(iso(defaultFirstPeriodEnd(d('2026-07-10'), 1))).toBe('2026-08-31')
  })
})

describe('dueDateFor', () => {
  it('is one calendar month and 7 days after the period end', () => {
    expect(iso(dueDateFor(d('2026-01-01'), d('2026-03-31'), 'quarterly'))).toBe('2026-05-07')
    expect(iso(dueDateFor(d('2026-02-01'), d('2026-04-30'), 'quarterly'))).toBe('2026-06-07')
    expect(iso(dueDateFor(d('2026-09-01'), d('2026-11-30'), 'quarterly'))).toBe('2027-01-07')
    expect(iso(dueDateFor(d('2026-11-01'), d('2026-11-30'), 'monthly'))).toBe('2027-01-07')
  })

  it("covers the user-reported case: 10 Jul to 31 Oct is due 7 December", () => {
    expect(iso(dueDateFor(d('2026-07-10'), d('2026-10-31'), 'quarterly'))).toBe('2026-12-07')
  })

  it('annual accounting: 2 months after the end, 1 month when under 4 months', () => {
    expect(iso(dueDateFor(d('2026-01-01'), d('2026-12-31'), 'annual'))).toBe('2027-02-28')
    expect(iso(dueDateFor(d('2027-01-01'), d('2027-12-31'), 'annual'))).toBe('2028-02-29')
    // A short first annual period gets only a month.
    expect(iso(dueDateFor(d('2026-07-10'), d('2026-09-30'), 'annual'))).toBe('2026-10-31')
    // Exactly four months is not "less than 4 months".
    expect(iso(dueDateFor(d('2026-01-01'), d('2026-04-30'), 'annual'))).toBe('2026-06-30')
  })
})

describe('layOutPeriods', () => {
  it('lays the reported registration out the way HMRC does', () => {
    const periods = layOutPeriods({
      firstStart: d('2026-07-10'),
      firstEnd: d('2026-10-31'),
      frequency: 'quarterly',
      today: d('2026-08-21'),
    })
    expect(periods.map((p) => [iso(p.start), iso(p.end), iso(p.due)])).toEqual([
      ['2026-07-10', '2026-10-31', '2026-12-07'],
      ['2026-11-01', '2027-01-31', '2027-03-07'],
    ])
  })

  it('guesses the same layout when no first end is set', () => {
    const periods = layOutPeriods({
      firstStart: d('2026-07-10'),
      firstEnd: null,
      frequency: 'quarterly',
      today: d('2026-08-21'),
    })
    expect(iso(periods[0]!.end)).toBe('2026-10-31')
  })

  it('never drifts off month ends, whatever the month lengths', () => {
    const periods = layOutPeriods({
      firstStart: d('2026-07-10'),
      firstEnd: d('2026-10-31'),
      frequency: 'quarterly',
      today: d('2029-08-01'),
    })
    for (const p of periods.slice(1)) {
      expect(isMonthEnd(p.end)).toBe(true)
      expect(p.start.getUTCDate()).toBe(1)
    }
    // Anchored, not iterated: four quarters on is the same month end again.
    expect(iso(periods[4]!.end)).toBe('2027-10-31')
  })

  it('steps a hand-typed mid-month end clamped instead of inventing month ends', () => {
    const periods = layOutPeriods({
      firstStart: d('2026-07-10'),
      firstEnd: d('2026-11-09'),
      frequency: 'quarterly',
      today: d('2026-10-01'),
    })
    expect(periods.map((p) => [iso(p.start), iso(p.end)])).toEqual([
      ['2026-07-10', '2026-11-09'],
      ['2026-11-10', '2027-02-09'],
    ])
  })

  it('monthly periods follow calendar months after the first', () => {
    const periods = layOutPeriods({
      firstStart: d('2026-07-10'),
      firstEnd: d('2026-07-31'),
      frequency: 'monthly',
      today: d('2026-09-15'),
    })
    expect(periods.map((p) => [iso(p.start), iso(p.end), iso(p.due)])).toEqual([
      ['2026-07-10', '2026-07-31', '2026-09-07'],
      ['2026-08-01', '2026-08-31', '2026-10-07'],
      ['2026-09-01', '2026-09-30', '2026-11-07'],
      ['2026-10-01', '2026-10-31', '2026-12-07'],
    ])
  })

  it('refuses a first period that ends before it starts', () => {
    expect(() =>
      layOutPeriods({
        firstStart: d('2026-07-10'),
        firstEnd: d('2026-07-09'),
        frequency: 'quarterly',
        today: d('2026-08-21'),
      }),
    ).toThrow()
  })

  it('produces nothing when the first period has not started by the horizon', () => {
    const periods = layOutPeriods({
      firstStart: d('2027-06-01'),
      firstEnd: d('2027-09-30'),
      frequency: 'quarterly',
      today: d('2026-08-21'),
    })
    expect(periods).toEqual([])
  })
})

describe('monthsPerPeriod', () => {
  it('maps the three frequencies', () => {
    expect(monthsPerPeriod('monthly')).toBe(1)
    expect(monthsPerPeriod('quarterly')).toBe(3)
    expect(monthsPerPeriod('annual')).toBe(12)
  })
})
