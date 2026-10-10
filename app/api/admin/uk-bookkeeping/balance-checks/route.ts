import { NextRequest, NextResponse } from 'next/server'
import { getBalancePosition, saveBalanceCheck } from '@/modules/uk-bookkeeping/lib/balance-checks'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { BalanceCheckBody } from '@/modules/uk-bookkeeping/lib/validation'

// Checking a cash account with no statement against the balance its supplier
// shows. See lib/balance-checks.ts and migrations/022_balance_checks.sql.

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const bankAccountId = request.nextUrl.searchParams.get('bankAccountId')
  if (!bankAccountId) return NextResponse.json({ error: 'Say which account.' }, { status: 400 })
  try {
    return NextResponse.json(await getBalancePosition(bankAccountId, request.nextUrl.searchParams.get('asAt')))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const parsed = BalanceCheckBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  try {
    return NextResponse.json({ check: await saveBalanceCheck(parsed.data, gate.user) }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
