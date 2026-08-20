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

/** Adding two decimal strings without ever making a float of either. */
export function addStrings(a: string, b: string): string {
  const toPence = (value: string): bigint => {
    const negative = value.startsWith('-')
    const [whole = '0', fraction = '00'] = value.replace('-', '').split('.')
    const pence = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
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
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function toDateInput(value: string | Date | null | undefined): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}
