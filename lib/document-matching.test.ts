import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { scoreDocumentAgainstLine, type DocumentMatchLine, type PoolRow } from './document-matching'
import { normaliseAlias } from './counterparty-aliases'

// Offering the right receipt against the right payment, and - the half that
// matters more - never offering the wrong one.
//
// A suggestion that is merely unhelpful costs a click. A suggestion that is
// wrong and plausible costs the whole point of bookkeeping: it looks explained,
// so nobody looks again. Every "returns null" case below is one of those.

function document(overrides: Partial<PoolRow> = {}): PoolRow {
  return {
    id: 'doc-1',
    name: 'invoice.pdf',
    filename: 'invoice.pdf',
    mime_type: 'application/pdf',
    scan_status: 'read',
    guessed_counterparty: 'Acme Supplies Ltd',
    counterparty_confidence: 90,
    guessed_document_date: new Date('2026-09-01T00:00:00Z'),
    guessed_document_number: 'INV-0042',
    guessed_net: new Prisma.Decimal('100.00'),
    guessed_vat: new Prisma.Decimal('20.00'),
    guessed_total: new Prisma.Decimal('120.00'),
    guessed_vat_rate_code: 'standard',
    guessed_direction: 'expense',
    ...overrides,
  }
}

function line(overrides: Partial<DocumentMatchLine> = {}): DocumentMatchLine {
  return {
    date: '2026-09-08',
    amount: '-120.00',
    counterparty: 'ACME SUPPLIES LTD',
    details: 'ACME SUPPLIES LTD LEEDS',
    reference: null,
    ...overrides,
  }
}

const noAliases = new Map<string, string>()

describe('scoring a document against a statement line', () => {
  it('matches on the amount to the penny and the name', () => {
    const result = scoreDocumentAgainstLine(line(), document(), noAliases)
    expect(result).not.toBeNull()
    expect(result!.score).toBeGreaterThan(80)
    expect(result!.reasons.join(' ')).toMatch(/to the penny/)
  })

  it('refuses a document whose total is a different amount', () => {
    expect(
      scoreDocumentAgainstLine(line({ amount: '-59.00' }), document(), noAliases),
    ).toBeNull()
  })

  it('refuses a document that is a penny out', () => {
    expect(
      scoreDocumentAgainstLine(line({ amount: '-119.99' }), document(), noAliases),
    ).toBeNull()
  })

  it('refuses a document dated months away from the payment', () => {
    expect(
      scoreDocumentAgainstLine(line({ date: '2027-02-01' }), document(), noAliases),
    ).toBeNull()
  })

  it('refuses a document with no total that does not even look like the same supplier', () => {
    const photo = document({
      guessed_total: null,
      guessed_net: null,
      guessed_vat: null,
      guessed_counterparty: 'Riverside Joinery',
    })
    expect(scoreDocumentAgainstLine(line(), photo, noAliases)).toBeNull()
  })

  it('still offers a photo with no figures when the name is unmistakable', () => {
    const photo = document({
      guessed_total: null,
      guessed_net: null,
      guessed_vat: null,
      guessed_document_number: null,
      scan_status: 'no_text',
    })
    const result = scoreDocumentAgainstLine(line(), photo, noAliases)
    expect(result).not.toBeNull()
    expect(result!.reasons.join(' ')).not.toMatch(/to the penny/)
  })

  it('matches a card-processor spelling on the words the two names share', () => {
    const card = line({
      counterparty: 'SQ *THE COFFEE SHOP 1234',
      details: 'SQ *THE COFFEE SHOP 1234 CARD 5678',
    })
    const coffee = document({ guessed_counterparty: 'The Coffee Shop Limited' })
    expect(scoreDocumentAgainstLine(card, coffee, noAliases)).not.toBeNull()
  })

  it('needs a learned name where the two spellings share no words at all', () => {
    const travel = line({
      counterparty: 'TFL TRAVEL CH',
      details: 'TFL TRAVEL CH LONDON',
      amount: '-18.40',
    })
    const invoice = document({
      guessed_counterparty: 'Transport for London',
      guessed_total: null,
      guessed_net: null,
      guessed_vat: null,
      guessed_document_number: null,
    })

    // Nothing ties "TFL" to "Transport for London" except somebody saying so
    // once, and until they have, the matcher is right to say nothing.
    expect(scoreDocumentAgainstLine(travel, invoice, noAliases)).toBeNull()

    const learned = new Map([[normaliseAlias(travel.counterparty), 'Transport for London']])
    expect(scoreDocumentAgainstLine(travel, invoice, learned)).not.toBeNull()
  })

  it('rewards an invoice number printed on the statement line', () => {
    const withReference = scoreDocumentAgainstLine(
      line({ reference: 'INV0042' }),
      document(),
      noAliases,
    )
    const without = scoreDocumentAgainstLine(line(), document(), noAliases)
    expect(withReference!.score).toBeGreaterThan(without!.score)
    expect(withReference!.reasons.join(' ')).toMatch(/INV-0042/)
  })

  it('marks down a purchase invoice offered against money coming in', () => {
    const moneyIn = line({ amount: '120.00' })
    expect(scoreDocumentAgainstLine(moneyIn, document(), noAliases)!.score).toBeLessThan(
      scoreDocumentAgainstLine(line(), document(), noAliases)!.score,
    )
  })

  it('prefers the invoice dated nearest the payment', () => {
    const near = scoreDocumentAgainstLine(line(), document(), noAliases)!
    const far = scoreDocumentAgainstLine(
      line(),
      document({ guessed_document_date: new Date('2026-08-05T00:00:00Z') }),
      noAliases,
    )!
    expect(near.score).toBeGreaterThan(far.score)
  })
})

describe('normalising a name into a lookup key', () => {
  it('strips the card processor and the card digits', () => {
    expect(normaliseAlias('SQ *THE COFFEE SHOP 1234')).toBe('coffee shop')
  })

  it('drops the company form so one supplier is one key', () => {
    expect(normaliseAlias('Acme Supplies Limited')).toBe(normaliseAlias('ACME SUPPLIES LTD'))
  })

  it('keeps something rather than nothing for a name made only of form words', () => {
    expect(normaliseAlias('The Company Ltd')).not.toBe('')
  })
})
