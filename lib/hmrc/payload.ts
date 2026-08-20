import { Prisma } from '@prisma/client'
import { BookkeepingError } from '../errors'
import type { VatBoxes } from '../types'
import { VAT_BOX_KEYS, VAT_BOX_NUMBERS, WHOLE_POUND_BOXES } from '../types'
import { assertValidPeriodKey } from './limits'

// Turning nine decimal strings into the JSON body HMRC wants, without ever
// creating a JavaScript number from them.
//
// HMRC's schema says these fields are JSON *numbers* - "a monetary value (to 2
// decimal places)" for boxes 1 to 5, and "to 2 zeroed decimal places" for boxes
// 6 to 9. Numbers, not strings, so the naive route is JSON.stringify over an
// object of parseFloat values. That is the one thing this module will not do:
// the moment a box value becomes a JavaScript number it is binary floating
// point, and 1234.55 is no longer exactly 1234.55.
//
// So the body is composed as text. `1234.55` written into a JSON document is a
// perfectly valid JSON number literal and HMRC parses it as the decimal it is,
// and no float ever exists on our side of the wire. Every value is validated
// against the real per-field limits below before it goes near the string.

/** Boxes 1 to 5: a decimal with exactly two places. */
const TWO_DP = /^-?\d{1,13}\.\d{2}$/
/** Boxes 6 to 9: whole pounds, written with their zeroed pence. */
const WHOLE_POUNDS = /^-?\d{1,13}\.00$/

/**
 * The per-field limits, transcribed from the VAT (MTD) API schema on
 * 2026-08-21. They are NOT all the same, which is the point of writing them out
 * rather than checking one shape for everything: `netVatDue` is capped two
 * orders of magnitude lower than its neighbours and is the only one that may
 * not be negative.
 *
 * Boxes 6 to 9 carry no `multipleOf` in the schema, but their bounds are whole
 * numbers and their description says zeroed decimals - so `.00` is what we send
 * and what WHOLE_POUNDS enforces.
 */
const LIMITS: Record<keyof VatBoxes, { min: string; max: string }> = {
  vatDueSales: { min: '-9999999999999.99', max: '9999999999999.99' },
  vatDueAcquisitions: { min: '-9999999999999.99', max: '9999999999999.99' },
  totalVatDue: { min: '-9999999999999.99', max: '9999999999999.99' },
  vatReclaimedCurrPeriod: { min: '-9999999999999.99', max: '9999999999999.99' },
  netVatDue: { min: '0', max: '99999999999.99' },
  totalValueSalesExVAT: { min: '-9999999999999', max: '9999999999999' },
  totalValuePurchasesExVAT: { min: '-9999999999999', max: '9999999999999' },
  totalValueGoodsSuppliedExVAT: { min: '-9999999999999', max: '9999999999999' },
  totalAcquisitionsExVAT: { min: '-9999999999999', max: '9999999999999' },
}

function refuse(detail: string): never {
  throw new BookkeepingError('invalid_boxes', `${detail} Nothing has been sent.`)
}

export function assertBoxesSendable(boxes: VatBoxes): void {
  for (const key of VAT_BOX_KEYS) {
    const value = boxes[key]
    const box = VAT_BOX_NUMBERS[key]

    if (typeof value !== 'string' || !TWO_DP.test(value)) {
      refuse(`Box ${box} is not a figure we are willing to send ("${value}").`)
    }
    if (WHOLE_POUND_BOXES.includes(key) && !WHOLE_POUNDS.test(value)) {
      refuse(`Box ${box} has to be a whole number of pounds ("${value}").`)
    }

    const decimal = new Prisma.Decimal(value)
    const limit = LIMITS[key]
    if (decimal.lessThan(new Prisma.Decimal(limit.min))) {
      refuse(`Box ${box} is below the smallest figure HMRC accepts there ("${value}").`)
    }
    if (decimal.greaterThan(new Prisma.Decimal(limit.max))) {
      refuse(`Box ${box} is larger than the biggest figure HMRC accepts there ("${value}").`)
    }
  }

  // HMRC re-checks both of these on their side and answers VAT_TOTAL_VALUE /
  // VAT_NET_VALUE when they do not hold. They cannot fail while the box query is
  // the only thing that ever produces these values - which is exactly why they
  // are asserted here: the day somebody introduces a second producer, this is
  // what refuses it rather than HMRC.
  const box1 = new Prisma.Decimal(boxes.vatDueSales)
  const box2 = new Prisma.Decimal(boxes.vatDueAcquisitions)
  const box3 = new Prisma.Decimal(boxes.totalVatDue)
  const box4 = new Prisma.Decimal(boxes.vatReclaimedCurrPeriod)
  const box5 = new Prisma.Decimal(boxes.netVatDue)

  if (!box3.equals(box1.plus(box2))) {
    refuse('Box 3 is not box 1 and box 2 added together.')
  }
  if (!box5.equals(box3.minus(box4).abs())) {
    refuse('Box 5 is not the difference between box 3 and box 4.')
  }
  // Belt and braces on the one HMRC rejects outright: their field has a minimum
  // of 0 and works the direction out from boxes 3 and 4 itself.
  if (box5.isNegative()) {
    refuse('Box 5 cannot be negative.')
  }
}

/**
 * The request body, as text. `finalised: true` is the owner's declaration and is
 * the only thing added to the frozen figures.
 *
 * Every field in HMRC's `required` array is present, in their order, because a
 * missing one is INVALID_REQUEST rather than a default.
 */
export function buildVatReturnBody(periodKey: string, boxes: VatBoxes): string {
  assertValidPeriodKey(periodKey)
  assertBoxesSendable(boxes)
  const numeric = VAT_BOX_KEYS.map((key) => `"${key}":${boxes[key]}`).join(',')
  return `{"periodKey":${JSON.stringify(periodKey)},${numeric},"finalised":true}`
}
