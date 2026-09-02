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
import { LEDGER_SQL } from './ledger'

// The posting projection, against a real Postgres.
//
// LEDGER_SQL is the single most load-bearing piece of SQL in this module: every
// report reads it, and if it is wrong then the profit and loss account, the
// balance sheet and the corporation tax computation are all wrong in the same
// direction at once. It cannot be tested in memory - it is a query - so it is
// tested here, against a throwaway database with the migrations applied.
//
// The one thing that matters more than any individual figure is that IT
// BALANCES. Every branch of the union posts both sides of an entry, so total
// debits must equal total credits whatever is thrown at it. If that ever stops
// being true, a balance sheet is quietly wrong and nothing else in the suite
// would notice.
//
// Gated the same way the backup round-trip and the trigger guards are, and for
// the same reason: it needs the OVH server. The databases it makes are named
// cactus_rt_* and dropped afterwards; nothing else on that server is ever
// named, opened or altered.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_BACKUP_ROUNDTRIP === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - testServerFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

suite('the ledger projection, against a real database', () => {
  let server: TestServer
  let role: TestRole
  let client: Client
  const databaseName = `cactus_rt_ledgerproj_${process.pid}`
  const roleName = `cactus_rt_role_ledgerproj_${process.pid}`

  beforeAll(async () => {
    server = testServerFromEnv()
    await dropStaleTestObjects(server)
    role = await createTestRole(server, roleName)
    await createTestDatabase(server, databaseName, role)
    client = new Client({
      connectionString: `${connectionUri(server, databaseName, role)}&uselibpqcompat=true`,
    })
    await client.connect()
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

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** LEDGER_SQL carries no bound parameters, so its text runs as it stands. */
  const ledger = () => `WITH ledger AS (${LEDGER_SQL.text})`

  async function categoryId(code: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      'SELECT "id" FROM "bk_categories" WHERE "code" = $1',
      [code],
    )
    return result.rows[0]!.id
  }

  async function accountId(code: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      'SELECT "id" FROM "bk_accounts" WHERE "code" = $1',
      [code],
    )
    return result.rows[0]!.id
  }

  /** One transaction with one line. Everything this test needs and nothing else. */
  async function addTransaction(input: {
    direction: 'income' | 'expense'
    taxPoint: string
    settled?: string | null
    category: string
    net: string
    vat: string
    bankAccountId?: string | null
  }): Promise<string> {
    const category = await categoryId(input.category)
    const gross = (Number.parseFloat(input.net) + Number.parseFloat(input.vat)).toFixed(2)
    const transaction = await client.query<{ id: string }>(
      `INSERT INTO "bk_transactions"
         ("direction", "tax_point_date", "settled_date", "counterparty", "status", "bank_account_id")
       VALUES ($1, $2::date, $3::date, 'Somebody', 'posted', $4) RETURNING "id"`,
      [input.direction, input.taxPoint, input.settled ?? null, input.bankAccountId ?? null],
    )
    const id = transaction.rows[0]!.id
    await client.query(
      `INSERT INTO "bk_transaction_lines"
         ("transaction_id", "position", "category_id", "vat_rate_code", "vat_rate_percent",
          "net_amount", "vat_amount", "gross_amount")
       VALUES ($1, 0, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric)`,
      [
        id,
        category,
        Number.parseFloat(input.vat) > 0 ? 'standard' : 'zero',
        Number.parseFloat(input.vat) > 0 ? '20.00' : '0.00',
        input.net,
        input.vat,
        gross,
      ],
    )
    return id
  }

  /**
   * Cast to numeric(14,2) rather than straight to text: SUM over an account
   * with no entries at all is NULL, and COALESCE to a bare 0 renders as "0"
   * rather than "0.00" - which would make an empty account look different from
   * one that nets to nothing.
   */
  async function balanceOf(code: string): Promise<string> {
    const result = await client.query<{ balance: string }>(
      `${ledger()}
       SELECT COALESCE(SUM(e."debit" - e."credit"), 0)::numeric(14,2)::text AS balance
       FROM ledger e JOIN "bk_accounts" a ON a."id" = e."account_id"
       WHERE a."code" = $1`,
      [code],
    )
    return result.rows[0]!.balance
  }

  async function totals(): Promise<{ debits: string; credits: string }> {
    const result = await client.query<{ debits: string; credits: string }>(
      `${ledger()}
       SELECT COALESCE(SUM("debit"), 0)::numeric(14,2)::text AS debits,
              COALESCE(SUM("credit"), 0)::numeric(14,2)::text AS credits
       FROM ledger`,
    )
    return result.rows[0]!
  }

  async function setScheme(scheme: 'accrual' | 'cash'): Promise<void> {
    await client.query('UPDATE "bk_settings" SET "scheme" = $1 WHERE "id" = \'singleton\'', [scheme])
  }

  // -------------------------------------------------------------------------

  it('every seeded category has an account to post to', async () => {
    // A category with no account posts one side of an entry and not the other,
    // which unbalances the whole ledger. 009_ledger_mapping.sql exists to make
    // this true, and this is the assertion that keeps it true.
    const orphans = await client.query<{ code: string }>(`
      SELECT c."code" FROM "bk_categories" c
      WHERE NOT EXISTS (SELECT 1 FROM "bk_accounts" a WHERE a."category_id" = c."id")
    `)
    expect(orphans.rows.map((row) => row.code)).toEqual([])
  })

  it('no category has two accounts pointing at it', async () => {
    // The projection picks one deterministically, but two would mean two
    // plausible answers to "where does this go", and one of them would be wrong.
    const duplicates = await client.query<{ code: string }>(`
      SELECT c."code" FROM "bk_categories" c
      JOIN "bk_accounts" a ON a."category_id" = c."id"
      GROUP BY c."id", c."code" HAVING COUNT(a."id") > 1
    `)
    expect(duplicates.rows.map((row) => row.code)).toEqual([])
  })

  it('an unpaid sale sits in debtors, with the VAT owed to HMRC', async () => {
    await setScheme('accrual')
    await addTransaction({
      direction: 'income',
      taxPoint: '2026-01-10',
      settled: null,
      category: 'sales',
      net: '1000.00',
      vat: '200.00',
    })

    // Sales is an income account, so its natural side is credit: a debit
    // balance of -1000 IS £1,000 of income.
    expect(await balanceOf('pl-sales')).toBe('-1000.00')
    expect(await balanceOf('debtors')).toBe('1200.00')
    expect(await balanceOf('vat-control')).toBe('-200.00')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('paying the sale moves it out of debtors and into the bank', async () => {
    await setScheme('accrual')
    await addTransaction({
      direction: 'income',
      taxPoint: '2026-02-01',
      settled: '2026-02-20',
      category: 'sales',
      net: '500.00',
      vat: '100.00',
    })
    // The first sale is still unpaid, so debtors holds only that one.
    expect(await balanceOf('debtors')).toBe('1200.00')
    expect(await balanceOf('bank-current')).toBe('600.00')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('an unpaid purchase sits in creditors, with the VAT reclaimable', async () => {
    await setScheme('accrual')
    const before = await balanceOf('vat-control')
    await addTransaction({
      direction: 'expense',
      taxPoint: '2026-02-05',
      settled: null,
      category: 'office',
      net: '200.00',
      vat: '40.00',
    })
    expect(await balanceOf('pl-office')).toBe('200.00')
    expect(await balanceOf('creditors')).toBe('-240.00')
    // Input VAT reduces what is owed to HMRC: -300 becomes -260.
    expect(Number(await balanceOf('vat-control'))).toBeCloseTo(Number(before) + 40, 2)

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('a capital purchase goes to fixed assets rather than to costs', async () => {
    await addTransaction({
      direction: 'expense',
      taxPoint: '2026-02-06',
      settled: '2026-02-06',
      category: 'capital-equipment',
      net: '3000.00',
      vat: '600.00',
    })
    expect(await balanceOf('fixed-assets')).toBe('3000.00')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('a dividend is equity, not a cost', async () => {
    // The classic way a cashbook overstates costs and understates the tax by
    // exactly the same amount.
    await addTransaction({
      direction: 'expense',
      taxPoint: '2026-02-07',
      settled: '2026-02-07',
      category: 'drawings',
      net: '2000.00',
      vat: '0.00',
    })
    expect(await balanceOf('dividends-drawings')).toBe('2000.00')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('parks the VAT until payment under cash accounting', async () => {
    await setScheme('cash')
    const controlBefore = await balanceOf('vat-control')
    const deferredBefore = await balanceOf('vat-deferred')

    await addTransaction({
      direction: 'income',
      taxPoint: '2026-03-01',
      settled: null,
      category: 'sales',
      net: '800.00',
      vat: '160.00',
    })

    // Nothing owed to HMRC yet: the customer has not paid.
    expect(await balanceOf('vat-control')).toBe(controlBefore)
    expect(Number(await balanceOf('vat-deferred'))).toBeCloseTo(Number(deferredBefore) - 160, 2)

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
    await setScheme('accrual')
  })

  it('brings a bank opening balance onto the books', async () => {
    const bank = await client.query<{ id: string }>(
      `INSERT INTO "bk_bank_accounts" ("name", "kind", "opening_balance", "opening_date")
       VALUES ('Second account', 'bank', 4000.00, '2026-01-01') RETURNING "id"`,
    )
    const bankId = bank.rows[0]!.id
    // 009 creates these for the accounts that existed when it ran; the
    // application creates them from then on. This test stands in for the
    // application.
    await client.query(
      `INSERT INTO "bk_accounts" ("code", "name", "kind", "subtype", "bs_group", "bank_account_id", "is_system")
       VALUES ('bank-second', 'Second account', 'asset', 'bank', 'current_assets_cash', $1, TRUE)`,
      [bankId],
    )

    expect(await balanceOf('bank-second')).toBe('4000.00')
    // The other side is equity, so it reads as a credit.
    expect(await balanceOf('opening-balances')).toBe('-4000.00')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('posts a settlement to the named bank account', async () => {
    const bank = await client.query<{ id: string }>(
      `SELECT "id" FROM "bk_bank_accounts" WHERE "name" = 'Second account'`,
    )
    await addTransaction({
      direction: 'expense',
      taxPoint: '2026-03-05',
      settled: '2026-03-05',
      category: 'office',
      net: '100.00',
      vat: '20.00',
      bankAccountId: bank.rows[0]!.id,
    })
    expect(await balanceOf('bank-second')).toBe('3880.00')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('includes journals alongside the cashbook', async () => {
    // The whole point of the exercise: a depreciation journal and a receipt
    // coded to depreciation land on the same account and add up.
    const expense = await accountId('pl-depreciation')
    const accumulated = await accountId('accumulated-depreciation')
    await client.query('BEGIN')
    const journal = await client.query<{ id: string }>(
      `INSERT INTO "bk_journals" ("date", "narrative", "status")
       VALUES ('2026-03-31', 'Depreciation for the year', 'posted') RETURNING "id"`,
    )
    const id = journal.rows[0]!.id
    await client.query(
      `INSERT INTO "bk_journal_lines" ("journal_id", "position", "account_id", "debit", "credit")
       VALUES ($1, 0, $2, 750.00, 0), ($1, 1, $3, 0, 750.00)`,
      [id, expense, accumulated],
    )
    await client.query('COMMIT')

    expect(await balanceOf('pl-depreciation')).toBe('750.00')
    expect(await balanceOf('accumulated-depreciation')).toBe('-750.00')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('leaves drafts out of the ledger entirely', async () => {
    const before = await totals()
    const category = await categoryId('sales')
    const draft = await client.query<{ id: string }>(
      `INSERT INTO "bk_transactions"
         ("direction", "tax_point_date", "counterparty", "status")
       VALUES ('income', '2026-03-20', 'Not yet reviewed', 'draft') RETURNING "id"`,
    )
    await client.query(
      `INSERT INTO "bk_transaction_lines"
         ("transaction_id", "position", "category_id", "vat_rate_code", "vat_rate_percent",
          "net_amount", "vat_amount", "gross_amount")
       VALUES ($1, 0, $2, 'standard', 20.00, 9999.00, 1999.80, 11998.80)`,
      [draft.rows[0]!.id, category],
    )
    const after = await totals()
    expect(after.debits).toBe(before.debits)
    expect(after.credits).toBe(before.credits)
  })

  it('takes a refund out the other side rather than as a negative debit', async () => {
    // A credit note arrives as a negative amount on a cashbook line. Debits and
    // credits stay non-negative throughout, so nothing downstream has to cope
    // with a negative debit.
    await addTransaction({
      direction: 'income',
      taxPoint: '2026-03-25',
      settled: '2026-03-25',
      category: 'sales',
      net: '-150.00',
      vat: '-30.00',
    })
    const negatives = await client.query<{ count: string }>(
      `${ledger()} SELECT COUNT(*)::text AS count FROM ledger WHERE "debit" < 0 OR "credit" < 0`,
    )
    expect(negatives.rows[0]!.count).toBe('0')

    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
  })

  it('balances over everything put together, which is the whole promise', async () => {
    const sums = await totals()
    expect(sums.debits).toBe(sums.credits)
    // And nothing has fallen into suspense, which would mean something had
    // nowhere else to go.
    expect(await balanceOf('suspense')).toBe('0.00')
  })
})
