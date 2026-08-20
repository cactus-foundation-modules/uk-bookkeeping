import { NextRequest, NextResponse } from 'next/server'
import { csvExportResponse, exportSummary, type ExportKind } from '@/modules/uk-bookkeeping/lib/export'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

const KINDS: ExportKind[] = ['transactions', 'lines', 'attachments', 'periods', 'audit']

// Everything out, in a form somebody else can read. Streamed rather than
// assembled in memory, so six years of records still comes back inside the
// dispatcher's 60 second ceiling.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { kind } = await params

  if (kind === 'summary') {
    return NextResponse.json(await exportSummary())
  }
  if (!KINDS.includes(kind as ExportKind)) {
    return NextResponse.json({ error: 'There is nothing of that kind to export.' }, { status: 404 })
  }

  const stamp = new Date().toISOString().slice(0, 10)
  return csvExportResponse(kind as ExportKind, `bookkeeping-${kind}-${stamp}.csv`)
}
