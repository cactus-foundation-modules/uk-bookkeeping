import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { createTransfer } from '@/modules/uk-bookkeeping/lib/transfers'
import { TransferBody } from '@/modules/uk-bookkeeping/lib/validation'

// Money moved between two accounts the business already owns. Its own route
// rather than a branch of the transactions one, because it writes a journal and
// not an entry - see lib/transfers.ts and migrations/020_transfers.sql.

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const parsed = TransferBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  try {
    return NextResponse.json(await createTransfer(parsed.data, gate.user), { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
