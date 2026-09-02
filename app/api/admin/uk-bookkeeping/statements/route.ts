import { NextRequest, NextResponse } from 'next/server'
import { listBankAccounts } from '@/modules/uk-bookkeeping/lib/bank-accounts'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { listStatements } from '@/modules/uk-bookkeeping/lib/statements'

// Every statement brought in, for the screen that lists them.
//
// The accounts come back with it rather than from a second request: the filter
// at the top of the page needs them before it can render, and two round trips to
// draw one toolbar is two round trips.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  try {
    const list = await listStatements({
      bankAccountId: params.get('bankAccountId'),
      missingFileOnly: params.get('missingFile') === '1',
      limit: Number(params.get('limit') ?? 50),
      offset: Number(params.get('offset') ?? 0),
    })

    return NextResponse.json({
      ...list,
      accounts: (await listBankAccounts(true)).map((account) => ({
        id: account.id,
        name: account.name,
        kind: account.kind,
        accountLast4: account.account_last4,
      })),
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
