import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { listBankTransactions } from '@/modules/uk-bookkeeping/lib/bank-transactions'
import { suggestMatchesForLines, summariseReconciliation } from '@/modules/uk-bookkeeping/lib/reconciliation'
import { formatMoney } from '@/modules/uk-bookkeeping/lib/money'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import type { BankTransactionStatus } from '@/modules/uk-bookkeeping/lib/types'

// The reconciliation screen's one read: the statement lines, what is matched to
// each, and - for the ones still open - what might explain them.

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const params = request.nextUrl.searchParams
  const bankAccountId = params.get('bankAccountId')
  const status = params.get('status') as BankTransactionStatus | null

  try {
    const list = await listBankTransactions({
      bankAccountId,
      status: status && ['unreconciled', 'reconciled', 'ignored'].includes(status) ? status : null,
      from: params.get('from'),
      to: params.get('to'),
      search: params.get('search'),
      limit: Number(params.get('limit') ?? 100),
      offset: Number(params.get('offset') ?? 0),
    })

    // Suggestions for the open ones only, and in one query for the lot of them.
    // A reconciled line needs no suggestions, and asking for them per row is how
    // this page would spend its sixty seconds.
    const open = list.rows.filter((row) => row.status === 'unreconciled')
    const suggestions = await suggestMatchesForLines(
      open.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        amount: formatMoney(row.amount),
        counterparty: row.counterparty,
        details: row.details,
        reference: row.reference,
      })),
    )

    const byId: Record<string, unknown> = {}
    open.forEach((row, index) => {
      byId[row.id] = suggestions.get(index) ?? []
    })

    return NextResponse.json({
      ...list,
      suggestions: byId,
      summary: bankAccountId
        ? await summariseReconciliation(bankAccountId, params.get('from'), params.get('to'))
        : null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
