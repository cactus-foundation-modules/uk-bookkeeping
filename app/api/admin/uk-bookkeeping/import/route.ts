import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { BANK_PRESETS, commitImport, previewImport } from '@/modules/uk-bookkeeping/lib/import'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Bank statement import, in two halves. POST reads the file and shows what each
// row WOULD become, writing nothing. PUT creates what the reviewer ticked, as
// drafts - and a draft reaches no VAT box until a human has posted it.

export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  return NextResponse.json({ presets: BANK_PRESETS.map((p) => ({ id: p.id, label: p.label })) })
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file was sent.' }, { status: 400 })
  }
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json(
      { error: 'That file is larger than 5 MB. Export a shorter date range from your bank and try again.' },
      { status: 400 },
    )
  }

  const preset = typeof form?.get('preset') === 'string' ? String(form.get('preset')) : undefined
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
    return NextResponse.json(await previewImport(await file.text(), preset, mapping))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PUT(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  if (!body?.rows || !Array.isArray(body.rows) || !Array.isArray(body.include)) {
    return NextResponse.json({ error: 'Nothing was chosen to import.' }, { status: 400 })
  }

  try {
    const result = await commitImport(
      {
        filename: typeof body.filename === 'string' ? body.filename : 'bank-statement.csv',
        preset: typeof body.preset === 'string' ? body.preset : null,
        mapping: body.mapping,
        rows: body.rows,
        include: body.include,
      },
      gate.user,
    )
    return NextResponse.json(result)
  } catch (error) {
    return toErrorResponse(error)
  }
}
