import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import {
  buildReportCsv,
  REPORT_CSV_KINDS,
  type ReportCsvKind,
} from '@/modules/uk-bookkeeping/lib/report-csv'

// Any report on the Reports screen as a spreadsheet, for the same date range
// the screen is showing.
export async function GET(request: NextRequest, { params }: { params: Promise<{ kind: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { kind } = await params
  if (!(REPORT_CSV_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: 'There is no report of that kind.' }, { status: 404 })
  }

  const query = request.nextUrl.searchParams
  const to = query.get('to') ? new Date(`${query.get('to')}T00:00:00.000Z`) : new Date()
  const from = query.get('from')
    ? new Date(`${query.get('from')}T00:00:00.000Z`)
    : new Date(Date.UTC(to.getUTCFullYear(), 0, 1))
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: 'That date range is not one we can read.' }, { status: 400 })
  }

  try {
    const csv = await buildReportCsv(kind as ReportCsvKind, {
      from,
      to,
      accountId: query.get('accountId'),
    })
    if (!csv) {
      return NextResponse.json({ error: 'Pick an account first.' }, { status: 400 })
    }
    return new Response(csv.body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csv.filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
