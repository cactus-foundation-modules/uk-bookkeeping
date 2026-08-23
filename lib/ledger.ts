import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { formatMoney, toMoney } from './money'
import { INCREASES_ON_DEBIT, type AccountKind, type AccountSubtype, type Money } from './types'

// The ledger. One set of books, at last.
//
// The module records money two ways, and it needs to, because they are two
// different jobs:
//
//   bk_transactions  a cashbook. Money in, money out, coded to a category, with
//                    VAT on it. This is what a VAT return is made of and it is
//                    the only shape a person will actually keep up with.
//   bk_journals      a ledger. Debits and credits against accounts. This is the
//                    only way to say "depreciation", "accrual", "stock at the
//                    year end" - none of which is money moving.
//
// What was missing was that they were never the same books. The trial balance
// read the journals and so showed only the adjustments; the profit and loss
// account read the cashbook and so showed everything EXCEPT the adjustments.
// There was no balance sheet at all, because a balance sheet is precisely the
// thing you cannot draw from half a ledger.
//
// LEDGER_SQL below is the fix. It is a projection, not a table: it turns each
// posted cashbook line into the debits and credits it always implied, and
// unions that with the posted journal lines. Every report in this module reads
// it, so there is exactly one answer to "what is the balance on this account".
//
// WHY A PROJECTION AND NOT A POSTINGS TABLE. A cashbook row goes hard-locked
// and trigger-protected the moment its VAT return is filed (002_immutability),
// and it stays that way forever. A derived table would have to be written at
// the same moment, kept in step through every later edit, and restored in the
// right order from a backup - and any drift between it and the rows it came
// from would be silent and permanent. Computing it costs one extra scan of a
// table with a few thousand rows in it. That is a very cheap way to buy "cannot
// possibly disagree with itself".
//
// ---------------------------------------------------------------------------
// The entries a cashbook transaction implies
// ---------------------------------------------------------------------------
// Take a £120 purchase, £100 net and £20 VAT, invoiced on the 3rd and paid on
// the 20th. What actually happened is:
//
//   3rd   Dr  Motor expenses      100     the cost was incurred
//         Dr  VAT control          20     the VAT became reclaimable
//         Cr  Creditors           120     and the business owed the supplier
//   20th  Dr  Creditors           120     the debt was settled
//         Cr  Bank                120     with money
//
// which is five postings from one row, and is why a cashbook alone cannot
// produce a balance sheet: nothing in it knows what a creditor is. A sale is
// the mirror image, through Debtors.
//
// Two consequences worth stating outright:
//
//   * An unpaid invoice sits in debtors or creditors, exactly as it should. The
//     aged debtor and creditor reports are then a straight read of that, rather
//     than a second calculation that might not agree.
//
//   * Under CASH ACCOUNTING the VAT is not reclaimable until the invoice is
//     paid, so the projection parks it in "VAT not yet due or reclaimable" at
//     the invoice date and moves it to the VAT control account on settlement.
//     Without that step a cash-accounting business's balance sheet claims a
//     debt to HMRC that HMRC does not yet have any claim to.
//
// The accounts themselves are always drawn up on the accruals basis - the tax
// point, not the settlement date - whatever VAT scheme the business is on. Cash
// accounting is a VAT arrangement, not a way of keeping accounts, and the only
// thing it changes here is where the VAT sits in the meantime.

/**
 * The projection. Yields one relation of postings:
 *
 *   entry_date, account_id, debit, credit, source_kind, source_id,
 *   source_line_id, counterparty, description, reference, sort_key
 *
 * Debits and credits are always non-negative, both here and in the journals, so
 * nothing downstream has to cope with a negative debit. A credit note or a
 * refund arrives as a negative amount on a cashbook line and comes out of here
 * on the other side, which is the same figure said correctly.
 *
 * Every branch balances on its own, so the whole thing balances. That is worth
 * more than it sounds: it means a trial balance that does not add up is proof
 * of a real problem rather than of a rounding argument, and ledgerHealth()
 * treats it that way.
 */
export const LEDGER_SQL = Prisma.sql`
  WITH scheme_cte AS (
    -- COALESCE rather than a join: a missing settings row must not silently
    -- empty the entire ledger.
    SELECT COALESCE(
      (SELECT "scheme" FROM "bk_settings" WHERE "id" = 'singleton'), 'accrual'
    ) AS scheme
  ),
  ctrl AS (
    -- The control accounts, found by their stable codes. Codes are unique, so
    -- each of these is one row or none.
    SELECT
      MAX("id") FILTER (WHERE "code" = 'bank-current')     AS default_bank,
      MAX("id") FILTER (WHERE "code" = 'debtors')          AS debtors,
      MAX("id") FILTER (WHERE "code" = 'creditors')        AS creditors,
      MAX("id") FILTER (WHERE "code" = 'vat-control')      AS vat_control,
      MAX("id") FILTER (WHERE "code" = 'vat-deferred')     AS vat_deferred,
      MAX("id") FILTER (WHERE "code" = 'fixed-assets')     AS fixed_assets,
      MAX("id") FILTER (WHERE "code" = 'opening-balances') AS opening_balances,
      MAX("id") FILTER (WHERE "code" = 'suspense')         AS suspense
    FROM "bk_accounts"
  ),
  cat_account AS (
    -- Which account a category posts to. DISTINCT ON rather than a unique
    -- constraint, because an owner may have pointed a second account at a
    -- category and a migration that failed on their install would be worse
    -- than a deterministic choice here. ledgerHealth() reports the duplicate.
    SELECT DISTINCT ON (a."category_id") a."category_id", a."id" AS account_id
    FROM "bk_accounts" a
    WHERE a."category_id" IS NOT NULL
    ORDER BY a."category_id", a."is_system" DESC, a."position" ASC, a."id" ASC
  ),
  bank_account AS (
    SELECT DISTINCT ON (a."bank_account_id") a."bank_account_id", a."id" AS account_id
    FROM "bk_accounts" a
    WHERE a."bank_account_id" IS NOT NULL
    ORDER BY a."bank_account_id", a."is_system" DESC, a."position" ASC, a."id" ASC
  ),
  txn AS (
    -- Each posted transaction with its gross and VAT totals, resolved once so
    -- the settlement branches below do not each re-aggregate the lines.
    SELECT t."id", t."direction", t."tax_point_date", t."settled_date",
           t."counterparty", t."description", t."reference", t."created_at",
           t."bank_account_id",
           COALESCE(SUM(l."gross_amount"), 0)::numeric AS gross,
           COALESCE(SUM(l."vat_amount"), 0)::numeric   AS vat
    FROM "bk_transactions" t
    JOIN "bk_transaction_lines" l ON l."transaction_id" = t."id"
    WHERE t."status" = 'posted'
    GROUP BY t."id"
  )

  -- 1. The analysis side: what the money was for.
  SELECT
    t."tax_point_date"                              AS entry_date,
    -- A line flagged capital goes to fixed assets whatever category it carries,
    -- because a capital purchase is not a cost however it was coded. Anything
    -- with no account at all lands in suspense rather than nowhere: a
    -- one-sided entry would unbalance the whole ledger, and a suspense balance
    -- is a visible problem where a missing posting is an invisible one.
    CASE WHEN l."is_capital" THEN COALESCE(ctrl.fixed_assets, ctrl.suspense)
         ELSE COALESCE(ca.account_id, ctrl.suspense) END AS account_id,
    CASE WHEN t."direction" = 'expense' THEN GREATEST(l."net_amount", 0)
         ELSE GREATEST(-l."net_amount", 0) END      AS debit,
    CASE WHEN t."direction" = 'income'  THEN GREATEST(l."net_amount", 0)
         ELSE GREATEST(-l."net_amount", 0) END      AS credit,
    'transaction'::text                             AS source_kind,
    t."id"                                          AS source_id,
    l."id"                                          AS source_line_id,
    t."counterparty"                                AS counterparty,
    COALESCE(NULLIF(l."description", ''), t."description") AS description,
    t."reference"                                   AS reference,
    t."created_at"                                  AS sort_key
  FROM "bk_transaction_lines" l
  JOIN "bk_transactions" t ON t."id" = l."transaction_id"
  LEFT JOIN cat_account ca ON ca."category_id" = l."category_id"
  CROSS JOIN ctrl
  WHERE t."status" = 'posted' AND l."net_amount" <> 0

  UNION ALL

  -- 2. The VAT, at the invoice date. To the VAT control account on the accruals
  --    scheme; parked in the deferred account on cash accounting until paid.
  SELECT
    t."tax_point_date",
    CASE WHEN s.scheme = 'cash' THEN COALESCE(ctrl.vat_deferred, ctrl.vat_control)
         ELSE ctrl.vat_control END,
    CASE WHEN t."direction" = 'expense' THEN GREATEST(l."vat_amount", 0)
         ELSE GREATEST(-l."vat_amount", 0) END,
    CASE WHEN t."direction" = 'income'  THEN GREATEST(l."vat_amount", 0)
         ELSE GREATEST(-l."vat_amount", 0) END,
    'transaction'::text, t."id", l."id", t."counterparty",
    'VAT', t."reference", t."created_at"
  FROM "bk_transaction_lines" l
  JOIN "bk_transactions" t ON t."id" = l."transaction_id"
  CROSS JOIN ctrl
  CROSS JOIN scheme_cte s
  WHERE t."status" = 'posted' AND l."vat_amount" <> 0

  UNION ALL

  -- 3. The other side at the invoice date: somebody owes somebody. A sale
  --    creates a debtor, a purchase creates a creditor, and both are gross.
  SELECT
    t."tax_point_date",
    CASE WHEN t."direction" = 'income' THEN ctrl.debtors ELSE ctrl.creditors END,
    CASE WHEN t."direction" = 'income' THEN GREATEST(t.gross, 0) ELSE GREATEST(-t.gross, 0) END,
    CASE WHEN t."direction" = 'income' THEN GREATEST(-t.gross, 0) ELSE GREATEST(t.gross, 0) END,
    'transaction'::text, t."id", NULL, t."counterparty",
    CASE WHEN t."direction" = 'income' THEN 'Owed by customer' ELSE 'Owed to supplier' END,
    t."reference", t."created_at"
  FROM txn t
  CROSS JOIN ctrl
  WHERE t.gross <> 0

  UNION ALL

  -- 4. Settlement, the money side. Named bank account if the entry has one,
  --    otherwise the default current account.
  SELECT
    t."settled_date",
    COALESCE(ba.account_id, ctrl.default_bank, ctrl.suspense),
    CASE WHEN t."direction" = 'income' THEN GREATEST(t.gross, 0) ELSE GREATEST(-t.gross, 0) END,
    CASE WHEN t."direction" = 'income' THEN GREATEST(-t.gross, 0) ELSE GREATEST(t.gross, 0) END,
    'transaction'::text, t."id", NULL, t."counterparty",
    CASE WHEN t."direction" = 'income' THEN 'Money received' ELSE 'Money paid' END,
    t."reference", t."created_at"
  FROM txn t
  LEFT JOIN bank_account ba ON ba."bank_account_id" = t."bank_account_id"
  CROSS JOIN ctrl
  WHERE t."settled_date" IS NOT NULL AND t.gross <> 0

  UNION ALL

  -- 5. Settlement, clearing the debtor or creditor it raised at step 3.
  SELECT
    t."settled_date",
    CASE WHEN t."direction" = 'income' THEN ctrl.debtors ELSE ctrl.creditors END,
    CASE WHEN t."direction" = 'income' THEN GREATEST(-t.gross, 0) ELSE GREATEST(t.gross, 0) END,
    CASE WHEN t."direction" = 'income' THEN GREATEST(t.gross, 0) ELSE GREATEST(-t.gross, 0) END,
    'transaction'::text, t."id", NULL, t."counterparty",
    CASE WHEN t."direction" = 'income' THEN 'Customer paid' ELSE 'Supplier paid' END,
    t."reference", t."created_at"
  FROM txn t
  CROSS JOIN ctrl
  WHERE t."settled_date" IS NOT NULL AND t.gross <> 0

  UNION ALL

  -- 6. Cash accounting only: the VAT becomes due, or reclaimable, on payment.
  --    Two postings moving it out of the deferred account and into the real one.
  SELECT
    t."settled_date", ctrl.vat_deferred,
    CASE WHEN t."direction" = 'income' THEN GREATEST(t.vat, 0) ELSE GREATEST(-t.vat, 0) END,
    CASE WHEN t."direction" = 'income' THEN GREATEST(-t.vat, 0) ELSE GREATEST(t.vat, 0) END,
    'transaction'::text, t."id", NULL, t."counterparty",
    'VAT now due on payment', t."reference", t."created_at"
  FROM txn t
  CROSS JOIN ctrl
  CROSS JOIN scheme_cte s
  WHERE s.scheme = 'cash' AND t."settled_date" IS NOT NULL AND t.vat <> 0
    AND ctrl.vat_deferred IS NOT NULL

  UNION ALL

  SELECT
    t."settled_date", ctrl.vat_control,
    CASE WHEN t."direction" = 'income' THEN GREATEST(-t.vat, 0) ELSE GREATEST(t.vat, 0) END,
    CASE WHEN t."direction" = 'income' THEN GREATEST(t.vat, 0) ELSE GREATEST(-t.vat, 0) END,
    'transaction'::text, t."id", NULL, t."counterparty",
    'VAT now due on payment', t."reference", t."created_at"
  FROM txn t
  CROSS JOIN ctrl
  CROSS JOIN scheme_cte s
  WHERE s.scheme = 'cash' AND t."settled_date" IS NOT NULL AND t.vat <> 0
    AND ctrl.vat_deferred IS NOT NULL

  UNION ALL

  -- 7. Bank opening balances. A business that kept its books elsewhere before
  --    this one did not start with nothing, and a balance sheet that says it
  --    did is off by the whole opening position. The other side goes to an
  --    equity account named for what it is, so the ledger still balances and
  --    the figure is visible rather than smuggled into reserves.
  SELECT
    b."opening_date", a2."id",
    GREATEST(b."opening_balance", 0), GREATEST(-b."opening_balance", 0),
    'opening'::text, b."id", NULL, b."name",
    'Opening balance', NULL, b."created_at"
  FROM "bk_bank_accounts" b
  JOIN bank_account ba ON ba."bank_account_id" = b."id"
  JOIN "bk_accounts" a2 ON a2."id" = ba.account_id
  WHERE b."opening_date" IS NOT NULL AND b."opening_balance" <> 0

  UNION ALL

  SELECT
    b."opening_date", ctrl.opening_balances,
    GREATEST(-b."opening_balance", 0), GREATEST(b."opening_balance", 0),
    'opening'::text, b."id", NULL, b."name",
    'Opening balance', NULL, b."created_at"
  FROM "bk_bank_accounts" b
  CROSS JOIN ctrl
  WHERE b."opening_date" IS NOT NULL AND b."opening_balance" <> 0
    AND ctrl.opening_balances IS NOT NULL

  UNION ALL

  -- 8. The journals, which were already debits and credits and need no
  --    translating at all.
  SELECT
    j."date", l."account_id", l."debit", l."credit",
    'journal'::text, j."id", l."id",
    COALESCE(j."reference", 'Journal'),
    COALESCE(NULLIF(l."description", ''), j."narrative"),
    j."reference", j."created_at"
  FROM "bk_journal_lines" l
  JOIN "bk_journals" j ON j."id" = l."journal_id"
  WHERE j."status" = 'posted'
`

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export type AccountBalance = {
  accountId: string
  code: string
  name: string
  kind: AccountKind
  subtype: AccountSubtype
  reportGroup: string | null
  bsGroup: string | null
  /** How much of what lands here the taxman disallows, as a percentage string. */
  disallowablePercent: string
  debits: string
  credits: string
  /** Signed the way the account reads: positive means "more of what this account is". */
  balance: string
}

/**
 * What every account holds, as at a date, from the whole ledger.
 *
 * One statement. The sign convention lives in INCREASES_ON_DEBIT and is applied
 * once, here, rather than being repeated at every call site - which is how a
 * liability ends up displayed upside down on one screen and the right way up on
 * another.
 */
export async function accountBalances(
  asAt?: string | null,
  from?: string | null,
): Promise<AccountBalance[]> {
  const asAtDate = asAt ? new Date(`${asAt.slice(0, 10)}T00:00:00.000Z`) : null
  const fromDate = from ? new Date(`${from.slice(0, 10)}T00:00:00.000Z`) : null

  const rows = await prisma.$queryRaw<
    {
      id: string
      code: string
      name: string
      kind: AccountKind
      subtype: AccountSubtype
      report_group: string | null
      bs_group: string | null
      disallowable_percent: Prisma.Decimal
      debits: Prisma.Decimal
      credits: Prisma.Decimal
    }[]
  >(Prisma.sql`
    WITH ledger AS (${LEDGER_SQL})
    SELECT a."id", a."code", a."name", a."kind", a."subtype",
           a."report_group", a."bs_group", a."disallowable_percent",
           COALESCE(sums."debits", 0)::numeric  AS debits,
           COALESCE(sums."credits", 0)::numeric AS credits
    FROM "bk_accounts" a
    -- A lateral rather than a join and a GROUP BY: with the date test in a join
    -- condition, an account whose only entries fall outside the range matches a
    -- row that then fails every WHERE written to keep the empty accounts, and
    -- the account disappears from the list altogether rather than showing nil.
    LEFT JOIN LATERAL (
      SELECT SUM(e."debit") AS debits, SUM(e."credit") AS credits
      FROM ledger e
      WHERE e."account_id" = a."id"
        AND (${fromDate}::date IS NULL OR e."entry_date" >= ${fromDate}::date)
        AND (${asAtDate}::date IS NULL OR e."entry_date" <= ${asAtDate}::date)
    ) sums ON TRUE
    ORDER BY a."position" ASC, a."name" ASC
  `)

  return rows.map((row) => {
    const debits = toMoney(row.debits)
    const credits = toMoney(row.credits)
    const balance = INCREASES_ON_DEBIT[row.kind] ? debits.minus(credits) : credits.minus(debits)
    return {
      accountId: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      subtype: row.subtype,
      reportGroup: row.report_group,
      bsGroup: row.bs_group,
      disallowablePercent: formatMoney(row.disallowable_percent),
      debits: formatMoney(debits),
      credits: formatMoney(credits),
      balance: formatMoney(balance),
    }
  })
}

/**
 * The trial balance: every account with a movement, and the two totals that
 * should agree.
 *
 * They agree because every branch of the projection posts both sides. A
 * difference here therefore means something real - a control account deleted
 * out from under it, or a guard interfered with - which is worth showing rather
 * than hiding behind a rounding tolerance.
 */
export type TrialBalance = {
  asAt: string | null
  rows: {
    accountId: string
    code: string
    name: string
    kind: AccountKind
    debit: string
    credit: string
  }[]
  totalDebits: string
  totalCredits: string
  balanced: boolean
  difference: string
}

export async function trialBalance(asAt?: string | null): Promise<TrialBalance> {
  const balances = await accountBalances(asAt)
  let totalDebits: Money = toMoney('0.00')
  let totalCredits: Money = toMoney('0.00')

  const rows = balances
    .map((row) => {
      // A trial balance shows each account's NET position on one side or the
      // other, not its gross turnover on both. An account that took £900 in and
      // paid £900 out belongs on neither side.
      const net = toMoney(row.debits).minus(toMoney(row.credits))
      const debit = net.isPositive() ? net : toMoney('0.00')
      const credit = net.isNegative() ? net.negated() : toMoney('0.00')
      totalDebits = totalDebits.plus(debit)
      totalCredits = totalCredits.plus(credit)
      return {
        accountId: row.accountId,
        code: row.code,
        name: row.name,
        kind: row.kind,
        debit: formatMoney(debit),
        credit: formatMoney(credit),
      }
    })
    .filter((row) => row.debit !== '0.00' || row.credit !== '0.00')

  return {
    asAt: asAt ?? null,
    rows,
    totalDebits: formatMoney(totalDebits),
    totalCredits: formatMoney(totalCredits),
    balanced: totalDebits.equals(totalCredits),
    difference: formatMoney(totalDebits.minus(totalCredits)),
  }
}

// ---------------------------------------------------------------------------
// Nominal ledger
// ---------------------------------------------------------------------------

export type NominalEntry = {
  date: string
  sourceKind: 'transaction' | 'journal' | 'opening'
  sourceId: string
  counterparty: string
  description: string
  reference: string | null
  debit: string
  credit: string
  /** The running balance, signed the way the account reads. */
  balance: string
}

export type NominalLedger = {
  accountId: string
  code: string
  name: string
  kind: AccountKind
  from: string | null
  to: string | null
  broughtForward: string
  entries: NominalEntry[]
  totalDebits: string
  totalCredits: string
  closing: string
}

/**
 * Everything that has hit one account, oldest first, with a running balance.
 *
 * This is the report an accountant asks for first and the one a cashbook cannot
 * give you at all: "show me every single thing that went to motor expenses".
 * The brought-forward figure is worked out separately from the listed rows,
 * because a running total that restarts at zero whenever a date filter is set
 * reads as though the account began on the date somebody typed.
 */
export async function nominalLedger(
  accountId: string,
  options: { from?: string | null; to?: string | null } = {},
): Promise<NominalLedger | null> {
  const account = (
    await prisma.$queryRaw<
      { id: string; code: string; name: string; kind: AccountKind }[]
    >`SELECT "id", "code", "name", "kind" FROM "bk_accounts" WHERE "id" = ${accountId} LIMIT 1`
  )[0]
  if (!account) return null

  const from = options.from ? new Date(`${options.from.slice(0, 10)}T00:00:00.000Z`) : null
  const to = options.to ? new Date(`${options.to.slice(0, 10)}T00:00:00.000Z`) : null

  const rows = await prisma.$queryRaw<
    {
      entry_date: Date
      source_kind: 'transaction' | 'journal' | 'opening'
      source_id: string
      counterparty: string
      description: string
      reference: string | null
      debit: Prisma.Decimal
      credit: Prisma.Decimal
      bf_debit: Prisma.Decimal
      bf_credit: Prisma.Decimal
    }[]
  >(Prisma.sql`
    WITH ledger AS (${LEDGER_SQL}),
    mine AS (
      SELECT * FROM ledger WHERE "account_id" = ${accountId}
    ),
    bf AS (
      -- What the account held before the range opened. One row, always, even
      -- when there is nothing before the range.
      SELECT COALESCE(SUM("debit"), 0)::numeric AS bf_debit,
             COALESCE(SUM("credit"), 0)::numeric AS bf_credit
      FROM mine
      WHERE ${from}::date IS NOT NULL AND "entry_date" < ${from}::date
    )
    SELECT m."entry_date", m."source_kind", m."source_id", m."counterparty",
           m."description", m."reference", m."debit", m."credit",
           bf.bf_debit, bf.bf_credit
    FROM mine m
    CROSS JOIN bf
    WHERE (${from}::date IS NULL OR m."entry_date" >= ${from}::date)
      AND (${to}::date IS NULL OR m."entry_date" <= ${to}::date)
      AND (m."debit" <> 0 OR m."credit" <> 0)
    ORDER BY m."entry_date" ASC, m."sort_key" ASC, m."source_id" ASC
  `)

  const increasesOnDebit = INCREASES_ON_DEBIT[account.kind]
  const bfDebit = toMoney(rows[0]?.bf_debit ?? '0')
  const bfCredit = toMoney(rows[0]?.bf_credit ?? '0')
  let running = increasesOnDebit ? bfDebit.minus(bfCredit) : bfCredit.minus(bfDebit)

  let totalDebits = toMoney('0.00')
  let totalCredits = toMoney('0.00')

  const entries: NominalEntry[] = rows.map((row) => {
    const debit = toMoney(row.debit)
    const credit = toMoney(row.credit)
    totalDebits = totalDebits.plus(debit)
    totalCredits = totalCredits.plus(credit)
    running = increasesOnDebit
      ? running.plus(debit).minus(credit)
      : running.plus(credit).minus(debit)
    return {
      date: row.entry_date.toISOString().slice(0, 10),
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      counterparty: row.counterparty,
      description: row.description,
      reference: row.reference,
      debit: formatMoney(debit),
      credit: formatMoney(credit),
      balance: formatMoney(running),
    }
  })

  return {
    accountId: account.id,
    code: account.code,
    name: account.name,
    kind: account.kind,
    from: options.from ?? null,
    to: options.to ?? null,
    broughtForward: formatMoney(increasesOnDebit ? bfDebit.minus(bfCredit) : bfCredit.minus(bfDebit)),
    entries,
    totalDebits: formatMoney(totalDebits),
    totalCredits: formatMoney(totalCredits),
    closing: formatMoney(running),
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type LedgerHealth = {
  healthy: boolean
  /** Control accounts the projection needs and cannot find. */
  missingAccounts: string[]
  /** Categories used by a posted entry that point at no account, so land in suspense. */
  unmappedCategories: { id: string; code: string; name: string; entries: number }[]
  /** Categories with more than one account pointing at them. */
  duplicateMappings: { code: string; name: string; accounts: number }[]
  /** Anything sitting in suspense, which is always somebody's mistake. */
  suspenseBalance: string
  /**
   * Entries that settled without naming an account, on a site that keeps real
   * ones. Their money went to the built-in main current account, which is not
   * in the owner's bank list and which nobody reconciles - so the balance
   * sheet shows cash sitting somewhere the business does not actually bank.
   * Null when there is nothing to say.
   */
  strandedSettlements: { entries: number; balance: string } | null
  balanced: boolean
  difference: string
}

const REQUIRED_ACCOUNT_CODES = [
  'debtors',
  'creditors',
  'vat-control',
  'vat-deferred',
  'bank-current',
  'fixed-assets',
  'retained-earnings',
  'opening-balances',
  'suspense',
]

/**
 * Whether the books can be trusted to add up, and if not, exactly why.
 *
 * Shown wherever it is not well, in the same spirit as the trigger health
 * check: a report that is quietly wrong is far worse than one that says it is.
 */
export async function ledgerHealth(): Promise<LedgerHealth> {
  const [present, unmapped, duplicates, stranded, tb] = await Promise.all([
    prisma.$queryRaw<{ code: string }[]>`
      SELECT "code" FROM "bk_accounts" WHERE "code" = ANY(${REQUIRED_ACCOUNT_CODES}::text[])
    `,
    prisma.$queryRaw<{ id: string; code: string; name: string; entries: bigint }[]>`
      SELECT c."id", c."code", c."name", COUNT(DISTINCT t."id")::bigint AS entries
      FROM "bk_categories" c
      JOIN "bk_transaction_lines" l ON l."category_id" = c."id"
      JOIN "bk_transactions" t ON t."id" = l."transaction_id" AND t."status" = 'posted'
      WHERE NOT EXISTS (SELECT 1 FROM "bk_accounts" a WHERE a."category_id" = c."id")
      GROUP BY c."id", c."code", c."name"
      ORDER BY c."name" ASC
    `,
    prisma.$queryRaw<{ code: string; name: string; accounts: bigint }[]>`
      SELECT c."code", c."name", COUNT(a."id")::bigint AS accounts
      FROM "bk_categories" c
      JOIN "bk_accounts" a ON a."category_id" = c."id"
      GROUP BY c."id", c."code", c."name"
      HAVING COUNT(a."id") > 1
      ORDER BY c."name" ASC
    `,
    // Two counts in one round trip: whether this site keeps real bank accounts
    // at all, and how many settled entries never said which one the money moved
    // through. Neither is a problem on its own. Together they are.
    prisma.$queryRaw<{ bank_accounts: bigint; entries: bigint }[]>`
      SELECT
        (SELECT COUNT(*) FROM "bk_bank_accounts" WHERE "archived" = FALSE)::bigint
          AS bank_accounts,
        (SELECT COUNT(*) FROM "bk_transactions"
          WHERE "status" = 'posted'
            AND "settled_date" IS NOT NULL
            AND "bank_account_id" IS NULL)::bigint
          AS entries
    `,
    trialBalance(),
  ])

  const found = new Set(present.map((row) => row.code))
  const missingAccounts = REQUIRED_ACCOUNT_CODES.filter((code) => !found.has(code))
  const suspense = tb.rows.find((row) => row.code === 'suspense')
  const suspenseBalance = formatMoney(
    toMoney(suspense?.debit ?? '0').minus(toMoney(suspense?.credit ?? '0')),
  )

  const counts = stranded[0]
  const defaultBank = tb.rows.find((row) => row.code === 'bank-current')
  const strandedSettlements =
    Number(counts?.bank_accounts ?? 0) > 0 && Number(counts?.entries ?? 0) > 0
      ? {
          entries: Number(counts?.entries ?? 0),
          balance: formatMoney(
            toMoney(defaultBank?.debit ?? '0').minus(toMoney(defaultBank?.credit ?? '0')),
          ),
        }
      : null

  return {
    healthy:
      missingAccounts.length === 0 &&
      unmapped.length === 0 &&
      duplicates.length === 0 &&
      tb.balanced &&
      strandedSettlements === null &&
      suspenseBalance === '0.00',
    missingAccounts,
    unmappedCategories: unmapped.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      entries: Number(row.entries),
    })),
    duplicateMappings: duplicates.map((row) => ({
      code: row.code,
      name: row.name,
      accounts: Number(row.accounts),
    })),
    suspenseBalance,
    strandedSettlements,
    balanced: tb.balanced,
    difference: tb.difference,
  }
}
