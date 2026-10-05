import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { issueManualInvoice } from '@/modules/uk-bookkeeping/lib/manual-invoice'

// Makes the invoice for a payment that was recorded by hand - for the one that
// was recorded before invoices existed, or whose first print failed. Printing
// opens a browser, so the generous ceiling the module dispatcher already gives
// every route is the one this runs under.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    return NextResponse.json(await issueManualInvoice(id, gate.user))
  } catch (error) {
    return toErrorResponse(error)
  }
}
