import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'

// Learned names.
//
// A bank statement prints "SQ *THE COFFEE SHOP 1234" and the invoice from the
// same shop says "The Coffee Shop Limited". No amount of cleverness in a matcher
// derives one from the other, because the connection is not a fact about text -
// it is a fact about this particular business, and somebody has to state it
// once.
//
// So it gets stated once, silently, the first time a human corrects a guess or
// files a document against a supplier. Every later document from that supplier
// and every later statement line carrying that wording then knows the answer.
//
// This file is the ONLY place allowed to compute a normalised alias, the same
// rule lib/bank-transactions.ts keeps for the statement fingerprint. Two places
// normalising slightly differently is how a lookup table quietly stops matching
// the thing it was written from.

/**
 * Noise a card processor or a bank puts around a name. Stripped before the name
 * is used as a key, because "SQ *COFFEE SHOP 1234" and "SQ *COFFEE SHOP 9987"
 * are the same shop on two different cards.
 */
const NOISE_PATTERNS: RegExp[] = [
  /^(sq|sqc|sumup|zettle|izettle|paypal|pp|wp|stripe|gocardless|klarna)\s*\*+\s*/i,
  /\b(?:card|visa|mastercard|maestro|amex)\s*(?:no\.?|number)?\s*[*x\d\s]{4,}$/i,
  /\bon\s+\d{1,2}\s+[a-z]{3,9}\s+\d{2,4}\b/gi,
  /\bref(?:erence)?\s*[:.]?\s*/gi,
  /\b\d{4,}\b\s*$/,
]

/** Company-form words, which every third supplier has and none is identified by. */
const FORM_WORDS = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'co', 'company', 'the'])

/**
 * The lookup key for a name, whoever wrote it.
 *
 * Lower case, noise removed, punctuation flattened, company forms dropped. What
 * survives is the handful of words that actually identify the business, in the
 * order they were written.
 *
 * Returns an empty string when nothing identifying is left - a caller must treat
 * that as "no key", never as a key that happens to be empty, or every nameless
 * line in the ledger becomes the same supplier.
 */
export function normaliseAlias(value: string): string {
  let text = value.toLowerCase()
  for (const pattern of NOISE_PATTERNS) text = text.replace(pattern, ' ')
  const words = text
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length > 0 && !FORM_WORDS.has(word))
  // A name made of nothing but company forms ("The Company Ltd") keeps them
  // rather than becoming nothing at all.
  if (words.length === 0) {
    return text.replace(/[^a-z0-9]+/g, ' ').trim()
  }
  return words.join(' ')
}

export type CounterpartyAlias = {
  alias: string
  counterparty: string
  hits: number
}

/**
 * Every alias this site has learned, most-used first.
 *
 * The whole table in one read. There is one row per distinct spelling a real
 * business has ever been written under, which for a small company is tens and
 * for a busy one is hundreds - small enough that reading the lot beats a query
 * per name on a screen showing a hundred statement lines.
 */
export async function listAliases(limit = 2000): Promise<CounterpartyAlias[]> {
  return prisma.$queryRaw<CounterpartyAlias[]>`
    SELECT "alias", "counterparty", "hits"
    FROM "bk_counterparty_aliases"
    ORDER BY "hits" DESC, "updated_at" DESC
    LIMIT ${Math.min(Math.max(limit, 1), 5000)}
  `
}

/** The aliases keyed for lookup, ready to hand to the reader or the matcher. */
export async function aliasMap(): Promise<Map<string, string>> {
  return new Map((await listAliases()).map((row) => [row.alias, row.counterparty]))
}

/** One name resolved through what has been learned, or null if nothing has. */
export async function resolveAlias(value: string): Promise<string | null> {
  const alias = normaliseAlias(value)
  if (!alias) return null
  const rows = await prisma.$queryRaw<{ counterparty: string }[]>`
    SELECT "counterparty" FROM "bk_counterparty_aliases" WHERE "alias" = ${alias} LIMIT 1
  `
  return rows[0]?.counterparty ?? null
}

/**
 * Remember that this wording means this supplier.
 *
 * Called wherever a human's decision reveals the connection: correcting the
 * supplier on a document, or filing one against an entry whose counterparty is
 * spelled differently. It never overwrites a `manual` row with a `learned` one,
 * because a name somebody typed on purpose outranks one inferred from a click.
 *
 * Deliberately quiet. Nothing here is worth an error on the page in front of
 * somebody who was doing something else: the worst case is that the next
 * document guesses no better than this one did.
 */
export async function learnAlias(
  wording: string,
  counterparty: string,
  user: SessionUser | null,
  source: 'learned' | 'manual' = 'learned',
): Promise<void> {
  const alias = normaliseAlias(wording)
  const name = counterparty.trim()
  if (!alias || !name) return
  // A name that normalises to itself teaches nothing - "Acme Ltd" meaning
  // "Acme Ltd" is not a fact worth a row.
  if (source === 'learned' && alias === normaliseAlias(name)) return

  await prisma.$executeRaw`
    INSERT INTO "bk_counterparty_aliases" ("alias", "counterparty", "source", "created_by_user_id")
    VALUES (${alias}, ${name}, ${source}, ${user?.id ?? null})
    ON CONFLICT ("alias") DO UPDATE SET
      "counterparty" = CASE
        WHEN "bk_counterparty_aliases"."source" = 'manual' AND ${source} = 'learned'
          THEN "bk_counterparty_aliases"."counterparty"
        ELSE EXCLUDED."counterparty"
      END,
      "source" = CASE
        WHEN "bk_counterparty_aliases"."source" = 'manual' THEN 'manual' ELSE EXCLUDED."source"
      END,
      "hits" = "bk_counterparty_aliases"."hits" + 1,
      "updated_at" = NOW()
  `
}

export async function forgetAlias(alias: string): Promise<void> {
  const key = normaliseAlias(alias)
  if (!key) return
  await prisma.$executeRaw`DELETE FROM "bk_counterparty_aliases" WHERE "alias" = ${key}`
}
