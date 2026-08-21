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

// Importing a statement, end to end, through the real client.
//
// This exists because the guards test did not catch the bug it was written for.
// That one drives a raw `pg` client, so it proves the SQL in the migrations and
// nothing about the SQL in the service layer - and the first real import failed
// with a 500 from a query that no test had ever executed:
//
//     ERROR: operator does not exist: date - bigint
//
// Prisma sends a JavaScript number as int8, Postgres has `date - integer` but no
// `date - bigint`, and the match query subtracted a plain `10` from a date. It
// type-checked, it linted, every unit test passed, and it could not run once.
//
// So this test goes through the actual service functions on the actual Prisma
// client, against a throwaway database, and does the whole job: preview, match,
// commit. Anything the database would refuse fails here instead of in front of
// somebody trying to do their books.
//
// The statement is a CSV rather than a PDF on purpose. Reading a PDF is covered
// exhaustively by statement-pdf.test.ts and needs no database; everything from
// the parse onwards - duplicate detection, matching, committing - is one shared
// path, and a CSV reaches it without a hand-built PDF getting in the way.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_BACKUP_ROUNDTRIP === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - vpsConfigFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

const STATEMENT_CSV = [
  'Date,Description,Paid in,Paid out',
  '16/07/2026,Christopher Taylor-Guest / ref: TopUp,20.00,',
  '18/07/2026,TWILIO.COM,,20.00',
  '21/07/2026,OVHcloud - 4th Floor Lincoln House,,4.68',
  '26/07/2026,ANTHROPIC* CLAUDE SUB - 548 Market Street,,144.59',
].join('\n')

suite('importing a statement, against a real database', () => {
  let config: VpsConfig
  let role: TestRole
  let admin: Client
  const databaseName = `cactus_rt_import_${process.pid}`
  const roleName = `cactus_rt_role_import_${process.pid}`

  // Loaded after DATABASE_URL is redirected, because the Prisma client reads it
  // when it is first constructed and there is only ever one of them.
  let lib: {
    previewStatement: typeof import('./import').previewStatement
    commitStatement: typeof import('./import').commitStatement
    createBankAccount: typeof import('./bank-accounts').createBankAccount
    createTransaction: typeof import('./transactions').createTransaction
    listBankTransactions: typeof import('./bank-transactions').listBankTransactions
    getCategoryByCode: typeof import('./categories').getCategoryByCode
  }
  let bankAccountId: string

  beforeAll(async () => {
    config = vpsConfigFromEnv()
    await dropStaleTestObjects(config)
    role = await createTestRole(config, roleName)
    await createTestDatabase(config, databaseName, role)

    const uri = connectionUri(config, databaseName, role)
    admin = new Client({ connectionString: `${uri}&uselibpqcompat=true` })
    await admin.connect()
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

    const directory = join(__dirname, '..', 'migrations')
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      await admin.query(readFileSync(join(directory, file), 'utf8'))
    }

    process.env.DATABASE_URL = uri
    process.env.DIRECT_URL = uri
    lib = {
      previewStatement: (await import('./import')).previewStatement,
      commitStatement: (await import('./import')).commitStatement,
      createBankAccount: (await import('./bank-accounts')).createBankAccount,
      createTransaction: (await import('./transactions')).createTransaction,
      listBankTransactions: (await import('./bank-transactions')).listBankTransactions,
      getCategoryByCode: (await import('./categories')).getCategoryByCode,
    }

    const account = await lib.createBankAccount({ name: 'Test current account', kind: 'bank' })
    bankAccountId = account.id
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

  const preview = (): ReturnType<typeof lib.previewStatement> =>
    lib.previewStatement(
      { filename: 'statement.csv', bytes: Buffer.from(STATEMENT_CSV, 'utf8') },
      { bankAccountId },
    )

  it('reads the statement and asks the database what it already knows', async () => {
    // The whole of this used to fail at the database with a type error, so the
    // assertion that matters most is simply that it returns at all.
    const result = await preview()
    expect(result.lines).toHaveLength(4)
    expect(result.bankAccountId).toBe(bankAccountId)
    expect(result.lines.map((line) => line.amount)).toEqual(['20.00', '-20.00', '-4.68', '-144.59'])
  })

  it('offers an entry that is already recorded rather than a second copy of it', async () => {
    const category = await lib.getCategoryByCode('office')
    await lib.createTransaction(
      {
        direction: 'expense',
        taxPointDate: '2026-07-18',
        counterparty: 'TWILIO.COM',
        lines: [
          {
            categoryId: category!.id,
            vatTreatment: 'domestic',
            vatRateCode: 'zero',
            vatRatePercent: '0.00',
            netAmount: '20.00',
            vatAmount: '0.00',
            grossAmount: '20.00',
          },
        ],
      },
      null,
    )

    const result = await preview()
    const twilio = result.lines.find((line) => line.counterparty.includes('TWILIO'))!
    expect(twilio.suggestions.length).toBeGreaterThan(0)
    expect(twilio.suggestions[0]!.reasons).toContain('the amount is the same')
    // Same day, same name, same amount: confident enough to tick on its own.
    expect(twilio.action).toBe('match')
    expect(twilio.suggestedMatchId).toBe(twilio.suggestions[0]!.transactionId)
  })

  it('commits what the reviewer settled on, and ties the matched line to its entry', async () => {
    const result = await preview()
    const committed = await lib.commitStatement(
      {
        filename: 'statement.csv',
        format: 'csv',
        bankAccountId,
        meta: result.meta,
        mapping: result.mapping,
        lines: result.lines,
        decisions: Object.fromEntries(
          result.lines.map((line) => [
            String(line.index),
            { action: line.action, matchTransactionId: line.suggestedMatchId, categoryId: line.categoryId },
          ]),
        ),
      },
      null,
    )

    expect(committed.linesKept).toBe(4)
    // Three new drafts; the Twilio line was ticked off against the entry that
    // already existed rather than entered a second time.
    expect(committed.entriesCreated).toBe(3)
    expect(committed.matched).toBe(1)

    const saved = await lib.listBankTransactions({ bankAccountId })
    expect(saved.rows).toHaveLength(4)
    // Every line is explained: three by the draft made from it, one by the entry
    // it was matched to. Nothing left unreconciled.
    expect(saved.rows.every((row) => row.status === 'reconciled')).toBe(true)
    expect(saved.unreconciledCount).toBe(0)
  })

  it('recognises the same statement on a second import instead of doubling it', async () => {
    const result = await preview()
    expect(result.duplicates).toBe(4)
    expect(result.lines.every((line) => line.action === 'skip')).toBe(true)

    const committed = await lib.commitStatement(
      {
        filename: 'statement.csv',
        format: 'csv',
        bankAccountId,
        meta: result.meta,
        mapping: result.mapping,
        lines: result.lines,
        decisions: Object.fromEntries(
          result.lines.map((line) => [String(line.index), { action: line.action }]),
        ),
      },
      null,
    )
    expect(committed.linesKept).toBe(0)

    const saved = await lib.listBankTransactions({ bankAccountId })
    expect(saved.rows).toHaveLength(4)
  })
})
