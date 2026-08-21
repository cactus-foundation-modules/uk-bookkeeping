import { describe, expect, it } from 'vitest'
import { describeFromLines } from '@/modules/uk-bookkeeping/lib/transactions'
import type { LineInput } from '@/modules/uk-bookkeeping/lib/transactions'

// "What it was for" is asked per line, because that is the level it is true at:
// a receipt with a tank of fuel and a sandwich on it was for two things. But the
// transactions table, the CSV export and the reconciliation screen all print one
// column, so the lines are folded into one sentence. This is that fold, pinned
// here because an entry that says nothing in a list is an entry nobody finds.

function line(description: string): LineInput {
  return {
    categoryId: 'cat-1',
    description,
    vatTreatment: 'domestic',
    vatRateCode: 'standard',
    vatRatePercent: '20.00',
    netAmount: '10.00',
    vatAmount: '2.00',
    grossAmount: '12.00',
  }
}

describe('describeFromLines', () => {
  it('is the line itself when there is only one', () => {
    expect(describeFromLines([line('Printer paper')])).toBe('Printer paper')
  })

  it('lists them when there are a few', () => {
    expect(describeFromLines([line('Fuel'), line('Sandwich')])).toBe('Fuel, Sandwich')
  })

  it('says the same thing once', () => {
    // Two lines of the same goods at different rates is ordinary, and reading
    // "Fuel, Fuel" back in a list is not.
    expect(describeFromLines([line('Fuel'), line('Fuel')])).toBe('Fuel')
  })

  it('counts the rest once past three', () => {
    const lines = ['Desk', 'Chair', 'Lamp', 'Rug', 'Bin'].map(line)
    expect(describeFromLines(lines)).toBe('Desk, Chair, Lamp and 2 more')
  })

  it('ignores a line nobody described', () => {
    expect(describeFromLines([line('Fuel'), line('   '), line('')])).toBe('Fuel')
  })

  it('is empty when nothing was described, rather than a string of commas', () => {
    expect(describeFromLines([line(''), line('  ')])).toBe('')
  })
})
