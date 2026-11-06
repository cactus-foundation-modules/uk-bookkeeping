import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import {
  connectionUri,
  createTestDatabase,
  createTestRole,
  dropStaleTestObjects,
  dropTestDatabase,
  dropTestRole,
  testServerFromEnv,
  type TestRole,
  type TestServer,
} from '@/lib/backup/test-database'

// A supplier's credit note, recorded for real.
//
// Goods often go back before the invoice arrives, so a credit may have no bill to
// point at. What decides whether it is recorded at all is the validator and a CHECK
// constraint working together, and neither is visible to a test of the line builder.
//
// Gated like the ledger and backup suites, and for the same reason: it needs the
// OVH server. Databases are named cactus_rt_* and dropped afterwards.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_BACKUP_ROUNDTRIP === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - testServerFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

type EntryRow = {
  id: string
  entry_type: string
  corrects_transaction_id: string | null
  correction_reason: string | null
  source: string
  net_amount: string
  vat_amount: string
}

suite('supplier credit notes, against a real database', () => {
  let server: TestServer
  let role: TestRole
  let client: Client
  const databaseName = `cactus_rt_pocredit_${process.pid}`
  const roleName = `cactus_rt_role_pocredit_${process.pid}`

  let purchases: typeof import('./external-purchases')
  let boxes: typeof import('./vat-boxes')

  function credit(number: string, billId: string | null, date: string) {
    return purchases.recordExternalPurchaseCredit({
      source: 'purchase-orders',
      returnNumber: number,
      billId,
      billInvoiceNumber: billId ? 'INV-1' : null,
      supplier: { name: 'A Supplier' },
      taxPointDate: date,
      lines: [{ description: 'Returned desk', net: '100.00', tax: '20.00', ratePercent: '20' }],
    })
  }

  async function entriesFor(number: string): Promise<EntryRow[]> {
    const result = await client.query<EntryRow>(
      `SELECT t."id", t."entry_type", t."corrects_transaction_id", t."correction_reason", t."source",
              l."net_amount"::text, l."vat_amount"::text
       FROM "bk_transactions" t JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
       WHERE t."source_ref" = $1`,
      [`credit:${number}`],
    )
    return result.rows
  }

  beforeAll(async () => {
    server = testServerFromEnv()
    await dropStaleTestObjects(server)
    role = await createTestRole(server, roleName)
    await createTestDatabase(server, databaseName, role)

    const uri = connectionUri(server, databaseName, role)
    client = new Client({ connectionString: `${uri}&uselibpqcompat=true` })
    await client.connect()
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

    const directory = join(__dirname, '..', 'migrations')
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(directory, file), 'utf8'))
    }

    process.env.DATABASE_URL = uri
    purchases = await import('./external-purchases')
    boxes = await import('./vat-boxes')
  }, 300_000)

  afterAll(async () => {
    await import('@/lib/db/prisma')
      .then((module) => module.prisma.$disconnect())
      .catch(() => undefined)
    await client?.end().catch(() => undefined)
    if (server) {
      await dropTestDatabase(server, databaseName).catch(() => undefined)
      await dropTestRole(server, roleName).catch(() => undefined)
    }
  }, 120_000)

  it('records a credit with no bill named as an entry standing on its own', async () => {
    const outcome = await credit('RET-1', null, '2026-02-10')
    expect(outcome.ok).toBe(true)

    const [row] = await entriesFor('RET-1')
    expect(row).toMatchObject({
      entry_type: 'normal',
      corrects_transaction_id: null,
      correction_reason: null,
      source: 'purchase-orders',
      net_amount: '-100.00',
      vat_amount: '-20.00',
    })
  })

  it('takes that credit off the input VAT and the purchases on the return', async () => {
    const totals = await boxes.computeVatTotals(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-03-31T00:00:00Z'),
      'accrual',
    )
    expect(totals.box4.toFixed(2)).toBe('-20.00')
    expect(totals.box7.toFixed(2)).toBe('-100.00')
  })

  it('does the same when the bill it names is not in the books', async () => {
    const outcome = await credit('RET-2', 'bill-never-seen', '2026-04-10')
    expect(outcome.ok).toBe(true)

    const [row] = await entriesFor('RET-2')
    expect(row).toMatchObject({ entry_type: 'normal', corrects_transaction_id: null })
  })

  it('records it once, however many times it is sent', async () => {
    const outcome = await credit('RET-1', null, '2026-02-10')
    expect(outcome.ok).toBe(true)
    expect(await entriesFor('RET-1')).toHaveLength(1)
  })

  it('points at the bill when the bill is in the books', async () => {
    await client.query(
      `INSERT INTO "bk_transactions" ("id","direction","tax_point_date","counterparty","status","source","source_ref")
       VALUES ('the-bill','expense','2026-05-01','A Supplier','posted','purchase-orders','bill:bill-1')`,
    )

    const outcome = await credit('RET-3', 'bill-1', '2026-05-10')
    expect(outcome.ok).toBe(true)

    const [row] = await entriesFor('RET-3')
    expect(row).toMatchObject({ entry_type: 'adjustment', corrects_transaction_id: 'the-bill' })
    expect(row!.correction_reason).toContain('RET-3')
  })
})
