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
// the parse onwards - duplicate detection, committing, coding the lines up on
// the reconciliation screen - is one shared path, and a CSV reaches it without a
// hand-built PDF getting in the way.
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

// A card processor's payout: two invoices and a refund, netted, less the fee.
// 120.00 + 95.00 - 10.00 - 3.15 = 201.85, and not one of those figures is a
// number the ordinary matcher would ever find.
const PAYOUT_CSV = [
  'Date,Description,Paid in,Paid out',
  '31/07/2026,GOCARDLESS PAYOUT REF 88213,201.85,',
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
    listSettlementCandidates: typeof import('./reconcile-actions').listSettlementCandidates
    settleBankLine: typeof import('./reconcile-actions').settleBankLine
    getCategoryByCode: typeof import('./categories').getCategoryByCode
    recordEntriesFromBankLines: typeof import('./reconcile-actions').recordEntriesFromBankLines
    acceptSuggestedMatches: typeof import('./reconcile-actions').acceptSuggestedMatches
    setBankLinesIgnored: typeof import('./reconcile-actions').setBankLinesIgnored
    listTransactions: typeof import('./transactions').listTransactions
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
      listSettlementCandidates: (await import('./reconcile-actions')).listSettlementCandidates,
      settleBankLine: (await import('./reconcile-actions')).settleBankLine,
      getCategoryByCode: (await import('./categories')).getCategoryByCode,
      recordEntriesFromBankLines: (await import('./reconcile-actions')).recordEntriesFromBankLines,
      acceptSuggestedMatches: (await import('./reconcile-actions')).acceptSuggestedMatches,
      setBankLinesIgnored: (await import('./reconcile-actions')).setBankLinesIgnored,
      listTransactions: (await import('./transactions')).listTransactions,
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
    expect(result.lines.every((line) => line.duplicateOfId === null)).toBe(true)
  })

  it('brings the lines in without touching the books', async () => {
    const result = await preview()
    const committed = await lib.commitStatement(
      {
        filename: 'statement.csv',
        format: 'csv',
        bankAccountId,
        meta: result.meta,
        mapping: result.mapping,
        lines: result.lines,
      },
      null,
    )

    expect(committed.linesKept).toBe(4)
    expect(committed.duplicates).toBe(0)

    const saved = await lib.listBankTransactions({ bankAccountId })
    expect(saved.rows).toHaveLength(4)
    // Nothing has been explained yet, and nothing was invented on the way in.
    expect(saved.rows.every((row) => row.status === 'unreconciled')).toBe(true)
    expect(saved.unreconciledCount).toBe(4)
    expect((await lib.listTransactions({})).rows).toHaveLength(0)
  })

  it('ticks off a line against an entry that was already recorded', async () => {
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

    const saved = await lib.listBankTransactions({ bankAccountId })
    const twilio = saved.rows.find((row) => row.details.includes('TWILIO'))!
    const outcome = await lib.acceptSuggestedMatches([twilio.id], null)
    expect(outcome.done).toBe(1)
    expect(outcome.failed).toHaveLength(0)

    const after = await lib.listBankTransactions({ bankAccountId })
    expect(after.rows.find((row) => row.id === twilio.id)!.status).toBe('reconciled')
    // Matched, not duplicated: still the one entry in the books.
    expect((await lib.listTransactions({})).rows).toHaveLength(1)
  })

  it('codes a batch of lines to one category in a single go', async () => {
    const category = await lib.getCategoryByCode('other-expenses')
    const open = (await lib.listBankTransactions({ bankAccountId, status: 'unreconciled' })).rows
    // The money-in line cannot take an expense category, and has to say so
    // without stranding the two that can.
    expect(open).toHaveLength(3)

    const outcome = await lib.recordEntriesFromBankLines(
      open.map((row) => row.id),
      { categoryId: category!.id, vatRateCode: 'standard', status: 'posted' },
      null,
    )
    expect(outcome.done).toBe(2)
    expect(outcome.failed).toHaveLength(1)
    expect(outcome.failed[0]!.error).toContain('money out')

    const after = await lib.listBankTransactions({ bankAccountId })
    expect(after.unreconciledCount).toBe(1)

    // The VAT was worked back out of the gross rather than added on top of it.
    const entries = (await lib.listTransactions({})).rows
    const ovh = entries.find((row) => row.counterparty.includes('OVHcloud'))!
    expect(ovh.gross_total.toFixed(2)).toBe('4.68')
    expect(ovh.net_total.toFixed(2)).toBe('3.90')
    expect(ovh.vat_total.toFixed(2)).toBe('0.78')
  })

  it('sets the last one aside with a reason', async () => {
    const open = (await lib.listBankTransactions({ bankAccountId, status: 'unreconciled' })).rows
    expect(open).toHaveLength(1)

    const outcome = await lib.setBankLinesIgnored([open[0]!.id], true, 'Money the director put in', null)
    expect(outcome.done).toBe(1)

    const after = await lib.listBankTransactions({ bankAccountId })
    expect(after.unreconciledCount).toBe(0)
    expect(after.rows.find((row) => row.id === open[0]!.id)!.ignored_reason).toBe(
      'Money the director put in',
    )
  })

  it('recognises the same statement on a second import instead of doubling it', async () => {
    const result = await preview()
    expect(result.duplicates).toBe(4)

    const committed = await lib.commitStatement(
      {
        filename: 'statement.csv',
        format: 'csv',
        bankAccountId,
        meta: result.meta,
        mapping: result.mapping,
        lines: result.lines,
      },
      null,
    )
    expect(committed.linesKept).toBe(0)
    expect(committed.duplicates).toBe(4)

    const saved = await lib.listBankTransactions({ bankAccountId })
    expect(saved.rows).toHaveLength(4)
  })
  it('settles a card payout against several invoices, less the fee', async () => {
    const sales = await lib.getCategoryByCode('sales')
    const expenses = await lib.getCategoryByCode('other-expenses')
    const charges = await lib.getCategoryByCode('bank-charges')

    const income = (counterparty: string, date: string, gross: string) =>
      lib.createTransaction(
        {
          direction: 'income',
          taxPointDate: date,
          counterparty,
          lines: [
            {
              categoryId: sales!.id,
              vatTreatment: 'domestic',
              vatRateCode: 'zero',
              vatRatePercent: '0.00',
              netAmount: gross,
              vatAmount: '0.00',
              grossAmount: gross,
            },
          ],
        },
        null,
      )

    await income('Acme Ltd', '2026-07-20', '120.00')
    await income('Beta Ltd', '2026-07-22', '95.00')
    // A refund the processor took back out of the same payout. It pulls the
    // total DOWN, which is the sign the whole thing turns on.
    await lib.createTransaction(
      {
        direction: 'expense',
        taxPointDate: '2026-07-25',
        counterparty: 'Refund to Acme Ltd',
        lines: [
          {
            categoryId: expenses!.id,
            vatTreatment: 'domestic',
            vatRateCode: 'zero',
            vatRatePercent: '0.00',
            netAmount: '10.00',
            vatAmount: '0.00',
            grossAmount: '10.00',
          },
        ],
      },
      null,
    )

    const payout = await lib.previewStatement(
      { filename: 'payout.csv', bytes: Buffer.from(PAYOUT_CSV, 'utf8') },
      { bankAccountId },
    )
    await lib.commitStatement(
      {
        filename: 'payout.csv',
        format: 'csv',
        bankAccountId,
        meta: payout.meta,
        mapping: payout.mapping,
        lines: payout.lines,
      },
      null,
    )

    const line = (await lib.listBankTransactions({ bankAccountId, status: 'unreconciled' })).rows[0]!
    expect(line.amount.toFixed(2)).toBe('201.85')

    const view = await lib.listSettlementCandidates(line.id)
    expect(view.remaining).toBe('201.85')
    const contributions = Object.fromEntries(
      view.candidates.map((candidate) => [candidate.counterparty, candidate.contribution]),
    )
    expect(contributions['Acme Ltd']).toBe('120.00')
    expect(contributions['Beta Ltd']).toBe('95.00')
    // Signed the way the bank saw it, not the way the entry was recorded.
    expect(contributions['Refund to Acme Ltd']).toBe('-10.00')

    const settled = await lib.settleBankLine(
      line.id,
      {
        transactionIds: view.candidates.map((candidate) => candidate.transactionId),
        differenceCategoryId: charges!.id,
        differenceVatRateCode: 'exempt',
      },
      null,
    )
    expect(settled.matched).toBe(3)
    // Negative: money the processor kept rather than money that arrived.
    expect(settled.difference).toBe('-3.15')
    expect(settled.differenceTransactionId).not.toBeNull()

    const after = await lib.listBankTransactions({ bankAccountId, status: 'unreconciled' })
    expect(after.rows).toHaveLength(0)

    // The fee is a real expense on the right category, not a rounding fudge.
    const fee = (await lib.listTransactions({ categoryId: charges!.id })).rows
    expect(fee).toHaveLength(1)
    expect(fee[0]!.gross_total.toFixed(2)).toBe('3.15')
    expect(fee[0]!.direction).toBe('expense')
  })

  it('refuses to settle while the difference has nowhere to go, and changes nothing', async () => {
    const sales = await lib.getCategoryByCode('sales')
    const charges = await lib.getCategoryByCode('bank-charges')
    const gamma = await lib.createTransaction(
      {
        direction: 'income',
        taxPointDate: '2026-07-28',
        counterparty: 'Gamma Ltd',
        lines: [
          {
            categoryId: sales!.id,
            vatTreatment: 'domestic',
            vatRateCode: 'zero',
            vatRatePercent: '0.00',
            netAmount: '50.00',
            vatAmount: '0.00',
            grossAmount: '50.00',
          },
        ],
      },
      null,
    )

    // £50.00 invoiced, £48.50 arrived.
    const second = await lib.previewStatement(
      {
        filename: 'payout-2.csv',
        bytes: Buffer.from(
          ['Date,Description,Paid in,Paid out', '01/08/2026,GOCARDLESS PAYOUT REF 88907,48.50,'].join('\n'),
          'utf8',
        ),
      },
      { bankAccountId },
    )
    await lib.commitStatement(
      {
        filename: 'payout-2.csv',
        format: 'csv',
        bankAccountId,
        meta: second.meta,
        mapping: second.mapping,
        lines: second.lines,
      },
      null,
    )
    const line = (await lib.listBankTransactions({ bankAccountId, status: 'unreconciled' })).rows[0]!

    await expect(lib.settleBankLine(line.id, { transactionIds: [gamma.id] }, null)).rejects.toThrow(
      /is unaccounted for/,
    )

    // Refused outright: the invoice is not half matched and the line has not moved.
    const untouched = await lib.listBankTransactions({ bankAccountId, status: 'unreconciled' })
    expect(untouched.rows.map((row) => row.id)).toEqual([line.id])

    // With somewhere for the fee to go, the same settlement goes through.
    const settled = await lib.settleBankLine(
      line.id,
      { transactionIds: [gamma.id], differenceCategoryId: charges!.id, differenceVatRateCode: 'exempt' },
      null,
    )
    expect(settled.difference).toBe('-1.50')
    expect((await lib.listBankTransactions({ bankAccountId, status: 'unreconciled' })).rows).toHaveLength(0)
  })
})
