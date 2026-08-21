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
  vpsConfigFromEnv,
  type TestRole,
  type VpsConfig,
} from '@/lib/backup/vps-database'

// The guards, against a real Postgres.
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
    // No .env - vpsConfigFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

suite('the ledger guards, against a real database', () => {
  let config: VpsConfig
  let role: TestRole
  let client: Client
  const databaseName = `${'cactus_rt_ledger_'}${process.pid}`
  const roleName = `${'cactus_rt_role_ledger_'}${process.pid}`

  beforeAll(async () => {
    config = vpsConfigFromEnv()
    await dropStaleTestObjects(config)
    role = await createTestRole(config, roleName)
    await createTestDatabase(config, databaseName, role)

    // `pg` now reads sslmode=require as full certificate verification, and the
    // server's certificate is issued for the site's own hostname rather than for
    // the VPS one we connect by here. libpq compatibility keeps the connection
    // encrypted while asking it not to check a name that cannot match. This is a
    // throwaway database on a server we own; nothing else is reachable from it.
    client = new Client({
      connectionString: `${connectionUri(config, databaseName, role)}&uselibpqcompat=true`,
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
    if (config) {
      await dropTestDatabase(config, databaseName).catch(() => undefined)
      await dropTestRole(config, roleName).catch(() => undefined)
    }
  }, 120_000)

  async function accountId(code: string): Promise<string> {
    const result = await client.query<{ id: string }>('SELECT "id" FROM "bk_accounts" WHERE "code" = $1', [code])
    return result.rows[0]!.id
  }

  it('applies every migration and seeds the chart of accounts', async () => {
    const accounts = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM "bk_accounts"')
    expect(Number(accounts.rows[0]!.count)).toBeGreaterThan(20)

    // The loan account and the category that feeds it both exist, and point at
    // each other. Without that link a bank transfer to the director and a
    // journal to the loan account would land in two different places.
    const linked = await client.query<{ code: string }>(`
      SELECT c."code" FROM "bk_accounts" a
      JOIN "bk_categories" c ON c."id" = a."category_id"
      WHERE a."code" = 'directors-loan'
    `)
    expect(linked.rows[0]?.code).toBe('directors-loan')
  })

  it('refuses to post a journal whose sides do not agree', async () => {
    const debit = await accountId('pl-office')
    const credit = await accountId('creditors')

    await expect(
      (async () => {
        await client.query('BEGIN')
        const journal = await client.query<{ id: string }>(
          `INSERT INTO "bk_journals" ("date", "narrative", "status")
           VALUES ('2026-07-31', 'A journal that does not add up', 'posted') RETURNING "id"`,
        )
        const id = journal.rows[0]!.id
        await client.query(
          `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
           VALUES ($1, 0, $2, 100.00, 0), ($1, 1, $3, 0, 60.00)`,
          [id, debit, credit],
        )
        await client.query('COMMIT')
      })(),
    ).rejects.toThrow(/does not balance/i)
    await client.query('ROLLBACK').catch(() => undefined)
  })

  it('accepts a journal that balances, built one line at a time', async () => {
    // The check has to be DEFERRED, not per-row: the first line of any journal
    // is unbalanced on its own, and a per-row check would refuse every journal
    // ever written - and would refuse a backup restore, which inserts rows one
    // at a time in exactly this way.
    const debit = await accountId('pl-depreciation')
    const credit = await accountId('accumulated-depreciation')

    await client.query('BEGIN')
    const journal = await client.query<{ id: string }>(
      `INSERT INTO "bk_journals" ("date", "narrative", "status")
       VALUES ('2026-03-31', 'Depreciation for the year', 'posted') RETURNING "id"`,
    )
    const id = journal.rows[0]!.id
    await client.query(
      `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
       VALUES ($1, 0, $2, 1200.00, 0)`,
      [id, debit],
    )
    await client.query(
      `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
       VALUES ($1, 1, $2, 0, 1200.00)`,
      [id, credit],
    )
    await client.query('COMMIT')

    const saved = await client.query<{ debits: string; credits: string }>(
      `SELECT SUM("debit")::text AS debits, SUM("credit")::text AS credits
       FROM "bk_journal_lines" WHERE "journal_id" = $1`,
      [id],
    )
    expect(saved.rows[0]!.debits).toBe('1200.00')
    expect(saved.rows[0]!.credits).toBe('1200.00')
  })

  it('lets a draft sit half-written, because that is what a draft is', async () => {
    const debit = await accountId('prepayments')
    await client.query('BEGIN')
    const journal = await client.query<{ id: string }>(
      `INSERT INTO "bk_journals" ("date", "narrative", "status")
       VALUES ('2026-03-31', 'Half typed, saved for later', 'draft') RETURNING "id"`,
    )
    await client.query(
      `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
       VALUES ($1, 0, $2, 500.00, 0)`,
      [journal.rows[0]!.id, debit],
    )
    await client.query('COMMIT')

    // ...and refuses to let that draft become a record while it is still half
    // written, which is the other half of the same rule.
    await expect(
      client.query(`UPDATE "bk_journals" SET "status" = 'posted' WHERE "id" = $1`, [journal.rows[0]!.id]),
    ).rejects.toThrow(/does not balance/i)
  })

  it('refuses a line with an amount on both sides, and one with none', async () => {
    const account = await accountId('suspense')
    const journal = await client.query<{ id: string }>(
      `INSERT INTO "bk_journals" ("date", "narrative", "status")
       VALUES ('2026-07-31', 'Line shapes', 'draft') RETURNING "id"`,
    )
    const id = journal.rows[0]!.id

    await expect(
      client.query(
        `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
         VALUES ($1, 0, $2, 10.00, 10.00)`,
        [id, account],
      ),
    ).rejects.toThrow(/sides_chk/i)

    await expect(
      client.query(
        `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
         VALUES ($1, 0, $2, 0, 0)`,
        [id, account],
      ),
    ).rejects.toThrow(/sides_chk/i)

    // A negative debit is a credit written by somebody in a hurry.
    await expect(
      client.query(
        `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
         VALUES ($1, 0, $2, -10.00, 0)`,
        [id, account],
      ),
    ).rejects.toThrow(/sides_chk/i)
  })

  it('will not have a journal without a note saying what it is for', async () => {
    await expect(
      client.query(`INSERT INTO "bk_journals" ("date", "narrative") VALUES ('2026-07-31', '   ')`),
    ).rejects.toThrow(/narrative_chk/i)
  })

  it('refuses to change or delete a journal that went on a filed return', async () => {
    const period = await client.query<{ id: string }>(
      `INSERT INTO "bk_vat_periods" ("start_date", "end_date", "status", "scheme")
       VALUES ('2026-04-01', '2026-06-30', 'submitted', 'accrual') RETURNING "id"`,
    )
    const debit = await accountId('pl-office')
    const credit = await accountId('creditors')

    await client.query('BEGIN')
    const journal = await client.query<{ id: string }>(
      `INSERT INTO "bk_journals" ("date", "narrative", "status", "locked_period_id", "locked_at")
       VALUES ('2026-05-31', 'Filed and locked', 'posted', $1, NOW()) RETURNING "id"`,
      [period.rows[0]!.id],
    )
    const id = journal.rows[0]!.id
    await client.query(
      `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit", "locked_period_id")
       VALUES ($1, 0, $2, 40.00, 0, $4), ($1, 1, $3, 0, 40.00, $4)`,
      [id, debit, credit, period.rows[0]!.id],
    )
    await client.query('COMMIT')

    await expect(
      client.query(`UPDATE "bk_journals" SET "narrative" = 'Rewritten' WHERE "id" = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/i)

    await expect(client.query(`DELETE FROM "bk_journals" WHERE "id" = $1`, [id])).rejects.toThrow(
      /cannot be deleted/i,
    )

    // And nothing new may join it, which is the insert guard.
    await expect(
      client.query(
        `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
         VALUES ($1, 2, $2, 5.00, 0)`,
        [id, debit],
      ),
    ).rejects.toThrow(/submitted VAT return/i)
  })

  it('keeps one statement line from being imported twice', async () => {
    const account = await client.query<{ id: string }>(
      `INSERT INTO "bk_bank_accounts" ("name") VALUES ('Test current account') RETURNING "id"`,
    )
    const id = account.rows[0]!.id

    await client.query(
      `INSERT INTO "bk_bank_transactions" ("bank_account_id", "date", "details", "counterparty", "amount", "fingerprint")
       VALUES ($1, '2026-07-29', 'AMAZON UK', 'AMAZON UK', -10.19, 'abc123')`,
      [id],
    )
    await expect(
      client.query(
        `INSERT INTO "bk_bank_transactions" ("bank_account_id", "date", "details", "counterparty", "amount", "fingerprint")
         VALUES ($1, '2026-07-29', 'AMAZON UK', 'AMAZON UK', -10.19, 'abc123')`,
        [id],
      ),
    ).rejects.toThrow(/fingerprint/i)

    // The same payment on a DIFFERENT account is a different payment.
    const other = await client.query<{ id: string }>(
      `INSERT INTO "bk_bank_accounts" ("name") VALUES ('Test card') RETURNING "id"`,
    )
    await expect(
      client.query(
        `INSERT INTO "bk_bank_transactions" ("bank_account_id", "date", "details", "counterparty", "amount", "fingerprint")
         VALUES ($1, '2026-07-29', 'AMAZON UK', 'AMAZON UK', -10.19, 'abc123')`,
        [other.rows[0]!.id],
      ),
    ).resolves.toBeTruthy()
  })

  it('re-runs every migration without complaint, which is what an update does', async () => {
    const directory = join(__dirname, '..', 'migrations')
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      await expect(client.query(readFileSync(join(directory, file), 'utf8'))).resolves.toBeTruthy()
    }
    // Still one of each seeded account, not two.
    const duplicated = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM (
         SELECT "code" FROM "bk_accounts" GROUP BY "code" HAVING COUNT(*) > 1
       ) d`,
    )
    expect(duplicated.rows[0]!.count).toBe('0')
  }, 120_000)
})
