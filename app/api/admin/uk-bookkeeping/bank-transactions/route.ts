import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { listBankTransactions } from '@/modules/uk-bookkeeping/lib/bank-transactions'
import { aliasMap } from '@/modules/uk-bookkeeping/lib/counterparty-aliases'
import { suggestDocumentsForLines } from '@/modules/uk-bookkeeping/lib/document-matching'
import { suggestMatchesForLines, summariseReconciliation } from '@/modules/uk-bookkeeping/lib/reconciliation'
import { formatMoney } from '@/modules/uk-bookkeeping/lib/money'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { suggestCategoriesForCounterparties } from '@/modules/uk-bookkeeping/lib/transactions'
import { findTransferCandidatesForLines } from '@/modules/uk-bookkeeping/lib/transfers'
import type { BankTransactionStatus } from '@/modules/uk-bookkeeping/lib/types'

// The reconciliation screen's one read: the statement lines, what is matched to
// each, and - for the ones still open - what might explain them.
//
// Two kinds of "what might explain them", and they are different questions.
// `suggestions` are entries already in the books, and accepting one ties the two
// together. `documentSuggestions` are receipts sitting unfiled in the inbox that
// nobody has typed up yet, and accepting one WRITES the entry, from what the
// document says, with the document attached to it. `transferSuggestions` are
// movements between two of the business's own accounts, where the line is one
// half of something already recorded on the other side.

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
    const matchable = open.map((row) => ({
      date: row.date.toISOString().slice(0, 10),
      amount: formatMoney(row.amount),
      counterparty: row.counterparty,
      details: row.details,
      reference: row.reference,
    }))
    const suggestions = await suggestMatchesForLines(matchable)

    const byId: Record<string, unknown> = {}
    open.forEach((row, index) => {
      byId[row.id] = suggestions.get(index) ?? []
    })

    // Unfiled paperwork that might be what each of these payments was for. One
    // read of the inbox for the whole page, then arithmetic - same rule as the
    // entry matcher above.
    const documents = await suggestDocumentsForLines(matchable, await aliasMap())
    const documentsById: Record<string, unknown> = {}
    open.forEach((row, index) => {
      const found = documents.byLine.get(index)
      if (found?.length) documentsById[row.id] = found
    })

    // Money moved between two of the business's own accounts, where this line is
    // one half of it. Same one-query-for-the-page rule as the two above.
    const transfers = await findTransferCandidatesForLines(
      open.map((row) => ({
        id: row.id,
        bankAccountId: row.bank_account_id,
        date: row.date.toISOString().slice(0, 10),
        amount: formatMoney(row.amount),
      })),
    )
    const transfersById: Record<string, unknown> = {}
    for (const [id, found] of transfers) {
      if (found.length) transfersById[id] = found
    }

    // What each of these counterparties was filed under last time, so the screen
    // opens with a category already picked on most lines. One query for the page.
    const nameOf = (row: (typeof open)[number]): string =>
      row.counterparty.trim() || row.details.trim()
    const guesses = await suggestCategoriesForCounterparties(open.map(nameOf))
    const categoryGuesses: Record<string, string> = {}
    for (const row of open) {
      const guess = guesses.get(nameOf(row).toLowerCase())
      if (guess) categoryGuesses[row.id] = guess
    }

    return NextResponse.json({
      ...list,
      suggestions: byId,
      documentSuggestions: documentsById,
      transferSuggestions: transfersById,
      documentsTruncated: documents.truncated,
      categoryGuesses,
      summary: bankAccountId
        ? await summariseReconciliation(bankAccountId, params.get('from'), params.get('to'))
        : null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
