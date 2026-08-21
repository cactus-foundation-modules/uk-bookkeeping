import { inflateSync } from 'node:zlib'
import { hexToUnicode } from './lexer'

// Enough of a PDF file to find the pages, their content streams and the maps
// that turn a font's own character codes back into readable text.
//
// The file is scanned for `N G obj` rather than followed from the cross
// reference table. That sounds lazy and is in fact the more robust of the two:
// bank statements are frequently produced by generators that leave a slightly
// wrong xref behind, and every PDF reader in the world has a "reconstruct by
// scanning" fallback for exactly that reason. We simply start there.

export class PdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfError'
  }
}

type RawObject = { start: number; end: number }

export type PdfFont = {
  /** Character code to text. Absent when the font declared no ToUnicode map. */
  toUnicode: Map<number, string> | null
  /** Type0 fonts encode two bytes per glyph; simple fonts encode one. */
  twoByte: boolean
}

export type PdfPage = {
  index: number
  content: string
  fonts: Map<string, PdfFont>
}

export class PdfDocument {
  private readonly bytes: Buffer
  private readonly latin1: string
  private readonly objects = new Map<number, RawObject>()
  /** Objects unpacked from object streams, held as their already-extracted text. */
  private readonly embedded = new Map<number, string>()

  constructor(bytes: Buffer) {
    this.bytes = bytes
    this.latin1 = bytes.toString('latin1')

    if (!this.latin1.startsWith('%PDF-')) {
      throw new PdfError('That file is not a PDF. Save the statement as a PDF and try again.')
    }
    if (/\/Encrypt\b/.test(this.latin1)) {
      throw new PdfError(
        'That PDF is password protected, so we cannot read it. Open it, save an unprotected copy, and import that.',
      )
    }

    for (const match of this.latin1.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) {
      const start = match.index! + match[0].length
      const end = this.latin1.indexOf('endobj', start)
      this.objects.set(Number(match[1]), { start, end: end === -1 ? this.latin1.length : end })
    }
    this.loadObjectStreams()
  }

  /** The raw text of an indirect object, from wherever it lives. */
  object(number: number): string {
    const raw = this.objects.get(number)
    if (raw) return this.latin1.slice(raw.start, raw.end)
    return this.embedded.get(number) ?? ''
  }

  /** An object's stream data, inflated where it is deflated. */
  stream(number: number): Buffer | null {
    const raw = this.objects.get(number)
    if (!raw) return null
    const body = this.latin1.slice(raw.start, raw.end)
    const at = body.indexOf('stream')
    if (at === -1) return null

    let from = raw.start + at + 'stream'.length
    if (this.latin1[from] === '\r') from += 1
    if (this.latin1[from] === '\n') from += 1

    // /Length is sometimes an indirect reference, and sometimes simply wrong.
    // Trust it only when it lands on an `endstream`; otherwise find the marker.
    const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(body)
    let to = -1
    if (declared) {
      const candidate = from + Number(declared[1])
      if (/^\s*endstream/.test(this.latin1.slice(candidate, candidate + 12))) to = candidate
    }
    if (to === -1) {
      to = this.latin1.indexOf('endstream', from)
      if (to === -1) return null
      // Back off the end-of-line that belongs to the marker, not to the data.
      if (this.latin1[to - 1] === '\n') to -= 1
      if (this.latin1[to - 1] === '\r') to -= 1
    }

    const data = this.bytes.subarray(from, to)
    if (!/\/Filter[^/]*\/FlateDecode/.test(body)) return data
    try {
      return inflateSync(data)
    } catch {
      // A stream truncated by a byte or two is common enough in the wild that
      // giving up on the whole document over it would be the wrong call.
      try {
        return inflateSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */ })
      } catch {
        return null
      }
    }
  }

  /**
   * PDF 1.5 and later pack most objects into compressed object streams, so a
   * plain scan finds the container and none of its contents. Unpack them.
   */
  private loadObjectStreams(): void {
    for (const [number, raw] of this.objects) {
      const body = this.latin1.slice(raw.start, raw.end)
      if (!/\/Type\s*\/ObjStm\b/.test(body)) continue

      const data = this.stream(number)
      if (!data) continue
      const text = data.toString('latin1')
      const count = Number(/\/N\s+(\d+)/.exec(body)?.[1] ?? 0)
      const first = Number(/\/First\s+(\d+)/.exec(body)?.[1] ?? 0)
      if (!count || !first) continue

      // The header is N pairs of "object number, offset from /First".
      const header = text.slice(0, first).trim().split(/\s+/).map(Number)
      for (let i = 0; i < count; i += 1) {
        const objNumber = header[i * 2]
        const offset = header[i * 2 + 1]
        if (objNumber === undefined || offset === undefined) break
        const nextOffset = header[i * 2 + 3]
        const end = nextOffset === undefined ? text.length : first + nextOffset
        if (this.objects.has(objNumber)) continue
        this.embedded.set(objNumber, text.slice(first + offset, end))
      }
    }
  }

  private resolve(value: string): string {
    const reference = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(value)
    return reference ? this.object(Number(reference[1])) : value
  }

  /** Every page, in document order, with its content and its fonts. */
  pages(): PdfPage[] {
    const numbers = [...this.objects.keys()]
      .concat([...this.embedded.keys()])
      .filter((n) => /\/Type\s*\/Page(?![a-zA-Z])/.test(this.object(n)))
      .sort((a, b) => a - b)

    return numbers.map((number, index) => ({
      index,
      content: this.pageContent(number),
      fonts: this.pageFonts(number),
    }))
  }

  private pageContent(pageNumber: number): string {
    const page = this.object(pageNumber)
    const contents = /\/Contents\s+(?:(\d+)\s+\d+\s+R|\[([^\]]*)\])/.exec(page)
    if (!contents) return ''

    if (contents[1]) {
      // A single reference may itself point at an array of streams.
      const direct = this.stream(Number(contents[1]))
      if (direct) return direct.toString('latin1')
      const array = /\[([^\]]*)\]/.exec(this.object(Number(contents[1])))
      if (!array) return ''
      return this.joinStreams(array[1]!)
    }
    return this.joinStreams(contents[2]!)
  }

  private joinStreams(references: string): string {
    let out = ''
    for (const match of references.matchAll(/(\d+)\s+\d+\s+R/g)) {
      // The newline matters: a stream can end mid-token, and two streams run
      // together would fuse the last operator of one onto the first of the next.
      out += `${this.stream(Number(match[1]))?.toString('latin1') ?? ''}\n`
    }
    return out
  }

  private pageFonts(pageNumber: number): Map<string, PdfFont> {
    const page = this.object(pageNumber)
    let resources = /\/Resources\s*(<<[\s\S]*?>>\s*(?:\/|>>|$))/.exec(page)?.[1] ?? ''
    const resourceRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(page)
    if (resourceRef) resources = this.object(Number(resourceRef[1]))
    // Inherited from the page tree, which is where a generator that repeats one
    // font across every page usually puts it.
    if (!resources) {
      const parent = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(page)
      if (parent) resources = this.object(Number(parent[1]))
    }

    const fontRef = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resources)
    const fontDict = fontRef
      ? this.object(Number(fontRef[1]))
      : (/\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? '')

    const fonts = new Map<string, PdfFont>()
    for (const entry of fontDict.matchAll(/\/([^\s/[\]<>]+)\s+(\d+)\s+\d+\s+R/g)) {
      const definition = this.object(Number(entry[2]))
      const toUnicodeRef = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(definition)
      const cmap = toUnicodeRef ? this.stream(Number(toUnicodeRef[1])) : null
      fonts.set(entry[1]!, {
        toUnicode: cmap ? parseToUnicode(cmap.toString('latin1')) : null,
        twoByte: /\/Type0\b/.test(definition) || /\/Identity-[HV]\b/.test(this.resolve(definition)),
      })
    }
    return fonts
  }
}

/**
 * A ToUnicode CMap: the font's own character codes back to real text.
 *
 * bfchar maps codes one at a time; bfrange maps a run. A range's destination can
 * be several code units long (a surrogate pair, or a ligature that expands to
 * two letters), in which case it is the LAST unit that walks up the range.
 */
export function parseToUnicode(source: string): Map<number, string> {
  const map = new Map<number, string>()

  for (const block of source.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
    for (const pair of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1]!, 16), hexToUnicode(pair[2]!))
    }
  }

  for (const block of source.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
    for (const entry of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const low = parseInt(entry[1]!, 16)
      const high = parseInt(entry[2]!, 16)
      const base = hexToUnicode(entry[3]!)
      if (!base) continue
      // A malformed range claiming the whole code space would otherwise build a
      // 65k-entry map per range and take the request with it.
      const last = Math.min(high, low + 65535)
      for (let code = low; code <= last; code += 1) {
        const units = [...base].map((c) => c.charCodeAt(0))
        units[units.length - 1] = (units[units.length - 1]! + (code - low)) & 0xffff
        map.set(code, String.fromCharCode(...units))
      }
    }
    // The array form: <lo> <hi> [<dst> <dst> …], one destination per code.
    for (const entry of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const low = parseInt(entry[1]!, 16)
      let offset = 0
      for (const destination of entry[3]!.matchAll(/<([0-9A-Fa-f]*)>/g)) {
        map.set(low + offset, hexToUnicode(destination[1]!))
        offset += 1
      }
    }
  }

  return map
}
