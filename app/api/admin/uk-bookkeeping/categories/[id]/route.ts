import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { appendAudit } from '@/modules/uk-bookkeeping/lib/audit'
import { deleteOrArchiveCategory, updateCategory } from '@/modules/uk-bookkeeping/lib/categories'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

const Body = z.object({
  name: z.string().min(1).optional(),
  direction: z.enum(['income', 'expense', 'both']).optional(),
  sa103Box: z.string().nullable().optional(),
  ct600Group: z.string().nullable().optional(),
  isTrading: z.boolean().optional(),
  isCapital: z.boolean().optional(),
  position: z.number().int().optional(),
  archived: z.boolean().optional(),
  /** Move it onto a different account. */
  accountId: z.string().nullable().optional(),
})

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const { id } = await params
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  try {
    const category = await updateCategory(id, parsed.data)
    await appendAudit({
      action: parsed.data.archived ? 'category.archived' : 'category.updated',
      entityType: 'category',
      entityId: id,
      summary: `Category “${category.name}” ${parsed.data.archived ? 'archived' : 'changed'}`,
      user: gate.user,
    })
    return NextResponse.json(category)
  } catch (error) {
    return toErrorResponse(error)
  }
}

// Mostly not a delete. A seeded category, or one any entry has ever pointed at,
// is archived instead - a 2019 return has to be able to explain itself in 2026.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const { id } = await params
  try {
    const outcome = await deleteOrArchiveCategory(id)
    await appendAudit({
      action: 'category.archived',
      entityType: 'category',
      entityId: id,
      summary: outcome === 'deleted' ? 'Unused category deleted' : 'Category archived',
      user: gate.user,
    })
    return NextResponse.json({ outcome })
  } catch (error) {
    return toErrorResponse(error)
  }
}
