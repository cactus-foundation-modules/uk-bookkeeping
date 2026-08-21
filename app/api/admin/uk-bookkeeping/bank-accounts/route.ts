import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  createBankAccount,
  listBankAccounts,
} from '@/modules/uk-bookkeeping/lib/bank-accounts'
import { getBankAccountPosition } from '@/modules/uk-bookkeeping/lib/bank-transactions'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const includeArchived = request.nextUrl.searchParams.get('archived') === 'true'
  const accounts = await listBankAccounts(includeArchived)

  // The position for each account alongside it, so the screen does not have to
  // ask again per row.
  const positions = await Promise.all(accounts.map((account) => getBankAccountPosition(account.id)))
  return NextResponse.json({
    accounts: accounts.map((account, index) => ({ ...account, position_summary: positions[index] })),
  })
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ account: await createBankAccount(body) })
  } catch (error) {
    return toErrorResponse(error)
  }
}
