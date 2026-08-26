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

// The nine boxes, against a real Postgres, on the treatments that are not
// ordinary.
//
// vat-boxes.test.ts covers the assembly - box 3 is box 1 plus box 2, box 5 is
// the absolute difference - and none of it touches the database. But the
// CLASSIFY fragment and the VAT_FOR_RETURN expression beside it ARE the return:
// they decide what a line contributes to which box, in SQL, and no amount of
// type checking has anything to say about a CASE expression. A wrong answer here
// is a wrong figure sent to HMRC.
//
// Gated like the ledger and backup suites, and for the same reason: it needs the
// OVH server. Databases are named cactus_rt_* and dropped afterwards.
const ENABLED = process.env.RUN_LEDGER_GUARDS === '1' || process.env.RUN_BACKUP_ROUNDTRIP === '1'
if (ENABLED) {
  try {
    ;(process as unknown as { loadEnvFile: (path: string) => void }).loadEnvFile('.env')
  } catch {
    // No .env - vpsConfigFromEnv below fails the suite loudly rather than here.
  }
}
const suite = ENABLED ? describe : describe.skip

suite('the VAT boxes, against a real database', () => {
  let config: VpsConfig
  let role: TestRole
  let client: Client
  const databaseName = `cactus_rt_boxes_${process.pid}`
  const roleName = `cactus_rt_role_boxes_${process.pid}`

  let boxes: typeof import('./vat-boxes')
  let category: string

  const START = new Date('2026-01-01T00:00:00Z')
  const END = new Date('2026-03-31T00:00:00Z')

  /** One expense line, with everything about it stated rather than defaulted. */
  async function expense(
    id: string,
    treatment: string,
    rateCode: string,
    percent: string,
    net: string,
    vat: string,
  ): Promise<void> {
    const gross = (Number(net) + Number(vat)).toFixed(2)
    await client.query(
      `INSERT INTO "bk_transactions" ("id","direction","tax_point_date","counterparty","status")
       VALUES ($1,'expense','2026-02-10','A Supplier','posted')`,
      [id],
    )
    await client.query(
      `INSERT INTO "bk_transaction_lines"
         ("transaction_id","category_id","vat_treatment","vat_rate_code","vat_rate_percent",
          "net_amount","vat_amount","gross_amount")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, category, treatment, rateCode, percent, net, vat, gross],
    )
  }

  beforeAll(async () => {
    config = vpsConfigFromEnv()
    await dropStaleTestObjects(config)
    role = await createTestRole(config, roleName)
    await createTestDatabase(config, databaseName, role)

    const uri = connectionUri(config, databaseName, role)
    client = new Client({ connectionString: `${uri}&uselibpqcompat=true` })
    await client.connect()
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')

    const directory = join(__dirname, '..', 'migrations')
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(directory, file), 'utf8'))
    }

    process.env.DATABASE_URL = uri
    boxes = await import('./vat-boxes')

    const seeded = await client.query<{ id: string }>(
      `SELECT "id" FROM "bk_categories" WHERE "direction" IN ('expense','both') LIMIT 1`,
    )
    category = seeded.rows[0]!.id
  }, 300_000)

  afterAll(async () => {
    await import('@/lib/db/prisma')
      .then((module) => module.prisma.$disconnect())
      .catch(() => undefined)
    await client?.end().catch(() => undefined)
    if (config) {
      await dropTestDatabase(config, databaseName).catch(() => undefined)
      await dropTestRole(config, roleName).catch(() => undefined)
    }
  }, 120_000)

  it('puts a reverse charge in boxes 1, 4, 6 and 7, from a line that paid no VAT', async () => {
    // The shape a real reverse-charge invoice produces: £75 net, no VAT charged,
    // and £75 is what leaves the bank.
    await expense('rc-1', 'reverse_charge_services', 'standard', '20.00', '75.00', '0.00')

    const totals = await boxes.computeVatTotals(START, END, 'accrual')
    expect(totals.box1.toFixed(2)).toBe('15.00')
    expect(totals.box4.toFixed(2)).toBe('15.00')
    expect(totals.box6.toFixed(2)).toBe('75.00')
    expect(totals.box7.toFixed(2)).toBe('75.00')

    // And it costs nothing on the return, which is the whole point of a reverse
    // charge: the output tax and the input tax are the same figure.
    const assembled = boxes.assembleBoxes(totals, 'nearest')
    expect(assembled.netVatDue).toBe('0.00')
  })

  it('leaves the line itself saying what the supplier actually charged', async () => {
    const line = await client.query<{ vat_amount: string; gross_amount: string }>(
      `SELECT "vat_amount"::text, "gross_amount"::text FROM "bk_transaction_lines"
       WHERE "transaction_id" = 'rc-1'`,
    )
    // Nothing, and £75 - so the entry agrees with the bank statement it came
    // from, and the supplier is shown owed what they invoiced.
    expect(line.rows[0]!.vat_amount).toBe('0.00')
    expect(line.rows[0]!.gross_amount).toBe('75.00')
  })

  it('says the same about an entry recorded the old way, with the VAT on the line', async () => {
    await client.query(`DELETE FROM "bk_transaction_lines"`)
    await client.query(`DELETE FROM "bk_transactions"`)
    // Net 75 at 20% is 15 whether that 15 is read off the line or worked out.
    await expense('rc-old', 'reverse_charge_services', 'standard', '20.00', '75.00', '15.00')

    const totals = await boxes.computeVatTotals(START, END, 'accrual')
    expect(totals.box1.toFixed(2)).toBe('15.00')
    expect(totals.box4.toFixed(2)).toBe('15.00')
  })

  it('does the same for a UK construction reverse charge', async () => {
    await client.query(`DELETE FROM "bk_transaction_lines"`)
    await client.query(`DELETE FROM "bk_transactions"`)
    await expense('rc-cis', 'domestic_reverse_charge', 'standard', '20.00', '1000.00', '0.00')

    const totals = await boxes.computeVatTotals(START, END, 'accrual')
    expect(totals.box1.toFixed(2)).toBe('200.00')
    expect(totals.box4.toFixed(2)).toBe('200.00')
    // Construction goods and services are NOT box 6 - only overseas services are.
    expect(totals.box6.toFixed(2)).toBe('0.00')
    expect(totals.box7.toFixed(2)).toBe('1000.00')
  })

  it('leaves an ordinary domestic purchase exactly as it was', async () => {
    await client.query(`DELETE FROM "bk_transaction_lines"`)
    await client.query(`DELETE FROM "bk_transactions"`)
    await expense('dom-1', 'domestic', 'standard', '20.00', '100.00', '20.00')

    const totals = await boxes.computeVatTotals(START, END, 'accrual')
    expect(totals.box1.toFixed(2)).toBe('0.00')
    expect(totals.box4.toFixed(2)).toBe('20.00')
    expect(totals.box6.toFixed(2)).toBe('0.00')
    expect(totals.box7.toFixed(2)).toBe('100.00')
  })

  it('does not invent VAT on a postponed import, where customs decides the figure', async () => {
    await client.query(`DELETE FROM "bk_transaction_lines"`)
    await client.query(`DELETE FROM "bk_transactions"`)
    // The rate says 20% and the customs value is not the supplier's net, so the
    // figure entered off the postponed VAT statement is the one that counts.
    await expense('pva-1', 'import_pva', 'standard', '20.00', '500.00', '106.40')

    const totals = await boxes.computeVatTotals(START, END, 'accrual')
    expect(totals.box1.toFixed(2)).toBe('106.40')
    expect(totals.box4.toFixed(2)).toBe('106.40')
  })

  it('shows the working that adds up to the box, not the nothing that was paid', async () => {
    await client.query(`DELETE FROM "bk_transaction_lines"`)
    await client.query(`DELETE FROM "bk_transactions"`)
    await expense('rc-w', 'reverse_charge_services', 'standard', '20.00', '75.00', '0.00')

    const workings = await boxes.computeVatWorkings(START, END, 'accrual')
    expect(workings).toHaveLength(1)
    // A snapshot exists so the boxes can be rebuilt from it. A line reporting
    // 0.00 against a box 1 of 15.00 would rebuild nothing.
    expect(workings[0]!.vatAmount).toBe('15.00')
    expect(workings[0]!.boxes).toEqual(['1', '4', '6', '7'])
  })

  it('rounds the notional VAT to the penny, in the database, never through a float', async () => {
    await client.query(`DELETE FROM "bk_transaction_lines"`)
    await client.query(`DELETE FROM "bk_transactions"`)
    // 0.1 + 0.2 territory: 20% of 33.33 is 6.666, which must land on 6.67.
    await expense('rc-r', 'reverse_charge_services', 'standard', '20.00', '33.33', '0.00')

    const totals = await boxes.computeVatTotals(START, END, 'accrual')
    expect(totals.box1.toFixed(2)).toBe('6.67')
  })
})
