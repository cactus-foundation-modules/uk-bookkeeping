import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { appendAudit } from '@/modules/uk-bookkeeping/lib/audit'
import { createCategory, listCategories } from '@/modules/uk-bookkeeping/lib/categories'
import { toErrorResponse } from '@/modules/uk-bookkeeping/lib/errors'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

export async function GET(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error
  const includeArchived = request.nextUrl.searchParams.get('archived') === '1'
  return NextResponse.json({ categories: await listCategories(includeArchived) })
}

const Body = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  direction: z.enum(['income', 'expense', 'both']),
  sa103Box: z.string().nullable().optional(),
  ct600Group: z.string().nullable().optional(),
  isTrading: z.boolean().optional(),
  isCapital: z.boolean().optional(),
})

export async function POST(request: NextRequest) {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  try {
    const category = await createCategory(parsed.data)
    await appendAudit({
      action: 'category.created',
      entityType: 'category',
      entityId: category.id,
      summary: `Category “${category.name}” added`,
      user: gate.user,
    })
    return NextResponse.json(category, { status: 201 })
  } catch (error) {
    return toErrorResponse(error)
  }
}
