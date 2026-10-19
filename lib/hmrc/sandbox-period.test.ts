import { describe, expect, it } from 'vitest'
import { pickSandboxTestPeriod } from '@/modules/uk-bookkeeping/lib/hmrc/sandbox-period'

const TODAY = new Date('2026-10-19T12:00:00Z')

describe('pickSandboxTestPeriod', () => {
  it('takes the latest quarter that has finished', () => {
    expect(pickSandboxTestPeriod([], TODAY)).toEqual({
      periodKey: '#900',
      start: '2026-07-01',
      end: '2026-09-30',
      due: '2026-11-07',
    })
  })

  it('steps back past quarters that already exist, and past keys in use', () => {
    const picked = pickSandboxTestPeriod(
      [{ start: '2026-07-01', end: '2026-09-30', periodKey: '#900' }],
      TODAY,
    )
    expect(picked).toMatchObject({ periodKey: '#901', start: '2026-04-01', end: '2026-06-30' })
  })

  it('crosses a year boundary', () => {
    const picked = pickSandboxTestPeriod([], new Date('2026-02-10T00:00:00Z'))
    expect(picked).toMatchObject({ start: '2025-10-01', end: '2025-12-31' })
  })
})
