import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { BANK_PRESETS, commitStatement, previewStatement } from '@/modules/uk-bookkeeping/lib/import'
import { listBankAccounts } from '@/modules/uk-bookkeeping/lib/bank-accounts'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Bank statement import, in two halves. POST reads the file - CSV or PDF - and
// shows what is in it, writing nothing. PUT keeps the bank's own lines and stops
// there: what each line was for is settled afterwards, on the reconciliation
// screen, where it can be done a few at a time and in bulk.

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

  const body = await request.json().catch(() => null)
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
          meta: body.meta ?? {},
          mapping: body.mapping ?? {},
          lines: body.lines,
        },
        gate.user,
      ),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
