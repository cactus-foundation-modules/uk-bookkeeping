import { describe, expect, it } from 'vitest'
import type { VatLiability } from '@/modules/uk-bookkeeping/lib/hmrc/client'
import { judgePeriodPayment, liabilityWindows } from '@/modules/uk-bookkeeping/lib/hmrc/payment-match'

const PERIOD = { start: '2026-04-01', end: '2026-06-30' }

function liability(over: Partial<VatLiability>): VatLiability {
  return {
    taxPeriodFrom: PERIOD.start,
    taxPeriodTo: PERIOD.end,
    type: 'VAT Return Debit Charge',
    originalAmount: '1000.00',
    outstandingAmount: '1000.00',
    due: '2026-08-07',
    ...over,
  }
}

describe('judgePeriodPayment', () => {
  it('calls it paid only when HMRC states an outstanding amount of nothing', () => {
    expect(judgePeriodPayment(PERIOD, [liability({ outstandingAmount: '0.00' })]).status).toBe('paid')
  })

  it('calls it unpaid when everything is still owed', () => {
    expect(judgePeriodPayment(PERIOD, [liability({})]).status).toBe('unpaid')
  })

  it('calls it part-paid when some of it is outstanding', () => {
    const verdict = judgePeriodPayment(PERIOD, [liability({ outstandingAmount: '250.50' })])
    expect(verdict).toMatchObject({ status: 'part_paid', outstandingAmount: '250.50' })
  })

  it('never says paid when HMRC has no liability for the period', () => {
    expect(judgePeriodPayment(PERIOD, []).status).toBe('unknown')
    expect(
      judgePeriodPayment(PERIOD, [liability({ taxPeriodFrom: '2026-01-01', taxPeriodTo: '2026-03-31' })]).status,
    ).toBe('unknown')
  })

  it('never says paid when the outstanding figure is missing', () => {
    expect(judgePeriodPayment(PERIOD, [liability({ outstandingAmount: null })]).status).toBe('unknown')
  })

  it('ignores a surcharge and refund charge on the same period', () => {
    const verdict = judgePeriodPayment(PERIOD, [
      liability({ outstandingAmount: '0.00' }),
      liability({ type: 'VAT Default Surcharge', outstandingAmount: '40.00', originalAmount: '40.00' }),
    ])
    expect(verdict.status).toBe('paid')
    expect(judgePeriodPayment(PERIOD, [liability({ type: 'VAT Return Credit Charge' })]).status).toBe('unknown')
  })

  it('adds several return charges for one period together', () => {
    const verdict = judgePeriodPayment(PERIOD, [
      liability({ originalAmount: '600.10', outstandingAmount: '0.00' }),
      liability({ originalAmount: '400.20', outstandingAmount: '0.10' }),
    ])
    expect(verdict).toMatchObject({ status: 'part_paid', originalAmount: '1000.30', outstandingAmount: '0.10' })
  })
})

describe('liabilityWindows', () => {
  it('splits a long span into windows HMRC will accept', () => {
    const windows = liabilityWindows('2024-01-01', '2026-01-01', 364)
    expect(windows[0]!.from).toBe('2024-01-01')
    expect(windows.at(-1)!.to).toBe('2026-01-01')
    for (const w of windows) {
      const days = (Date.parse(w.to) - Date.parse(w.from)) / 86_400_000
      expect(days).toBeLessThanOrEqual(364)
    }
  })

  it('gives one window for a short span', () => {
    expect(liabilityWindows('2026-01-01', '2026-03-01', 364)).toEqual([{ from: '2026-01-01', to: '2026-03-01' }])
  })
})
