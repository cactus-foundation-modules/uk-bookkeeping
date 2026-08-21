import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { createJournal, listJournals, listTemplates } from '@/modules/uk-bookkeeping/lib/journals'
import { listAccounts } from '@/modules/uk-bookkeeping/lib/accounts'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import type { JournalStatus } from '@/modules/uk-bookkeeping/lib/types'

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  const status = params.get('status')

  try {
    const list = await listJournals({
      from: params.get('from'),
      to: params.get('to'),
      status: status === 'draft' || status === 'posted' ? (status as JournalStatus) : null,
      accountId: params.get('accountId'),
      search: params.get('search'),
      limit: Number(params.get('limit') ?? 50),
      offset: Number(params.get('offset') ?? 0),
    })
    return NextResponse.json({
      ...list,
      accounts: await listAccounts(),
      templates: await listTemplates(),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ journal: await createJournal(body, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
