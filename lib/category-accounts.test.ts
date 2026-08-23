import { describe, expect, it } from 'vitest'
import { accountShapeForCategory, type AccountTemplate } from './accounts'

// Every category has to post somewhere. A category with no account puts the
// analysis side of an entry into Suspense, and the first anybody hears of it is
// a trial balance that no longer agrees with itself - so what shape of account
// a category gets is worth pinning down here rather than finding out later.

const pl = (reportGroup: string, disallowable = '0.00'): AccountTemplate => ({
  kind: 'expense',
  subtype: 'profit_and_loss',
  reportGroup,
  bsGroup: null,
  disallowablePercent: disallowable,
  position: 1012,
})

describe('accountShapeForCategory', () => {
  it('makes a profit and loss account named after the category, as 006 seeded the originals', () => {
    const shape = accountShapeForCategory({
      code: 'software',
      direction: 'expense',
      ct600Group: 'admin-expenses',
      position: 45,
    })
    expect(shape).toEqual({
      code: 'pl-software',
      kind: 'expense',
      subtype: 'profit_and_loss',
      reportGroup: 'admin-expenses',
      bsGroup: null,
      disallowablePercent: '0',
      position: 1045,
    })
  })

  it('points an income category at an income account', () => {
    expect(accountShapeForCategory({ code: 'grants', direction: 'income', ct600Group: 'other-income' }).kind).toBe(
      'income',
    )
  })

  it('takes the report line and the disallowable share from the category it is filed like', () => {
    const shape = accountShapeForCategory(
      { code: 'client-lunches', direction: 'expense', ct600Group: 'admin-expenses' },
      pl('admin-expenses', '100.00'),
    )
    expect(shape.reportGroup).toBe('admin-expenses')
    expect(shape.disallowablePercent).toBe('100.00')
  })

  it('copies a balance sheet template whole, because a second drawings category is not a cost', () => {
    const shape = accountShapeForCategory(
      { code: 'dividends-b', direction: 'expense', ct600Group: 'distributions', position: 30 },
      {
        kind: 'equity',
        subtype: 'reserves',
        reportGroup: null,
        bsGroup: 'reserves',
        disallowablePercent: '0.00',
        position: 150,
      },
    )
    expect(shape).toEqual({
      code: 'cat-dividends-b',
      kind: 'equity',
      subtype: 'reserves',
      reportGroup: null,
      bsGroup: 'reserves',
      disallowablePercent: '0.00',
      position: 150,
    })
  })

  it('never leaves a profit and loss account off the report, whatever the category carries', () => {
    // 'capital' is not a profit and loss line. With no template to copy there is
    // no honest way to know which balance sheet account was meant, so it lands
    // somewhere visible instead of nowhere.
    const shape = accountShapeForCategory({ code: 'odd', direction: 'expense', ct600Group: 'capital' })
    expect(shape.reportGroup).toBe('admin-expenses')
    expect(shape.kind).toBe('expense')
  })

  it('treats a category that points both ways as a cost', () => {
    expect(accountShapeForCategory({ code: 'either', direction: 'both', ct600Group: null }).kind).toBe('expense')
  })
})
