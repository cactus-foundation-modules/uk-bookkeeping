import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { accountBalances, createAccount, listAccounts, trialBalance } from '@/modules/uk-bookkeeping/lib/accounts'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  const asAt = params.get('asAt')

  try {
    return NextResponse.json({
      accounts: await listAccounts(params.get('archived') === 'true'),
      balances: params.get('balances') === 'true' ? await accountBalances(asAt) : undefined,
      trialBalance: params.get('trialBalance') === 'true' ? await trialBalance(asAt) : undefined,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ account: await createAccount(body) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
