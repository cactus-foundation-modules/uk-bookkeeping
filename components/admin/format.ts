// Formatting for the browser.
//
// Client components deliberately never import Prisma.Decimal - it would drag the
// client into the database library, and it is not needed: every money value has
// already left the server as a two-place decimal STRING. These helpers work on
// those strings and never turn one into a number, which is the same rule the
// server side keeps in lib/money.ts.

export function poundsFromString(value: string | null | undefined): string {
  if (!value) return '£0.00'
  const negative = value.startsWith('-')
  const [whole = '0', fraction = '00'] = value.replace('-', '').split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}£${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`
}

/**
 * Adding two decimal strings without ever making a float of either.
 *
 * Tolerant of anything a human has typed - "1,000", "£12.50", "12a" - because it
 * runs on every keystroke while an amount field is mid-edit. Non-digits are
 * stripped rather than thrown on; a BigInt SyntaxError here would crash the form
 * during render and take the half-typed entry with it.
 */
export function addStrings(a: string, b: string): string {
  const toPence = (value: string): bigint => {
    const cleaned = (value || '0').replace(/[^0-9.-]/g, '')
    const negative = cleaned.startsWith('-')
    const [whole = '', fraction = ''] = cleaned.replace(/-/g, '').split('.')
    const wholeDigits = whole.replace(/\D/g, '') || '0'
    const fractionDigits = (fraction.replace(/\D/g, '').padEnd(2, '0') || '00').slice(0, 2)
    const pence = BigInt(wholeDigits) * 100n + BigInt(fractionDigits)
    return negative ? -pence : pence
  }
  const total = toPence(a) + toPence(b)
  const negative = total < 0n
  const absolute = negative ? -total : total
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  // Server dates are date-only values serialised at UTC midnight. Rendered in
  // the viewer's local zone they would slip a day early anywhere west of
  // Greenwich, so they are rendered back at UTC - the date IS the value.
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/**
 * Today as the person filling the form understands it - their wall clock, not
 * UTC. toISOString() would hand a UK owner yesterday's date between midnight
 * and 1am all summer.
 */
export function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// ---------------------------------------------------------------------------
// The three figures on a line
// ---------------------------------------------------------------------------
// Net, VAT and gross, of which exactly one is typed and the other two follow.
// Kept here rather than inside the form so the arithmetic can be tested without
// rendering anything - the rule below got this wrong once, in a way no test
// could have caught while it lived in a component.

/** Decimal arithmetic on strings, in pence, so no float ever exists here. */
export function pence(value: string): number {
  const cleaned = (value || '0').replace(/[^0-9.-]/g, '')
  const negative = cleaned.startsWith('-')
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.')
  const total = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0').slice(0, 2) || '0')
  return negative ? -total : total
}

export function fromPence(value: number): string {
  const negative = value < 0
  const absolute = Math.abs(Math.round(value))
  return `${negative ? '-' : ''}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`
}

export function vatForNet(net: string, ratePercent: string): string {
  return fromPence(Math.round((pence(net) * pence(ratePercent)) / 100 / 100))
}

export function netForGross(gross: string, ratePercent: string): string {
  const rate = pence(ratePercent)
  return fromPence(Math.round((pence(gross) * 10000) / (rate + 10000)))
}

/** Which of the three figures is the fact the other two are worked out from. */
export type AmountAnchor = 'net' | 'gross'

export type LineAmounts = { netAmount: string; vatAmount: string; grossAmount: string }

/**
 * The line re-split at a new VAT rate, holding whichever figure was typed.
 *
 * This is the rule that was wrong. It always held the NET and put the VAT on
 * top, so an entry raised from a bank line - where the gross is the money that
 * actually left the account - grew by the VAT the moment somebody put it on
 * 20%: a £20 statement line became a £24 receipt, and the entry no longer
 * agreed with the statement it came from.
 *
 * Gross-anchored, the total stays put and the VAT comes out of it. Net-anchored,
 * which is somebody typing a figure off an invoice that shows net and VAT
 * separately, it goes on top. VAT is always the remainder rather than a second
 * rounding, so gross equals net plus VAT to the penny and the CHECK constraint
 * on the line cannot bite.
 */
export function resplitAtRate(
  line: LineAmounts,
  ratePercent: string,
  anchor: AmountAnchor | undefined,
): LineAmounts {
  if (anchor !== 'net' && pence(line.grossAmount) !== 0) {
    const netAmount = netForGross(line.grossAmount, ratePercent)
    return {
      netAmount,
      vatAmount: fromPence(pence(line.grossAmount) - pence(netAmount)),
      grossAmount: line.grossAmount,
    }
  }
  const vatAmount = vatForNet(line.netAmount, ratePercent)
  return {
    netAmount: line.netAmount,
    vatAmount,
    grossAmount: fromPence(pence(line.netAmount) + pence(vatAmount)),
  }
}
