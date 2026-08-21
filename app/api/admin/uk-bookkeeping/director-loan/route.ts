import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { listDirectorLoanAccounts } from '@/modules/uk-bookkeeping/lib/accounts'
import {
  getDirectorLoanStatement,
  summariseDirectorLoans,
} from '@/modules/uk-bookkeeping/lib/director-loan'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  const accounts = await listDirectorLoanAccounts()
  const requested = params.get('accountId') ?? accounts[0]?.id ?? null

  try {
    return NextResponse.json({
      accounts,
      summaries: await summariseDirectorLoans(),
      statement: requested
        ? await getDirectorLoanStatement(requested, {
            from: params.get('from'),
            to: params.get('to'),
          })
        : null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
