import { NextRequest, NextResponse } from 'next/server'
import { appendAudit } from '@/modules/uk-bookkeeping/lib/audit'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { sweepFiling } from '@/modules/uk-bookkeeping/lib/refiling'

// Moving what is already filed into the folder scheme.
//
// A button rather than something that happens on its own at deploy time, and
// deliberately so: every move copies a file in storage, and a few hundred
// receipts shifting themselves about unannounced during a site update is not a
// thing anybody asked for. Somebody presses it, and it says what it did.
//
// Batched, and the browser calls it again with the cursor until there is
// nothing left. Each call is well inside a serverless function's ceiling, and
// stopping half way is harmless - it is idempotent, so the next run picks up
// exactly where this one stopped and files already in place cost a comparison.
export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  const after = typeof body?.after === 'string' ? body.after : null

  try {
    const sweep = await sweepFiling({ after })

    // One entry per sweep that actually moved something, so "who reorganised the
    // evidence folder" has an answer. A pass that moved nothing says nothing.
    if (sweep.moved > 0) {
      await appendAudit({
        action: 'documents.refiled',
        entityType: 'attachment',
        entityId: sweep.cursor ?? 'sweep',
        summary: `${sweep.moved} document${sweep.moved === 1 ? '' : 's'} moved into the Bookkeeping folders`,
        detail: { examined: sweep.examined, moved: sweep.moved, examples: sweep.examples },
        user: gate.user,
      })
    }

    return NextResponse.json(sweep)
  } catch (error) {
    return toErrorResponse(error)
  }
}
