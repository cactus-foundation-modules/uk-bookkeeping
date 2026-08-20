import { isMoneyString } from '../money'
import { BookkeepingError } from '../errors'
import type { VatBoxes } from '../types'
import { VAT_BOX_KEYS, WHOLE_POUND_BOXES } from '../types'

// Turning nine decimal strings into the JSON body HMRC wants, without ever
// creating a JavaScript number from them.
//
// HMRC's schema says these fields are JSON *numbers* - "a monetary value (to 2
// decimal places)" for boxes 1 to 5, and "to 2 zeroed decimal places" for boxes 6
// to 9. Numbers, not strings, so the naive route is JSON.stringify over an
// object of parseFloat values. That is the one thing this module will not do:
// the moment a box value becomes a JavaScript number it is binary floating
// point, and 1234.55 is no longer exactly 1234.55.
//
// So the body is composed as text. `1234.55` written into a JSON document is a
// perfectly valid JSON number literal and HMRC parses it as the decimal it is,
// and no float ever exists on our side of the wire. Every value is validated
// against the shapes below before it goes anywhere near the string.

/** Boxes 1 to 5: a decimal with exactly two places. */
const TWO_DP = /^-?\d{1,13}\.\d{2}$/
/** Boxes 6 to 9: whole pounds, written with their zeroed pence. */
const WHOLE_POUNDS = /^-?\d{1,13}\.00$/

export function assertBoxesSendable(boxes: VatBoxes): void {
  for (const key of VAT_BOX_KEYS) {
    const value = boxes[key]
    if (!isMoneyString(value) || !TWO_DP.test(value)) {
      throw new BookkeepingError(
        'invalid_boxes',
        `Box value for ${key} is not a figure we are willing to send ("${value}"). Nothing has been sent.`,
      )
    }
    if (WHOLE_POUND_BOXES.includes(key) && !WHOLE_POUNDS.test(value)) {
      throw new BookkeepingError(
        'invalid_boxes',
        `Box value for ${key} has to be a whole number of pounds ("${value}"). Nothing has been sent.`,
      )
    }
  }
  // HMRC rejects a negative box 5 outright; it wants the absolute difference and
  // works the direction out itself.
  if (boxes.netVatDue.startsWith('-')) {
    throw new BookkeepingError(
      'invalid_boxes',
      'Box 5 cannot be negative. It is the difference between boxes 3 and 4, and which way round it goes is worked out from those. Nothing has been sent.',
    )
  }
}

/**
 * The request body, as text. `finalised: true` is the owner's declaration and is
 * the only thing added to the frozen figures.
 */
export function buildVatReturnBody(periodKey: string, boxes: VatBoxes): string {
  assertBoxesSendable(boxes)
  const numeric = VAT_BOX_KEYS.map((key) => `"${key}":${boxes[key]}`).join(',')
  return `{"periodKey":${JSON.stringify(periodKey)},${numeric},"finalised":true}`
}
