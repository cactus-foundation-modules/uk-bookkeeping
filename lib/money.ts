import { Prisma } from '@prisma/client'
import type { BoxRounding, Money } from './types'

// The only place in this module allowed to turn a decimal into a string, and the
// only place allowed to do arithmetic on money outside SQL.
//
// The rule this file exists to enforce, from the plan's §2.6: a NUMERIC(10,2)
// column arrives from prisma.$queryRaw as a Prisma.Decimal, and passing one
// through Number() silently converts exact decimal into binary floating point.
// That is the single live risk in choosing NUMERIC over integer pence, and it is
// a named item on every code review of this module.

/** A zero that is a Decimal, not a number. */
export const ZERO: Money = new Prisma.Decimal(0)

/**
 * Anything that might be a money value on its way in: a Decimal from Prisma, a
 * decimal string from a form or a JSON body, or null. Never a number - a caller
 * holding a number has already lost the precision this module is about.
 */
export type MoneyInput = Prisma.Decimal | string | null | undefined

export function toMoney(value: MoneyInput): Money {
  if (value === null || value === undefined || value === '') return ZERO
  if (value instanceof Prisma.Decimal) return value
  return new Prisma.Decimal(value)
}

/** True if the string is a plain decimal we are willing to treat as money. */
export function isMoneyString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d{1,10}(\.\d{1,2})?$/.test(value.trim())
}

/**
 * The edge. Two decimal places, always, including trailing zeros - "0.00" and
 * "1240.50" rather than "0" and "1240.5". Everything that reaches a screen, a
 * CSV, a snapshot or an HTTP body goes through here.
 */
export function formatMoney(value: MoneyInput): string {
  return toMoney(value).toFixed(2)
}

/** With a pound sign, for reading rather than for sending. */
export function formatPounds(value: MoneyInput): string {
  const decimal = toMoney(value)
  const negative = decimal.isNegative()
  const digits = decimal.abs().toFixed(2)
  const [whole = '0', fraction = '00'] = digits.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}£${grouped}.${fraction}`
}

export function addMoney(a: MoneyInput, b: MoneyInput): Money {
  return toMoney(a).plus(toMoney(b))
}

export function subtractMoney(a: MoneyInput, b: MoneyInput): Money {
  return toMoney(a).minus(toMoney(b))
}

/**
 * VAT at a rate, rounded to the nearest penny (half up), which is what
 * VATREC12030 describes as the ordinary treatment. Used to pre-fill the VAT box
 * on the line form; the figure stays editable so it can be made to match the
 * supplier's own rounding penny for penny.
 */
export function vatFromNet(net: MoneyInput, ratePercent: MoneyInput): Money {
  return toMoney(net)
    .times(toMoney(ratePercent))
    .dividedBy(100)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}

/** Back-solve net and VAT from a gross figure at a rate. */
export function netFromGross(gross: MoneyInput, ratePercent: MoneyInput): Money {
  const rate = toMoney(ratePercent)
  return toMoney(gross)
    .times(100)
    .dividedBy(rate.plus(100))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
}

/**
 * Boxes 6 to 9 reduced to whole pounds.
 *
 * HMRC's notices do not state a rule for this - VAT Notice 700/12 says what goes
 * in each box and nothing about pence, and 700 covers rounding on invoices
 * rather than on the return - and both "round down" and "round to nearest" are
 * practices in the wild. So it is a setting with a documented default rather
 * than whichever Math function was nearest to hand, it is applied exactly once
 * (in the box query's caller), it is applied identically to all four boxes, and
 * the pre-rounding figures are kept in the snapshot's `boxes_unrounded` so any
 * later question can be answered from the snapshot itself.
 *
 * The result carries its zeroed pence, because HMRC's API describes these
 * fields as "a monetary value (to 2 zeroed decimal places)".
 */
export function roundWholePounds(value: MoneyInput, rule: BoxRounding): Money {
  const decimal = toMoney(value)
  // ROUND_FLOOR rather than ROUND_DOWN: "round down" means towards minus
  // infinity, and a negative box 6 (a period of net credit notes) should go the
  // same way as a positive one rather than towards zero.
  const mode = rule === 'down' ? Prisma.Decimal.ROUND_FLOOR : Prisma.Decimal.ROUND_HALF_UP
  return decimal.toDecimalPlaces(0, mode)
}
