-- ===========================================================================
-- 012_corporation_tax.sql
--
-- Working out what a company owes, and where each figure goes on the CT600.
--
-- The rule this file exists to keep is the same one the VAT half of the module
-- keeps: no figure that HMRC will be told is ever typed by a human. The
-- computation is a function of the ledger, the fixed asset register, the rates
-- table and a list of named adjustments, and every one of those is a record you
-- can go and look at. What the owner types is a judgement ("£340 of that was
-- entertaining"), never an answer.
--
-- Three tables:
--
--   bk_ct_rates        - what the rates and limits were, by financial year.
--                        Data, not code, because they change most years and a
--                        rate change should be an edit rather than a release.
--   bk_ct_computations - one per accounting period, with its frozen workings.
--   bk_ct_adjustments  - the named things that make taxable profit differ from
--                        accounting profit, each with a reason attached.
--
-- This module does NOT file a CT600. There is no HMRC API for a small company
-- to self-file corporation tax the way there is for VAT - filing goes through
-- HMRC's own online service or commercial software - so what this produces is
-- the computation and the box numbers to copy into it. That is the honest
-- limit of it, and the screen says so rather than implying otherwise.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Rates, by financial year
-- ---------------------------------------------------------------------------
-- A financial year for corporation tax runs 1 April to 31 March and is named
-- after the year it STARTS in: "FY2025" is 1 April 2025 to 31 March 2026. An
-- accounting period that straddles 1 April therefore falls in two of them and
-- is apportioned by days across both, which is why this is a table keyed by
-- year and not four columns on the settings row.
CREATE TABLE IF NOT EXISTS "bk_ct_rates" (
  "financial_year"        INTEGER NOT NULL,
  -- Percentages, not fractions: 25.0000 means 25%. Four decimal places because
  -- the marginal relief fraction produces effective rates that need them.
  "main_rate"             NUMERIC(7,4) NOT NULL,
  -- NULL in the years there was only one rate (FY2015 to FY2022).
  "small_profits_rate"    NUMERIC(7,4),
  "lower_limit"           NUMERIC(14,2),
  "upper_limit"           NUMERIC(14,2),
  -- The marginal relief standard fraction, as a fraction rather than a rounded
  -- decimal. 3/200 is exact; 0.015 is what somebody types when they are in a
  -- hurry and it is not the same thing once it is multiplied by a large number.
  "mr_numerator"          INTEGER,
  "mr_denominator"        INTEGER,
  -- Capital allowances, held here for the same reason: they move.
  "aia_limit"             NUMERIC(14,2) NOT NULL DEFAULT 1000000.00,
  "main_pool_wda"         NUMERIC(7,4) NOT NULL DEFAULT 18.0000,
  "special_pool_wda"      NUMERIC(7,4) NOT NULL DEFAULT 6.0000,
  -- Write a pool off entirely once it drops below this. £1,000, pro-rated for
  -- a short period, and it exists so nobody spends thirty years writing down
  -- the last four pounds of a filing cabinet.
  "small_pool_limit"      NUMERIC(14,2) NOT NULL DEFAULT 1000.00,
  -- 100% first year allowance on new main-rate plant, companies only, from
  -- 1 April 2023. NULL in the years it did not exist.
  "full_expensing_rate"   NUMERIC(7,4),
  -- The 50% first year allowance on new special rate plant, same dates.
  "fya_special_rate"      NUMERIC(7,4),
  "notes"                 TEXT,
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_ct_rates_pkey" PRIMARY KEY ("financial_year"),
  -- Both halves of the fraction or neither. Half a fraction divides by null.
  CONSTRAINT "bk_ct_rates_fraction_chk" CHECK (
    ("mr_numerator" IS NULL AND "mr_denominator" IS NULL)
    OR ("mr_numerator" IS NOT NULL AND "mr_denominator" IS NOT NULL AND "mr_denominator" > 0)
  ),
  -- Marginal relief needs both limits and the small rate to mean anything.
  CONSTRAINT "bk_ct_rates_limits_chk" CHECK (
    ("small_profits_rate" IS NULL AND "lower_limit" IS NULL AND "upper_limit" IS NULL)
    OR ("small_profits_rate" IS NOT NULL AND "lower_limit" IS NOT NULL
        AND "upper_limit" IS NOT NULL AND "upper_limit" > "lower_limit")
  )
);

-- Seeded from HMRC's published rates, checked 2026-08-21. Editable, because the
-- alternative is a module release every March.
INSERT INTO "bk_ct_rates" ("financial_year", "main_rate", "small_profits_rate",
  "lower_limit", "upper_limit", "mr_numerator", "mr_denominator",
  "aia_limit", "main_pool_wda", "special_pool_wda", "full_expensing_rate",
  "fya_special_rate", "notes")
VALUES
  -- One rate for everybody, FY2015 to FY2022. The small profits rate and
  -- marginal relief were abolished from 1 April 2015 and brought back from
  -- 1 April 2023.
  (2015, 20.0000, NULL, NULL, NULL, NULL, NULL,  200000.00, 18.0000, 8.0000, NULL, NULL,
   'Single rate. AIA was £500,000 to 31 December 2015; £200,000 shown here as the year''s ordinary figure.'),
  (2016, 20.0000, NULL, NULL, NULL, NULL, NULL,  200000.00, 18.0000, 8.0000, NULL, NULL, 'Single rate.'),
  (2017, 19.0000, NULL, NULL, NULL, NULL, NULL,  200000.00, 18.0000, 8.0000, NULL, NULL, 'Single rate.'),
  (2018, 19.0000, NULL, NULL, NULL, NULL, NULL,  200000.00, 18.0000, 8.0000, NULL, NULL,
   'Single rate. AIA rose to £1,000,000 from 1 January 2019.'),
  (2019, 19.0000, NULL, NULL, NULL, NULL, NULL, 1000000.00, 18.0000, 6.0000, NULL, NULL,
   'Single rate. Special rate pool fell to 6% from April 2019.'),
  (2020, 19.0000, NULL, NULL, NULL, NULL, NULL, 1000000.00, 18.0000, 6.0000, NULL, NULL, 'Single rate.'),
  (2021, 19.0000, NULL, NULL, NULL, NULL, NULL, 1000000.00, 18.0000, 6.0000, NULL, NULL,
   'Single rate. The 130% super-deduction ran 1 April 2021 to 31 March 2023 and is not modelled; claim it as a manual adjustment.'),
  (2022, 19.0000, NULL, NULL, NULL, NULL, NULL, 1000000.00, 18.0000, 6.0000, NULL, NULL, 'Single rate.'),
  -- Two rates and marginal relief again from 1 April 2023, and full expensing
  -- alongside them.
  (2023, 25.0000, 19.0000, 50000.00, 250000.00, 3, 200, 1000000.00, 18.0000, 6.0000, 100.0000, 50.0000,
   'Small profits rate and marginal relief reintroduced. Full expensing from 1 April 2023.'),
  (2024, 25.0000, 19.0000, 50000.00, 250000.00, 3, 200, 1000000.00, 18.0000, 6.0000, 100.0000, 50.0000, NULL),
  (2025, 25.0000, 19.0000, 50000.00, 250000.00, 3, 200, 1000000.00, 18.0000, 6.0000, 100.0000, 50.0000, NULL),
  (2026, 25.0000, 19.0000, 50000.00, 250000.00, 3, 200, 1000000.00, 18.0000, 6.0000, 100.0000, 50.0000, NULL)
ON CONFLICT ("financial_year") DO NOTHING;

-- ---------------------------------------------------------------------------
-- The computation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bk_ct_computations" (
  "id"                      TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "accounting_period_id"    TEXT NOT NULL,
  -- Copied off the accounting period rather than joined to it, because a
  -- corporation tax accounting period is capped at twelve months and a long
  -- period of account therefore splits into two computations with two sets of
  -- dates that are NOT the year's dates.
  "start_date"              DATE NOT NULL,
  "end_date"                DATE NOT NULL,
  "status"                  TEXT NOT NULL DEFAULT 'draft',   -- draft | final

  -- --- What the owner tells it ---------------------------------------------
  -- Associated companies divide the £50,000 and £250,000 limits between them,
  -- so a one-man company that also owns a dormant one pays marginal relief
  -- rates from £25,000 rather than £50,000. Getting this wrong is the single
  -- most common way a small company's corporation tax comes out wrong.
  "associated_companies"    INTEGER NOT NULL DEFAULT 0,
  -- Pool balances carried in. Defaulted from the previous period's carried
  -- out figures; typed once, by hand, on the first computation a business ever
  -- does, because before that the books were somewhere else.
  "main_pool_bf"            NUMERIC(14,2) NOT NULL DEFAULT 0,
  "special_pool_bf"         NUMERIC(14,2) NOT NULL DEFAULT 0,
  "losses_bf"               NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Whether to claim the allowances that are optional. They are: a company may
  -- disclaim, and sometimes should, to keep a loss for a year the rate is
  -- higher.
  "claim_aia"               BOOLEAN NOT NULL DEFAULT TRUE,
  "claim_full_expensing"    BOOLEAN NOT NULL DEFAULT TRUE,

  -- --- What it works out ----------------------------------------------------
  -- The whole workings, as computed, as JSON. Frozen on finalise so the answer
  -- can be reproduced years later without the live tables having to still agree
  -- with themselves - the same reason bk_period_snapshots exists for VAT.
  "computation"             JSONB,
  -- The CT600 boxes, as decimal STRINGS, keyed by box number. Never JSON
  -- numbers: a float is not a thing to send a tax authority.
  "boxes"                   JSONB,
  "tax_due"                 NUMERIC(14,2),
  -- Carried out, for the next period to carry in.
  "main_pool_cf"            NUMERIC(14,2),
  "special_pool_cf"         NUMERIC(14,2),
  "losses_cf"               NUMERIC(14,2),

  "finalised_at"            TIMESTAMPTZ,
  "finalised_by_user_id"    TEXT,
  "created_by_user_id"      TEXT,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "bk_ct_computations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_ct_computations_status_chk" CHECK ("status" IN ('draft', 'final')),
  CONSTRAINT "bk_ct_computations_dates_chk" CHECK ("end_date" >= "start_date"),
  CONSTRAINT "bk_ct_computations_associated_chk" CHECK ("associated_companies" >= 0),
  CONSTRAINT "bk_ct_computations_period_fkey"
    FOREIGN KEY ("accounting_period_id") REFERENCES "bk_accounting_periods"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  -- One computation per set of dates. A long period splits into two, and they
  -- have different dates, so this still allows it.
  CONSTRAINT "bk_ct_computations_range_key" UNIQUE ("start_date", "end_date")
);
CREATE INDEX IF NOT EXISTS "bk_ct_computations_period_idx"
  ON "bk_ct_computations" ("accounting_period_id");
CREATE INDEX IF NOT EXISTS "bk_ct_computations_status_idx"
  ON "bk_ct_computations" ("status");

-- ---------------------------------------------------------------------------
-- The adjustments
-- ---------------------------------------------------------------------------
-- Everything that makes taxable profit differ from the profit in the accounts,
-- other than the parts the module works out for itself (the disallowable
-- percentage on an account, and the capital allowances from the register).
--
-- Each carries a label and a note, and both are shown on the computation. A
-- figure with no explanation is exactly what an enquiry asks about.
CREATE TABLE IF NOT EXISTS "bk_ct_adjustments" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "computation_id"  TEXT NOT NULL,
  "position"        INTEGER NOT NULL DEFAULT 0,
  "kind"            TEXT NOT NULL,
  "label"           TEXT NOT NULL,
  -- Always entered positive. Which way it pulls is decided by `kind`, not by a
  -- minus sign a human may or may not have typed - the same reasoning as
  -- debit and credit being two columns rather than one signed one.
  "amount"          NUMERIC(14,2) NOT NULL,
  "note"            TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_ct_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_ct_adjustments_amount_chk" CHECK ("amount" >= 0),
  CONSTRAINT "bk_ct_adjustments_label_chk" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "bk_ct_adjustments_kind_chk" CHECK ("kind" IN (
    'add_back',                  -- disallowable cost, added back to profit
    'deduction',                 -- allowable deduction not in the accounts
    'capital_allowance',         -- a claim on top of what the register works out
    'balancing_charge',          -- likewise, in the other direction
    'non_trade_income',          -- CT600 box 170
    'property_income',           -- CT600 box 190
    'other_income',              -- CT600 box 205
    'chargeable_gain',           -- CT600 boxes 210 and 220
    'loss_bf',                   -- trading losses brought forward used, box 160
    'loss_cy',                   -- this period's loss against total profits, box 275
    'group_relief',              -- CT600 box 310
    'qualifying_donations',      -- CT600 box 305
    'management_expenses',       -- CT600 box 245
    'franked_investment_income'  -- box 620; raises augmented profits for the rate
  )),
  CONSTRAINT "bk_ct_adjustments_computation_fkey"
    FOREIGN KEY ("computation_id") REFERENCES "bk_ct_computations"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_ct_adjustments_computation_idx"
  ON "bk_ct_adjustments" ("computation_id", "position");
