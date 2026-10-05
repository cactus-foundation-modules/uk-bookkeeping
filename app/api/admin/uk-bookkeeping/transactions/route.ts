import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { createTransaction, listTransactions } from '@/modules/uk-bookkeeping/lib/transactions'
import { issueManualInvoice, wantsManualInvoice } from '@/modules/uk-bookkeeping/lib/manual-invoice'
import { getSettings } from '@/modules/uk-bookkeeping/lib/settings'
import { TransactionBody } from '@/modules/uk-bookkeeping/lib/validation'

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const query = request.nextUrl.searchParams
  const boolean = (name: string): boolean | null => {
    const value = query.get(name)
    return value === null || value === '' ? null : value === '1' || value === 'true'
  }
  // Number('abc') is NaN, and NaN sails through a Math.min/Math.max clamp
  // straight into LIMIT - a 500 for a mistyped query string.
  const integer = (name: string, fallback: number): number => {
    const value = Number(query.get(name) ?? NaN)
    return Number.isFinite(value) ? Math.trunc(value) : fallback
  }

  try {
    const list = await listTransactions({
      from: query.get('from'),
      to: query.get('to'),
      // 'transfer' is not a direction on the row - it selects the journals that
      // are transfers instead. See lib/transactions.ts.
      direction: (query.get('direction') as 'income' | 'expense' | 'transfer' | null) || null,
      categoryId: query.get('categoryId'),
      vatRateCode: (query.get('vatRateCode') as never) || null,
      counterparty: query.get('counterparty'),
      status: (query.get('status') as 'draft' | 'posted' | null) || null,
      locked: boolean('locked'),
      hasEvidence: boolean('hasEvidence'),
      evidenceNotRequired: boolean('evidenceNotRequired'),
      limit: integer('limit', 50),
      offset: integer('offset', 0),
    })
    return NextResponse.json(list)
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const parsed = TransactionBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  try {
    const created = await createTransaction(parsed.data, gate.user)

    // Money recorded as coming in gets its invoice, unless the person has said
    // they are attaching their own. Never fatal: the entry is saved either way,
    // and a failure comes back as a sentence the form shows - the entry's own
    // page has a button to try again under the same number.
    let invoiceError: string | null = null
    if (parsed.data.generateInvoice !== false && wantsManualInvoice(created)) {
      try {
        if ((await getSettings()).auto_invoice_manual_income) {
          await issueManualInvoice(created.id, gate.user)
        }
      } catch (error) {
        console.error('[uk-bookkeeping] could not make an invoice for a recorded payment:', error)
        invoiceError = error instanceof Error ? error.message : 'The invoice could not be made.'
      }
    }
    return NextResponse.json({ ...created, invoiceError }, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
