import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import {
  computeCapitalAllowances,
  computeTax,
  financialYearOf,
  financialYearSlices,
  splitIntoTaxPeriods,
} from './corporation-tax'
import type { BkCtRateRow } from './types'

// The corporation tax arithmetic, tested without a database.
//
// Everything here is a pure function of dates, rates and figures, and every one
// of these cases is something that is genuinely easy to get wrong and expensive
// to get wrong: the financial year boundary at 1 April, a period of account
// longer than twelve months, marginal relief, associated companies halving the
// thresholds, and the capital allowance pools.
//
// Money is Prisma.Decimal throughout and never a JavaScript number. A test that
// compared 0.1 + 0.2 to 0.3 here would pass for the wrong reason and then miss
// the real thing.

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`)
const m = (value: string): Prisma.Decimal => new Prisma.Decimal(value)

/** The rates as they were from 1 April 2023: two rates and marginal relief. */
function modernRate(year: number): BkCtRateRow {
  return {
    financial_year: year,
    main_rate: m('25'),
    small_profits_rate: m('19'),
    lower_limit: m('50000'),
    upper_limit: m('250000'),
    mr_numerator: 3,
    mr_denominator: 200,
    aia_limit: m('1000000'),
    main_pool_wda: m('18'),
    special_pool_wda: m('6'),
    small_pool_limit: m('1000'),
    full_expensing_rate: m('100'),
    fya_special_rate: m('50'),
    notes: null,
    updated_at: new Date(),
  }
}

/** The rates as they were before that: one rate, no relief, no full expensing. */
function singleRate(year: number, rate = '19'): BkCtRateRow {
  return {
    ...modernRate(year),
    main_rate: m(rate),
    small_profits_rate: null,
    lower_limit: null,
    upper_limit: null,
    mr_numerator: null,
    mr_denominator: null,
    full_expensing_rate: null,
    fya_special_rate: null,
  }
}

describe('financial years', () => {
  it('names a financial year after the year it starts in', () => {
    // FY2025 runs 1 April 2025 to 31 March 2026, so a date in March 2026 is
    // still FY2025. This off-by-one is the whole reason the function exists.
    expect(financialYearOf(d('2025-04-01'))).toBe(2025)
    expect(financialYearOf(d('2026-03-31'))).toBe(2025)
    expect(financialYearOf(d('2026-04-01'))).toBe(2026)
    expect(financialYearOf(d('2026-01-15'))).toBe(2025)
  })

  it('splits a calendar year across the two financial years it touches', () => {
    const slices = financialYearSlices(d('2025-01-01'), d('2025-12-31'))
    expect(slices).toHaveLength(2)
    expect(slices[0]).toMatchObject({ financialYear: 2024, days: 90 }) // Jan to Mar
    expect(slices[1]).toMatchObject({ financialYear: 2025, days: 275 }) // Apr to Dec
    expect(slices[0]!.days + slices[1]!.days).toBe(365)
  })

  it('leaves a year running April to March in one financial year', () => {
    const slices = financialYearSlices(d('2025-04-01'), d('2026-03-31'))
    expect(slices).toHaveLength(1)
    expect(slices[0]).toMatchObject({ financialYear: 2025, days: 365 })
  })

  it('counts the extra day in a leap year', () => {
    const slices = financialYearSlices(d('2024-01-01'), d('2024-12-31'))
    expect(slices[0]!.days + slices[1]!.days).toBe(366)
  })
})

describe('splitting a long period of account', () => {
  it('leaves a twelve month period alone', () => {
    const spans = splitIntoTaxPeriods(d('2025-01-01'), d('2025-12-31'))
    expect(spans).toHaveLength(1)
  })

  it('splits eighteen months into twelve and the rest', () => {
    // A company's first period, or one where the year end moved. Two tax
    // periods, two returns, two payment dates - and missing that is how a
    // penalty arrives for the return nobody knew about.
    const spans = splitIntoTaxPeriods(d('2024-06-01'), d('2025-11-30'))
    expect(spans).toHaveLength(2)
    expect(spans[0]!.end.toISOString().slice(0, 10)).toBe('2025-05-31')
    expect(spans[1]!.start.toISOString().slice(0, 10)).toBe('2025-06-01')
    expect(spans[1]!.end.toISOString().slice(0, 10)).toBe('2025-11-30')
  })

  it('handles a period starting on 29 February', () => {
    const spans = splitIntoTaxPeriods(d('2024-02-29'), d('2025-06-30'))
    expect(spans[0]!.end.toISOString().slice(0, 10)).toBe('2025-02-28')
  })
})

describe('the tax itself', () => {
  const slices2025 = financialYearSlices(d('2025-04-01'), d('2026-03-31'))
  const rates2025 = new Map([[2025, modernRate(2025)]])

  const tax = (profit: string, options: Partial<Parameters<typeof computeTax>[0]> = {}) =>
    computeTax({
      taxableProfit: m(profit),
      frankedInvestmentIncome: m('0'),
      associatedCompanies: 0,
      slices: slices2025,
      rates: rates2025,
      periodDays: 365,
      ...options,
    })

  it('charges the small profits rate under the lower limit', () => {
    const result = tax('40000')
    expect(result.rows[0]!.basis).toBe('small')
    expect(result.rows[0]!.rate).toBe('19.00')
    expect(result.taxChargeable).toBe('7600.00')
    expect(result.totalMarginalRelief).toBe('0.00')
  })

  it('charges the main rate over the upper limit', () => {
    const result = tax('300000')
    expect(result.rows[0]!.basis).toBe('main')
    expect(result.taxChargeable).toBe('75000.00')
  })

  it('gives marginal relief between the two', () => {
    // £100,000: tax at 25% is £25,000, relief is 3/200 x (250,000 - 100,000)
    // x (100,000/100,000) = £2,250, so £22,750 - an effective 22.75%.
    const result = tax('100000')
    expect(result.rows[0]!.basis).toBe('marginal')
    expect(result.totalTax).toBe('25000.00')
    expect(result.totalMarginalRelief).toBe('2250.00')
    expect(result.taxChargeable).toBe('22750.00')
    expect(result.effectiveRate).toBe('22.75')
  })

  it('meets the small profits rate exactly at the lower limit', () => {
    // The boundary itself. £50,000 is IN the small profits band, not out of it,
    // and 19% of it is the same figure marginal relief gives at that point -
    // which is what makes the band continuous rather than a cliff edge.
    expect(tax('50000').taxChargeable).toBe('9500.00')
  })

  it('halves the thresholds when there is one associated company', () => {
    // £40,000 is under the £50,000 limit and taxed at 19% on its own. Add a
    // dormant company the same people own and the limit becomes £25,000, so the
    // same profit is now in the marginal band. This is the single most common
    // way a small company's corporation tax comes out wrong.
    const alone = tax('40000')
    const paired = tax('40000', { associatedCompanies: 1 })
    expect(alone.rows[0]!.basis).toBe('small')
    expect(paired.rows[0]!.basis).toBe('marginal')
    expect(paired.rows[0]!.lowerLimit).toBe('25000.00')
    expect(paired.rows[0]!.upperLimit).toBe('125000.00')
    expect(Number(paired.taxChargeable)).toBeGreaterThan(Number(alone.taxChargeable))
  })

  it('raises the rate on dividends received without taxing them', () => {
    // Augmented profits decide the RATE; taxable profits decide what the rate
    // is applied to. £45,000 of profit with £10,000 of dividends is taxed on
    // £45,000, but at marginal rates rather than the small profits rate.
    const plain = tax('45000')
    const withDividends = tax('45000', { frankedInvestmentIncome: m('10000') })
    expect(plain.rows[0]!.basis).toBe('small')
    expect(withDividends.rows[0]!.basis).toBe('marginal')
    expect(withDividends.taxableProfit).toBe('45000.00')
  })

  it('scales the thresholds down for a short period', () => {
    // Six months, so the limits halve. £30,000 in six months is over the
    // £25,000 the lower limit becomes.
    const halfYear = financialYearSlices(d('2025-04-01'), d('2025-09-30'))
    const result = computeTax({
      taxableProfit: m('30000'),
      frankedInvestmentIncome: m('0'),
      associatedCompanies: 0,
      slices: halfYear,
      rates: rates2025,
      periodDays: 183,
    })
    expect(result.rows[0]!.basis).toBe('marginal')
  })

  it('taxes each financial year at its own rate when a period straddles April', () => {
    // A calendar year 2023: three months at the old single 19% rate, nine at
    // the new two-rate regime. Apportioned by days, not by halves.
    const slices = financialYearSlices(d('2023-01-01'), d('2023-12-31'))
    const rates = new Map([
      [2022, singleRate(2022)],
      [2023, modernRate(2023)],
    ])
    const result = computeTax({
      taxableProfit: m('365000'),
      frankedInvestmentIncome: m('0'),
      associatedCompanies: 0,
      slices,
      rates,
      periodDays: 365,
    })
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]!.rate).toBe('19.00')
    expect(result.rows[0]!.basis).toBe('single')
    expect(result.rows[1]!.rate).toBe('25.00')
    // 90 days of £365,000 is £90,000, at 19% = £17,100.
    expect(result.rows[0]!.tax).toBe('17100.00')
  })

  it('says so rather than guessing when a year has no rates on record', () => {
    const result = computeTax({
      taxableProfit: m('100000'),
      frankedInvestmentIncome: m('0'),
      associatedCompanies: 0,
      slices: financialYearSlices(d('2035-04-01'), d('2036-03-31')),
      rates: new Map(),
      periodDays: 365,
    })
    expect(result.rows).toHaveLength(0)
    expect(result.taxChargeable).toBe('0.00')
    expect(result.warnings[0]).toContain('no corporation tax rates on record')
  })

  it('charges nothing on no profit', () => {
    expect(tax('0').taxChargeable).toBe('0.00')
  })
})

describe('capital allowances', () => {
  const slices = financialYearSlices(d('2025-04-01'), d('2026-03-31'))
  const rates = new Map([[2025, modernRate(2025)]])

  const run = (
    assets: {
      id: string
      cost: string
      ca_pool: 'aia' | 'full_expensing' | 'fya_special' | 'main' | 'special' | 'none'
      acquired: string
      disposed?: string
      proceeds?: string
    }[],
    options: { mainBf?: string; specialBf?: string; claimAia?: boolean; claimFe?: boolean } = {},
  ) =>
    computeCapitalAllowances({
      assets: assets.map((asset) => ({
        id: asset.id,
        cost: m(asset.cost),
        ca_pool: asset.ca_pool,
        acquired_date: d(asset.acquired),
        disposed_date: asset.disposed ? d(asset.disposed) : null,
        disposal_proceeds: asset.proceeds ? m(asset.proceeds) : null,
      })),
      start: d('2025-04-01'),
      end: d('2026-03-31'),
      slices,
      rates,
      mainPoolBf: m(options.mainBf ?? '0'),
      specialPoolBf: m(options.specialBf ?? '0'),
      claimAia: options.claimAia ?? true,
      claimFullExpensing: options.claimFe ?? true,
    })

  it('writes off a purchase in full under the annual investment allowance', () => {
    const result = run([{ id: 'a', cost: '12000', ca_pool: 'aia', acquired: '2025-06-01' }])
    expect(result.aiaClaimed).toBe('12000.00')
    expect(result.totalAllowances).toBe('12000.00')
    expect(result.mainPool.carriedForward).toBe('0.00')
  })

  it('spills anything over the cap into the main pool rather than losing it', () => {
    const result = run([{ id: 'a', cost: '1200000', ca_pool: 'aia', acquired: '2025-06-01' }])
    expect(result.aiaClaimed).toBe('1000000.00')
    expect(result.aiaSpilled).toBe('200000.00')
    // The £200,000 goes to the main pool and gets 18% of it this year.
    expect(result.mainPool.wda).toBe('36000.00')
    expect(result.mainPool.carriedForward).toBe('164000.00')
  })

  it('pro-rates the cap for a short period', () => {
    const halfYear = financialYearSlices(d('2025-04-01'), d('2025-09-30'))
    const result = computeCapitalAllowances({
      assets: [],
      start: d('2025-04-01'),
      end: d('2025-09-30'),
      slices: halfYear,
      rates,
      mainPoolBf: m('0'),
      specialPoolBf: m('0'),
      claimAia: true,
      claimFullExpensing: true,
    })
    // 183 days of a £1,000,000 annual cap.
    expect(result.aiaLimit).toBe('501369.86')
  })

  it('writes down the main pool at 18% and the special pool at 6%', () => {
    const result = run([], { mainBf: '10000', specialBf: '10000' })
    expect(result.mainPool.wda).toBe('1800.00')
    expect(result.specialPool.wda).toBe('600.00')
    expect(result.mainPool.carriedForward).toBe('8200.00')
    expect(result.specialPool.carriedForward).toBe('9400.00')
  })

  it('writes a small pool off in one go', () => {
    // £900 left in the pool. Nobody should spend thirty years writing down the
    // last few pounds of a filing cabinet.
    const result = run([], { mainBf: '900' })
    expect(result.mainPool.smallPoolWriteOff).toBe(true)
    expect(result.mainPool.wda).toBe('900.00')
    expect(result.mainPool.carriedForward).toBe('0.00')
  })

  it('takes a disposal out of the pool at proceeds capped at cost', () => {
    // Sold for more than it cost. Only the cost comes out of the pool; the
    // excess is a chargeable gain, which is a different tax and a different box.
    const result = run(
      [{ id: 'a', cost: '5000', ca_pool: 'main', acquired: '2020-01-01', disposed: '2025-08-01', proceeds: '7000' }],
      { mainBf: '20000' },
    )
    expect(result.mainPool.disposals).toBe('5000.00')
    expect(result.mainPool.beforeWda).toBe('15000.00')
  })

  it('turns a pool driven below nothing into a balancing charge', () => {
    const result = run(
      [{ id: 'a', cost: '9000', ca_pool: 'main', acquired: '2020-01-01', disposed: '2025-08-01', proceeds: '9000' }],
      { mainBf: '4000' },
    )
    expect(result.mainPool.balancingCharge).toBe('5000.00')
    expect(result.mainPool.carriedForward).toBe('0.00')
    expect(result.totalBalancingCharges).toBe('5000.00')
  })

  it('gives full expensing on new main rate plant', () => {
    const result = run([{ id: 'a', cost: '80000', ca_pool: 'full_expensing', acquired: '2025-06-01' }])
    expect(result.fullExpensing).toBe('80000.00')
    expect(result.totalAllowances).toBe('80000.00')
  })

  it('charges the whole disposal value when something that had full expensing is sold', () => {
    // The trade for having had all of it up front: there is no pool for the
    // proceeds to come out of, so they are taxable in one go.
    const result = run([
      { id: 'a', cost: '80000', ca_pool: 'full_expensing', acquired: '2024-06-01', disposed: '2025-08-01', proceeds: '30000' },
    ])
    expect(result.fullExpensingBalancingCharge).toBe('30000.00')
  })

  it('gives half of a special rate first year allowance and pools the rest', () => {
    const result = run([{ id: 'a', cost: '20000', ca_pool: 'fya_special', acquired: '2025-06-01' }])
    expect(result.fyaSpecial).toBe('10000.00')
    // The other £10,000 joins the special rate pool and gets 6% of it.
    expect(result.specialPool.additions).toBe('10000.00')
    expect(result.specialPool.wda).toBe('600.00')
  })

  it('sends purchases to the main pool when the allowance is disclaimed', () => {
    // A company may disclaim, and sometimes should, to keep the relief for a
    // year when the rate is higher.
    const result = run([{ id: 'a', cost: '12000', ca_pool: 'aia', acquired: '2025-06-01' }], { claimAia: false })
    expect(result.aiaClaimed).toBe('0.00')
    expect(result.mainPool.additions).toBe('12000.00')
    expect(result.mainPool.wda).toBe('2160.00')
  })

  it('ignores an asset bought after the period ended', () => {
    const result = run([{ id: 'a', cost: '12000', ca_pool: 'aia', acquired: '2026-06-01' }])
    expect(result.aiaClaimed).toBe('0.00')
  })

  it('pools full expensing purchases in a year before it existed', () => {
    const oldSlices = financialYearSlices(d('2021-04-01'), d('2022-03-31'))
    const result = computeCapitalAllowances({
      assets: [
        {
          id: 'a',
          cost: m('50000'),
          ca_pool: 'full_expensing',
          acquired_date: d('2021-06-01'),
          disposed_date: null,
          disposal_proceeds: null,
        },
      ],
      start: d('2021-04-01'),
      end: d('2022-03-31'),
      slices: oldSlices,
      rates: new Map([[2021, singleRate(2021)]]),
      mainPoolBf: m('0'),
      specialPoolBf: m('0'),
      claimAia: true,
      claimFullExpensing: true,
    })
    expect(result.fullExpensing).toBe('0.00')
    expect(result.mainPool.additions).toBe('50000.00')
    expect(result.notes.join(' ')).toContain('did not exist')
  })
})
