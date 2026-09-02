import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  BANK_PRESETS,
  commitStatement,
  previewStatement,
  type PreparedLine,
} from '@/modules/uk-bookkeeping/lib/import'
import { EMPTY_META, type StatementMeta } from '@/modules/uk-bookkeeping/lib/statement'
import { listBankAccounts } from '@/modules/uk-bookkeeping/lib/bank-accounts'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Bank statement import, in two halves. POST reads the file - CSV or PDF - and
// shows what is in it, writing nothing. PUT keeps the bank's own lines and stops
// there: what each line was for is settled afterwards, on the reconciliation
// screen, where it can be done a few at a time and in bulk.
//
// The PUT takes the FILE again as well as the lines, which looks like waste and
// is not. The file is now kept - filed under Bookkeeping / year / month / Bank
// Statements, named after the account - and the only two ways to have the bytes
// at commit time are to send them twice or to park them somewhere between the
// two requests. Parking them means a half-finished import leaving litter in a
// bucket nobody ever cleans up, so the browser sends them again.
//
// A plain JSON body still works and still imports. It simply keeps no copy of
// the statement, which is what every import before this did.

/**
 * PDFs are read in a Node runtime, not on the edge: the reader inflates the
 * file's streams with node:zlib, which has no edge equivalent.
 */
export const runtime = 'nodejs'

/**
 * 8 MB. A year of statements as PDF runs to a couple of megabytes; anything much
 * past this is a scan, and a scan has no text in it to read.
 */
const MAX_BYTES = 8 * 1024 * 1024

export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  return NextResponse.json({
    presets: BANK_PRESETS.map((preset) => ({ id: preset.id, label: preset.label })),
    accounts: (await listBankAccounts()).map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      accountLast4: account.account_last4,
    })),
  })
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was sent.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error:
          'That file is larger than 8 MB. Export a shorter date range from your bank and try again - and if it is a scan of a paper statement, there is no text in it for us to read.',
      },
      { status: 400 },
    )
  }

  const preset = typeof form?.get('preset') === 'string' ? String(form.get('preset')) : undefined
  const bankAccountId =
    typeof form?.get('bankAccountId') === 'string' && String(form.get('bankAccountId'))
      ? String(form.get('bankAccountId'))
      : null

  const rawMapping = form?.get('mapping')
  let mapping = null
  if (typeof rawMapping === 'string' && rawMapping.trim()) {
    try {
      mapping = JSON.parse(rawMapping)
    } catch {
      return NextResponse.json({ error: 'The column mapping could not be read.' }, { status: 400 })
    }
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer())
    return NextResponse.json(
      await previewStatement({ filename: file.name, bytes }, { bankAccountId, preset, mapping }),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const parsed = await readCommitBody(request)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const { body, file } = parsed

  if (!body?.lines || !Array.isArray(body.lines)) {
    return NextResponse.json({ error: 'Nothing was chosen to bring in.' }, { status: 400 })
  }
  if (typeof body.bankAccountId !== 'string' || !body.bankAccountId) {
    return NextResponse.json(
      { error: 'Choose which account this statement is for before bringing it in.' },
      { status: 400 },
    )
  }

  try {
    return NextResponse.json(
      await commitStatement(
        {
          filename: typeof body.filename === 'string' ? body.filename : 'bank-statement',
          format: body.format === 'pdf' ? 'pdf' : 'csv',
          bankAccountId: body.bankAccountId,
          preset: typeof body.preset === 'string' ? body.preset : null,
          meta: body.meta ?? EMPTY_META,
          mapping: body.mapping ?? {},
          lines: body.lines,
          file,
          replaceStatementId:
            typeof body.replaceStatementId === 'string' && body.replaceStatementId
              ? body.replaceStatementId
              : null,
        },
        gate.user,
      ),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** What the browser sends back once somebody has looked at the preview and said
 *  yes. Every field is checked before it reaches an INSERT - see checkLine and
 *  commitStatement, which do not trust this any further than the shape. */
type CommitBody = {
  filename?: string
  format?: string
  bankAccountId?: string
  preset?: string
  meta?: StatementMeta
  mapping?: Record<string, unknown>
  lines?: PreparedLine[]
  replaceStatementId?: string
}

/**
 * The commit body, whichever way it arrived.
 *
 * Multipart when the browser is re-sending the file alongside what was reviewed,
 * plain JSON otherwise. The JSON half is the older shape and stays supported
 * exactly as it was - an import is not going to start refusing to run because
 * something is posting to it the way it always has.
 */
async function readCommitBody(
  request: NextRequest,
): Promise<{ body: CommitBody | null; file: Buffer | null } | { error: string }> {
  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    return { body: (await request.json().catch(() => null)) as CommitBody | null, file: null }
  }

  const form = await request.formData().catch(() => null)
  if (!form) return { error: 'That import could not be read.' }

  const raw = form.get('payload')
  if (typeof raw !== 'string') {
    return { error: 'That import arrived without the lines to bring in.' }
  }
  let body: CommitBody | null
  try {
    body = JSON.parse(raw) as CommitBody
  } catch {
    return { error: 'That import could not be read.' }
  }

  const sent = form.get('file')
  if (!(sent instanceof File)) return { body, file: null }
  // The same ceiling the preview enforces. It has already been past this once,
  // so this is a guard against the second request being something else rather
  // than a check anybody is expected to hit.
  if (sent.size > MAX_BYTES) {
    return { error: 'That file is larger than 8 MB, so no copy of it has been kept.' }
  }
  return { body, file: Buffer.from(await sent.arrayBuffer()) }
}
