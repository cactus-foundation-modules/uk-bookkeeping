import { describe, expect, it } from 'vitest'
import { coveredRange } from './import'
import { EMPTY_META } from './statement'

// What makes two files "the same statement".
//
// Never the filename. Banks name their exports after a serial number and the
// moment you pressed the button, so the same month downloaded twice arrives
// under two different names - and two consecutive months arrive under names
// that differ by one digit. The period is the only part that means anything,
// which is what this works out.

describe('coveredRange', () => {
  it('takes the period the statement declared', () => {
    expect(
      coveredRange({ ...EMPTY_META, periodStart: '2026-08-01', periodEnd: '2026-08-31' }, []),
    ).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('falls back to the first and last line, which is what a CSV needs', () => {
    // A CSV export almost never carries a period. Without this every re-import
    // of one would look like a brand new statement, and the account would end up
    // with a row per attempt.
    expect(
      coveredRange(EMPTY_META, [
        { date: '2026-08-14' },
        { date: '2026-08-02' },
        { date: '2026-08-29' },
      ]),
    ).toEqual({ from: '2026-08-02', to: '2026-08-29' })
  })

  it('prefers what the statement said over what its lines happen to cover', () => {
    // A month with no transactions in the first week still covers the first
    // week, and the closing balance check depends on that being true.
    expect(
      coveredRange({ ...EMPTY_META, periodStart: '2026-08-01', periodEnd: '2026-08-31' }, [
        { date: '2026-08-09' },
      ]),
    ).toEqual({ from: '2026-08-01', to: '2026-08-31' })
  })

  it('ignores anything that is not a plain date', () => {
    expect(coveredRange(EMPTY_META, [{ date: '' }, { date: 'not a date' }])).toEqual({
      from: null,
      to: null,
    })
  })

  it('has no range at all for an empty file, so nothing matches it', () => {
    // Null either side is what stops findStatementCovering claiming a match: an
    // unknown period must never be treated as equal to another unknown one.
    expect(coveredRange(EMPTY_META, [])).toEqual({ from: null, to: null })
  })
})
