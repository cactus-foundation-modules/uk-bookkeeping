import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { balanceSheet } from '@/modules/uk-bookkeeping/lib/reports'

// The balance sheet as at a date, with the same date a year earlier alongside
// it unless the caller names a different one - which the year end screen does,
// because a comparative should be the previous year END and not the same
// calendar date.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  const asAt = params.get('asAt')
    ? new Date(`${params.get('asAt')}T00:00:00.000Z`)
    : new Date()
  const priorRaw = params.get('priorAsAt')
  const priorAsAt = priorRaw ? new Date(`${priorRaw}T00:00:00.000Z`) : null
  if (Number.isNaN(asAt.getTime()) || (priorAsAt && Number.isNaN(priorAsAt.getTime()))) {
    return NextResponse.json({ error: 'That date is not one we can read.' }, { status: 400 })
  }

  try {
    return NextResponse.json(
      await balanceSheet(asAt, {
        comparative: params.get('comparative') !== 'false',
        priorAsAt,
      }),
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}
