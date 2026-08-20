import { NextResponse } from 'next/server'
import { appendAudit, verifyAuditChain } from '@/modules/uk-bookkeeping/lib/audit'
import { checkTriggerHealth } from '@/modules/uk-bookkeeping/lib/health'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Whether the guards that make a filed return unchangeable are still in place.
// A trigger missing or switched off is a red banner on every bookkeeping page
// and an audit row, because interference that nobody can see is the only kind
// worth worrying about.
export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  const health = await checkTriggerHealth()
  if (!health.healthy) {
    await appendAudit({
      action: 'health.trigger-missing',
      entityType: 'health',
      summary: 'One or more record-protection guards are missing or switched off',
      detail: health,
      user: gate.user,
    })
  }
  return NextResponse.json(health)
}

export async function POST() {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error
  return NextResponse.json(await verifyAuditChain())
}
