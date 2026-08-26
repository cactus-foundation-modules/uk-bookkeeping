import { NextRequest, NextResponse } from 'next/server'
import { recordEntryFromDocument } from '@/modules/uk-bookkeeping/lib/reconcile-actions'
import { BookkeepingError, toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { VAT_RATE_CODES, type VatRateCode } from '@/modules/uk-bookkeeping/lib/types'

// Confirming that this unfiled invoice is what this payment was for.
//
// One click, one finished entry: the amount and the settlement date from the
// bank, the supplier, the invoice number, the tax point and the VAT from the
// document, the category from whoever pressed the button. The document ends up
// attached to the entry it paid for, in the same database transaction.

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    const body = await request.json().catch(() => ({}))
    const documentId = typeof body.documentId === 'string' ? body.documentId.trim() : ''
    const categoryId = typeof body.categoryId === 'string' ? body.categoryId.trim() : ''
    if (!documentId) throw new BookkeepingError('invalid', 'Which document this is has to be said.')
    if (!categoryId) throw new BookkeepingError('invalid', 'Pick what it was for first.')

    const rate = body.vatRateCode as VatRateCode | undefined
    if (rate && !VAT_RATE_CODES.includes(rate)) {
      throw new BookkeepingError('invalid', 'That is not a VAT rate this module knows about.')
    }

    const outcome = await recordEntryFromDocument(
      id,
      {
        documentId,
        categoryId,
        vatRateCode: rate ?? null,
        status: body.status === 'draft' ? 'draft' : 'posted',
      },
      gate.user,
    )
    return NextResponse.json(outcome, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
