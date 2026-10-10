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

// The balance check on a cash account, against a real database.
//
// The queries behind it are raw SQL that no typecheck, lint or build ever runs:
// the ledger lookup for the account, and the insert whose CHECK ties the three
// figures together. A cash account is opened with a balance, topped up by a
// transfer, and checked - once with the right figure and once with a wrong one.
//
// Gated like the other live tests, and it makes and drops only cactus_rt_*.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_BACKUP_ROUNDTRIP === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - testServerFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

suite('balance check on a cash account, against a real database', () => {
  let server: TestServer
  let role: TestRole
  let admin: Client
  const databaseName = `cactus_rt_balchk_${process.pid}`
  const roleName = `cactus_rt_role_balchk_${process.pid}`

  let lib: {
    createBankAccount: typeof import('./bank-accounts').createBankAccount
    createTransfer: typeof import('./transfers').createTransfer
    getBalancePosition: typeof import('./balance-checks').getBalancePosition
    saveBalanceCheck: typeof import('./balance-checks').saveBalanceCheck
    createTransaction: typeof import('./transactions').createTransaction
    getCategoryByCode: typeof import('./categories').getCategoryByCode
    listSettlementCandidates: typeof import('./reconcile-actions').listSettlementCandidates
    summariseReconciliation: typeof import('./reconciliation').summariseReconciliation
  }

  const migrationsDirectory = join(__dirname, '..', 'migrations')
  const migrationFiles = (): string[] =>
    readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()

  let bankId = ''
  let cashId = ''

  beforeAll(async () => {
    server = testServerFromEnv()
    await dropStaleTestObjects(server)
    role = await createTestRole(server, roleName)
    await createTestDatabase(server, databaseName, role)

    const uri = connectionUri(server, databaseName, role)
    admin = new Client({ connectionString: `${uri}&uselibpqcompat=true` })
    await admin.connect()
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    for (const file of migrationFiles()) {
      await admin.query(readFileSync(join(migrationsDirectory, file), 'utf8'))
    }

    process.env.DATABASE_URL = uri
    process.env.DIRECT_URL = uri
    lib = {
      createBankAccount: (await import('./bank-accounts')).createBankAccount,
      createTransfer: (await import('./transfers')).createTransfer,
      getBalancePosition: (await import('./balance-checks')).getBalancePosition,
      saveBalanceCheck: (await import('./balance-checks')).saveBalanceCheck,
      createTransaction: (await import('./transactions')).createTransaction,
      getCategoryByCode: (await import('./categories')).getCategoryByCode,
      listSettlementCandidates: (await import('./reconcile-actions')).listSettlementCandidates,
      summariseReconciliation: (await import('./reconciliation')).summariseReconciliation,
    }

    bankId = (await lib.createBankAccount({ name: 'Current account', kind: 'bank' })).id
    cashId = (
      await lib.createBankAccount({
        name: 'Twilio cash',
        kind: 'cash',
        openingBalance: '10.00',
        openingDate: '2026-01-01',
      })
    ).id
    await lib.createTransfer(
      {
        date: '2026-02-01',
        amount: '20.00',
        fromBankAccountId: bankId,
        toBankAccountId: cashId,
        status: 'posted',
      },
      null,
    )
  }, 300_000)

  afterAll(async () => {
    const { prisma } = await import('@/lib/db/prisma')
    await prisma.$disconnect().catch(() => undefined)
    await admin?.end().catch(() => undefined)
    if (server) {
      await dropTestDatabase(server, databaseName).catch(() => undefined)
      await dropTestRole(server, roleName).catch(() => undefined)
    }
  }, 120_000)

  it('reads the books balance as the opening balance plus the top-up', async () => {
    const position = await lib.getBalancePosition(cashId, '2026-03-01')
    expect(position.booksBalance).toBe('30.00')
    expect(position.recent.length).toBeGreaterThan(0)
    expect(position.latest).toBeNull()
  })

  it('does not count a top-up that is after the date asked about', async () => {
    expect((await lib.getBalancePosition(cashId, '2026-01-15')).booksBalance).toBe('10.00')
  })

  it('records an agreeing check with a difference of nothing', async () => {
    const check = await lib.saveBalanceCheck({ bankAccountId: cashId, asAt: '2026-03-01', statedBalance: '30.00' }, null)
    expect(check).toMatchObject({ booksBalance: '30.00', statedBalance: '30.00', difference: '0.00' })
  })

  it('records a wrong figure as the amount out, stated minus books', async () => {
    const check = await lib.saveBalanceCheck(
      { bankAccountId: cashId, asAt: '2026-03-02', statedBalance: '28.50', note: 'Read off the billing page' },
      null,
    )
    expect(check).toMatchObject({ booksBalance: '30.00', statedBalance: '28.50', difference: '-1.50' })
    const position = await lib.getBalancePosition(cashId, '2026-03-02')
    expect(position.latest).toMatchObject({ difference: '-1.50', note: 'Read off the billing page' })
  })

  it('refuses a bank account, and a figure it cannot read', async () => {
    await expect(lib.getBalancePosition(bankId, '2026-03-01')).rejects.toThrow(/statement/)
    await expect(
      lib.saveBalanceCheck({ bankAccountId: cashId, asAt: '2026-03-01', statedBalance: 'about thirty' }, null),
    ).rejects.toThrow(/amount/)
  })

  it('will not let the stored difference disagree with the two balances', async () => {
    await expect(
      admin.query(
        `INSERT INTO "bk_balance_checks" ("bank_account_id", "as_at", "books_balance", "stated_balance", "difference")
         VALUES ($1, '2026-03-03', 30.00, 28.00, 0.00)`,
        [cashId],
      ),
    ).rejects.toThrow(/difference_chk/)
  })

  async function bill(counterparty: string, amount: string, bankAccountId: string | null) {
    const office = (await lib.getCategoryByCode('office'))!
    return lib.createTransaction(
      {
        direction: 'expense',
        taxPointDate: '2026-02-10',
        settledDate: '2026-02-10',
        counterparty,
        ...(bankAccountId ? { bankAccountId } : {}),
        evidenceNotRequired: true,
        lines: [
          {
            categoryId: office.id,
            description: 'February usage',
            vatTreatment: 'outside_scope',
            vatRateCode: 'outside_scope',
            vatRatePercent: '0.00',
            netAmount: amount,
            vatAmount: '0.00',
            grossAmount: amount,
          },
        ],
      },
      null,
    )
  }

  it('keeps a bill paid from the cash account out of another account\'s settle list', async () => {
    const twilio = await bill('Twilio', '4.80', cashId)
    const unnamed = await bill('Somebody else', '4.80', null)
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO "bk_bank_transactions"
         ("bank_account_id", "date", "details", "counterparty", "amount", "fingerprint")
       VALUES ($1, '2026-02-12', 'SOMEBODY ELSE', 'Somebody else', -4.80, 'balchk-line-1')
       RETURNING "id"`,
      [bankId],
    )
    const view = await lib.listSettlementCandidates(rows[0]!.id)
    const ids = view.candidates.map((candidate) => candidate.transactionId)
    expect(ids).not.toContain(twilio.id)
    // An entry that names no account is still offered everywhere, as before.
    expect(ids).toContain(unnamed.id)
  })

  it('covers the entries behind an agreeing check, and nothing for a disagreeing one', async () => {
    const before = await lib.getBalancePosition(cashId, '2026-03-05')
    expect(before.booksBalance).toBe('25.20')
    expect(before.unchecked.count).toBe(1)
    const unmatchedBefore = (await lib.summariseReconciliation(cashId, null, null)).unmatchedEntryCount

    const wrong = await lib.saveBalanceCheck({ bankAccountId: cashId, asAt: '2026-03-05', statedBalance: '25.00' }, null)
    expect(wrong.covered).toBe(0)
    expect((await lib.getBalancePosition(cashId, '2026-03-05')).unchecked.count).toBe(1)

    const right = await lib.saveBalanceCheck({ bankAccountId: cashId, asAt: '2026-03-05', statedBalance: '25.20' }, null)
    expect(right).toMatchObject({ difference: '0.00', covered: 1 })

    const after = await lib.getBalancePosition(cashId, '2026-03-05')
    expect(after.unchecked.count).toBe(0)
    expect(after.latest).toMatchObject({ covered: 1 })
    expect((await lib.summariseReconciliation(cashId, null, null)).unmatchedEntryCount).toBe(unmatchedBefore - 1)

    // A second agreeing check does not claim the same entry twice.
    const again = await lib.saveBalanceCheck({ bankAccountId: cashId, asAt: '2026-03-06', statedBalance: '25.20' }, null)
    expect(again.covered).toBe(0)
  })
})
