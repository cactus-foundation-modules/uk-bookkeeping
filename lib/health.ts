import { prisma } from '@/lib/db/prisma'

// The honest version of "bulletproof".
//
// The immutability triggers in 002_immutability.sql stop a buggy service
// function, a careless migration, a rogue module and an admin API that forgot
// its check. They do not stop a determined human with the connection string: the
// application connects as the table owner, and a table owner can ALTER TABLE ...
// DISABLE TRIGGER. No amount of trigger code changes that.
//
// What it can do is make interference VISIBLE. Any trigger missing, or present
// but switched off, puts a red banner across every bookkeeping page and writes
// an audit row.

/** Every trigger 002_immutability.sql installs, and what it protects. */
export const EXPECTED_TRIGGERS: { name: string; table: string; protects: string }[] = [
  { name: 'bk_transactions_immutable', table: 'bk_transactions', protects: 'filed transactions cannot be changed or deleted' },
  { name: 'bk_transaction_lines_immutable', table: 'bk_transaction_lines', protects: 'lines of a filed transaction cannot be changed' },
  { name: 'bk_transaction_lines_no_insert_locked', table: 'bk_transaction_lines', protects: 'no line can be added to a filed transaction' },
  { name: 'bk_attachments_immutable', table: 'bk_attachments', protects: 'evidence for a filed return cannot be changed or removed' },
  { name: 'bk_attachments_no_insert_locked', table: 'bk_attachments', protects: 'no evidence can be added to a filed transaction' },
  { name: 'bk_vat_periods_immutable', table: 'bk_vat_periods', protects: 'a submitted VAT period cannot be changed' },
  { name: 'bk_audit_log_append_only', table: 'bk_audit_log', protects: 'the audit log is append-only' },
  { name: 'bk_period_snapshots_append_only', table: 'bk_period_snapshots', protects: 'return snapshots are append-only' },
  { name: 'bk_period_snapshot_lines_append_only', table: 'bk_period_snapshot_lines', protects: 'snapshot workings are append-only' },
  { name: 'bk_hmrc_api_calls_append_only', table: 'bk_hmrc_api_calls', protects: 'the record of what was sent to HMRC is write-once' },
]

export type TriggerHealth = {
  healthy: boolean
  missing: { name: string; table: string; protects: string }[]
  disabled: { name: string; table: string; protects: string }[]
}

export async function checkTriggerHealth(): Promise<TriggerHealth> {
  // tgenabled: 'O' means "fires in the ordinary way". 'D' is disabled; 'R'/'A'
  // are replication-role settings which, for our purposes, are equally "not
  // what this migration installed".
  const rows = await prisma.$queryRaw<{ tgname: string; tgenabled: string }[]>`
    SELECT t.tgname, t.tgenabled
    FROM pg_trigger t
    WHERE t.tgrelid::regclass::text LIKE 'bk\\_%'
      AND NOT t.tgisinternal
  `
  const found = new Map(rows.map((r) => [r.tgname, r.tgenabled]))

  const missing: TriggerHealth['missing'] = []
  const disabled: TriggerHealth['disabled'] = []
  for (const expected of EXPECTED_TRIGGERS) {
    const state = found.get(expected.name)
    if (state === undefined) missing.push(expected)
    else if (state !== 'O') disabled.push(expected)
  }

  return { healthy: missing.length === 0 && disabled.length === 0, missing, disabled }
}
