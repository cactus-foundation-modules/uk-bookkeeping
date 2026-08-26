// Comparing two spellings of the same business.
//
// Three places need this and they need it to agree: the reconciliation matcher
// scoring an entry against a statement line, the document reader deciding whose
// letterhead it is looking at, and the document matcher offering an unfiled
// receipt against a payment. Three private copies that drifted apart would show
// up as a receipt matching a statement line on one screen and not on another,
// which is exactly the kind of bug nobody reports because it just looks like the
// software being stupid.

/**
 * Company-form words. Every third supplier is a limited company, so matching on
 * "ltd" would make them all look like each other.
 */
export const COMPANY_FORM_WORDS = [
  'ltd', 'limited', 'plc', 'llp', 'inc', 'co', 'company', 'the', 'uk', 'gb',
] as const

/** Words a bank prints around a name that are not part of it. */
export const BANK_NOISE_WORDS = [
  'payment', 'card', 'transfer', 'bill', 'direct', 'debit', 'ref', 'to', 'from',
] as const

/** For anything read off a bank statement. */
export const NAME_STOP_WORDS = new Set<string>([...COMPANY_FORM_WORDS, ...BANK_NOISE_WORDS])

/**
 * For anything read off a document. The bank's noise words are left IN, because
 * on an invoice "Direct Line" and "Bill Smith Roofing" are names rather than
 * banking vocabulary.
 */
export const DOCUMENT_STOP_WORDS = new Set<string>([...COMPANY_FORM_WORDS, 'llc', 'and'])

/** The words in a name that are worth comparing on. */
export function significantWords(value: string, stopWords = NAME_STOP_WORDS): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word.length >= 3 && !stopWords.has(word)),
  )
}

/**
 * How alike two names are, 0 to 1.
 *
 * Shared words over the SHORTER name's word count, not over the union: a
 * statement line carrying a supplier's name plus a branch, a town and a card
 * number should still be a full match for the supplier.
 */
export function nameSimilarity(a: string, b: string, stopWords = NAME_STOP_WORDS): number {
  const left = significantWords(a, stopWords)
  const right = significantWords(b, stopWords)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / Math.min(left.size, right.size)
}

/**
 * True when every identifying word of `name` appears somewhere in `haystack`.
 *
 * `haystack` must already be lower-cased and flattened to letters, digits and
 * single spaces - the callers do it once for a whole page rather than once per
 * name they test against it.
 */
export function allWordsPresent(name: string, haystack: string, stopWords = DOCUMENT_STOP_WORDS): boolean {
  const words = significantWords(name, stopWords)
  if (words.size === 0) return false
  for (const word of words) {
    if (!haystack.includes(word)) return false
  }
  return true
}
