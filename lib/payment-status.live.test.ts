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

// The payment-status table and the SQL that writes it, against a real Postgres.
// The statements below mirror the ones in lib/hmrc/service.ts (refreshPaymentStatuses):
// raw SQL is a string to tsc and eslint, so it is run here or not at all.
//
// Everything else in this module's suite is arithmetic that can be checked in
// memory. These four rules cannot: they are enforced by triggers, and a trigger
// that does not fire looks exactly like a trigger that does until the day it
// matters. "A posted journal balances" is the one promise the whole double-entry
// half of this module rests on, and the only honest way to test it is to try to
// break it against a database that has the migrations applied.
//
// Gated the same way the backup round-trip is, and for the same reason: it needs
// the OVH server. The databases it makes are named cactus_rt_* and dropped
// afterwards; nothing else on that server is ever named, opened or altered.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_BACKUP_ROUNDTRIP === '1'
if (ENABLED) {
  try {
    // Only read once the run has been asked for, the same way the backup
    // round-trip does it: a plain `npm test` must never go looking for server
    // credentials it has no business holding.
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - testServerFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

suite('the payment-status table, against a real database', () => {
  let server: TestServer
  let role: TestRole
  let client: Client
  const databaseName = `${'cactus_rt_paystat_'}${process.pid}`
  const roleName = `${'cactus_rt_role_paystat_'}${process.pid}`

  beforeAll(async () => {
    server = testServerFromEnv()
    await dropStaleTestObjects(server)
    role = await createTestRole(server, roleName)
    await createTestDatabase(server, databaseName, role)

    // `pg` now reads sslmode=require as full certificate verification, and the
    // server's certificate is issued for the site's own hostname rather than for
    // the VPS one we connect by here. libpq compatibility keeps the connection
    // encrypted while asking it not to check a name that cannot match. This is a
    // throwaway database on a server we own; nothing else is reachable from it.
    client = new Client({
      connectionString: `${connectionUri(server, databaseName, role)}&uselibpqcompat=true`,
    })
    await client.connect()

    // The bits of core schema the module's own migrations lean on. Only what is
    // needed to make the module's SQL run: this is a test of the module's
    // guards, not of core's schema.
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

    const directory = join(__dirname, '..', 'migrations')
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(directory, file), 'utf8'))
    }
  }, 300_000)

  afterAll(async () => {
    await client?.end().catch(() => undefined)
    if (server) {
      await dropTestDatabase(server, databaseName).catch(() => undefined)
      await dropTestRole(server, roleName).catch(() => undefined)
    }
  }, 120_000)


  async function submittedPeriod(start: string, end: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO "bk_vat_periods" ("start_date", "end_date", "status", "scheme", "vrn")
       VALUES ($1::date, $2::date, 'submitted', 'accrual', '123456789') RETURNING "id"`,
      [start, end],
    )
    return result.rows[0]!.id
  }

  const UPSERT = `
    INSERT INTO "bk_vat_payment_status"
      ("period_id", "status", "original_amount", "outstanding_amount", "hmrc_due_date", "paid_seen_at")
    VALUES ($1, $2::text, $3::numeric, $4::numeric, $5::date, CASE WHEN $2::text = 'paid' THEN NOW() END)
    ON CONFLICT ("period_id") DO UPDATE SET
      "status" = EXCLUDED."status",
      "original_amount" = EXCLUDED."original_amount",
      "outstanding_amount" = EXCLUDED."outstanding_amount",
      "hmrc_due_date" = EXCLUDED."hmrc_due_date",
      "paid_seen_at" = EXCLUDED."paid_seen_at",
      "checked_at" = NOW()
    WHERE "bk_vat_payment_status"."status" <> 'paid'`

  const PENDING = `
    SELECT p."id", p."start_date"::text AS "start", p."end_date"::text AS "end"
    FROM "bk_vat_periods" p
    LEFT JOIN "bk_vat_payment_status" s ON s."period_id" = p."id"
    WHERE p."status" = 'submitted'
      AND (p."vrn" IS NULL OR p."vrn" = $1)
      AND (s."status" IS NULL OR s."status" <> 'paid')
      AND ($2::boolean OR s."checked_at" IS NULL
           OR s."checked_at" < NOW() - INTERVAL '60 minutes')`

  it('keeps asking about a return until it is paid, then never again', async () => {
    const id = await submittedPeriod('2026-04-01', '2026-06-30')

    let pending = await client.query(PENDING, ['123456789', false])
    expect(pending.rows.map((r) => r.id)).toContain(id)

    await client.query(UPSERT, [id, 'unpaid', '1000.00', '1000.00', '2026-08-07'])
    // Checked a moment ago: left alone unless forced.
    pending = await client.query(PENDING, ['123456789', false])
    expect(pending.rows.map((r) => r.id)).not.toContain(id)
    pending = await client.query(PENDING, ['123456789', true])
    expect(pending.rows.map((r) => r.id)).toContain(id)

    await client.query(UPSERT, [id, 'paid', '1000.00', '0.00', '2026-08-07'])
    pending = await client.query(PENDING, ['123456789', true])
    expect(pending.rows.map((r) => r.id)).not.toContain(id)

    const row = await client.query(
      'SELECT "status", "paid_seen_at", "outstanding_amount"::text AS out FROM "bk_vat_payment_status" WHERE "period_id" = $1',
      [id],
    )
    expect(row.rows[0]).toMatchObject({ status: 'paid', out: '0.00' })
    expect(row.rows[0].paid_seen_at).not.toBeNull()
  })

  it('does not let a later answer undo a paid one', async () => {
    const id = await submittedPeriod('2026-07-01', '2026-09-30')
    await client.query(UPSERT, [id, 'paid', '50.00', '0.00', null])
    await client.query(UPSERT, [id, 'unknown', null, null, null])
    const row = await client.query('SELECT "status" FROM "bk_vat_payment_status" WHERE "period_id" = $1', [id])
    expect(row.rows[0].status).toBe('paid')
  })

  it('stores an unknown answer with no amounts, and refuses a made-up status', async () => {
    const id = await submittedPeriod('2026-10-01', '2026-12-31')
    await client.query(UPSERT, [id, 'unknown', null, null, null])
    await expect(client.query(UPSERT, [id, 'settled', null, null, null])).rejects.toThrow()
  })

  it('is written by a migration that can be run twice', async () => {
    const sql = readFileSync(join(__dirname, '..', 'migrations', '024_vat_payment_status.sql'), 'utf8')
    await client.query(sql)
  })
  it('lays out a sandbox test period only when nothing open is left', async () => {
    // Mirrors ensureSandboxTestPeriod in lib/hmrc/service.ts.
    const COUNT = `SELECT COUNT(*)::int AS n FROM "bk_vat_periods"
      WHERE "status" <> 'submitted' AND ("vrn" IS NULL OR "vrn" = $1)`
    const INSERT = `INSERT INTO "bk_vat_periods"
      ("period_key", "start_date", "end_date", "due_date", "scheme", "source", "obligation_status", "vrn")
      VALUES ($1, $2::date, $3::date, $4::date, 'accrual', 'hmrc', 'O', $5) ON CONFLICT DO NOTHING`
    expect((await client.query(COUNT, ['123456789'])).rows[0].n).toBe(0)
    await client.query(INSERT, ['#900', '2025-01-01', '2025-03-31', '2025-05-07', '123456789'])
    expect((await client.query(COUNT, ['123456789'])).rows[0].n).toBe(1)
    const again = await client.query(INSERT, ['#900', '2025-01-01', '2025-03-31', '2025-05-07', '123456789'])
    expect(again.rowCount).toBe(0)
  })
  it('records the test scenario with the call and keeps it write-once', async () => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO "bk_hmrc_api_calls" ("environment", "method", "path", "fraud_headers", "test_scenario")
       VALUES ('sandbox', 'GET', '/x', '{}'::jsonb, 'MULTIPLE_LIABILITIES_2018_19') RETURNING "id"`,
    )
    const id = row.rows[0]!.id
    // Completing the call, as completeApiCall does, is still allowed.
    await client.query('UPDATE "bk_hmrc_api_calls" SET "status_code" = 200 WHERE "id" = $1', [id])
    await expect(
      client.query('UPDATE "bk_hmrc_api_calls" SET "test_scenario" = NULL WHERE "id" = $1', [id]),
    ).rejects.toThrow(/cannot be rewritten/)
    const noScenario = await client.query(
      `INSERT INTO "bk_hmrc_api_calls" ("environment", "method", "path", "fraud_headers")
       VALUES ('sandbox', 'GET', '/y', '{}'::jsonb) RETURNING "test_scenario"`,
    )
    expect(noScenario.rows[0].test_scenario).toBeNull()
  })
})
