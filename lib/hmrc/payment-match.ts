import { Prisma } from '@prisma/client'
import type { VatLiability } from './client'

// Whether HMRC has been paid for a filed return, read from their liabilities.
// The payments endpoint cannot say: a payment is an amount and a date, with no
// period on it, so matching one to a return would be a guess. A liability names
// the tax period it belongs to and says how much of it is still outstanding.

export type PaymentState = 'unpaid' | 'part_paid' | 'paid' | 'unknown'

export type PaymentVerdict = {
  status: PaymentState
  originalAmount: string | null
  outstandingAmount: string | null
  dueDate: string | null
}

const UNKNOWN: PaymentVerdict = {
  status: 'unknown',
  originalAmount: null,
  outstandingAmount: null,
  dueDate: null,
}

// "VAT Return Debit Charge" and its relatives. Default surcharges, assessments
// and interest carry their own types and are a different conversation: a
// surcharge still being open does not mean the return was not paid.
const RETURN_CHARGE = /^VAT Return/i

/**
 * Judge one period against the liabilities HMRC returned.
 *
 * Deliberately slow to say "paid". It takes a matching return charge that states
 * an outstanding amount of exactly nothing. A missing liability, a missing
 * outstanding figure or a refund (credit) charge are all "unknown", which keeps
 * the module asking - the cost of a wrong "paid" is that it stops looking.
 */
export function judgePeriodPayment(
  period: { start: string; end: string },
  liabilities: VatLiability[],
): PaymentVerdict {
  const charges = liabilities.filter(
    (l) =>
      l.taxPeriodFrom === period.start &&
      l.taxPeriodTo === period.end &&
      RETURN_CHARGE.test(l.type) &&
      !/credit/i.test(l.type),
  )
  if (charges.length === 0) return UNKNOWN

  if (charges.some((c) => c.outstandingAmount === null)) {
    return { ...UNKNOWN, dueDate: charges[0]?.due ?? null }
  }

  let original = new Prisma.Decimal(0)
  let outstanding = new Prisma.Decimal(0)
  for (const c of charges) {
    original = original.plus(c.originalAmount)
    outstanding = outstanding.plus(c.outstandingAmount ?? 0)
  }

  const dueDates = charges.map((c) => c.due).filter((d): d is string => d !== null)
  const dueDate = dueDates.length > 0 ? dueDates.sort()[0]! : null

  const status: PaymentState = outstanding.lte(0)
    ? 'paid'
    : outstanding.lt(original)
      ? 'part_paid'
      : 'unpaid'

  return {
    status,
    originalAmount: original.toFixed(2),
    outstandingAmount: outstanding.toFixed(2),
    dueDate,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Date windows covering from..to that the liabilities endpoint will accept
 * (it refuses more than 364 days between the ends), oldest first.
 */
export function liabilityWindows(from: string, to: string, maxDays: number): { from: string; to: string }[] {
  const end = new Date(`${to}T00:00:00.000Z`).getTime()
  let start = new Date(`${from}T00:00:00.000Z`).getTime()
  const windows: { from: string; to: string }[] = []
  while (start <= end) {
    const stop = Math.min(start + maxDays * DAY_MS, end)
    windows.push({
      from: new Date(start).toISOString().slice(0, 10),
      to: new Date(stop).toISOString().slice(0, 10),
    })
    start = stop + DAY_MS
  }
  return windows
}
