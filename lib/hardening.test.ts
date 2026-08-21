import { describe, expect, it } from 'vitest'
import { addStrings } from '../components/admin/format'
import { csvCell } from './csv'
import { parseImportDate } from './import'

// Pins for the defects fixed in the 0.1.3 hardening pass, so none of them can
// quietly come back.

describe('csvCell formula neutralisation', () => {
  it('escapes leading formula characters', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`)
    expect(csvCell('+SUM(A1)')).toBe(`'+SUM(A1)`)
    expect(csvCell('@cmd')).toBe(`'@cmd`)
  })

  it('leaves negative amounts as numbers', () => {
    expect(csvCell('-10.50')).toBe('-10.50')
    expect(csvCell('-1000')).toBe('-1000')
  })

  it('escapes minus-led text that is not an amount', () => {
    expect(csvCell('-2+3+cmd')).toBe(`'-2+3+cmd`)
  })

  it('still quotes ordinary awkward text', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
  })
})

describe('addStrings tolerance', () => {
  it('adds plain decimal strings exactly', () => {
    expect(addStrings('0.10', '0.20')).toBe('0.30')
    expect(addStrings('-5.25', '10.00')).toBe('4.75')
  })

  it('survives whatever a human is mid-typing', () => {
    expect(() => addStrings('1,000', '0.00')).not.toThrow()
    expect(addStrings('1,000', '0.00')).toBe('1000.00')
    expect(() => addStrings('£12.50', '12a')).not.toThrow()
    expect(addStrings('£12.50', '0.00')).toBe('12.50')
    expect(() => addStrings('', 'abc')).not.toThrow()
  })
})

describe('parseImportDate rollover', () => {
  it('reads a legitimate date', () => {
    expect(parseImportDate('28/02/2026', 'dd/mm/yyyy')?.toISOString().slice(0, 10)).toBe('2026-02-28')
  })

  it('refuses an impossible date instead of rolling it into March', () => {
    expect(parseImportDate('30/02/2026', 'dd/mm/yyyy')).toBeNull()
    expect(parseImportDate('31/04/2026', 'dd/mm/yyyy')).toBeNull()
  })
})
