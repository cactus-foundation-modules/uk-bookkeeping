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

// Categories, the accounts behind them, and money held with a supplier.
//
// The arithmetic half of this is in category-accounts.test.ts and needs no
// database. What needs one is the promise: that adding a category can never
// leave the books unable to balance. That promise is a transaction, a backfill
// migration and a projection working together, and none of the three can be
// checked in memory - the defect it replaces was a category with no account,
// which type-checked, linted, and put every entry filed under it into Suspense.
//
// The second half walks the prepaid supplier balance end to end, because that
// is what "paid from" was added for: twenty pounds put on an account against a
// statement that is not a VAT invoice, then a usage invoice WITH VAT taken off
// that balance. If the bank moves when the second one is recorded, the feature
// does not work, whatever the unit tests say.
//
// Gated like the other live tests, and it makes and drops only cactus_rt_*.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_BACKUP_ROUNDTRIP === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - vpsConfigFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

suite('categories and the accounts behind them, against a real database', () => {
  let config: VpsConfig
  let role: TestRole
  let admin: Client
  const databaseName = `cactus_rt_catacc_${process.pid}`
  const roleName = `cactus_rt_role_catacc_${process.pid}`

  // Loaded after DATABASE_URL is redirected: the Prisma client reads it when it
  // is first constructed and there is only ever one of them.
  let lib: {
    createCategory: typeof import('./categories').createCategory
    updateCategory: typeof import('./categories').updateCategory
    getCategoryByCode: typeof import('./categories').getCategoryByCode
    getAccountByCode: typeof import('./accounts').getAccountByCode
    createBankAccount: typeof import('./bank-accounts').createBankAccount
    createTransaction: typeof import('./transactions').createTransaction
    listTransactions: typeof import('./transactions').listTransactions
    accountBalances: typeof import('./ledger').accountBalances
    ledgerHealth: typeof import('./ledger').ledgerHealth
  }

  const migrationsDirectory = join(__dirname, '..', 'migrations')
  const migrationFiles = (): string[] =>
    readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()

  beforeAll(async () => {
    config = vpsConfigFromEnv()
    await dropStaleTestObjects(config)
    role = await createTestRole(config, roleName)
    await createTestDatabase(config, databaseName, role)

    const uri = connectionUri(config, databaseName, role)
    admin = new Client({ connectionString: `${uri}&uselibpqcompat=true` })
    await admin.connect()
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    for (const file of migrationFiles()) {
      await admin.query(readFileSync(join(migrationsDirectory, file), 'utf8'))
    }

    process.env.DATABASE_URL = uri
    process.env.DIRECT_URL = uri
    lib = {
      createCategory: (await import('./categories')).createCategory,
      updateCategory: (await import('./categories')).updateCategory,
      getCategoryByCode: (await import('./categories')).getCategoryByCode,
      getAccountByCode: (await import('./accounts')).getAccountByCode,
      createBankAccount: (await import('./bank-accounts')).createBankAccount,
      createTransaction: (await import('./transactions')).createTransaction,
      listTransactions: (await import('./transactions')).listTransactions,
      accountBalances: (await import('./ledger')).accountBalances,
      ledgerHealth: (await import('./ledger')).ledgerHealth,
    }
  }, 300_000)

  afterAll(async () => {
    // Let go of the Prisma connection before the database is dropped, or the
    // drop kills it underneath and Prisma logs a FATAL over the results.
    const { prisma } = await import('@/lib/db/prisma')
    await prisma.$disconnect().catch(() => undefined)
    await admin?.end().catch(() => undefined)
    if (config) {
      await dropTestDatabase(config, databaseName).catch(() => undefined)
      await dropTestRole(config, roleName).catch(() => undefined)
    }
  }, 120_000)

  async function unmappedCount(): Promise<number> {
    const { rows } = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "bk_categories" c
       WHERE NOT EXISTS (SELECT 1 FROM "bk_accounts" a WHERE a."category_id" = c."id")`,
    )
    return Number(rows[0]!.count)
  }

  it('leaves no seeded category without an account', async () => {
    expect(await unmappedCount()).toBe(0)
  })

  it('gives an account to a category that was added before it got one', async () => {
    // Exactly the state an install updating from an older version arrives in:
    // a category somebody added through the settings screen, posting nowhere.
    await admin.query(
      `INSERT INTO "bk_categories" ("code", "name", "direction", "ct600_group", "position")
       VALUES ('legacy-hosting', 'Hosting', 'expense', 'admin-expenses', 46)`,
    )
    expect(await unmappedCount()).toBe(1)

    await admin.query(readFileSync(join(migrationsDirectory, '014_category_accounts.sql'), 'utf8'))

    expect(await unmappedCount()).toBe(0)
    const { rows } = await admin.query<{ code: string; kind: string; report_group: string }>(
      `SELECT a."code", a."kind", a."report_group" FROM "bk_accounts" a
       JOIN "bk_categories" c ON c."id" = a."category_id" WHERE c."code" = 'legacy-hosting'`,
    )
    expect(rows[0]).toMatchObject({ code: 'pl-legacy-hosting', kind: 'expense', report_group: 'admin-expenses' })

    // And again, because an update re-runs every migration.
    await admin.query(readFileSync(join(migrationsDirectory, '014_category_accounts.sql'), 'utf8'))
    const { rows: again } = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "bk_accounts" a
       JOIN "bk_categories" c ON c."id" = a."category_id" WHERE c."code" = 'legacy-hosting'`,
    )
    expect(again[0]!.count).toBe('1')
  })

  it('creates the account with the category, shaped like the one it is filed with', async () => {
    const category = await lib.createCategory({
      code: 'Software subscriptions',
      name: 'Software subscriptions',
      direction: 'expense',
      sa103Box: 'SA103F.24',
      ct600Group: 'admin-expenses',
      likeCategoryCode: 'office',
      position: 1010,
    })
    const account = await lib.getAccountByCode('pl-software-subscriptions')
    expect(account).not.toBeNull()
    expect(account!.category_id).toBe(category.id)
    expect(account!.kind).toBe('expense')
    expect(account!.report_group).toBe('admin-expenses')
    expect(await unmappedCount()).toBe(0)
  })

  it('points a category at an account that already exists, rather than making a second one', async () => {
    const prepayments = await lib.getAccountByCode('prepayments')
    const category = await lib.createCategory({
      code: 'On account with Acme',
      name: 'On account with Acme',
      direction: 'expense',
      ct600Group: 'admin-expenses',
      accountId: prepayments!.id,
    })
    expect((await lib.getAccountByCode('prepayments'))!.category_id).toBe(category.id)
    expect(await lib.getAccountByCode('pl-on-account-with-acme')).toBeNull()
  })

  it('moves a category onto a different account, leaving only one pointing at it', async () => {
    const category = (await lib.getCategoryByCode('on-account-with-acme'))!
    const accruals = await lib.getAccountByCode('accruals')
    await lib.updateCategory(category.id, { accountId: accruals!.id })

    const { rows } = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "bk_accounts" WHERE "category_id" = $1`,
      [category.id],
    )
    expect(rows[0]!.count).toBe('1')
    expect((await lib.getAccountByCode('prepayments'))!.category_id).toBeNull()

    // Put it back, since the rest of this file uses it as a supplier balance.
    await lib.updateCategory(category.id, { accountId: (await lib.getAccountByCode('prepayments'))!.id })
  })

  it('refuses to take an account another category already stands for', async () => {
    const office = (await lib.getCategoryByCode('office'))!
    const { rows } = await admin.query<{ id: string }>(
      `SELECT "id" FROM "bk_accounts" WHERE "category_id" = $1`,
      [office.id],
    )
    await expect(
      lib.createCategory({
        code: 'Second phone',
        name: 'Second phone',
        direction: 'expense',
        ct600Group: 'admin-expenses',
        accountId: rows[0]!.id,
      }),
    ).rejects.toThrow(/already posts for/)
    // And the category did not survive the refusal either.
    expect(await lib.getCategoryByCode('second-phone')).toBeNull()
  })

  it('drains a balance held with a supplier instead of the bank', async () => {
    const bank = await lib.createBankAccount({ name: 'Current account', kind: 'bank' })
    const balance = await lib.createBankAccount({ name: 'Acme prepaid balance', kind: 'cash' })
    const { rows: balanceRows } = await admin.query<{ id: string }>(
      `SELECT "id" FROM "bk_accounts" WHERE "bank_account_id" = $1`,
      [balance.id],
    )
    const balanceAccountId = balanceRows[0]!.id

    // The category that puts a top-up onto the balance rather than into a cost.
    const topUpCategory = (await lib.getCategoryByCode('on-account-with-acme'))!
    await lib.updateCategory(topUpCategory.id, { accountId: balanceAccountId })

    // £20 onto the account. No VAT: their statement is not a VAT invoice.
    await lib.createTransaction(
      {
        direction: 'expense',
        taxPointDate: '2026-07-16',
        settledDate: '2026-07-16',
        counterparty: 'Acme',
        bankAccountId: bank.id,
        // Their statement is not a receipt and none is coming, which is exactly
        // what the tickbox is for.
        evidenceNotRequired: true,
        lines: [
          {
            categoryId: topUpCategory.id,
            description: 'Money onto the account',
            vatTreatment: 'outside_scope',
            vatRateCode: 'outside_scope',
            vatRatePercent: '0.00',
            netAmount: '20.00',
            vatAmount: '0.00',
            grossAmount: '20.00',
          },
        ],
      },
      null,
    )

    // The month's usage, WITH VAT, taken off the balance and not off the bank.
    const office = (await lib.getCategoryByCode('office'))!
    await lib.createTransaction(
      {
        direction: 'expense',
        taxPointDate: '2026-07-31',
        settledDate: '2026-07-31',
        counterparty: 'Acme',
        bankAccountId: balance.id,
        lines: [
          {
            categoryId: office.id,
            description: 'July usage',
            vatTreatment: 'domestic',
            vatRateCode: 'standard',
            vatRatePercent: '20.00',
            netAmount: '4.00',
            vatAmount: '0.80',
            grossAmount: '4.80',
          },
        ],
      },
      null,
    )

    const balances = await lib.accountBalances()
    const at = (id: string) => balances.find((row) => row.accountId === id)?.balance ?? '0.00'
    const byCode = (code: string) => balances.find((row) => row.code === code)?.balance ?? '0.00'

    // Twenty out of the bank, once, for the top-up only.
    const { rows: bankRows } = await admin.query<{ id: string }>(
      `SELECT "id" FROM "bk_accounts" WHERE "bank_account_id" = $1`,
      [bank.id],
    )
    expect(at(bankRows[0]!.id)).toBe('-20.00')
    // What is left sitting with the supplier.
    expect(at(balanceAccountId)).toBe('15.20')
    // The cost, and the VAT, landed on the invoice date.
    expect(byCode('pl-office')).toBe('4.00')
    expect(byCode('vat-control')).toBe('-0.80')

    const health = await lib.ledgerHealth()
    expect(health.suspenseBalance).toBe('0.00')
    expect(health.balanced).toBe(true)
    expect(health.healthy).toBe(true)
  })

  it('keeps an entry marked as needing no receipt off the still-to-do pile', async () => {
    const marked = await lib.listTransactions({ evidenceNotRequired: true })
    expect(marked.rows).toHaveLength(1)
    expect(marked.rows[0]!.counterparty).toBe('Acme')
    expect(marked.rows[0]!.evidence_not_required).toBe(true)

    // "Still needs one" is no receipt AND not marked, which is the pair of
    // filters the entries screen sends behind that one choice.
    const stillNeeded = await lib.listTransactions({ hasEvidence: false, evidenceNotRequired: false })
    expect(stillNeeded.rows).toHaveLength(1)
    expect(stillNeeded.rows[0]!.evidence_not_required).toBe(false)
  })
})
