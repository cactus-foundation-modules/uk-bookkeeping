import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  previewDepreciation,
  runDepreciation,
  undoDepreciation,
} from '@/modules/uk-bookkeeping/lib/fixed-assets'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

function range(params: URLSearchParams): { from: Date; to: Date } | null {
  const fromRaw = params.get('from')
  const toRaw = params.get('to')
  if (!fromRaw || !toRaw) return null
  const from = new Date(`${fromRaw}T00:00:00.000Z`)
  const to = new Date(`${toRaw}T00:00:00.000Z`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null
  if (to.getTime() < from.getTime()) return null
  return { from, to }
}

// GET shows what would be charged; POST charges it. The same function produces
// both, so what the screen offered and what lands in the books are the same
// arithmetic rather than two goes at it.
export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const dates = range(request.nextUrl.searchParams)
  if (!dates) {
    return NextResponse.json({ error: 'Give a start and an end date, in that order.' }, { status: 400 })
  }

  try {
    return NextResponse.json(await previewDepreciation(dates.from, dates.to))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const body = await request.json().catch(() => null)
  const dates = range(new URLSearchParams(body ?? {}))
  if (!dates) {
    return NextResponse.json({ error: 'Give a start and an end date, in that order.' }, { status: 400 })
  }

  try {
    return NextResponse.json(await runDepreciation(dates.from, dates.to, gate.user))
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error

  const journalId = request.nextUrl.searchParams.get('journalId')
  if (!journalId) return NextResponse.json({ error: 'Which run?' }, { status: 400 })

  try {
    await undoDepreciation(journalId, gate.user)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
