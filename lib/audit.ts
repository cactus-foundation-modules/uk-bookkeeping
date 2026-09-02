import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import type { SessionUser } from '@/lib/auth/session'

// The append-only audit log, and the hash chain over it.
//
// Chained, but with the honest caveat written down rather than left implied: a
// chain proves nothing to anybody whose only copy of the data is the database
// itself. Whoever rewrote row 400 could rewrite 401 to 900 as well, and
// self-verifying tamper-evidence is a common and comfortable illusion.
//
// What makes it real is an anchor the operator holds and we do not. So every
// submission emails the operator a receipt carrying the chain head hash (see
// lib/periods.ts), that mail sits in a mailbox nothing here can edit, and the
// same head is shown in the settings tab and written into every export. A later
// rewrite of history changes the head, and the head no longer matches the mail.
//
// Computed in application code and NEVER in a trigger: a trigger would recompute
// hashes during a backup restore and destroy the chain it was meant to protect.

export type AuditAction =
  | 'transaction.created'
  | 'transaction.updated'
  | 'transaction.deleted'
  | 'transaction.posted'
  | 'attachment.added'
  | 'attachment.removed'
  // An unfiled document being given an entry to belong to, and taken off one
  // again. Separate from added/removed because the file itself does not move -
  // what changes is what it is evidence FOR, which is the interesting fact.
  | 'attachment.filed'
  | 'attachment.unfiled'
  | 'attachment.file-deleted'
  | 'attachment.reading-corrected'
  | 'attachment.reread'
  | 'category.created'
  | 'category.updated'
  | 'category.archived'
  | 'settings.updated'
  | 'period.created'
  | 'period.relaid'
  | 'period.finalised'
  | 'period.unfinalised'
  | 'period.submitted'
  | 'period.marked-submitted-elsewhere'
  | 'hmrc.connected'
  | 'hmrc.disconnected'
  | 'hmrc.refresh-failed'
  | 'hmrc.submission-attempted'
  | 'hmrc.submission-failed'
  | 'import.created'
  | 'statement.imported'
  | 'statement.updated'
  | 'documents.refiled'
  | 'reconciliation.matched'
  | 'reconciliation.unmatched'
  | 'reconciliation.recorded'
  | 'reconciliation.settled'
  | 'reconciliation.set-aside'
  | 'reconciliation.put-back'
  | 'journal.created'
  | 'journal.updated'
  | 'journal.deleted'
  | 'journal.posted'
  | 'journal.reversed'
  | 'accounting_period.created'
  | 'accounting_period.updated'
  | 'accounting_period.deleted'
  | 'accounting_period.closed'
  | 'accounting_period.reopened'
  | 'fixed_asset.created'
  // Raised by the module off a ticked purchase line, and finished off by a
  // human afterwards. Two separate events because they are two separate acts:
  // one is bookkeeping, the other is a judgement about tax.
  | 'fixed_asset.raised_from_entry'
  | 'fixed_asset.confirmed'
  | 'fixed_asset.updated'
  | 'fixed_asset.deleted'
  | 'fixed_asset.disposed'
  | 'fixed_asset.disposal_undone'
  | 'depreciation.posted'
  | 'depreciation.undone'
  | 'ct_computation.created'
  | 'ct_computation.updated'
  | 'ct_computation.finalised'
  | 'ct_computation.unfinalised'
  | 'ct_computation.deleted'
  | 'ct_adjustment.added'
  | 'ct_adjustment.removed'
  | 'health.trigger-missing'

export type AuditInput = {
  action: AuditAction
  entityType: string
  entityId?: string | null
  summary: string
  detail?: unknown
  user?: SessionUser | null
  ipTruncated?: string | null
}

/**
 * A stable JSON rendering: object keys sorted, so two runs over the same data
 * hash the same whatever order the properties happened to be built in.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function chainHash(chainIndex: bigint, prevHash: string | null, payload: unknown): string {
  return createHash('sha256')
    .update(`${chainIndex}\u0000${prevHash ?? ''}\u0000${canonicalJson(payload)}`)
    .digest('hex')
}

/**
 * Truncated to the network rather than the machine: enough to tell two offices
 * apart, not enough to be a record of where one person was sitting.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : null
}

type ChainHead = { chain_index: bigint; row_hash: string } | null

/** The slice of the Prisma client both the global client and a $transaction handle satisfy. */
export type ChainDb = Pick<typeof prisma, '$queryRaw' | '$executeRaw'>

async function readHead(
  table: 'bk_audit_log' | 'bk_period_snapshots',
  db: ChainDb,
): Promise<ChainHead> {
  // FOR UPDATE is only worth anything when `db` is the caller's OWN transaction
  // handle. Run on the global client it executes in autocommit on some pooled
  // connection and the lock is gone the moment the statement returns - which is
  // why writeSnapshot passes its tx here, and why appendAudit (which has no
  // transaction) relies on the unique index plus a retry instead.
  const rows =
    table === 'bk_audit_log'
      ? await db.$queryRaw<{ chain_index: bigint; row_hash: string }[]>`
          SELECT "chain_index", "row_hash" FROM "bk_audit_log"
          ORDER BY "chain_index" DESC LIMIT 1 FOR UPDATE
        `
      : await db.$queryRaw<{ chain_index: bigint; row_hash: string }[]>`
          SELECT "chain_index", "row_hash" FROM "bk_period_snapshots"
          ORDER BY "chain_index" DESC LIMIT 1 FOR UPDATE
        `
  return rows[0] ?? null
}

/** Next (index, prevHash) for a chain. Pass the transaction handle doing the write. */
export async function nextChainLink(
  table: 'bk_audit_log' | 'bk_period_snapshots',
  db: ChainDb = prisma,
): Promise<{ chainIndex: bigint; prevHash: string | null }> {
  const head = await readHead(table, db)
  return {
    chainIndex: head ? head.chain_index + 1n : 0n,
    prevHash: head ? head.row_hash : null,
  }
}

/** True when an error is the chain's unique index refusing a duplicate link. */
export function isChainCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /23505|chain_key|duplicate key/i.test(message)
}

/**
 * Append one audit row. Deliberately never throws outward: an audit write that
 * fails must not roll back the thing it was describing, and a missing audit row
 * is a smaller problem than a transaction the owner believes they saved and did
 * not. It is written inside the caller's transaction where there is one.
 */
export async function appendAudit(input: AuditInput): Promise<void> {
  // Two people saving at once read the same chain head and collide on the
  // unique index. The chain must stay a chain, so the loser re-reads the new
  // head and links after it rather than being silently dropped.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { chainIndex, prevHash } = await nextChainLink('bk_audit_log')
      const at = new Date()
      const payload = {
        at: at.toISOString(),
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        summary: input.summary,
        detail: input.detail ?? null,
        actorUserId: input.user?.id ?? null,
        actorEmail: input.user?.email ?? null,
        ipTruncated: input.ipTruncated ?? null,
      }
      const rowHash = chainHash(chainIndex, prevHash, payload)

      await prisma.$executeRaw`
        INSERT INTO "bk_audit_log" (
          "at", "actor_user_id", "actor_email", "action", "entity_type", "entity_id",
          "summary", "detail", "ip_truncated", "chain_index", "prev_hash", "row_hash"
        ) VALUES (
          ${at}, ${input.user?.id ?? null}, ${input.user?.email ?? null}, ${input.action},
          ${input.entityType}, ${input.entityId ?? null}, ${input.summary},
          ${JSON.stringify(input.detail ?? null)}::jsonb, ${input.ipTruncated ?? null},
          ${chainIndex}, ${prevHash}, ${rowHash}
        )
      `
      return
    } catch (error) {
      if (isChainCollision(error)) continue
      // Anything else is deliberate swallow-and-log: an audit write that fails
      // must not roll back the thing it was describing, and a missing audit row
      // is a smaller problem than a transaction the owner believes they saved
      // and did not.
      console.error('[uk-bookkeeping] audit write failed', error)
      return
    }
  }
  console.error('[uk-bookkeeping] audit write dropped after repeated chain collisions')
}

export type ChainVerification = {
  rows: number
  intact: boolean
  headHash: string | null
  brokenAtIndex: number | null
}

/** Recompute the whole chain and say whether it still adds up. */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const rows = await prisma.$queryRaw<
    {
      at: Date
      action: string
      entity_type: string
      entity_id: string | null
      summary: string
      detail: unknown
      actor_user_id: string | null
      actor_email: string | null
      ip_truncated: string | null
      chain_index: bigint
      prev_hash: string | null
      row_hash: string
    }[]
  >`
    SELECT "at", "action", "entity_type", "entity_id", "summary", "detail",
           "actor_user_id", "actor_email", "ip_truncated",
           "chain_index", "prev_hash", "row_hash"
    FROM "bk_audit_log" ORDER BY "chain_index" ASC
  `

  let prev: string | null = null
  for (const row of rows) {
    const payload = {
      at: row.at.toISOString(),
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      detail: row.detail ?? null,
      actorUserId: row.actor_user_id,
      actorEmail: row.actor_email,
      ipTruncated: row.ip_truncated,
    }
    const expected = chainHash(row.chain_index, prev, payload)
    if (expected !== row.row_hash || row.prev_hash !== prev) {
      return {
        rows: rows.length,
        intact: false,
        headHash: null,
        brokenAtIndex: Number(row.chain_index),
      }
    }
    prev = row.row_hash
  }

  return { rows: rows.length, intact: true, headHash: prev, brokenAtIndex: null }
}

/** The head hash, as shown in settings, in exports and in the emailed receipt. */
export async function getChainHead(): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ row_hash: string }[]>`
    SELECT "row_hash" FROM "bk_audit_log" ORDER BY "chain_index" DESC LIMIT 1
  `
  return rows[0]?.row_hash ?? null
}
