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

// "Corrections to earlier returns", against a real Postgres.
//
// The whole rule is one query: which entries are errors on a filed return, as
// opposed to credit notes and voids going about their ordinary business. It is a
// string to tsc and to eslint, so only running it says anything about it.
//
// Locked rows cannot be deleted, so nothing is cleared between tests. Each one
// works in a year of its own instead, and that it can is rather the point of the
// figure being scoped to a return.
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

const REAL_VRN = '123456789'
const SANDBOX_VRN = '841969097'

suite('corrections to earlier returns, against a real database', () => {
  let server: TestServer
  let role: TestRole
  let client: Client
  const databaseName = `cactus_rt_neterr_${process.pid}`
  const roleName = `cactus_rt_role_neterr_${process.pid}`

  let periods: typeof import('./periods')
  let prisma: typeof import('@/lib/db/prisma').prisma
  let category: string

  async function period(
    start: string,
    end: string,
    options: { status?: string; vrn?: string | null; scheme?: string } = {},
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO "bk_vat_periods" ("start_date","end_date","status","scheme","vrn")
       VALUES ($1::date,$2::date,$3,$4,$5) RETURNING "id"`,
      [start, end, options.status ?? 'open', options.scheme ?? 'accrual',
        options.vrn === undefined ? REAL_VRN : options.vrn],
    )
    return result.rows[0]!.id
  }

  /** One entry of one line, posted, with whatever makes it what it is stated. */
  async function entry(
    id: string,
    date: string,
    vat: string,
    options: {
      corrects?: string
      source?: string
      sourceRef?: string
      direction?: 'income' | 'expense'
      net?: string
    } = {},
  ): Promise<void> {
    const net = options.net ?? (Number(vat) * 5).toFixed(2)
    const gross = (Number(net) + Number(vat)).toFixed(2)
    await client.query(
      `INSERT INTO "bk_transactions"
         ("id","entry_type","direction","tax_point_date","counterparty","status",
          "source","source_ref","corrects_transaction_id","correction_reason")
       VALUES ($1,$2,$3,$4::date,'A Customer','posted',$5,$6,$7,$8)`,
      [
        id,
        options.corrects ? 'adjustment' : 'normal',
        options.direction ?? 'income',
        date,
        options.source ?? 'manual',
        options.sourceRef ?? null,
        options.corrects ?? null,
        options.corrects ? 'A reason' : null,
      ],
    )
    await client.query(
      `INSERT INTO "bk_transaction_lines"
         ("transaction_id","category_id","vat_treatment","vat_rate_code","vat_rate_percent",
          "net_amount","vat_amount","gross_amount")
       VALUES ($1,$2,'domestic','standard','20.00',$3,$4,$5)`,
      [id, category, net, vat, gross],
    )
  }

  /** Locks the period's rows with the real function, as every filing does. */
  async function lock(id: string): Promise<void> {
    const row = await periods.requirePeriod(id)
    await periods.lockPeriodRecords(prisma, row)
  }

  async function netErrorsOn(id: string) {
    return periods.computeNetErrors(await periods.requirePeriod(id))
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
    periods = await import('./periods')
    prisma = (await import('@/lib/db/prisma')).prisma

    const seeded = await client.query<{ id: string }>(
      `SELECT "id" FROM "bk_categories" WHERE "direction" IN ('income','both') LIMIT 1`,
    )
    category = seeded.rows[0]!.id
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

  it('says nothing on a first return, with nothing filed before it', async () => {
    const first = await period('2010-01-01', '2010-03-31')
    await entry('first-sale', '2010-02-01', '100.00')
    // A hand correction with no filed return behind it is tidying up, not an error
    // on a return. Nothing has been told anything yet.
    await entry('first-fix', '2010-02-02', '-10.00', { corrects: 'first-sale' })

    const errors = await netErrorsOn(first)
    expect(errors.net).toBe('0.00')
    expect(errors.overThreshold).toBe(false)
  })

  it('ignores a credit note in the same period as its sale', async () => {
    const open = await period('2011-01-01', '2011-03-31')
    await entry('same-sale', '2011-02-01', '32.59')
    await entry('same-credit', '2011-02-01', '-32.59', {
      corrects: 'same-sale',
      source: 'shop',
      sourceRef: 'credit:CN-1',
    })

    expect((await netErrorsOn(open)).net).toBe('0.00')
  })

  it('ignores a credit note or a void against an entry on a filed return', async () => {
    const filed = await period('2012-01-01', '2012-03-31', { status: 'submitted' })
    await entry('filed-sale', '2012-02-01', '100.00')
    await entry('filed-bill', '2012-02-02', '50.00', {
      direction: 'expense',
      source: 'purchase-orders',
      sourceRef: 'bill:1',
    })
    await lock(filed)

    const next = await period('2012-04-01', '2012-06-30')
    await entry('late-credit', '2012-05-01', '-32.59', {
      corrects: 'filed-sale',
      source: 'shop',
      sourceRef: 'credit:CN-2',
    })
    await entry('late-void', '2012-05-02', '-20.00', {
      corrects: 'filed-sale',
      source: 'shop',
      sourceRef: 'INV-2:void',
    })
    await entry('late-bill-void', '2012-05-03', '-50.00', {
      corrects: 'filed-bill',
      direction: 'expense',
      source: 'purchase-orders',
      sourceRef: 'bill:1:void',
    })

    expect((await netErrorsOn(next)).net).toBe('0.00')
  })

  it('counts a real correction to a filed return, within the limit', async () => {
    const filed = await period('2013-01-01', '2013-03-31', { status: 'submitted' })
    await entry('small-sale', '2013-02-01', '100.00')
    await lock(filed)

    const next = await period('2013-04-01', '2013-06-30')
    await entry('small-fix', '2013-05-01', '-32.59', { corrects: 'small-sale' })

    const errors = await netErrorsOn(next)
    expect(errors.net).toBe('32.59')
    expect(errors.threshold).toBe('10000.00')
    expect(errors.overThreshold).toBe(false)
  })

  it('counts a real correction above the limit, and says so', async () => {
    const filed = await period('2014-01-01', '2014-03-31', { status: 'submitted' })
    await entry('big-sale', '2014-02-01', '100.00')
    await lock(filed)

    const next = await period('2014-04-01', '2014-06-30')
    await entry('big-fix', '2014-05-01', '12000.00', { corrects: 'big-sale' })

    const errors = await netErrorsOn(next)
    expect(errors.net).toBe('12000.00')
    expect(errors.threshold).toBe('10000.00')
    expect(errors.overThreshold).toBe(true)
  })

  it('still lets 1% of box 6 lift the limit, up to the cap', async () => {
    const filed = await period('2015-01-01', '2015-03-31', { status: 'submitted' })
    await entry('turnover-sale', '2015-02-01', '100.00')
    await lock(filed)

    const next = await period('2015-04-01', '2015-06-30')
    await entry('turnover-now', '2015-05-01', '400000.00', { net: '2000000.00' })
    await entry('turnover-fix', '2015-05-02', '15000.00', { corrects: 'turnover-sale', net: '0.00' })

    const errors = await netErrorsOn(next)
    expect(errors.net).toBe('15000.00')
    expect(errors.threshold).toBe('20000.00')
    expect(errors.overThreshold).toBe(false)
  })

  it('shows a correction only on the return it sits in', async () => {
    const filed = await period('2016-01-01', '2016-03-31', { status: 'submitted' })
    await entry('scope-sale', '2016-02-01', '100.00')
    await lock(filed)

    const carrying = await period('2016-04-01', '2016-06-30')
    const later = await period('2016-07-01', '2016-09-30')
    await entry('scope-fix', '2016-05-01', '-40.00', { corrects: 'scope-sale' })

    expect((await netErrorsOn(carrying)).net).toBe('40.00')
    expect((await netErrorsOn(later)).net).toBe('0.00')
    expect((await netErrorsOn(filed)).net).toBe('0.00')
  })

  it('goes on showing a correction once the return carrying it has been filed', async () => {
    const filed = await period('2017-01-01', '2017-03-31', { status: 'submitted' })
    await entry('kept-sale', '2017-02-01', '100.00')
    await lock(filed)

    const carrying = await period('2017-04-01', '2017-06-30', { status: 'submitted' })
    await entry('kept-fix', '2017-05-01', '-25.00', { corrects: 'kept-sale' })
    await lock(carrying)

    expect((await netErrorsOn(carrying)).net).toBe('25.00')
  })

  it('finds a cash-scheme correction by the day the money moved, as the boxes do', async () => {
    const filed = await period('2018-01-01', '2018-03-31', { status: 'submitted' })
    await entry('cash-sale', '2018-02-01', '100.00')
    await lock(filed)

    const cash = await period('2018-04-01', '2018-06-30', { scheme: 'cash' })
    const after = await period('2018-07-01', '2018-09-30', { scheme: 'cash' })
    await entry('cash-fix', '2018-05-01', '-15.00', { corrects: 'cash-sale' })
    await client.query(`UPDATE "bk_transactions" SET "settled_date" = '2018-08-01' WHERE "id" = 'cash-fix'`)

    expect((await netErrorsOn(cash)).net).toBe('0.00')
    expect((await netErrorsOn(after)).net).toBe('15.00')
  })

  it('does not take a sandbox filing for an earlier return', async () => {
    const rehearsal = await period('2019-01-01', '2019-03-31', { status: 'submitted', vrn: SANDBOX_VRN })
    await entry('sandbox-sale', '2019-02-01', '100.00')
    await lock(rehearsal)

    const real = await period('2019-04-01', '2019-06-30')
    await entry('sandbox-fix', '2019-05-01', '-60.00', { corrects: 'sandbox-sale' })

    expect((await netErrorsOn(real)).net).toBe('0.00')
  })

  it('does not hold a period with no VAT number against a real filing', async () => {
    const filed = await period('2020-01-01', '2020-03-31', { status: 'submitted', vrn: null })
    await entry('nullvrn-sale', '2020-02-01', '100.00')
    await lock(filed)

    const next = await period('2020-04-01', '2020-06-30')
    await entry('nullvrn-fix', '2020-05-01', '-5.00', { corrects: 'nullvrn-sale' })

    expect((await netErrorsOn(next)).net).toBe('5.00')
  })

  it('comes to nothing when corrections cancel out, so the screen says nothing', async () => {
    const filed = await period('2021-01-01', '2021-03-31', { status: 'submitted' })
    await entry('nil-sale', '2021-02-01', '100.00')
    await lock(filed)

    const next = await period('2021-04-01', '2021-06-30')
    await entry('nil-up', '2021-05-01', '30.00', { corrects: 'nil-sale' })
    await entry('nil-down', '2021-05-02', '-30.00', { corrects: 'nil-sale' })

    const errors = await netErrorsOn(next)
    expect(errors.net).toBe('0.00')
    expect(errors.overThreshold).toBe(false)
  })
})
