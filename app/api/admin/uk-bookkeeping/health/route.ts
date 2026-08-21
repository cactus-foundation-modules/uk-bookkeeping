import { NextResponse } from 'next/server'
import { appendAudit, verifyAuditChain } from '@/modules/uk-bookkeeping/lib/audit'
import { checkTriggerHealth } from '@/modules/uk-bookkeeping/lib/health'
import { ledgerHealth } from '@/modules/uk-bookkeeping/lib/ledger'
import { requireBookkeepingUser } from '@/modules/uk-bookkeeping/lib/permissions'

// Whether the guards that make a filed return unchangeable are still in place.
// A trigger missing or switched off is a red banner on every bookkeeping page
// and an audit row, because interference that nobody can see is the only kind
// worth worrying about.
export async function GET() {
  const gate = await requireBookkeepingUser('bookkeeping.access')
  if (gate.error) return gate.error

  // Two different questions, one banner. "Are the guards still in place" and
  // "do the books add up" are both things a site owner needs told without
  // having to go and look, and neither is worth its own request.
  const [health, ledger] = await Promise.all([checkTriggerHealth(), ledgerHealth()])
  if (!health.healthy) {
    await appendAudit({
      action: 'health.trigger-missing',
      entityType: 'health',
      summary: 'One or more record-protection guards are missing or switched off',
      detail: health,
      user: gate.user,
    })
  }
  return NextResponse.json({ ...health, ledger })
}

export async function POST() {
  const gate = await requireBookkeepingUser('bookkeeping.settings')
  if (gate.error) return gate.error
  return NextResponse.json(await verifyAuditChain())
}
