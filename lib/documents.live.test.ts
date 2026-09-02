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

// The document inbox's SQL, against a real Postgres.
//
// document-reading.test.ts and document-matching.test.ts cover the thinking, and
// neither of them touches a database - which is the point of those two, and also
// their limit. Everything in lib/documents.ts is raw SQL, and raw SQL is exactly
// what `tsc` and `eslint` have nothing to say about: a mis-cast parameter, a
// fragment that will not compose, a NUMERIC read back as something unexpected.
// Each of those type-checks perfectly and fails on the first real request.
//
// So the queries are run. Gated the same way the ledger and backup suites are,
// and for the same reason: it needs the OVH server. The databases it makes are
// named cactus_rt_* and dropped afterwards; nothing else on that server is ever
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

suite('the document inbox, against a real database', () => {
  let server: TestServer
  let role: TestRole
  let client: Client
  const databaseName = `cactus_rt_docs_${process.pid}`
  const roleName = `cactus_rt_role_docs_${process.pid}`

  // Imported after DATABASE_URL is set, because lib/db/prisma reads it when the
  // client is built. A static import would bind to whatever the environment held
  // at collection time, which is nothing.
  let documents: typeof import('./documents')
  let aliases: typeof import('./counterparty-aliases')
  let matching: typeof import('./document-matching')

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
    documents = await import('./documents')
    aliases = await import('./counterparty-aliases')
    matching = await import('./document-matching')

    // One entry to file things against, and one document in the inbox.
    await client.query(`
      INSERT INTO "bk_transactions" ("id","direction","tax_point_date","counterparty")
      VALUES ('txn-1','expense','2026-02-10','Acme Supplies Ltd')
    `)
    await client.query(`
      INSERT INTO "bk_attachments"
        ("id","transaction_id","name","filename","url","mime_type","size")
      VALUES ('doc-1', NULL, 'acme.pdf', 'acme.pdf', 'https://x/acme.pdf', 'application/pdf', 2048)
    `)
  }, 300_000)

  afterAll(async () => {
    // Prisma's pool goes first. Dropping the database out from under a live
    // connection works, but the FATAL it logs on the way out reads like a test
    // failure to anybody scanning the output.
    await import('@/lib/db/prisma')
      .then((module) => module.prisma.$disconnect())
      .catch(() => undefined)
    await client?.end().catch(() => undefined)
    if (server) {
      await dropTestDatabase(server, databaseName).catch(() => undefined)
      await dropTestRole(server, roleName).catch(() => undefined)
    }
  }, 120_000)

  it('writes a reading and reads it back in the types the rest of the module expects', async () => {
    await documents.saveReading('doc-1', {
      scanStatus: 'read',
      scanNote: null,
      counterparty: 'ACME SUPPLIES LIMITED',
      counterpartyConfidence: 55,
      counterpartySource: 'letterhead',
      direction: 'expense',
      documentDate: '2026-02-10',
      documentNumber: 'INV-0042',
      net: '100.00',
      vat: '20.00',
      total: '120.00',
      vatRateCode: 'standard',
      vatTreatment: 'domestic',
      vatNumber: 'GB123456782',
      text: 'Acme Supplies Limited\nTotal 120.00',
    })

    const row = await documents.getDocument('doc-1')
    expect(row).not.toBeNull()
    expect(row!.scan_status).toBe('read')
    // NUMERIC arrives as a Decimal, never a float. The whole module turns on it.
    expect(row!.guessed_total?.toFixed(2)).toBe('120.00')
    expect(row!.guessed_document_date?.toISOString().slice(0, 10)).toBe('2026-02-10')
    expect(row!.reading_confirmed).toBe(false)
    expect(row!.guessed_vat_treatment).toBe('domestic')

    // And crosses the wire as a two-decimal string rather than Decimal's "120.5".
    const payload = documents.toDocumentPayload(row!)
    expect(payload.guessed_total).toBe('120.00')
    expect(payload.guessed_document_date).toBe('2026-02-10')
  })

  it('lists the pile, filtered and counted, with every optional parameter left null', async () => {
    const all = await documents.listDocuments()
    expect(all.total).toBe(1)
    expect(all.rows[0]!.id).toBe('doc-1')

    // The same composed WHERE fragment runs in both the page query and the count
    // query. Each of these exercises a different arm of it.
    expect((await documents.listDocuments({ search: 'acme' })).total).toBe(1)
    expect((await documents.listDocuments({ search: 'nothing like it' })).total).toBe(0)
    expect((await documents.listDocuments({ from: '2026-01-01', to: '2026-12-31' })).total).toBe(1)
    expect((await documents.listDocuments({ from: '2026-06-01' })).total).toBe(0)
    expect(await documents.countUnfiledDocuments()).toBe(1)

    // unfiled: false must reach filed rows too, or the picker on an entry would
    // never be able to show what is already attached anywhere.
    expect((await documents.listDocuments({ unfiled: false })).total).toBeGreaterThanOrEqual(1)
  })

  it('gathers the reading context, including the VAT-number-to-supplier lookup', async () => {
    const context = await documents.buildReadingContext()
    expect(context.knownCounterparties).toBeInstanceOf(Array)
    expect(context.aliases).toBeInstanceOf(Map)
    // Not yet: the document is unfiled and nobody has confirmed its reading, so
    // its VAT number belongs to nobody in particular.
    expect(context.vatNumberOwners.has('GB123456782')).toBe(false)
  })

  it('offers the document against a statement line that matches it', async () => {
    const suggestions = await matching.suggestDocumentsForLines(
      [
        {
          date: '2026-02-14',
          amount: '-120.00',
          counterparty: 'ACME SUPPLIES LTD',
          details: 'ACME SUPPLIES LTD LEEDS',
          reference: null,
        },
        // A different amount entirely. Must be offered nothing at all.
        {
          date: '2026-02-14',
          amount: '-59.00',
          counterparty: 'ACME SUPPLIES LTD',
          details: 'ACME SUPPLIES LTD LEEDS',
          reference: null,
        },
      ],
      await aliases.aliasMap(),
    )
    expect(suggestions.byLine.get(0)?.[0]?.documentId).toBe('doc-1')
    expect(suggestions.byLine.get(0)?.[0]?.total).toBe('120.00')
    expect(suggestions.byLine.get(1)).toBeUndefined()
    expect(suggestions.truncated).toBe(false)
  })

  it('files a document against an entry, and the VAT number then names a supplier', async () => {
    const filed = await documents.attachDocument('doc-1', 'txn-1', null)
    expect(filed.transaction_id).toBe('txn-1')

    // A filed document's VAT number now belongs to a supplier, so the next
    // invoice from them is recognised on its number alone even if their
    // letterhead has changed in the meantime.
    const context = await documents.buildReadingContext()
    expect(context.vatNumberOwners.get('GB123456782')).toBe('Acme Supplies Ltd')

    expect(await documents.countUnfiledDocuments()).toBe(0)

    // Nothing was learned here, and that is correct rather than a miss. "ACME
    // SUPPLIES LIMITED" and "Acme Supplies Ltd" already reduce to the same key,
    // so there is no fact to store - the matcher finds them by the words they
    // share. A row would be noise in a table whose whole value is that every row
    // in it says something.
    expect(await aliases.resolveAlias('ACME SUPPLIES LIMITED')).toBeNull()
  })

  it('learns the name where the two spellings genuinely do not agree', async () => {
    await client.query(`
      INSERT INTO "bk_transactions" ("id","direction","tax_point_date","counterparty")
      VALUES ('txn-3','expense','2026-03-02','Transport for London')
    `)
    await client.query(`
      INSERT INTO "bk_attachments"
        ("id","transaction_id","name","filename","url","mime_type","size","guessed_counterparty")
      VALUES ('doc-3', NULL, 'tfl.pdf', 'tfl.pdf', 'https://x/tfl.pdf', 'application/pdf', 512,
              'TFL TRAVEL CH')
    `)

    await documents.attachDocument('doc-3', 'txn-3', null)
    expect(await aliases.resolveAlias('TFL TRAVEL CH')).toBe('Transport for London')
    await aliases.forgetAlias('TFL TRAVEL CH')
  })

  it('refuses to file a document that is already filed elsewhere', async () => {
    await client.query(`
      INSERT INTO "bk_transactions" ("id","direction","tax_point_date","counterparty")
      VALUES ('txn-2','expense','2026-02-11','Someone Else')
    `)
    await expect(documents.attachDocument('doc-1', 'txn-2', null)).rejects.toThrow(/already filed/i)
  })

  it('puts a document back in the inbox', async () => {
    const loose = await documents.detachDocument('doc-1', null)
    expect(loose.transaction_id).toBeNull()
    expect(await documents.countUnfiledDocuments()).toBe(1)
  })

  it('takes a correction, marks the reading confirmed, and learns from it', async () => {
    const corrected = await documents.updateDocumentReading(
      'doc-1',
      {
        counterparty: 'Acme Supplies Ltd',
        direction: 'expense',
        documentDate: '2026-02-09',
        documentNumber: 'INV-0043',
        net: '80.00',
        vat: '16.00',
        total: '96.00',
        vatRateCode: 'standard',
        vatTreatment: 'reverse_charge_services',
      },
      null,
    )
    expect(corrected.reading_confirmed).toBe(true)
    expect(corrected.guessed_vat_treatment).toBe('reverse_charge_services')
    expect(corrected.counterparty_confidence).toBe(100)
    expect(corrected.guessed_total?.toFixed(2)).toBe('96.00')
    expect(corrected.guessed_document_date?.toISOString().slice(0, 10)).toBe('2026-02-09')
  })

  it('refuses an amount that is not an amount, rather than storing something odd', async () => {
    await expect(
      documents.updateDocumentReading('doc-1', { total: 'about a hundred quid' }, null),
    ).rejects.toThrow(/has to be an amount/i)
    await expect(
      documents.updateDocumentReading('doc-1', { documentDate: 'last Tuesday' }, null),
    ).rejects.toThrow(/has to be a real date/i)
    await expect(
      documents.updateDocumentReading(
        'doc-1',
        { vatTreatment: 'made up' as never },
        null,
      ),
    ).rejects.toThrow(/not a way of handling VAT/i)
  })

  it('will not silently re-read a document somebody has checked by hand', async () => {
    await expect(
      documents.rescanDocument('doc-1', Buffer.from('%PDF-1.4 nonsense'), null),
    ).rejects.toThrow(/already checked this one/i)

    // Asked twice, it does it - and the confirmation goes with it.
    const reading = await documents.rescanDocument(
      'doc-1',
      Buffer.from('%PDF-1.4 nonsense'),
      null,
      true,
    )
    expect(['no_text', 'unreadable']).toContain(reading.scanStatus)
    expect((await documents.getDocument('doc-1'))!.reading_confirmed).toBe(false)
  })

  it('throws a receipt away and leaves the file alone by default', async () => {
    await client.query(`
      INSERT INTO "bk_attachments"
        ("id","transaction_id","name","filename","url","mime_type","size","media_provider","media_key")
      VALUES ('doc-keep', NULL, 'keep.pdf', 'keep.pdf', 'https://x/keep.pdf', 'application/pdf', 10,
              'BACKBLAZE_B2', 'bookkeeping/keep.pdf')
    `)
    const outcome = await documents.deleteDocument('doc-keep', null)
    expect(outcome.fileDeleted).toBe(false)
    expect(outcome.fileKept).toBeNull()
    expect(await documents.getDocument('doc-keep')).toBeNull()
  })

  it('refuses to delete a file that is evidence on another entry as well', async () => {
    // The same invoice filed against two entries. This is the case that actually
    // happens, and the one guard that can be answered exactly.
    await client.query(`
      INSERT INTO "bk_attachments"
        ("id","transaction_id","name","filename","url","mime_type","size","media_provider","media_key")
      VALUES
        ('doc-a', NULL, 'shared.pdf', 'shared.pdf', 'https://x/s.pdf', 'application/pdf', 10,
         'BACKBLAZE_B2', 'bookkeeping/shared.pdf'),
        ('doc-b', 'txn-1', 'shared.pdf', 'shared.pdf', 'https://x/s.pdf', 'application/pdf', 10,
         'BACKBLAZE_B2', 'bookkeeping/shared.pdf')
    `)
    const outcome = await documents.deleteDocument('doc-a', null, true)
    expect(outcome.fileDeleted).toBe(false)
    expect(outcome.fileKept).toMatch(/evidence on another entry/i)
    // The row still went - only the bytes were spared.
    expect(await documents.getDocument('doc-a')).toBeNull()
    expect(await documents.getDocument('doc-b')).not.toBeNull()
  })

  it('says so when there are no stored bytes to delete in the first place', async () => {
    await client.query(`
      INSERT INTO "bk_attachments"
        ("id","transaction_id","name","filename","url","mime_type","size")
      VALUES ('doc-linked', NULL, 'linked.pdf', 'linked.pdf', 'https://x/l.pdf', 'application/pdf', 10)
    `)
    const outcome = await documents.deleteDocument('doc-linked', null, true)
    expect(outcome.fileDeleted).toBe(false)
    expect(outcome.fileKept).toMatch(/no stored copy/i)
  })

  it('keeps a name somebody typed on purpose above one it worked out', async () => {
    await aliases.learnAlias('tfl travel ch', 'Transport for London', null, 'manual')
    await aliases.learnAlias('tfl travel ch', 'Something Else Entirely', null, 'learned')
    expect(await aliases.resolveAlias('TFL TRAVEL CH')).toBe('Transport for London')

    // A second manual answer is a decision and does replace it.
    await aliases.learnAlias('tfl travel ch', 'Transport for London (TfL)', null, 'manual')
    expect(await aliases.resolveAlias('TFL TRAVEL CH')).toBe('Transport for London (TfL)')

    await aliases.forgetAlias('TFL TRAVEL CH')
    expect(await aliases.resolveAlias('TFL TRAVEL CH')).toBeNull()
  })
})
