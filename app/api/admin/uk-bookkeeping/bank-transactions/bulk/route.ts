import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  acceptSuggestedMatches,
  MAX_BULK_LINES,
  recordEntriesFromBankLines,
  setBankLinesIgnored,
} from '@/modules/uk-bookkeeping/lib/reconcile-actions'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'
import { VAT_RATE_CODES, type VatRateCode } from '@/modules/uk-bookkeeping/lib/types'

// Doing the same thing to a handful of statement lines at once: code them all to
// one category, tick off the ones the matcher is sure about, set a run of
// internal transfers aside. The single-line buttons come through here too, with
// one id, so there is one code path and one set of refusals rather than two.

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  const ids: unknown = body?.ids

  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_BULK_LINES ||
    !ids.every((id) => typeof id === 'string' && id)
  ) {
    return NextResponse.json(
      { error: `Choose between one and ${MAX_BULK_LINES} statement lines.` },
      { status: 400 },
    )
  }
  const chosen = [...new Set(ids as string[])]

  try {
    switch (body.action) {
      case 'record': {
        if (typeof body.categoryId !== 'string' || !body.categoryId) {
          return NextResponse.json({ error: 'Choose what these were for first.' }, { status: 400 })
        }
        if (!VAT_RATE_CODES.includes(body.vatRateCode)) {
          return NextResponse.json({ error: 'That VAT rate is not one we recognise.' }, { status: 400 })
        }
        return NextResponse.json(
          await recordEntriesFromBankLines(
            chosen,
            {
              categoryId: body.categoryId,
              vatRateCode: body.vatRateCode as VatRateCode,
              // Recorded properly unless the reviewer asked for another look.
              status: body.leaveForReview === true ? 'draft' : 'posted',
            },
            gate.user,
          ),
        )
      }
      case 'accept-suggested':
        return NextResponse.json(await acceptSuggestedMatches(chosen, gate.user))
      case 'ignore':
        return NextResponse.json(
          await setBankLinesIgnored(
            chosen,
            true,
            typeof body.reason === 'string' ? body.reason : null,
            gate.user,
          ),
        )
      case 'unignore':
        return NextResponse.json(await setBankLinesIgnored(chosen, false, null, gate.user))
      default:
        return NextResponse.json(
          { error: 'That is not something we can do to a statement line.' },
          { status: 400 },
        )
    }
  } catch (error) {
    return toErrorResponse(error)
  }
}
