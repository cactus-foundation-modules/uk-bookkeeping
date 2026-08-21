-- ===========================================================================
-- 009_ledger_mapping.sql
--
-- What this file is for: making the cashbook and the ledger the same set of
-- books.
--
-- Up to now they were two. bk_transactions is a cashbook - money in, money out,
-- analysed to a category. bk_journals is a ledger - debits and credits against
-- accounts. Nothing joined them, so the trial balance showed only the journals
-- (which is to say, only the year-end adjustments), and the profit and loss
-- account showed only the cashbook (which is to say, everything EXCEPT the
-- depreciation and accruals that make it right). Neither report was wrong about
-- what it looked at. Both were wrong about the business.
--
-- The fix is not a second copy of the data. There is no postings table here, and
-- there deliberately never will be: bk_transactions rows go hard-locked and
-- trigger-protected the moment a VAT return is filed, and a derived table that
-- had to stay in step with locked rows would be a bug with a schedule. Instead
-- the projection lives in ONE SQL fragment (lib/ledger.ts, LEDGER_SQL) which
-- turns each posted transaction line into the debits and credits it always
-- implied, and unions that with the posted journal lines. Every report reads
-- that. Compute it, never store it.
--
-- What this migration adds is the mapping the projection needs:
--   * every category points at the ledger account it posts to,
--   * every bank account has a ledger account of its own,
--   * accounts say where they belong on a report, and how much of them the
--     taxman disallows.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- New subtypes
-- ---------------------------------------------------------------------------
-- Stock, intangibles and provisions are balance sheet lines a set of small
-- company accounts genuinely has and this module previously had no word for.
-- Re-stating the whole CHECK rather than adding a second one, so there is one
-- place that lists what a subtype may be.
DO $$ BEGIN
  ALTER TABLE "bk_accounts" DROP CONSTRAINT IF EXISTS "bk_accounts_subtype_chk";
  ALTER TABLE "bk_accounts" ADD CONSTRAINT "bk_accounts_subtype_chk" CHECK ("subtype" IN (
    'other', 'bank', 'cash', 'director_loan', 'vat_control', 'debtors',
    'creditors', 'fixed_assets', 'depreciation', 'share_capital', 'reserves',
    'suspense', 'profit_and_loss', 'stock', 'intangibles', 'provisions',
    'vat_deferred'
  ));
END $$;

-- ---------------------------------------------------------------------------
-- Where an account belongs on a report
-- ---------------------------------------------------------------------------
-- Plain text with no CHECK, on purpose and for the same reason bk_categories
-- keeps sa103_box and ct600_group as plain text: these are groupings on forms
-- that HMRC renumbers when it feels like it, and a renumbering should be a
-- settings edit rather than a release.
--
-- report_group: which line of the profit and loss account. One of 'turnover',
-- 'other-income', 'non-trade-income', 'property-income', 'cost-of-sales',
-- 'staff-costs', 'admin-expenses', 'depreciation', 'finance-costs', 'tax'.
-- NULL on balance sheet accounts.
ALTER TABLE "bk_accounts" ADD COLUMN IF NOT EXISTS "report_group" TEXT;

-- bs_group: which line of the balance sheet. One of 'fixed_assets',
-- 'intangible_assets', 'current_assets_stock', 'current_assets_debtors',
-- 'current_assets_cash', 'creditors_short', 'creditors_long', 'provisions',
-- 'share_capital', 'reserves'. NULL on profit and loss accounts.
--
-- Held separately from `subtype` because they answer different questions. The
-- subtype says what an account IS, which drives behaviour (the director's loan
-- screen, the overdrawn warning). The bs_group says where it PRINTS, which is
-- the owner's presentation choice - a bank loan is a liability either way, but
-- whether it sits above or below the one-year line depends on its term.
ALTER TABLE "bk_accounts" ADD COLUMN IF NOT EXISTS "bs_group" TEXT;

-- How much of what lands here the taxman will not allow, as a percentage.
-- Depreciation is 100 (capital allowances replace it), client entertaining is
-- 100, a fine is 100, and everything else is 0 until somebody says otherwise.
-- The corporation tax computation adds these back automatically, which is the
-- whole reason it can produce a figure nobody typed.
ALTER TABLE "bk_accounts"
  ADD COLUMN IF NOT EXISTS "disallowable_percent" NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE "bk_accounts" ADD CONSTRAINT "bk_accounts_disallowable_chk"
    CHECK ("disallowable_percent" >= 0 AND "disallowable_percent" <= 100);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "bk_accounts_report_group_idx" ON "bk_accounts" ("report_group");
CREATE INDEX IF NOT EXISTS "bk_accounts_bs_group_idx" ON "bk_accounts" ("bs_group");

-- ---------------------------------------------------------------------------
-- The accounts the projection needs and 006 did not seed
-- ---------------------------------------------------------------------------
INSERT INTO "bk_accounts"
  ("code", "name", "kind", "subtype", "bs_group", "report_group", "position", "is_system")
VALUES
  -- Stock. Not reachable from the cashbook (a stock figure is a count, not a
  -- payment), but a journal at the year end puts it here and the balance sheet
  -- is wrong without it.
  ('stock', 'Stock and work in progress', 'asset', 'stock', 'current_assets_stock', NULL, 45, TRUE),

  -- VAT charged or suffered that is not yet due to or from HMRC, because the
  -- business is on cash accounting and the invoice has not been settled. The
  -- projection parks VAT here at the invoice date and moves it to the VAT
  -- control account when the money moves. Without it, a cash-accounting
  -- business's balance sheet claims it owes HMRC for invoices nobody has paid.
  -- Its own subtype rather than 'vat_control', so the month-by-month VAT column
  -- counts what actually became due to HMRC that month. Sharing the subtype put
  -- a cash-accounting business's VAT in the month of the invoice.
  ('vat-deferred', 'VAT not yet due or reclaimable', 'liability', 'vat_deferred',
   'creditors_short', NULL, 95, TRUE),

  -- Long-term borrowing, so a bank loan does not have to sit in "money the
  -- business owes" as though it were all due next month.
  ('loans', 'Loans and other long-term borrowing', 'liability', 'other', 'creditors_long', NULL, 115, TRUE),

  -- Where drawings and dividends go. Equity, not cost: taking profit out of a
  -- business is not a business expense, and treating it as one overstates the
  -- costs and understates the tax by exactly the same amount.
  ('dividends-drawings', 'Dividends and drawings', 'equity', 'reserves', 'reserves', NULL, 135, TRUE),
  ('capital-introduced', 'Money introduced by the owner', 'equity', 'reserves', 'reserves', NULL, 136, TRUE),

  -- The opening position of a business that kept its books somewhere else
  -- before this. Bank opening balances are projected against it, so the books
  -- start from the right place and still balance.
  ('opening-balances', 'Opening balances brought forward', 'equity', 'reserves', 'reserves', NULL, 145, TRUE),

  -- The corporation tax CHARGE, as against the corporation-tax LIABILITY that
  -- 006 already seeded. A year-end journal debits this and credits that.
  ('pl-corporation-tax', 'Corporation tax on profits', 'expense', 'profit_and_loss', NULL, 'tax', 1900, TRUE)
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Two categories the seed set was missing, both of which matter to the tax
-- ---------------------------------------------------------------------------
-- Entertaining, split out of "Advertising and entertainment". Lumping the two
-- together is fine for a profit and loss account and quietly wrong for a tax
-- computation: advertising is allowable and entertaining a client is not, and
-- one category cannot be both.
--
-- Bank interest received, because a company pays tax on it under a different
-- heading (box 170, non-trading loan relationships) from its trade, and there
-- was previously nowhere to put it that was not turnover.
INSERT INTO "bk_categories"
  ("code", "name", "direction", "sa103_box", "ct600_group", "is_trading", "is_capital", "position", "is_system")
VALUES
  ('entertaining', 'Client entertaining', 'expense', 'SA103F.25', 'admin-expenses', TRUE, FALSE, 111, TRUE),
  ('interest-received', 'Bank interest received', 'income', 'SA103F.16', 'non-trade-income', TRUE, FALSE, 21, TRUE)
ON CONFLICT ("code") DO NOTHING;

-- Their mirroring accounts. Same 'pl-' convention 006 established.
INSERT INTO "bk_accounts"
  ("code", "name", "kind", "subtype", "category_id", "report_group", "disallowable_percent", "position", "is_system")
SELECT 'pl-' || c."code", c."name",
       CASE WHEN c."direction" = 'income' THEN 'income' ELSE 'expense' END,
       'profit_and_loss', c."id", c."ct600_group",
       CASE WHEN c."code" = 'entertaining' THEN 100 ELSE 0 END,
       1000 + c."position", TRUE
FROM "bk_categories" c
WHERE c."code" IN ('entertaining', 'interest-received')
ON CONFLICT ("code") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Backfill: which report line each existing account prints on
-- ---------------------------------------------------------------------------
-- Profit and loss accounts inherit the grouping from the category they mirror,
-- which is where it has been all along. Only fills NULLs, so an owner who has
-- already moved an account somewhere keeps their answer.
UPDATE "bk_accounts" a
SET "report_group" = c."ct600_group", "updated_at" = NOW()
FROM "bk_categories" c
WHERE a."category_id" = c."id"
  AND a."subtype" = 'profit_and_loss'
  AND a."report_group" IS NULL
  AND c."ct600_group" IS NOT NULL;

-- Anything left without one falls back on what sort of account it is, so no
-- P&L account can silently vanish off the bottom of a report.
UPDATE "bk_accounts"
SET "report_group" = CASE WHEN "kind" = 'income' THEN 'other-income' ELSE 'admin-expenses' END,
    "updated_at" = NOW()
WHERE "kind" IN ('income', 'expense') AND "report_group" IS NULL;

-- Depreciation is added back in full in a tax computation - capital allowances
-- take its place - so the account says so rather than a rule saying so
-- somewhere in TypeScript.
UPDATE "bk_accounts" SET "disallowable_percent" = 100, "updated_at" = NOW()
WHERE "report_group" = 'depreciation' AND "disallowable_percent" = 0;

-- Balance sheet accounts, grouped by what they are. Same NULL-only rule.
UPDATE "bk_accounts"
SET "bs_group" = CASE "subtype"
      WHEN 'fixed_assets'  THEN 'fixed_assets'
      WHEN 'depreciation'  THEN 'fixed_assets'
      WHEN 'intangibles'   THEN 'intangible_assets'
      WHEN 'stock'         THEN 'current_assets_stock'
      WHEN 'debtors'       THEN 'current_assets_debtors'
      WHEN 'bank'          THEN 'current_assets_cash'
      WHEN 'cash'          THEN 'current_assets_cash'
      WHEN 'provisions'    THEN 'provisions'
      WHEN 'share_capital' THEN 'share_capital'
      WHEN 'reserves'      THEN 'reserves'
      ELSE CASE WHEN "kind" = 'asset'     THEN 'current_assets_debtors'
                WHEN "kind" = 'liability' THEN 'creditors_short'
                WHEN "kind" = 'equity'    THEN 'reserves'
                ELSE NULL END
    END,
    "updated_at" = NOW()
WHERE "kind" IN ('asset', 'liability', 'equity') AND "bs_group" IS NULL;

-- ---------------------------------------------------------------------------
-- Every category points at an account
-- ---------------------------------------------------------------------------
-- This is the mapping the projection turns on. A cashbook line coded to a
-- category with no account would post one side of an entry and not the other,
-- and a trial balance that does not balance is worse than no trial balance:
-- lib/ledger.ts refuses to report at all while one exists, and the health check
-- names the category.
--
-- The five below are the non-trading categories 006 skipped, on the grounds
-- that they already had a balance sheet account. True - they just were not
-- pointed at one.
UPDATE "bk_accounts" a SET "category_id" = c."id", "updated_at" = NOW()
FROM "bk_categories" c
WHERE a."category_id" IS NULL
  AND (
    -- Buying equipment adds to fixed assets. It is not a cost.
    (a."code" = 'fixed-assets'       AND c."code" = 'capital-equipment')
    -- Taking money out is a movement in equity.
 OR (a."code" = 'dividends-drawings' AND c."code" = 'drawings')
 OR (a."code" = 'capital-introduced' AND c."code" = 'capital-introduced')
    -- Paying HMRC settles the VAT account rather than costing anything.
 OR (a."code" = 'vat-control'        AND c."code" = 'vat-payment')
    -- Same for the corporation tax bill: the charge went through the P&L when
    -- the year was closed, and paying it settles the liability.
 OR (a."code" = 'corporation-tax'    AND c."code" = 'tax-payment')
  );

-- ---------------------------------------------------------------------------
-- Every bank account has a ledger account
-- ---------------------------------------------------------------------------
-- Created for the ones that already exist; lib/bank-accounts.ts creates them
-- from now on. The code carries a hash of the row id so two accounts a human
-- named "Current account" cannot collide and quietly leave the second one
-- without anywhere to post.
INSERT INTO "bk_accounts"
  ("code", "name", "kind", "subtype", "bs_group", "bank_account_id", "position", "is_system")
SELECT
  'bank-' || substr(regexp_replace(lower(b."name"), '[^a-z0-9]+', '-', 'g'), 1, 20)
          || '-' || substr(md5(b."id"), 1, 6),
  b."name",
  'asset',
  CASE WHEN b."kind" = 'cash' THEN 'cash' ELSE 'bank' END,
  'current_assets_cash',
  b."id",
  200 + b."position",
  TRUE
FROM "bk_bank_accounts" b
WHERE NOT EXISTS (
  SELECT 1 FROM "bk_accounts" a WHERE a."bank_account_id" = b."id"
)
ON CONFLICT ("code") DO NOTHING;

-- The seeded fallback. A transaction that names no bank account still has to
-- post its settlement somewhere, and this is where. Marked so the projection
-- can find it by code rather than by guessing at the first row it sees.
UPDATE "bk_accounts"
SET "bs_group" = 'current_assets_cash', "updated_at" = NOW()
WHERE "code" IN ('bank-current', 'cash-in-hand') AND "bs_group" IS DISTINCT FROM 'current_assets_cash';
