import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  getBankTransaction,
  setBankTransactionIgnored,
} from '@/modules/uk-bookkeeping/lib/bank-transactions'
import {
  listMatches,
  matchTransaction,
  suggestMatches,
  unmatch,
} from '@/modules/uk-bookkeeping/lib/reconciliation'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await params

  const line = await getBankTransaction(id)
  if (!line) return NextResponse.json({ error: 'That statement line was not found.' }, { status: 404 })

  try {
    return NextResponse.json({
      line,
      matches: await listMatches(id),
      suggestions: line.status === 'unreconciled' ? await suggestMatches(id) : [],
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/**
 * Everything that changes what a statement line means, in one place: tie an
 * entry to it, take one off, or set it aside.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body?.action) return NextResponse.json({ error: 'Nothing was asked for.' }, { status: 400 })

  try {
    switch (body.action) {
      case 'match': {
        if (typeof body.transactionId !== 'string') {
          return NextResponse.json({ error: 'Which entry should it be matched to?' }, { status: 400 })
        }
        await matchTransaction(
          {
            bankTransactionId: id,
            transactionId: body.transactionId,
            amount: typeof body.amount === 'string' ? body.amount : null,
            method: body.method === 'suggested' ? 'suggested' : 'manual',
          },
          gate.user,
        )
        break
      }
      case 'unmatch': {
        if (typeof body.transactionId !== 'string') {
          return NextResponse.json({ error: 'Which match should come off?' }, { status: 400 })
        }
        await unmatch(id, body.transactionId, gate.user)
        break
      }
      case 'ignore':
        await setBankTransactionIgnored(id, true, typeof body.reason === 'string' ? body.reason : null)
        break
      case 'unignore':
        await setBankTransactionIgnored(id, false, null)
        break
      default:
        return NextResponse.json({ error: 'That is not something we can do to a statement line.' }, { status: 400 })
    }

    const line = await getBankTransaction(id)
    return NextResponse.json({
      line,
      matches: await listMatches(id),
      suggestions: line?.status === 'unreconciled' ? await suggestMatches(id) : [],
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
