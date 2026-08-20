import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { markSubmittedElsewhere } from '@/modules/uk-bookkeeping/lib/periods'

// Filed through some other tool, recorded here so the records lock anyway. This
// is what keeps the module honest for an owner who never gets production
// approval from HMRC, which is a real outcome and not a hypothetical one.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.submit')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    return NextResponse.json({ period: await markSubmittedElsewhere(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
