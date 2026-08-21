import { NextRequest, NextResponse } from 'next/server'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import {
  deleteJournal,
  getJournal,
  postJournal,
  reverseJournal,
  updateJournal,
} from '@/modules/uk-bookkeeping/lib/journals'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const { id } = await params

  const journal = await getJournal(id)
  if (!journal) return NextResponse.json({ error: 'That journal was not found.' }, { status: 404 })
  return NextResponse.json({ journal })
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Nothing was sent.' }, { status: 400 })

  try {
    return NextResponse.json({ journal: await updateJournal(id, body, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

/** Post a draft, or reverse a posted one. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  const body = await request.json().catch(() => null)

  try {
    if (body?.action === 'reverse') {
      const date = typeof body.date === 'string' ? body.date : new Date().toISOString().slice(0, 10)
      return NextResponse.json({ journal: await reverseJournal(id, date, gate.user) })
    }
    return NextResponse.json({ journal: await postJournal(id, gate.user) })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.record')
  if (gate.error) return gate.error
  const { id } = await params

  try {
    await deleteJournal(id, gate.user)
    return NextResponse.json({ deleted: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
