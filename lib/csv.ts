// CSV, both ways. Small enough to own rather than to take a dependency for, and
// the parsing half has to cope with whatever a bank exported at four in the
// morning, which a general-purpose library would not do any better.

/** One field, quoted only when it has to be, with the doubling rule applied. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',')
}

/**
 * A UTF-8 byte order mark, then CRLF line endings.
 *
 * Both are for Excel's benefit and neither is optional in practice: without the
 * mark, Excel reads a pound sign as two characters of nonsense, and it is the
 * first thing anybody notices about an export.
 */
export function csvDocument(rows: string[]): string {
  return `﻿${rows.join('\r\n')}\r\n`
}

export type ParsedCsv = { headers: string[]; rows: string[][] }

/**
 * Parse, properly: quoted fields, doubled quotes inside them, embedded newlines,
 * and either line ending. A split on commas handles none of those, and a bank
 * statement will contain all four before the year is out.
 */
export function parseCsv(text: string): ParsedCsv {
  const withoutBom = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < withoutBom.length; i += 1) {
    const char = withoutBom[i]!

    if (inQuotes) {
      if (char === '"') {
        if (withoutBom[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      // Swallow the second half of a CRLF rather than emitting an empty row.
      if (char === '\r' && withoutBom[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  // Trailing blank lines are ordinary in an export and are not data.
  const meaningful = rows.filter((r) => r.some((cell) => cell.trim() !== ''))
  const headers = (meaningful.shift() ?? []).map((h) => h.trim())
  return { headers, rows: meaningful }
}
