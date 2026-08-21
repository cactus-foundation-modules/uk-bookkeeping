import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { bulkDeleteDrafts, bulkPostDrafts } from '@/modules/uk-bookkeeping/lib/transactions'

// Reviewing an import in one go: post the ticked drafts, or bin them. Only
// drafts - a posted record is deleted one at a time, with its own confirm.
export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  const action = body?.action
  const ids: unknown = body?.ids
  if (
    (action !== 'post' && action !== 'delete') ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 500 ||
    !ids.every((id) => typeof id === 'string')
  ) {
    return NextResponse.json({ error: 'Nothing usable was chosen.' }, { status: 400 })
  }

  try {
    const outcome =
      action === 'post'
        ? await bulkPostDrafts(ids as string[], gate.user)
        : await bulkDeleteDrafts(ids as string[], gate.user)
    return NextResponse.json(outcome)
  } catch (error) {
    return toErrorResponse(error)
  }
}
