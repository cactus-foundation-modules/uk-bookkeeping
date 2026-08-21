-- ===========================================================================
-- 011_fixed_assets.sql
--
-- The fixed asset register, which does two jobs that look like one.
--
-- For the ACCOUNTS, an asset has to be depreciated: spread over the years it is
-- useful for, so the profit and loss account for one year is not wrecked by a
-- van bought in it. Straight line or reducing balance, the owner's choice, and
-- the charge is posted as an ordinary journal so it shows up everywhere every
-- other journal does.
--
-- For the TAX, depreciation is ignored entirely - added back in full - and
-- capital allowances are given instead, on HMRC's rules rather than the
-- owner's. That is not the module being fussy; it is the single biggest reason
-- a company's taxable profit is not the same number as its accounting profit,
-- and a computation that misses it is wrong by the cost of every asset the
-- business has ever bought.
--
-- One row serves both, because it is one asset. `depreciation_method` and its
-- rate answer the accounts; `ca_pool` answers the tax. Getting them from the
-- same row is what stops the two drifting apart, which is the classic failure
-- of keeping a spreadsheet next to a bookkeeping package.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "bk_fixed_assets" (
  "id"                      TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "description"             TEXT NOT NULL,
  "reference"               TEXT,
  "acquired_date"           DATE NOT NULL,
  -- What it cost, net of any VAT that was reclaimed. NUMERIC(12,2) rather than
  -- the (10,2) money uses elsewhere: a single asset can reasonably cost more
  -- than the £99,999,999.99 a ten-digit column tops out at, and a premises
  -- purchase should not need a schema change.
  "cost"                    NUMERIC(12,2) NOT NULL,
  -- The purchase it came from, when it came from one. Optional, because an
  -- asset the business already owned on the day it started using this module
  -- has no purchase here to point at.
  "transaction_id"          TEXT,

  -- Where it sits in the ledger. Three accounts, because depreciation touches
  -- three: the cost stays put, the accumulated depreciation grows against it,
  -- and the charge goes through the profit and loss account.
  "asset_account_id"        TEXT NOT NULL,
  "depreciation_account_id" TEXT NOT NULL,
  "expense_account_id"      TEXT NOT NULL,

  -- --- For the accounts -----------------------------------------------------
  "depreciation_method"     TEXT NOT NULL DEFAULT 'straight_line',
  -- Percent per year. 25 on straight line means four years; 25 on reducing
  -- balance means a quarter of what is left each year, which never quite
  -- reaches zero and is not meant to.
  "depreciation_rate"       NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- What it is reckoned to be worth at the end. Straight line depreciates cost
  -- minus this; reducing balance stops here.
  "residual_value"          NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- --- For the tax ----------------------------------------------------------
  -- Which capital allowances pool the spend goes in:
  --   aia            - annual investment allowance, 100% up to the annual cap
  --   full_expensing - 100% first year allowance, new main-rate plant, companies
  --   fya_special    - 50% first year allowance, new special rate plant; the
  --                    other half goes to the special rate pool
  --   main           - main pool, written down at 18% a year
  --   special        - special rate pool (integral features, long-life assets,
  --                    most cars), written down at 6% a year
  --   none           - no allowances at all, e.g. a building with no structures
  --                    and buildings allowance claim
  "ca_pool"                 TEXT NOT NULL DEFAULT 'aia',

  -- --- Disposal -------------------------------------------------------------
  "disposed_date"           DATE,
  "disposal_proceeds"       NUMERIC(12,2),
  "disposal_transaction_id" TEXT,

  "notes"                   TEXT,
  "archived"                BOOLEAN NOT NULL DEFAULT FALSE,
  "created_by_user_id"      TEXT,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "bk_fixed_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_fixed_assets_cost_chk" CHECK ("cost" >= 0),
  CONSTRAINT "bk_fixed_assets_residual_chk"
    CHECK ("residual_value" >= 0 AND "residual_value" <= "cost"),
  CONSTRAINT "bk_fixed_assets_rate_chk"
    CHECK ("depreciation_rate" >= 0 AND "depreciation_rate" <= 100),
  CONSTRAINT "bk_fixed_assets_method_chk"
    CHECK ("depreciation_method" IN ('straight_line', 'reducing_balance', 'none')),
  CONSTRAINT "bk_fixed_assets_pool_chk"
    CHECK ("ca_pool" IN ('aia', 'full_expensing', 'fya_special', 'main', 'special', 'none')),
  -- Sold on a date, or not sold. "Sold for £400" with no date is a figure with
  -- no year to belong to, and a capital allowances pool is worked out by year.
  CONSTRAINT "bk_fixed_assets_disposal_chk" CHECK (
    ("disposed_date" IS NULL AND "disposal_proceeds" IS NULL)
    OR ("disposed_date" IS NOT NULL AND "disposal_proceeds" IS NOT NULL)
  ),
  CONSTRAINT "bk_fixed_assets_disposal_order_chk"
    CHECK ("disposed_date" IS NULL OR "disposed_date" >= "acquired_date"),
  CONSTRAINT "bk_fixed_assets_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "bk_transactions"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_fixed_assets_disposal_transaction_fkey"
    FOREIGN KEY ("disposal_transaction_id") REFERENCES "bk_transactions"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_fixed_assets_asset_account_fkey"
    FOREIGN KEY ("asset_account_id") REFERENCES "bk_accounts"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_fixed_assets_depreciation_account_fkey"
    FOREIGN KEY ("depreciation_account_id") REFERENCES "bk_accounts"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_fixed_assets_expense_account_fkey"
    FOREIGN KEY ("expense_account_id") REFERENCES "bk_accounts"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_fixed_assets_acquired_idx"
  ON "bk_fixed_assets" ("acquired_date");
CREATE INDEX IF NOT EXISTS "bk_fixed_assets_disposed_idx"
  ON "bk_fixed_assets" ("disposed_date");
CREATE INDEX IF NOT EXISTS "bk_fixed_assets_pool_idx"
  ON "bk_fixed_assets" ("ca_pool");
CREATE INDEX IF NOT EXISTS "bk_fixed_assets_transaction_idx"
  ON "bk_fixed_assets" ("transaction_id");

-- ---------------------------------------------------------------------------
-- What has already been charged
-- ---------------------------------------------------------------------------
-- Without this, running depreciation twice for the same year charges it twice,
-- and a reducing balance calculation has no way of knowing what the balance has
-- been reduced to. One row per asset per run.
CREATE TABLE IF NOT EXISTS "bk_depreciation_charges" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "asset_id"      TEXT NOT NULL,
  "period_start"  DATE NOT NULL,
  "period_end"    DATE NOT NULL,
  "amount"        NUMERIC(12,2) NOT NULL,
  -- The journal that posted it. Removing the journal removes the charge, so
  -- that undoing a depreciation run puts the register back where it was rather
  -- than leaving it believing in a charge that is no longer in the books.
  "journal_id"    TEXT NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_depreciation_charges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_depreciation_charges_amount_chk" CHECK ("amount" >= 0),
  CONSTRAINT "bk_depreciation_charges_dates_chk" CHECK ("period_end" >= "period_start"),
  CONSTRAINT "bk_depreciation_charges_asset_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "bk_fixed_assets"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_depreciation_charges_journal_fkey"
    FOREIGN KEY ("journal_id") REFERENCES "bk_journals"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
-- One charge per asset per period. A second run for the same dates is a
-- mistake, not a top-up.
CREATE UNIQUE INDEX IF NOT EXISTS "bk_depreciation_charges_asset_period_key"
  ON "bk_depreciation_charges" ("asset_id", "period_start", "period_end");
CREATE INDEX IF NOT EXISTS "bk_depreciation_charges_journal_idx"
  ON "bk_depreciation_charges" ("journal_id");
