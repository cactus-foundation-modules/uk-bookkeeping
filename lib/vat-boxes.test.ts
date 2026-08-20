import { Prisma } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { assembleBoxes, boxesMatch, netVatDirection } from './vat-boxes'
import { formatMoney, roundWholePounds, vatFromNet, netFromGross } from './money'
import { assertBoxesSendable, buildVatReturnBody } from './hmrc/payload'
import { canonicalJson, chainHash } from './audit'
import { parseCsv, csvRow } from './csv'
import { parseImportAmount, parseImportDate, guessMapping } from './import'
import { sniffMimeType, preflightFileError, isHeic } from './file-kinds'
import { formatTimezoneOffset, keyValueHeader, percentEncode } from './hmrc/fraud-spec'
import {
  MAX_RANGE_DAYS,
  assertValidPeriodKey,
  assertValidVrn,
  clampRange,
  daysBetween,
  parseDateOnly,
} from './hmrc/limits'
import { EXPECTED_TRIGGERS } from './health'

// The arithmetic, the payload and the parsing, tested without a database.
//
// What this suite CANNOT prove is that a restore works or that a trigger fires -
// those need real Postgres, and they belong to `npm run test:backup-roundtrip`
// and to the integration checks the wiki page describes. What it does prove is
// every box formula, every rounding decision, and every place a decimal could
// quietly turn into a float.

const D = (value: string) => new Prisma.Decimal(value)

function totals(input: Partial<Record<'box1' | 'box2' | 'box4' | 'box6' | 'box7' | 'box8' | 'box9', string>>) {
  return {
    box1: D(input.box1 ?? '0'),
    box2: D(input.box2 ?? '0'),
    box4: D(input.box4 ?? '0'),
    box6: D(input.box6 ?? '0'),
    box7: D(input.box7 ?? '0'),
    box8: D(input.box8 ?? '0'),
    box9: D(input.box9 ?? '0'),
  }
}

describe('assembling the nine boxes', () => {
  it('box 3 is always box 1 plus box 2', () => {
    const boxes = assembleBoxes(totals({ box1: '1234.56', box2: '78.90' }), 'nearest')
    expect(boxes.totalVatDue).toBe('1313.46')
  })

  it('box 5 is the absolute difference, never negative', () => {
    const owing = assembleBoxes(totals({ box1: '1000.00', box4: '250.00' }), 'nearest')
    expect(owing.netVatDue).toBe('750.00')
    expect(netVatDirection(owing)).toBe('pay')

    const refund = assembleBoxes(totals({ box1: '100.00', box4: '412.00' }), 'nearest')
    expect(refund.netVatDue).toBe('312.00')
    expect(refund.netVatDue.startsWith('-')).toBe(false)
    expect(netVatDirection(refund)).toBe('reclaim')
  })

  it('a nil return is all zeroes, with pence', () => {
    const boxes = assembleBoxes(totals({}), 'nearest')
    for (const value of Object.values(boxes)) expect(value).toBe('0.00')
    expect(netVatDirection(boxes)).toBe('nil')
  })

  it('boxes 6 to 9 are whole pounds carrying their zeroed pence', () => {
    const boxes = assembleBoxes(
      totals({ box6: '1234.49', box7: '999.51', box8: '10.50', box9: '0.49' }),
      'nearest',
    )
    expect(boxes.totalValueSalesExVAT).toBe('1234.00')
    expect(boxes.totalValuePurchasesExVAT).toBe('1000.00')
    expect(boxes.totalValueGoodsSuppliedExVAT).toBe('11.00')
    expect(boxes.totalAcquisitionsExVAT).toBe('0.00')
  })

  it('the rounding rule applies identically to all four, and only to those four', () => {
    const nearest = assembleBoxes(totals({ box1: '10.99', box6: '10.99', box7: '10.99', box8: '10.99', box9: '10.99' }), 'nearest')
    const down = assembleBoxes(totals({ box1: '10.99', box6: '10.99', box7: '10.99', box8: '10.99', box9: '10.99' }), 'down')

    expect(nearest.vatDueSales).toBe('10.99')
    expect(down.vatDueSales).toBe('10.99')
    for (const key of ['totalValueSalesExVAT', 'totalValuePurchasesExVAT', 'totalValueGoodsSuppliedExVAT', 'totalAcquisitionsExVAT'] as const) {
      expect(nearest[key]).toBe('11.00')
      expect(down[key]).toBe('10.00')
    }
  })

  it('rounds a negative total the same way in both directions', () => {
    // ROUND_FLOOR rather than ROUND_DOWN: a period of net credit notes should go
    // the same way as a positive one, not towards zero.
    expect(formatMoney(roundWholePounds('-10.40', 'down'))).toBe('-11.00')
    expect(formatMoney(roundWholePounds('-10.40', 'nearest'))).toBe('-10.00')
  })

  it('boxesMatch is value-for-value', () => {
    const a = assembleBoxes(totals({ box1: '10.00' }), 'nearest')
    const b = assembleBoxes(totals({ box1: '10.00' }), 'nearest')
    const c = assembleBoxes(totals({ box1: '10.01' }), 'nearest')
    expect(boxesMatch(a, b)).toBe(true)
    expect(boxesMatch(a, c)).toBe(false)
  })
})

describe('money never becomes a float', () => {
  it('adds exactly where a float would not', () => {
    // 0.1 + 0.2 is the canonical float failure; decimals do not have it.
    expect(D('0.1').plus(D('0.2')).toFixed(2)).toBe('0.30')
  })

  it('works VAT out at the rate, to the nearest penny', () => {
    expect(formatMoney(vatFromNet('100.00', '20.00'))).toBe('20.00')
    expect(formatMoney(vatFromNet('99.99', '20.00'))).toBe('20.00')
    expect(formatMoney(vatFromNet('0.05', '20.00'))).toBe('0.01')
    expect(formatMoney(vatFromNet('123.45', '5.00'))).toBe('6.17')
  })

  it('back-solves net from a gross figure', () => {
    expect(formatMoney(netFromGross('120.00', '20.00'))).toBe('100.00')
    expect(formatMoney(netFromGross('100.00', '20.00'))).toBe('83.33')
    expect(formatMoney(netFromGross('105.00', '5.00'))).toBe('100.00')
  })

  it('always formats to two places including trailing zeros', () => {
    expect(formatMoney('1')).toBe('1.00')
    expect(formatMoney('1.5')).toBe('1.50')
    expect(formatMoney(null)).toBe('0.00')
  })
})

describe('the submission payload', () => {
  const good = assembleBoxes(totals({ box1: '1000.00', box4: '250.00', box6: '5000', box7: '1250' }), 'nearest')

  it('writes the numbers as decimal literals, not floats', () => {
    const body = buildVatReturnBody('18A1', good)
    expect(body).toContain('"vatDueSales":1000.00')
    expect(body).toContain('"totalValueSalesExVAT":5000.00')
    expect(body).toContain('"finalised":true')
    // And it is valid JSON, whatever else it is.
    expect(JSON.parse(body).periodKey).toBe('18A1')
  })

  it('escapes a period key rather than trusting it', () => {
    const body = buildVatReturnBody('18A#', good)
    expect(JSON.parse(body).periodKey).toBe('18A#')
  })

  it('refuses a box that is not a two-place decimal', () => {
    expect(() => assertBoxesSendable({ ...good, vatDueSales: '1000' })).toThrow()
    expect(() => assertBoxesSendable({ ...good, vatDueSales: '1e3' })).toThrow()
  })

  it('refuses pence in a whole-pound box', () => {
    expect(() => assertBoxesSendable({ ...good, totalValueSalesExVAT: '5000.50' })).toThrow()
  })

  it('refuses a negative box 5 outright', () => {
    expect(() => assertBoxesSendable({ ...good, netVatDue: '-750.00' })).toThrow()
  })
})

describe('the hash chain', () => {
  it('renders objects the same whatever order they were built in', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('changes when anything in the payload changes', () => {
    const first = chainHash(0n, null, { action: 'a' })
    const same = chainHash(0n, null, { action: 'a' })
    const different = chainHash(0n, null, { action: 'b' })
    expect(first).toBe(same)
    expect(first).not.toBe(different)
  })

  it('carries the previous hash forward, so a rewrite anywhere breaks everything after it', () => {
    const one = chainHash(0n, null, { n: 1 })
    const two = chainHash(1n, one, { n: 2 })
    const tampered = chainHash(0n, null, { n: 99 })
    expect(chainHash(1n, tampered, { n: 2 })).not.toBe(two)
  })
})

describe('CSV', () => {
  it('quotes only what has to be quoted', () => {
    expect(csvRow(['plain', 'has,comma', 'has"quote'])).toBe('plain,"has,comma","has""quote"')
  })

  it('parses quoted fields, doubled quotes and embedded newlines', () => {
    const parsed = parseCsv('Date,Description,Amount\r\n01/02/2026,"Smith, John said ""hi""",-12.34\r\n')
    expect(parsed.headers).toEqual(['Date', 'Description', 'Amount'])
    expect(parsed.rows[0]).toEqual(['01/02/2026', 'Smith, John said "hi"', '-12.34'])
  })

  it('ignores trailing blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n\n').rows).toHaveLength(1)
  })
})

describe('bank import', () => {
  it('reads a UK date as day first', () => {
    expect(parseImportDate('03/04/2026', 'dd/mm/yyyy')?.toISOString().slice(0, 10)).toBe('2026-04-03')
    expect(parseImportDate('03/04/2026', 'mm/dd/yyyy')?.toISOString().slice(0, 10)).toBe('2026-03-04')
    expect(parseImportDate('2026-04-03', 'yyyy-mm-dd')?.toISOString().slice(0, 10)).toBe('2026-04-03')
    expect(parseImportDate('not a date', 'dd/mm/yyyy')).toBeNull()
  })

  it('strips currency symbols and reads a parenthesised minus', () => {
    expect(parseImportAmount('£1,234.56')?.toFixed(2)).toBe('1234.56')
    expect(parseImportAmount('(12.34)')?.toFixed(2)).toBe('-12.34')
    expect(parseImportAmount('')).toBeNull()
    expect(parseImportAmount('n/a')).toBeNull()
  })

  it('guesses the columns from the headers', () => {
    const mapping = guessMapping(['Date', 'Description', 'Amount', 'Reference'])
    expect(mapping?.date).toBe('Date')
    expect(mapping?.amount).toBe('Amount')
  })

  it('gives up rather than guessing when nothing matches', () => {
    expect(guessMapping(['Column A', 'Column B'])).toBeNull()
  })
})

describe('evidence', () => {
  it('reads the type out of the bytes, not the name', () => {
    expect(sniffMimeType(Buffer.from('%PDF-1.7 rest of file'))).toBe('application/pdf')
    expect(sniffMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg')
    expect(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('image/png')
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
    expect(sniffMimeType(webp)).toBe('image/webp')
  })

  it('refuses something that only claims to be a PDF', () => {
    expect(sniffMimeType(Buffer.from('MZ\x90\x00 an executable, actually'))).toBeNull()
  })

  it('says something useful about an iPhone photo', () => {
    expect(isHeic('IMG_0001.HEIC', 'image/heic')).toBe(true)
    const file = { name: 'IMG_0001.HEIC', type: 'image/heic', size: 1000 } as File
    expect(preflightFileError(file)).toContain('Most Compatible')
  })
})

describe('the fraud prevention headers', () => {
  it('percent encodes the characters encodeURIComponent leaves alone', () => {
    expect(percentEncode("O'Brien & Co (Ltd)")).toBe('O%27Brien%20%26%20Co%20%28Ltd%29')
  })

  it('encodes keys and values but never the separators', () => {
    expect(keyValueHeader({ width: 1920, height: 1080 })).toBe('width=1920&height=1080')
    expect(keyValueHeader({ 'unique-reference': 'a b' })).toBe('unique-reference=a%20b')
  })

  it('leaves out anything we could not collect', () => {
    expect(keyValueHeader({ a: '1', b: undefined, c: null, d: '' })).toBe('a=1')
  })

  it('flips the sign on a JavaScript timezone offset', () => {
    // getTimezoneOffset is minutes BEHIND UTC, so British Summer Time is -60.
    expect(formatTimezoneOffset(-60)).toBe('UTC+01:00')
    expect(formatTimezoneOffset(0)).toBe('UTC+00:00')
    expect(formatTimezoneOffset(75)).toBe('UTC-01:15')
  })
})

describe('the record-protection guards', () => {
  it('names every trigger the migration installs', () => {
    // A guard against the health check drifting from the migration: if
    // 002_immutability.sql grows a trigger, this list has to grow with it or the
    // banner will never mention the missing one.
    expect(EXPECTED_TRIGGERS).toHaveLength(10)
    expect(EXPECTED_TRIGGERS.every((t) => t.name.startsWith('bk_'))).toBe(true)
    expect(EXPECTED_TRIGGERS.every((t) => t.protects.length > 10)).toBe(true)
  })
})

describe("HMRC's limits on what you may ask it", () => {
  const today = new Date('2026-08-21T00:00:00.000Z')

  it('leaves a range HMRC would accept exactly as it is', () => {
    expect(clampRange({ from: '2026-01-01', to: '2026-06-30' }, today)).toEqual({
      from: '2026-01-01',
      to: '2026-06-30',
    })
  })

  it('trims an over-long range from the far end, keeping the recent days', () => {
    // The old obligations sync asked for thirty months, which HMRC answer with
    // INVALID_DATE_RANGE every single time. This is the guard against that
    // coming back.
    const clamped = clampRange({ from: '2024-01-01', to: '2026-06-30' }, today)
    expect(clamped.to).toBe('2026-06-30')
    expect(
      daysBetween(parseDateOnly(clamped.from)!, parseDateOnly(clamped.to)!),
    ).toBeLessThanOrEqual(MAX_RANGE_DAYS)
  })

  it('stays one day inside the documented 366, because of their leap-year bug', () => {
    expect(MAX_RANGE_DAYS).toBe(365)
  })

  it('pulls a future end date back to today', () => {
    expect(clampRange({ from: '2026-08-01', to: '2027-12-31' }, today).to).toBe('2026-08-21')
  })

  it('will not ask for anything from before MTD existed', () => {
    expect(clampRange({ from: '2001-01-01', to: '2018-01-01' }, today).from).toBe('2017-12-01')
  })

  it('refuses a backwards or unreadable range rather than sending it', () => {
    expect(() => clampRange({ from: '2026-06-30', to: '2026-01-01' }, today)).toThrow()
    expect(() => clampRange({ from: 'last tuesday', to: '2026-01-01' }, today)).toThrow()
  })

  it('checks a period key is four characters of the right sort', () => {
    expect(() => assertValidPeriodKey('18A1')).not.toThrow()
    expect(() => assertValidPeriodKey('#001')).not.toThrow()
    expect(() => assertValidPeriodKey('18A')).toThrow()
    expect(() => assertValidPeriodKey('18A12')).toThrow()
    expect(() => assertValidPeriodKey('18 1')).toThrow()
  })

  it('checks a VAT number is nine digits', () => {
    expect(() => assertValidVrn('123456789')).not.toThrow()
    expect(() => assertValidVrn('12345678')).toThrow()
    expect(() => assertValidVrn('123 4567 89')).toThrow()
    expect(() => assertValidVrn('GB123456789')).toThrow()
  })
})

describe("the per-field limits HMRC actually publish", () => {
  const base = assembleBoxes(totals({ box1: '1000.00', box4: '250.00' }), 'nearest')

  it('refuses a box 5 above their lower cap, which is not the same as the others', () => {
    // netVatDue maxes out at 99,999,999,999.99 - two orders of magnitude below
    // its neighbours. One shape for all nine would have let this through.
    // Built through the box query rather than by overriding one value, so the
    // box 3 / box 5 identities still hold and it is genuinely the CAP under test.
    const atCap = assembleBoxes(totals({ box1: '99999999999.99' }), 'nearest')
    expect(atCap.netVatDue).toBe('99999999999.99')
    expect(() => assertBoxesSendable(atCap)).not.toThrow()

    const overCap = assembleBoxes(totals({ box1: '999999999999.99' }), 'nearest')
    expect(overCap.vatDueSales).toBe('999999999999.99') // fine in box 1
    expect(() => assertBoxesSendable(overCap)).toThrow() // not in box 5
  })

  it('accepts the full range on the boxes that do allow it', () => {
    // Boxes 1 and 4 both at their ceiling, which nets box 5 to zero - so this
    // exercises the wide limits without tripping the narrow one.
    const big = assembleBoxes(
      totals({ box1: '9999999999999.99', box4: '9999999999999.99' }),
      'nearest',
    )
    expect(big.netVatDue).toBe('0.00')
    expect(() => assertBoxesSendable(big)).not.toThrow()
  })

  it('refuses figures that break the identities HMRC re-check', () => {
    expect(() => assertBoxesSendable({ ...base, totalVatDue: '999.00' })).toThrow()
    expect(() => assertBoxesSendable({ ...base, netVatDue: '1.00' })).toThrow()
  })

  it('refuses a period key at the point of building the body', () => {
    expect(() => buildVatReturnBody('nope!', base)).toThrow()
  })

  it('sends every field HMRC list as required, and nothing else', () => {
    const body = JSON.parse(buildVatReturnBody('18A1', base))
    expect(Object.keys(body).sort()).toEqual(
      [
        'finalised',
        'netVatDue',
        'periodKey',
        'totalAcquisitionsExVAT',
        'totalValueGoodsSuppliedExVAT',
        'totalValuePurchasesExVAT',
        'totalValueSalesExVAT',
        'totalVatDue',
        'vatDueAcquisitions',
        'vatDueSales',
        'vatReclaimedCurrPeriod',
      ].sort(),
    )
    expect(body.finalised).toBe(true)
  })
})
