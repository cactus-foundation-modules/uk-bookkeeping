import { NextRequest, NextResponse } from 'next/server'
import {
  deleteAccountingPeriod,
  previewYearEnd,
  requireAccountingPeriod,
  updateAccountingPeriod,
} from '@/modules/uk-bookkeeping/lib/accounting-periods'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { balanceSheet, profitAndLoss } from '@/modules/uk-bookkeeping/lib/reports'

/**
 * One financial year, with the accounts for it and what closing it would post.
 *
 * All three together, because that is the decision being made on the screen:
 * here is the profit, here is the balance sheet it produces, here is the
 * journal that would take that profit to reserves. Splitting them into three
 * requests would only mean three chances of them being drawn as at different
 * moments.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    const period = await requireAccountingPeriod(id)
    const priorEnd = new Date(period.start_date.getTime() - 86_400_000)
    const [preview, pl, bs] = await Promise.all([
      previewYearEnd(id),
      profitAndLoss(period.start_date, period.end_date),
      balanceSheet(period.end_date, { priorAsAt: priorEnd }),
    ])
    return NextResponse.json({ period, preview, profitAndLoss: pl, balanceSheet: bs })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ period: await updateAccountingPeriod(id, body, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    await deleteAccountingPeriod(id, gate.user)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
