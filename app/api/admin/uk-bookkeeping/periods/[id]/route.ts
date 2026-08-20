import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import {
  compareWithFinalisedSnapshot,
  computeNetErrors,
  computePeriod,
  getPeriod,
  isOverdue,
  listSnapshots,
} from '@/modules/uk-bookkeeping/lib/periods'
import { netVatDirection } from '@/modules/uk-bookkeeping/lib/vat-boxes'

// One period, with its nine boxes worked out from the records as they stand.
// Recomputed on every read, never served from a stored total: a stored total is
// exactly how a return comes to disagree with the records behind it.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const { id } = await params
  const period = await getPeriod(id)
  if (!period) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    const computed = await computePeriod(period)
    const [snapshots, netErrors, comparison] = await Promise.all([
      listSnapshots(id),
      computeNetErrors(period),
      period.status === 'finalised' ? compareWithFinalisedSnapshot(period) : Promise.resolve(null),
    ])

    return NextResponse.json({
      period: { ...period, overdue: isOverdue(period) },
      boxes: computed.boxes,
      unrounded: computed.unrounded,
      lines: computed.lines,
      direction: netVatDirection(computed.boxes),
      snapshots,
      netErrors,
      comparison,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
