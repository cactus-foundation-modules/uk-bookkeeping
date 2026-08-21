import { Prisma } from '@prisma/client'
import type { SessionUser } from '@/lib/auth/session'
import { prisma } from '@/lib/db/prisma'
import { requireAccountingPeriod } from './accounting-periods'
import { appendAudit } from './audit'
import { BookkeepingError, NotFoundError, PeriodStateError } from './errors'
import { accountBalances } from './ledger'
import { countToDecimal, formatMoney, formatPounds, toMoney } from './money'
import { profitAndLoss } from './reports'
import { getSettings } from './settings'
import type {
  BkCtAdjustmentRow,
  BkCtComputationRow,
  BkCtRateRow,
  CapitalAllowancePool,
  CtAdjustmentKind,
  Money,
} from './types'

// Corporation tax: from the ledger to the CT600 boxes.
//
// The rule this file keeps is the one the VAT half keeps: no figure that goes
// to HMRC is ever typed by a human. The computation is a function of the
// ledger, the fixed asset register, the rates table and a list of named
// adjustments, and every one of those is a record somebody can go and look at.
// What the owner types is a judgement - "£340 of that was entertaining" - never
// an answer.
//
// WHAT THIS DOES NOT DO. It does not file. There is no HMRC API a small company
// can self-file corporation tax through, the way there is for VAT; filing goes
// through HMRC's own online service or commercial software. So what comes out
// of here is the computation and the box numbers to copy across, and the screen
// says exactly that rather than implying otherwise.
//
// WHAT IT DELIBERATELY LEAVES ALONE. Research and development relief, patent
// box, group relief arithmetic, ring fence trades, Northern Ireland rates,
// loans to participators, structures and buildings allowance, and the
// super-deduction. Each of those is a specialism with its own supplementary
// pages, and a half-implementation of one would be worse than an honest
// absence: it would look like an answer. Every one of them can still be entered
// as a named adjustment, which puts it on the computation with a reason
// attached and leaves the arithmetic to the person who knows it.
//
// Box numbers throughout are CT600 (2015) Version 3, which is the form in use
// for accounting periods starting on or after 1 April 2015. They are stated
// where each figure is worked out rather than collected in a mapping table at
// the end, so a figure and its box cannot drift apart.

const DAY = 86_400_000
const iso = (date: Date): string => date.toISOString().slice(0, 10)
const utc = (year: number, month: number, day: number): Date => new Date(Date.UTC(year, month, day))

function daysInclusive(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY) + 1
}

/**
 * Profits and income go on the return in whole pounds, rounded down.
 *
 * Rounding down rather than to nearest, because HMRC's own guidance is that a
 * figure may be rounded in the company's favour and this is the one direction
 * that cannot produce an underpayment argument over a penny.
 */
function poundsDown(value: Money): Money {
  return value.toDecimalPlaces(0, Prisma.Decimal.ROUND_FLOOR)
}

/** Tax itself carries pence. */
function pence(value: Money): Money {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}

const ZERO = toMoney('0.00')
const max0 = (value: Money): Money => (value.isNegative() ? ZERO : value)

// ---------------------------------------------------------------------------
// Financial years
// ---------------------------------------------------------------------------

/**
 * A corporation tax financial year runs 1 April to 31 March and is named after
 * the year it STARTS in: FY2025 is 1 April 2025 to 31 March 2026.
 *
 * An accounting period that crosses 1 April therefore falls in two of them and
 * has to be apportioned by days across both, at each year's own rates and with
 * each year's limits scaled to the days that fall in it. That is why this is a
 * table keyed by year rather than four numbers in the settings.
 */
export function financialYearOf(date: Date): number {
  const year = date.getUTCFullYear()
  // Before 1 April, the date belongs to the financial year that began last April.
  return date.getUTCMonth() < 3 ? year - 1 : year
}

export type FySlice = { financialYear: number; from: Date; to: Date; days: number }

/** The financial years an accounting period touches, and how many days in each. */
export function financialYearSlices(start: Date, end: Date): FySlice[] {
  const slices: FySlice[] = []
  let cursor = start
  while (cursor.getTime() <= end.getTime()) {
    const fy = financialYearOf(cursor)
    const fyEnd = utc(fy + 1, 2, 31) // 31 March of the following calendar year
    const to = fyEnd.getTime() < end.getTime() ? fyEnd : end
    slices.push({ financialYear: fy, from: cursor, to, days: daysInclusive(cursor, to) })
    cursor = new Date(to.getTime() + DAY)
  }
  return slices
}

/**
 * A corporation tax accounting period can never be longer than twelve months.
 *
 * A company that changes its year end, or has a first period running from
 * incorporation to its first year end, routinely has a period of account longer
 * than that - and it becomes TWO tax periods: the first twelve months, and the
 * rest. Two computations, two returns, two payment dates. Missing this is how a
 * company ends up filing one return for eighteen months and getting a penalty
 * for the one it did not file.
 */
export function splitIntoTaxPeriods(start: Date, end: Date): { start: Date; end: Date }[] {
  const twelveMonthEnd = new Date(
    Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()),
  )
  twelveMonthEnd.setUTCDate(twelveMonthEnd.getUTCDate() - 1)
  if (end.getTime() <= twelveMonthEnd.getTime()) return [{ start, end }]
  return [
    { start, end: twelveMonthEnd },
    { start: new Date(twelveMonthEnd.getTime() + DAY), end },
  ]
}

export async function getRates(years: number[]): Promise<Map<number, BkCtRateRow>> {
  if (years.length === 0) return new Map()
  const rows = await prisma.$queryRaw<BkCtRateRow[]>`
    SELECT * FROM "bk_ct_rates" WHERE "financial_year" = ANY(${years}::int[])
  `
  return new Map(rows.map((row) => [row.financial_year, row]))
}

export async function listRates(): Promise<BkCtRateRow[]> {
  return prisma.$queryRaw<BkCtRateRow[]>`
    SELECT * FROM "bk_ct_rates" ORDER BY "financial_year" DESC
  `
}

// ---------------------------------------------------------------------------
// Capital allowances
// ---------------------------------------------------------------------------

export type PoolWorkings = {
  label: string
  broughtForward: string
  additions: string
  disposals: string
  /** After additions and disposals, before the writing down allowance. */
  beforeWda: string
  wdaRate: string
  wda: string
  /** Set when the pool went negative, which is a charge rather than an allowance. */
  balancingCharge: string
  smallPoolWriteOff: boolean
  carriedForward: string
}

export type CapitalAllowances = {
  /** The annual investment allowance cap for this period, after pro-rating. */
  aiaLimit: string
  aiaClaimed: string
  aiaSpilled: string
  fullExpensing: string
  fyaSpecial: string
  mainPool: PoolWorkings
  specialPool: PoolWorkings
  /** Disposals of assets that got full expensing: an immediate charge, not a pool movement. */
  fullExpensingBalancingCharge: string
  totalAllowances: string
  totalBalancingCharges: string
  mainPoolCf: string
  specialPoolCf: string
  /** Qualifying expenditure by pool, for the CT600's allowances pages. */
  additionsByPool: Record<CapitalAllowancePool, string>
  notes: string[]
}

type AssetForCa = {
  id: string
  cost: Money
  ca_pool: CapitalAllowancePool
  acquired_date: Date
  disposed_date: Date | null
  disposal_proceeds: Money | null
}

/**
 * The capital allowances for a period, from the fixed asset register.
 *
 * The shape of it: what was bought goes into a pool (or gets written off in one
 * go by the annual investment allowance or full expensing), what was sold comes
 * out of that pool at its proceeds capped at what it cost, and what is left in
 * the pool gets a percentage written off. What survives is carried into next
 * year.
 *
 * The pro-rating is the part that is easy to get wrong: both the annual
 * investment allowance cap and the writing down percentages are annual figures
 * and are scaled by the length of the accounting period. A six month period
 * gets half the cap and half the writing down allowance.
 *
 * Where a period straddles two financial years with different figures - the
 * special rate pool went from 8% to 6% in April 2019, for instance - the rate
 * used is the days-weighted average across the years, which is HMRC's hybrid
 * rate approach for exactly that situation.
 */
export function computeCapitalAllowances(input: {
  assets: AssetForCa[]
  start: Date
  end: Date
  slices: FySlice[]
  rates: Map<number, BkCtRateRow>
  mainPoolBf: Money
  specialPoolBf: Money
  claimAia: boolean
  claimFullExpensing: boolean
}): CapitalAllowances {
  const { assets, start, end, slices, rates, mainPoolBf, specialPoolBf } = input
  const periodDays = daysInclusive(start, end)
  const notes: string[] = []

  // Days-weighted figures across the financial years the period touches.
  const weighted = (pick: (rate: BkCtRateRow) => Money | null): Money =>
    slices.reduce<Money>((running, slice) => {
      const rate = rates.get(slice.financialYear)
      const value = rate ? pick(rate) : null
      if (!rate || value === null) {
        if (!notes.includes(`No rates on record for the year to 31 March ${slice.financialYear + 1}.`)) {
          notes.push(`No rates on record for the year to 31 March ${slice.financialYear + 1}.`)
        }
        return running
      }
      return running.plus(toMoney(value).times(countToDecimal(slice.days)).dividedBy(periodDays))
    }, ZERO)

  const proRata = countToDecimal(periodDays).dividedBy(365)
  const aiaLimit = weighted((rate) => rate.aia_limit).times(proRata).toDecimalPlaces(2)
  const mainWdaRate = weighted((rate) => rate.main_pool_wda)
  const specialWdaRate = weighted((rate) => rate.special_pool_wda)
  const smallPoolLimit = weighted((rate) => rate.small_pool_limit).times(proRata)
  const fullExpensingAvailable = slices.every((slice) => rates.get(slice.financialYear)?.full_expensing_rate)
  const fyaSpecialRate = weighted((rate) => rate.fya_special_rate ?? toMoney('0'))

  const inPeriod = (date: Date | null): boolean =>
    !!date && date.getTime() >= start.getTime() && date.getTime() <= end.getTime()

  const additions: Record<CapitalAllowancePool, Money> = {
    aia: ZERO,
    full_expensing: ZERO,
    fya_special: ZERO,
    main: ZERO,
    special: ZERO,
    none: ZERO,
  }
  let mainDisposals = ZERO
  let specialDisposals = ZERO
  let feCharge = ZERO

  for (const asset of assets) {
    if (inPeriod(asset.acquired_date)) {
      additions[asset.ca_pool] = additions[asset.ca_pool].plus(toMoney(asset.cost))
    }
    if (inPeriod(asset.disposed_date) && asset.disposal_proceeds !== null) {
      // Never bring in more than the asset cost. Anything above cost is a
      // chargeable gain, not a capital allowances disposal - a different tax
      // and a different box.
      const proceeds = toMoney(asset.disposal_proceeds)
      const capped = proceeds.greaterThan(toMoney(asset.cost)) ? toMoney(asset.cost) : proceeds
      switch (asset.ca_pool) {
        case 'full_expensing':
          // Selling something that had full expensing brings an immediate
          // balancing charge for the whole disposal value. There is no pool for
          // it to come out of, which is the trade for having had all of it up
          // front.
          feCharge = feCharge.plus(capped)
          break
        case 'special':
        case 'fya_special':
          specialDisposals = specialDisposals.plus(capped)
          break
        default:
          mainDisposals = mainDisposals.plus(capped)
      }
    }
  }

  // Annual investment allowance, capped, with anything over the cap falling
  // into the main pool rather than being lost.
  let aiaClaimed = ZERO
  let aiaSpilled = ZERO
  if (input.claimAia) {
    aiaClaimed = additions.aia.greaterThan(aiaLimit) ? aiaLimit : additions.aia
    aiaSpilled = additions.aia.minus(aiaClaimed)
    if (aiaSpilled.greaterThan(0)) {
      notes.push(
        `£${formatMoney(aiaSpilled)} of purchases was over the annual investment allowance cap for this period and has gone into the main pool instead.`,
      )
    }
  } else {
    aiaSpilled = additions.aia
    notes.push('The annual investment allowance was not claimed, so those purchases went to the main pool.')
  }

  // Full expensing: the whole cost, first year, new main-rate plant only.
  let fullExpensing = ZERO
  let feToMain = ZERO
  if (input.claimFullExpensing && fullExpensingAvailable) {
    fullExpensing = additions.full_expensing
  } else {
    feToMain = additions.full_expensing
    if (feToMain.greaterThan(0)) {
      notes.push(
        fullExpensingAvailable
          ? 'Full expensing was not claimed, so those purchases went to the main pool.'
          : 'Full expensing did not exist for this period, so those purchases went to the main pool.',
      )
    }
  }

  // 50% first year allowance on new special rate plant; the other half joins
  // the special rate pool.
  const fyaSpecial = additions.fya_special.times(fyaSpecialRate).dividedBy(100).toDecimalPlaces(2)
  const fyaSpecialRemainder = additions.fya_special.minus(fyaSpecial)

  const runPool = (
    label: string,
    broughtForward: Money,
    poolAdditions: Money,
    disposals: Money,
    wdaRate: Money,
  ): PoolWorkings => {
    const beforeWda = broughtForward.plus(poolAdditions).minus(disposals)
    let wda = ZERO
    let balancingCharge = ZERO
    let smallPoolWriteOff = false

    if (beforeWda.isNegative()) {
      // A pool that has gone below nothing means more was taken out than was
      // ever put in: the excess is taxable, and the pool restarts at nil.
      balancingCharge = beforeWda.negated()
    } else if (beforeWda.greaterThan(0) && beforeWda.lessThanOrEqualTo(smallPoolLimit)) {
      // The small pools allowance. Nobody should spend thirty years writing
      // down the last four pounds of a filing cabinet.
      wda = beforeWda
      smallPoolWriteOff = true
    } else {
      wda = beforeWda.times(wdaRate).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_FLOOR)
    }

    return {
      label,
      broughtForward: formatMoney(broughtForward),
      additions: formatMoney(poolAdditions),
      disposals: formatMoney(disposals),
      beforeWda: formatMoney(beforeWda),
      wdaRate: formatMoney(wdaRate),
      wda: formatMoney(wda),
      balancingCharge: formatMoney(balancingCharge),
      smallPoolWriteOff,
      carriedForward: formatMoney(balancingCharge.isZero() ? beforeWda.minus(wda) : ZERO),
    }
  }

  const mainPool = runPool(
    'Main pool',
    toMoney(mainPoolBf),
    additions.main.plus(aiaSpilled).plus(feToMain),
    mainDisposals,
    mainWdaRate,
  )
  const specialPool = runPool(
    'Special rate pool',
    toMoney(specialPoolBf),
    additions.special.plus(fyaSpecialRemainder),
    specialDisposals,
    specialWdaRate,
  )

  const totalAllowances = aiaClaimed
    .plus(fullExpensing)
    .plus(fyaSpecial)
    .plus(toMoney(mainPool.wda))
    .plus(toMoney(specialPool.wda))
  const totalBalancingCharges = feCharge
    .plus(toMoney(mainPool.balancingCharge))
    .plus(toMoney(specialPool.balancingCharge))

  return {
    aiaLimit: formatMoney(aiaLimit),
    aiaClaimed: formatMoney(aiaClaimed),
    aiaSpilled: formatMoney(aiaSpilled),
    fullExpensing: formatMoney(fullExpensing),
    fyaSpecial: formatMoney(fyaSpecial),
    mainPool,
    specialPool,
    fullExpensingBalancingCharge: formatMoney(feCharge),
    totalAllowances: formatMoney(totalAllowances),
    totalBalancingCharges: formatMoney(totalBalancingCharges),
    mainPoolCf: mainPool.carriedForward,
    specialPoolCf: specialPool.carriedForward,
    additionsByPool: {
      aia: formatMoney(additions.aia),
      full_expensing: formatMoney(additions.full_expensing),
      fya_special: formatMoney(additions.fya_special),
      main: formatMoney(additions.main),
      special: formatMoney(additions.special),
      none: formatMoney(additions.none),
    },
    notes,
  }
}

// ---------------------------------------------------------------------------
// The tax itself
// ---------------------------------------------------------------------------

export type FyTaxRow = {
  financialYear: number
  days: number
  /** The share of taxable profit apportioned to this financial year. */
  profit: string
  rate: string
  tax: string
  marginalRelief: string
  lowerLimit: string | null
  upperLimit: string | null
  /** Which of the three ways this year's slice was taxed, in a word. */
  basis: 'small' | 'marginal' | 'main' | 'single'
}

export type TaxCalculation = {
  taxableProfit: string
  augmentedProfit: string
  associatedCompanies: number
  rows: FyTaxRow[]
  totalTax: string
  totalMarginalRelief: string
  taxChargeable: string
  /** The rate the company actually ended up paying, for the screen. */
  effectiveRate: string
  smallProfitsOrMarginal: boolean
  warnings: string[]
}

/**
 * The tax on a taxable total profit, across the financial years the period
 * touches.
 *
 * Three ways a slice can be taxed, and the only thing that decides which is the
 * AUGMENTED profit - the taxable profit plus dividends received from companies
 * that are not part of the same group:
 *
 *   at or under the lower limit  the small profits rate, 19%
 *   at or over the upper limit   the main rate, 25%
 *   in between                   the main rate, less marginal relief
 *
 * Marginal relief is F x (U - A) x N/A, where F is the standard fraction
 * (3/200), U the upper limit, A the augmented profit and N the taxable profit.
 * Both limits are scaled by the length of the period and divided between the
 * company and its associated companies.
 *
 * The associated companies part is the one that catches small companies out. A
 * one-person company that also owns a dormant one has its limits halved, so it
 * hits marginal rates at £25,000 instead of £50,000. The module cannot know
 * about the other company, so it asks, and it says why on the screen.
 */
export function computeTax(input: {
  taxableProfit: Money
  frankedInvestmentIncome: Money
  associatedCompanies: number
  slices: FySlice[]
  rates: Map<number, BkCtRateRow>
  periodDays: number
}): TaxCalculation {
  const { taxableProfit, frankedInvestmentIncome, associatedCompanies, slices, rates } = input
  const augmented = taxableProfit.plus(frankedInvestmentIncome)
  const divisor = countToDecimal(associatedCompanies + 1)
  const warnings: string[] = []
  const rows: FyTaxRow[] = []

  let totalTax = ZERO
  let totalRelief = ZERO
  let smallOrMarginal = false

  for (const slice of slices) {
    const rate = rates.get(slice.financialYear)
    if (!rate) {
      warnings.push(
        `There are no corporation tax rates on record for the year to 31 March ${slice.financialYear + 1}, so ${slice.days} day${slice.days === 1 ? '' : 's'} of this period could not be taxed. This site's copy of the rates stops before then and needs updating.`,
      )
      continue
    }

    const share = countToDecimal(slice.days).dividedBy(input.periodDays)
    const slicedProfit = taxableProfit.times(share)
    const slicedAugmented = augmented.times(share)

    // The limits, scaled for the days in this financial year and shared with
    // any associated companies.
    const scale = countToDecimal(slice.days).dividedBy(365).dividedBy(divisor)
    const lower = rate.lower_limit ? toMoney(rate.lower_limit).times(scale) : null
    const upper = rate.upper_limit ? toMoney(rate.upper_limit).times(scale) : null
    const mainRate = toMoney(rate.main_rate)
    const smallRate = rate.small_profits_rate ? toMoney(rate.small_profits_rate) : null

    let appliedRate = mainRate
    let relief = ZERO
    let basis: FyTaxRow['basis'] = 'single'

    if (smallRate && lower && upper) {
      if (slicedAugmented.lessThanOrEqualTo(lower)) {
        appliedRate = smallRate
        basis = 'small'
        smallOrMarginal = true
      } else if (slicedAugmented.greaterThanOrEqualTo(upper)) {
        basis = 'main'
      } else {
        basis = 'marginal'
        smallOrMarginal = true
        // F x (U - A) x N/A. Guard the division: augmented cannot be zero here,
        // because it is strictly above the lower limit, but a rates row edited
        // to a zero lower limit could make it so and a division by zero would
        // take the whole page down.
        if (rate.mr_numerator && rate.mr_denominator && !slicedAugmented.isZero()) {
          relief = countToDecimal(rate.mr_numerator)
            .dividedBy(rate.mr_denominator)
            .times(upper.minus(slicedAugmented))
            .times(slicedProfit.dividedBy(slicedAugmented))
        } else {
          warnings.push(
            `The year to 31 March ${slice.financialYear + 1} has no marginal relief fraction on record, so no relief has been given for it.`,
          )
        }
      }
    }

    const tax = pence(slicedProfit.times(appliedRate).dividedBy(100))
    relief = pence(max0(relief))
    totalTax = totalTax.plus(tax)
    totalRelief = totalRelief.plus(relief)

    rows.push({
      financialYear: slice.financialYear,
      days: slice.days,
      profit: formatMoney(poundsDown(slicedProfit)),
      rate: formatMoney(appliedRate),
      tax: formatMoney(tax),
      marginalRelief: formatMoney(relief),
      lowerLimit: lower ? formatMoney(lower) : null,
      upperLimit: upper ? formatMoney(upper) : null,
      basis,
    })
  }

  const chargeable = pence(max0(totalTax.minus(totalRelief)))
  const effectiveRate = taxableProfit.greaterThan(0)
    ? chargeable.dividedBy(taxableProfit).times(100).toDecimalPlaces(2)
    : ZERO

  return {
    taxableProfit: formatMoney(taxableProfit),
    augmentedProfit: formatMoney(augmented),
    associatedCompanies,
    rows,
    totalTax: formatMoney(totalTax),
    totalMarginalRelief: formatMoney(totalRelief),
    taxChargeable: formatMoney(chargeable),
    effectiveRate: formatMoney(effectiveRate),
    smallProfitsOrMarginal: smallOrMarginal,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Putting the computation together
// ---------------------------------------------------------------------------

export type WorkingLine = { label: string; amount: string; note?: string }

export type Computation = {
  id: string
  start: string
  end: string
  days: number
  status: 'draft' | 'final'
  companyName: string | null
  /** From the accounts, before tax. Where every computation starts. */
  profitPerAccounts: string
  turnover: string
  addBacks: WorkingLine[]
  totalAddBacks: string
  deductions: WorkingLine[]
  totalDeductions: string
  /** Income taken out of the trade because it is taxed under another heading. */
  removedFromTrade: WorkingLine[]
  capitalAllowances: CapitalAllowances
  tradingProfit: string
  tradingLoss: string
  lossesBroughtForward: string
  lossesUsed: string
  netTradingProfit: string
  nonTradeIncome: string
  propertyIncome: string
  otherIncome: string
  chargeableGains: string
  profitsBeforeReliefs: string
  managementExpenses: string
  lossesCurrentYear: string
  qualifyingDonations: string
  groupRelief: string
  taxableTotalProfits: string
  frankedInvestmentIncome: string
  tax: TaxCalculation
  lossesCarriedForward: string
  mainPoolCf: string
  specialPoolCf: string
  /** CT600 (2015) Version 3 boxes, keyed by box number, as decimal strings. */
  boxes: Record<string, string>
  warnings: string[]
}

/** Sum the adjustments of one kind. */
function sumKind(adjustments: BkCtAdjustmentRow[], kind: CtAdjustmentKind): Money {
  return adjustments
    .filter((row) => row.kind === kind)
    .reduce<Money>((running, row) => running.plus(toMoney(row.amount)), ZERO)
}

function linesOf(adjustments: BkCtAdjustmentRow[], kind: CtAdjustmentKind): WorkingLine[] {
  return adjustments
    .filter((row) => row.kind === kind)
    .map((row) => ({ label: row.label, amount: formatMoney(row.amount), note: row.note ?? undefined }))
}

/**
 * Work out one computation, from end to end.
 *
 * Nothing here is stored while it runs: the same function produces what the
 * screen shows and what gets frozen on the computation when it is finished, so
 * those two cannot be different figures.
 */
export async function computeCorporationTax(
  computationId: string,
): Promise<Computation> {
  const row = await requireComputation(computationId)
  const adjustments = await listAdjustments(computationId)
  const settings = await getSettings()

  const start = row.start_date
  const end = row.end_date
  const periodDays = daysInclusive(start, end)
  const slices = financialYearSlices(start, end)
  const rates = await getRates(slices.map((slice) => slice.financialYear))
  const warnings: string[] = []

  if (periodDays > 366) {
    warnings.push(
      'This computation covers more than twelve months. A corporation tax period cannot, so it needs splitting into two.',
    )
  }

  // --- Where every computation starts: the profit in the accounts -----------
  const pl = await profitAndLoss(start, end, { comparative: false })
  const profitBeforeTax = toMoney(
    pl.subtotals.find((subtotal) => subtotal.key === 'profit-before-tax')?.amount ?? '0',
  )
  const turnover = toMoney(pl.sections.find((section) => section.key === 'turnover')?.total ?? '0')

  // --- Add backs the module works out for itself ----------------------------
  // Every account carries what percentage of it the taxman disallows.
  // Depreciation is 100 because capital allowances take its place; client
  // entertaining is 100 because it simply is not allowed. Anything else is
  // whatever the owner set on the account, and it shows here by name.
  const balances = await accountBalances(iso(end), iso(start))
  const autoAddBacks: WorkingLine[] = []
  for (const account of balances) {
    if (account.kind !== 'expense') continue
    const percent = toMoney(account.disallowablePercent)
    if (percent.isZero()) continue
    const amount = toMoney(account.balance).times(percent).dividedBy(100).toDecimalPlaces(2)
    if (amount.isZero()) continue
    autoAddBacks.push({
      label: account.name,
      amount: formatMoney(amount),
      note: percent.equals(100) ? 'Not allowed at all' : `${formatMoney(percent)}% of it is not allowed`,
    })
  }

  const manualAddBacks = linesOf(adjustments, 'add_back')
  const addBacks = [...autoAddBacks, ...manualAddBacks]
  const totalAddBacks = addBacks.reduce<Money>((running, line) => running.plus(toMoney(line.amount)), ZERO)

  const deductions = linesOf(adjustments, 'deduction')
  const totalDeductions = sumKind(adjustments, 'deduction')

  // --- Income that is taxed under another heading ---------------------------
  // Bank interest and rent sit in the profit and loss account, so they are in
  // the profit above - but for tax they come out of the trade and go on their
  // own line of the return.
  const groupTotal = (group: string): Money =>
    balances
      .filter((account) => account.reportGroup === group)
      .reduce<Money>((running, account) => running.plus(toMoney(account.balance)), ZERO)

  const ledgerNonTrade = groupTotal('non-trade-income')
  const ledgerProperty = groupTotal('property-income')
  const removedFromTrade: WorkingLine[] = []
  if (!ledgerNonTrade.isZero()) {
    removedFromTrade.push({
      label: 'Interest and other non-trading income',
      amount: formatMoney(ledgerNonTrade),
      note: 'Taxed on its own line rather than as trade',
    })
  }
  if (!ledgerProperty.isZero()) {
    removedFromTrade.push({ label: 'Income from property', amount: formatMoney(ledgerProperty) })
  }

  // --- Capital allowances ---------------------------------------------------
  const assets = await prisma.$queryRaw<AssetForCa[]>`
    SELECT "id", "cost", "ca_pool", "acquired_date", "disposed_date", "disposal_proceeds"
    FROM "bk_fixed_assets"
    WHERE "acquired_date" <= ${end}::date
    ORDER BY "acquired_date" ASC
  `
  const ca = computeCapitalAllowances({
    assets,
    start,
    end,
    slices,
    rates,
    mainPoolBf: toMoney(row.main_pool_bf),
    specialPoolBf: toMoney(row.special_pool_bf),
    claimAia: row.claim_aia,
    claimFullExpensing: row.claim_full_expensing,
  })
  const capitalAllowances = toMoney(ca.totalAllowances).plus(sumKind(adjustments, 'capital_allowance'))
  const balancingCharges = toMoney(ca.totalBalancingCharges).plus(sumKind(adjustments, 'balancing_charge'))

  // --- Trading profit -------------------------------------------------------
  const tradingResult = profitBeforeTax
    .plus(totalAddBacks)
    .minus(totalDeductions)
    .minus(ledgerNonTrade)
    .minus(ledgerProperty)
    .minus(capitalAllowances)
    .plus(balancingCharges)

  const tradingProfit = max0(tradingResult) // CT600 box 155
  const tradingLoss = max0(tradingResult.negated()) // CT600 box 780

  // --- Losses brought forward ----------------------------------------------
  // Used automatically up to the trading profit, unless the owner has said how
  // much to use - which they might, to keep some back for a year at a higher
  // rate. Either way it can never exceed the profit there is to relieve.
  const lossesBf = toMoney(row.losses_bf)
  const requested = adjustments.some((adjustment) => adjustment.kind === 'loss_bf')
    ? sumKind(adjustments, 'loss_bf')
    : lossesBf
  const lossesUsed = [requested, lossesBf, tradingProfit].reduce((smallest, value) =>
    value.lessThan(smallest) ? value : smallest,
  )
  const netTradingProfit = tradingProfit.minus(lossesUsed) // box 165

  // --- The other headings ---------------------------------------------------
  const nonTradeIncome = ledgerNonTrade.plus(sumKind(adjustments, 'non_trade_income')) // box 170
  const propertyIncome = ledgerProperty.plus(sumKind(adjustments, 'property_income')) // box 190
  const otherIncome = sumKind(adjustments, 'other_income') // box 205
  const chargeableGains = sumKind(adjustments, 'chargeable_gain') // boxes 210 and 220

  const profitsBeforeReliefs = netTradingProfit
    .plus(nonTradeIncome)
    .plus(propertyIncome)
    .plus(otherIncome)
    .plus(chargeableGains) // box 235

  const managementExpenses = sumKind(adjustments, 'management_expenses') // box 245
  const lossesCurrentYear = sumKind(adjustments, 'loss_cy') // box 275
  const totalReliefs = managementExpenses.plus(lossesCurrentYear) // box 295
  const profitsBeforeDonations = max0(profitsBeforeReliefs.minus(totalReliefs)) // box 300

  const qualifyingDonations = sumKind(adjustments, 'qualifying_donations') // box 305
  const groupRelief = sumKind(adjustments, 'group_relief') // box 310
  const taxableTotalProfits = max0(
    profitsBeforeDonations.minus(qualifyingDonations).minus(groupRelief),
  ) // box 315

  const frankedInvestmentIncome = sumKind(adjustments, 'franked_investment_income') // box 620

  // --- The tax --------------------------------------------------------------
  const tax = computeTax({
    taxableProfit: poundsDown(taxableTotalProfits),
    frankedInvestmentIncome: poundsDown(frankedInvestmentIncome),
    associatedCompanies: row.associated_companies,
    slices,
    rates,
    periodDays,
  })
  warnings.push(...tax.warnings, ...ca.notes)

  // --- What carries into next year ------------------------------------------
  const lossesCarriedForward = lossesBf.minus(lossesUsed).plus(tradingLoss).minus(lossesCurrentYear)

  // --- The boxes ------------------------------------------------------------
  // CT600 (2015) Version 3. Whole pounds on the profit boxes, pence on the tax.
  const box = (value: Money): string => formatMoney(poundsDown(value))
  const boxes: Record<string, string> = {
    '145': box(turnover),
    '155': box(tradingProfit),
    '160': box(lossesUsed),
    '165': box(netTradingProfit),
    '170': box(nonTradeIncome),
    '190': box(propertyIncome),
    '205': box(otherIncome),
    '210': box(chargeableGains),
    '220': box(chargeableGains),
    '235': box(profitsBeforeReliefs),
    '245': box(managementExpenses),
    '275': box(lossesCurrentYear),
    '295': box(totalReliefs),
    '300': box(profitsBeforeDonations),
    '305': box(qualifyingDonations),
    '310': box(groupRelief),
    '315': box(taxableTotalProfits),
    '326': String(row.associated_companies),
    '329': tax.smallProfitsOrMarginal ? 'X' : '',
    '430': tax.totalTax,
    '435': tax.totalMarginalRelief,
    '440': tax.taxChargeable,
    // No reliefs in terms of tax are modelled, so 470 is nil and 475 follows
    // 440 straight through. Stated rather than skipped, because a blank box on
    // a return somebody is copying from is a question, and a nil is an answer.
    '470': '0.00',
    '475': tax.taxChargeable,
    '510': tax.taxChargeable,
    '515': '0.00',
    '525': tax.taxChargeable,
    '528': tax.taxChargeable,
    '620': box(frankedInvestmentIncome),
    // Capital allowances and charges in the calculation of trading profits.
    '690': formatMoney(poundsDown(toMoney(ca.aiaClaimed))),
    '688': formatMoney(poundsDown(toMoney(ca.fullExpensing))),
    '689': formatMoney(poundsDown(toMoney(ca.fullExpensingBalancingCharge))),
    '693': formatMoney(poundsDown(toMoney(ca.fyaSpecial))),
    '695': formatMoney(poundsDown(toMoney(ca.specialPool.wda))),
    '700': formatMoney(poundsDown(toMoney(ca.specialPool.balancingCharge))),
    '705': formatMoney(poundsDown(toMoney(ca.mainPool.wda))),
    '710': formatMoney(poundsDown(toMoney(ca.mainPool.balancingCharge))),
    // Qualifying expenditure.
    '760': formatMoney(
      poundsDown(toMoney(ca.additionsByPool.full_expensing).plus(toMoney(ca.additionsByPool.fya_special))),
    ),
    '773': formatMoney(poundsDown(toMoney(ca.additionsByPool.fya_special))),
    '775': formatMoney(
      poundsDown(toMoney(ca.additionsByPool.aia).plus(toMoney(ca.additionsByPool.main))),
    ),
    // Losses arising in the period, for the memorandum at the back.
    '780': box(tradingLoss),
  }

  // The financial year rows, boxes 330 to 345 for the first year and 380 to 395
  // for the second. The form has room for two, which is all an accounting
  // period can ever touch.
  const [first, second] = tax.rows
  if (first) {
    boxes['330'] = String(first.financialYear)
    boxes['335'] = first.profit
    boxes['340'] = first.rate
    boxes['345'] = first.tax
  }
  if (second) {
    boxes['380'] = String(second.financialYear)
    boxes['385'] = second.profit
    boxes['390'] = second.rate
    boxes['395'] = second.tax
  }
  if (row.associated_companies > 0 && tax.rows.length > 1) {
    boxes['327'] = String(row.associated_companies)
    boxes['328'] = String(row.associated_companies)
  }

  return {
    id: row.id,
    start: iso(start),
    end: iso(end),
    days: periodDays,
    status: row.status,
    companyName: settings.business_name,
    profitPerAccounts: formatMoney(profitBeforeTax),
    turnover: formatMoney(turnover),
    addBacks,
    totalAddBacks: formatMoney(totalAddBacks),
    deductions,
    totalDeductions: formatMoney(totalDeductions),
    removedFromTrade,
    capitalAllowances: ca,
    tradingProfit: formatMoney(tradingProfit),
    tradingLoss: formatMoney(tradingLoss),
    lossesBroughtForward: formatMoney(lossesBf),
    lossesUsed: formatMoney(lossesUsed),
    netTradingProfit: formatMoney(netTradingProfit),
    nonTradeIncome: formatMoney(nonTradeIncome),
    propertyIncome: formatMoney(propertyIncome),
    otherIncome: formatMoney(otherIncome),
    chargeableGains: formatMoney(chargeableGains),
    profitsBeforeReliefs: formatMoney(profitsBeforeReliefs),
    managementExpenses: formatMoney(managementExpenses),
    lossesCurrentYear: formatMoney(lossesCurrentYear),
    qualifyingDonations: formatMoney(qualifyingDonations),
    groupRelief: formatMoney(groupRelief),
    taxableTotalProfits: formatMoney(taxableTotalProfits),
    frankedInvestmentIncome: formatMoney(frankedInvestmentIncome),
    tax,
    lossesCarriedForward: formatMoney(max0(lossesCarriedForward)),
    mainPoolCf: ca.mainPoolCf,
    specialPoolCf: ca.specialPoolCf,
    boxes,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function listComputations(): Promise<
  (BkCtComputationRow & { period_name: string })[]
> {
  return prisma.$queryRaw<(BkCtComputationRow & { period_name: string })[]>`
    SELECT c.*, p."name" AS period_name
    FROM "bk_ct_computations" c
    JOIN "bk_accounting_periods" p ON p."id" = c."accounting_period_id"
    ORDER BY c."start_date" DESC
  `
}

export async function getComputation(id: string): Promise<BkCtComputationRow | null> {
  const rows = await prisma.$queryRaw<BkCtComputationRow[]>`
    SELECT * FROM "bk_ct_computations" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ?? null
}

export async function requireComputation(id: string): Promise<BkCtComputationRow> {
  const row = await getComputation(id)
  if (!row) throw new NotFoundError('That tax computation')
  return row
}

export async function listAdjustments(computationId: string): Promise<BkCtAdjustmentRow[]> {
  return prisma.$queryRaw<BkCtAdjustmentRow[]>`
    SELECT * FROM "bk_ct_adjustments" WHERE "computation_id" = ${computationId}
    ORDER BY "position" ASC, "created_at" ASC
  `
}

/**
 * Start the computations for a financial year.
 *
 * Plural, because a period of account longer than twelve months is two tax
 * periods and therefore two returns. The split happens here rather than being
 * left to the owner to notice.
 *
 * The pool balances and losses carried in are taken from the last computation
 * that ended before this one starts, so the only time anybody types them is the
 * first year - when the books genuinely were somewhere else.
 */
export async function createComputationsForPeriod(
  accountingPeriodId: string,
  user: SessionUser | null,
): Promise<BkCtComputationRow[]> {
  const period = await requireAccountingPeriod(accountingPeriodId)
  const [existing] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "bk_ct_computations" WHERE "accounting_period_id" = ${accountingPeriodId} LIMIT 1
  `
  if (existing) {
    throw new BookkeepingError(
      'duplicate',
      `${period.name} already has a tax computation. Open that one rather than starting another.`,
    )
  }

  const spans = splitIntoTaxPeriods(period.start_date, period.end_date)
  const created: BkCtComputationRow[] = []
  let carriedMain: Money | null = null
  let carriedSpecial: Money | null = null
  let carriedLosses: Money | null = null

  for (const span of spans) {
    if (carriedMain === null) {
      const [previous] = await prisma.$queryRaw<
        { main_pool_cf: Prisma.Decimal | null; special_pool_cf: Prisma.Decimal | null; losses_cf: Prisma.Decimal | null }[]
      >`
        SELECT "main_pool_cf", "special_pool_cf", "losses_cf"
        FROM "bk_ct_computations"
        WHERE "end_date" < ${span.start}::date
        ORDER BY "end_date" DESC LIMIT 1
      `
      carriedMain = toMoney(previous?.main_pool_cf ?? '0')
      carriedSpecial = toMoney(previous?.special_pool_cf ?? '0')
      carriedLosses = toMoney(previous?.losses_cf ?? '0')
    }

    const rows = await prisma.$queryRaw<BkCtComputationRow[]>`
      INSERT INTO "bk_ct_computations"
        ("accounting_period_id", "start_date", "end_date",
         "main_pool_bf", "special_pool_bf", "losses_bf", "created_by_user_id")
      VALUES (
        ${accountingPeriodId}, ${span.start}::date, ${span.end}::date,
        ${formatMoney(carriedMain)}::numeric, ${formatMoney(carriedSpecial ?? ZERO)}::numeric,
        ${formatMoney(carriedLosses ?? ZERO)}::numeric, ${user?.id ?? null}
      )
      RETURNING *
    `
    created.push(rows[0]!)
    // The second half of a long period carries in whatever the first half
    // leaves, and that is not known until the first is worked out. Nil to start
    // with; refreshComputation puts it right the moment the first is saved.
    carriedMain = ZERO
    carriedSpecial = ZERO
    carriedLosses = ZERO
  }

  await appendAudit({
    action: 'ct_computation.created',
    entityType: 'ct_computation',
    entityId: created[0]!.id,
    summary:
      spans.length > 1
        ? `${period.name} runs over twelve months, so it has been split into two tax periods.`
        : `Tax computation started for ${period.name}.`,
    detail: { spans: spans.map((span) => ({ start: iso(span.start), end: iso(span.end) })) },
    user,
  })
  return created
}

export type ComputationPatch = {
  associatedCompanies?: number
  mainPoolBf?: string
  specialPoolBf?: string
  lossesBf?: string
  claimAia?: boolean
  claimFullExpensing?: boolean
}

export async function updateComputation(
  id: string,
  patch: ComputationPatch,
  user: SessionUser | null,
): Promise<BkCtComputationRow> {
  const current = await requireComputation(id)
  if (current.status === 'final') {
    throw new PeriodStateError(
      'That computation has been marked finished, so its figures are frozen. Put it back to a draft first.',
    )
  }
  if (patch.associatedCompanies !== undefined && patch.associatedCompanies < 0) {
    throw new BookkeepingError('invalid', 'A company cannot have fewer than no associated companies.')
  }

  const rows = await prisma.$queryRaw<BkCtComputationRow[]>`
    UPDATE "bk_ct_computations" SET
      "associated_companies"  = ${patch.associatedCompanies ?? current.associated_companies},
      "main_pool_bf"          = ${patch.mainPoolBf ?? formatMoney(current.main_pool_bf)}::numeric,
      "special_pool_bf"       = ${patch.specialPoolBf ?? formatMoney(current.special_pool_bf)}::numeric,
      "losses_bf"             = ${patch.lossesBf ?? formatMoney(current.losses_bf)}::numeric,
      "claim_aia"             = ${patch.claimAia ?? current.claim_aia},
      "claim_full_expensing"  = ${patch.claimFullExpensing ?? current.claim_full_expensing},
      "updated_at"            = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  await appendAudit({
    action: 'ct_computation.updated',
    entityType: 'ct_computation',
    entityId: id,
    summary: 'Tax computation settings changed.',
    detail: { before: current, after: patch },
    user,
  })
  return rows[0]!
}

export type AdjustmentInput = {
  kind: CtAdjustmentKind
  label: string
  amount: string
  note?: string | null
  position?: number
}

export async function addAdjustment(
  computationId: string,
  input: AdjustmentInput,
  user: SessionUser | null,
): Promise<BkCtAdjustmentRow> {
  const computation = await requireComputation(computationId)
  if (computation.status === 'final') {
    throw new PeriodStateError('That computation is finished. Put it back to a draft to change it.')
  }
  if (!input.label?.trim()) {
    throw new BookkeepingError(
      'invalid',
      'An adjustment needs a description. An unexplained figure on a tax computation is exactly what an enquiry asks about.',
    )
  }
  const amount = toMoney(input.amount)
  if (amount.isNegative()) {
    throw new BookkeepingError(
      'invalid',
      'Adjustments are always entered as positive amounts. Which way it pulls is decided by what sort of adjustment it is.',
    )
  }

  const rows = await prisma.$queryRaw<BkCtAdjustmentRow[]>`
    INSERT INTO "bk_ct_adjustments" ("computation_id", "position", "kind", "label", "amount", "note")
    VALUES (
      ${computationId},
      ${input.position ?? 0},
      ${input.kind}, ${input.label.trim()}, ${formatMoney(amount)}::numeric,
      ${input.note?.trim() || null}
    )
    RETURNING *
  `
  await appendAudit({
    action: 'ct_adjustment.added',
    entityType: 'ct_computation',
    entityId: computationId,
    summary: `Tax adjustment added: ${input.label.trim()} ${formatPounds(amount)}`,
    detail: { after: input },
    user,
  })
  return rows[0]!
}

export async function deleteAdjustment(
  id: string,
  user: SessionUser | null,
): Promise<void> {
  const [row] = await prisma.$queryRaw<BkCtAdjustmentRow[]>`
    SELECT * FROM "bk_ct_adjustments" WHERE "id" = ${id} LIMIT 1
  `
  if (!row) throw new NotFoundError('That adjustment')
  const computation = await requireComputation(row.computation_id)
  if (computation.status === 'final') {
    throw new PeriodStateError('That computation is finished. Put it back to a draft to change it.')
  }
  await prisma.$executeRaw`DELETE FROM "bk_ct_adjustments" WHERE "id" = ${id}`
  await appendAudit({
    action: 'ct_adjustment.removed',
    entityType: 'ct_computation',
    entityId: row.computation_id,
    summary: `Tax adjustment removed: ${row.label}`,
    detail: { before: row },
    user,
  })
}

/**
 * Work the computation out and save what it came to.
 *
 * Saved on every view rather than only on finalising, so the pool balances and
 * losses the NEXT period carries in are always the ones this period actually
 * produced. A draft that has never been opened would otherwise hand nil
 * forward.
 */
export async function refreshComputation(id: string): Promise<Computation> {
  const result = await computeCorporationTax(id)
  await prisma.$executeRaw`
    UPDATE "bk_ct_computations" SET
      "computation"     = ${JSON.stringify(result)}::jsonb,
      "boxes"           = ${JSON.stringify(result.boxes)}::jsonb,
      "tax_due"         = ${result.tax.taxChargeable}::numeric,
      "main_pool_cf"    = ${result.mainPoolCf}::numeric,
      "special_pool_cf" = ${result.specialPoolCf}::numeric,
      "losses_cf"       = ${result.lossesCarriedForward}::numeric,
      "updated_at"      = NOW()
    WHERE "id" = ${id} AND "status" = 'draft'
  `
  return result
}

/**
 * Mark a computation finished.
 *
 * Which freezes it, in the same sense a finalised VAT return is frozen: the
 * workings stored on the row become the answer, and the live tables can move on
 * without restating it. The frozen JSON is what the screen shows from then on,
 * so a computation printed in June still reads the same in November.
 */
export async function finaliseComputation(
  id: string,
  user: SessionUser | null,
): Promise<BkCtComputationRow> {
  const current = await requireComputation(id)
  if (current.status === 'final') return current
  const result = await computeCorporationTax(id)

  const rows = await prisma.$queryRaw<BkCtComputationRow[]>`
    UPDATE "bk_ct_computations" SET
      "status"          = 'final',
      "computation"     = ${JSON.stringify(result)}::jsonb,
      "boxes"           = ${JSON.stringify(result.boxes)}::jsonb,
      "tax_due"         = ${result.tax.taxChargeable}::numeric,
      "main_pool_cf"    = ${result.mainPoolCf}::numeric,
      "special_pool_cf" = ${result.specialPoolCf}::numeric,
      "losses_cf"       = ${result.lossesCarriedForward}::numeric,
      "finalised_at"    = NOW(),
      "finalised_by_user_id" = ${user?.id ?? null},
      "updated_at"      = NOW()
    WHERE "id" = ${id} AND "status" = 'draft'
    RETURNING *
  `
  if (!rows[0]) throw new PeriodStateError('That computation was finished by somebody else a moment ago.')

  await appendAudit({
    action: 'ct_computation.finalised',
    entityType: 'ct_computation',
    entityId: id,
    summary: `Tax computation finished for ${iso(current.start_date)} to ${iso(current.end_date)}: ${formatPounds(result.tax.taxChargeable)} due.`,
    detail: { boxes: result.boxes, taxDue: result.tax.taxChargeable },
    user,
  })
  return rows[0]
}

export async function unfinaliseComputation(
  id: string,
  user: SessionUser | null,
): Promise<BkCtComputationRow> {
  const current = await requireComputation(id)
  if (current.status !== 'final') return current
  const rows = await prisma.$queryRaw<BkCtComputationRow[]>`
    UPDATE "bk_ct_computations" SET
      "status" = 'draft', "finalised_at" = NULL, "finalised_by_user_id" = NULL, "updated_at" = NOW()
    WHERE "id" = ${id}
    RETURNING *
  `
  await appendAudit({
    action: 'ct_computation.unfinalised',
    entityType: 'ct_computation',
    entityId: id,
    summary: 'Tax computation put back to a draft.',
    detail: { before: current },
    user,
  })
  return rows[0]!
}

export async function deleteComputation(id: string, user: SessionUser | null): Promise<void> {
  const current = await requireComputation(id)
  if (current.status === 'final') {
    throw new PeriodStateError(
      'That computation is marked finished. Put it back to a draft before removing it.',
    )
  }
  await prisma.$executeRaw`DELETE FROM "bk_ct_computations" WHERE "id" = ${id}`
  await appendAudit({
    action: 'ct_computation.deleted',
    entityType: 'ct_computation',
    entityId: id,
    summary: `Tax computation removed for ${iso(current.start_date)} to ${iso(current.end_date)}.`,
    detail: { before: current },
    user,
  })
}
