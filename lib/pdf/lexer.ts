// A tokeniser for PDF content streams.
//
// Written rather than taken from a library on purpose. Every PDF library that
// does this properly (pdfjs and friends) is a large dependency built to RENDER
// pages, and this module needs one narrow thing from a bank statement: what
// text is on the page and where. The whole of that job is this file, document.ts
// and text.ts, and none of it needs a canvas, a font rasteriser or a worker.
//
// The one lesson worth recording, because getting it wrong was silent: a hex
// string in a content stream is BYTES, two hex digits each. Reading `<000A>` as
// a single 16-bit code unit rather than as the two bytes 00 and 0A drops that
// glyph and every other glyph written that way, and drops them without any error
// - the output simply comes out missing its capital C's and half its digits.

export type PdfToken =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }

const WHITESPACE = ' \t\r\n\f\0'
const DELIMITERS = '/[]<>(){}%'

const isWhitespace = (c: string): boolean => WHITESPACE.includes(c)
const isDelimiter = (c: string): boolean => DELIMITERS.includes(c)

/**
 * A hex string, as bytes. One character of the result per byte, so it lines up
 * with a literal string and a two-byte font encoding can pair them the same way.
 */
export function hexToBytes(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '')
  // An odd number of digits is padded with a trailing zero, which is what the
  // specification says to do rather than an error worth stopping for.
  const padded = clean.length % 2 === 1 ? `${clean}0` : clean
  let out = ''
  for (let i = 0; i < padded.length; i += 2) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 2), 16))
  }
  return out
}

/** A hex string as UTF-16 code units, which is what a ToUnicode CMap holds. */
export function hexToUnicode(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '')
  const padded = clean.length % 4 === 0 ? clean : clean.padEnd(clean.length + (4 - (clean.length % 4)), '0')
  let out = ''
  for (let i = 0; i < padded.length; i += 4) {
    out += String.fromCharCode(parseInt(padded.slice(i, i + 4), 16))
  }
  return out
}

function readLiteralString(src: string, start: number): { value: string; next: number } {
  // Parentheses nest, and a nested pair does not end the string. The escapes are
  // the ones the specification lists, plus a backslash before a newline, which
  // means "this string continues on the next line" and contributes nothing.
  const escapes: Record<string, string> = {
    n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\',
  }
  let depth = 1
  let i = start
  let value = ''

  while (i < src.length && depth > 0) {
    const char = src[i]!

    if (char === '\\') {
      const next = src[i + 1]
      if (next === undefined) break
      if (next >= '0' && next <= '7') {
        let octal = ''
        let j = i + 1
        while (j < src.length && octal.length < 3 && src[j]! >= '0' && src[j]! <= '7') octal += src[j++]
        value += String.fromCharCode(parseInt(octal, 8) & 0xff)
        i = j
        continue
      }
      if (next === '\n') { i += 2; continue }
      if (next === '\r') { i += src[i + 2] === '\n' ? 3 : 2; continue }
      value += escapes[next] ?? next
      i += 2
      continue
    }

    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) { i += 1; break }
    }
    value += char
    i += 1
  }

  return { value, next: i }
}

/**
 * Tokenise a content stream.
 *
 * The stream is handled as latin1 - one character per byte - throughout. It is
 * not text and must never be decoded as UTF-8, which would fold byte sequences
 * together and shift every glyph after the first non-ASCII one.
 */
export function tokenise(src: string): PdfToken[] {
  const tokens: PdfToken[] = []
  let i = 0

  while (i < src.length) {
    const char = src[i]!

    if (isWhitespace(char)) { i += 1; continue }

    if (char === '%') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1
      continue
    }

    if (char === '(') {
      const { value, next } = readLiteralString(src, i + 1)
      tokens.push({ t: 'str', v: value })
      i = next
      continue
    }

    if (char === '<' && src[i + 1] === '<') { tokens.push({ t: 'op', v: '<<' }); i += 2; continue }
    if (char === '>' && src[i + 1] === '>') { tokens.push({ t: 'op', v: '>>' }); i += 2; continue }

    if (char === '<') {
      const end = src.indexOf('>', i)
      if (end === -1) break
      tokens.push({ t: 'str', v: hexToBytes(src.slice(i + 1, end)) })
      i = end + 1
      continue
    }

    if (char === '[' || char === ']' || char === '{' || char === '}') {
      tokens.push({ t: 'op', v: char })
      i += 1
      continue
    }

    if (char === '/') {
      let j = i + 1
      let name = ''
      while (j < src.length && !isWhitespace(src[j]!) && !isDelimiter(src[j]!)) name += src[j++]
      // #xx is a hex escape inside a name. Rare, and cheap to honour.
      tokens.push({ t: 'name', v: name.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) })
      i = j
      continue
    }

    if (char === '+' || char === '-' || char === '.' || (char >= '0' && char <= '9')) {
      let j = i
      let text = ''
      while (j < src.length && /[-+.\d]/.test(src[j]!)) text += src[j++]
      const value = Number(text)
      tokens.push({ t: 'num', v: Number.isFinite(value) ? value : 0 })
      i = j
      continue
    }

    let j = i
    let op = ''
    while (j < src.length && !isWhitespace(src[j]!) && !isDelimiter(src[j]!)) op += src[j++]
    if (op === '') { i += 1; continue }
    tokens.push({ t: 'op', v: op })
    i = j
  }

  return tokens
}
