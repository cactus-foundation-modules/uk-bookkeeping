-- ===========================================================================
-- 006_accounts_and_journals.sql
--
-- Ledger accounts and journal entries: the double-entry half of the module.
--
-- What this is for. The records half of this module is a cashbook: an entry is
-- money in or money out, analysed to a category, with VAT on it. That is the
-- right shape for a VAT return and the wrong shape for three things a small
-- limited company genuinely needs - depreciation, an accrual or prepayment at
-- the year end, and a director's loan account. None of those is money moving,
-- so none of them is a transaction. They are journals: two or more sides that
-- add up to nothing.
--
-- What a journal deliberately does NOT do: touch a VAT box. Journal lines carry
-- no VAT and appear in no return, under either scheme. Anything with VAT on it
-- is a purchase or a sale and belongs in bk_transactions, where the box query
-- can see it. This is not a limitation to be lifted later; it is what keeps
-- "no box value is ever typed by a human" true. A journal that could reach box
-- 1 would be exactly such a figure.
-- ===========================================================================

-- --- Ledger accounts ---------------------------------------------------------
-- One list, covering both the profit and loss accounts (which mirror the
-- categories the cashbook already uses, so a journal to "Motor expenses" and a
-- receipt coded to "Motor expenses" land in the same place on a report) and the
-- balance sheet accounts the cashbook has no way to express.
CREATE TABLE IF NOT EXISTS "bk_accounts" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "code"          TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "kind"          TEXT NOT NULL,   -- asset | liability | equity | income | expense
  -- What sort of balance sheet account this is, where that matters to a screen
  -- or a rule. 'director_loan' is the one that earns its keep: it drives the
  -- director's loan screen and the overdrawn-at-year-end warning.
  "subtype"       TEXT NOT NULL DEFAULT 'other',
  -- P&L accounts point at the category they mirror, so reports can roll a
  -- journal and a receipt into one figure. NULL on balance sheet accounts.
  "category_id"   TEXT,
  -- Bank and card accounts point at the real account they represent.
  "bank_account_id" TEXT,
  -- Whose loan account this is. Only ever set on subtype = 'director_loan'.
  "person_name"   TEXT,
  "position"      INTEGER NOT NULL DEFAULT 0,
  "archived"      BOOLEAN NOT NULL DEFAULT FALSE,
  "is_system"     BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_accounts_code_key" UNIQUE ("code"),
  CONSTRAINT "bk_accounts_kind_chk"
    CHECK ("kind" IN ('asset', 'liability', 'equity', 'income', 'expense')),
  CONSTRAINT "bk_accounts_subtype_chk" CHECK ("subtype" IN (
    'other', 'bank', 'cash', 'director_loan', 'vat_control', 'debtors',
    'creditors', 'fixed_assets', 'depreciation', 'share_capital', 'reserves',
    'suspense', 'profit_and_loss'
  )),
  CONSTRAINT "bk_accounts_category_fkey"
    FOREIGN KEY ("category_id") REFERENCES "bk_categories"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_accounts_bank_fkey"
    FOREIGN KEY ("bank_account_id") REFERENCES "bk_bank_accounts"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_accounts_kind_idx" ON "bk_accounts" ("kind", "position");
CREATE INDEX IF NOT EXISTS "bk_accounts_subtype_idx" ON "bk_accounts" ("subtype");
CREATE INDEX IF NOT EXISTS "bk_accounts_category_idx" ON "bk_accounts" ("category_id");

-- --- Journals ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bk_journals" (
  "id"                    TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "date"                  DATE NOT NULL,
  "reference"             TEXT,
  -- Mandatory, and the constraint says so. A journal nobody explained is a
  -- mystery the moment the person who posted it forgets, and an accountant
  -- looking at these in eighteen months has no other way in.
  "narrative"             TEXT NOT NULL,
  "status"                TEXT NOT NULL DEFAULT 'draft',   -- draft | posted
  "source"                TEXT NOT NULL DEFAULT 'manual',  -- manual | template | import
  -- A journal that undoes another one, which is how an accrual at the year end
  -- gets taken back out on the first day of the next.
  "reverses_journal_id"   TEXT,
  "reversed_by_journal_id" TEXT,
  -- The same two freeze columns the cashbook carries, and deliberately NOT set
  -- by filing a VAT return.
  --
  -- A journal reaches no VAT box, so filing a return says nothing about it - and
  -- locking journals on filing would break the ordinary run of things, because
  -- depreciation and year-end accruals are dated at the year end and posted
  -- months afterwards, by which time the VAT quarter they fall in has long since
  -- been filed. Refusing those would be refusing the main thing journals are for.
  --
  -- The columns and their guards (007_journal_immutability.sql) exist so that a
  -- closed accounting year, when there is one, has somewhere to bite. Nothing
  -- sets them today.
  "finalised_period_id"   TEXT,
  "locked_period_id"      TEXT,
  "locked_at"             TIMESTAMPTZ,
  "created_by_user_id"    TEXT,
  "updated_by_user_id"    TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_journals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_journals_status_chk" CHECK ("status" IN ('draft', 'posted')),
  CONSTRAINT "bk_journals_narrative_chk" CHECK (length(btrim("narrative")) > 0),
  CONSTRAINT "bk_journals_reverses_fkey"
    FOREIGN KEY ("reverses_journal_id") REFERENCES "bk_journals"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_journals_reversed_by_fkey"
    FOREIGN KEY ("reversed_by_journal_id") REFERENCES "bk_journals"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_journals_locked_period_fkey"
    FOREIGN KEY ("locked_period_id") REFERENCES "bk_vat_periods"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_journals_finalised_period_fkey"
    FOREIGN KEY ("finalised_period_id") REFERENCES "bk_vat_periods"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_journals_date_idx" ON "bk_journals" ("date");
CREATE INDEX IF NOT EXISTS "bk_journals_status_idx" ON "bk_journals" ("status");
CREATE INDEX IF NOT EXISTS "bk_journals_locked_idx" ON "bk_journals" ("locked_period_id");

-- --- Journal lines -----------------------------------------------------------
-- Debit and credit as two columns rather than one signed one, because that is
-- how a journal is read, entered, and checked by anybody who has ever seen one,
-- and because "which side is a negative credit on" is a question worth never
-- having to answer.
CREATE TABLE IF NOT EXISTS "bk_journal_lines" (
  "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "journal_id"        TEXT NOT NULL,
  "position"          INTEGER NOT NULL DEFAULT 0,
  "account_id"        TEXT NOT NULL,
  "description"       TEXT NOT NULL DEFAULT '',
  "debit"             NUMERIC(10,2) NOT NULL DEFAULT 0,
  "credit"            NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- Denormalised copy of the parent's hard lock, so the guard trigger on this
  -- table never has to read the parent. That is what keeps it restore-safe: a
  -- restored line arrives carrying its own lock and passes on its own.
  "locked_period_id"  TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_journal_lines_pkey" PRIMARY KEY ("id"),
  -- One side or the other, never both, never neither, never negative. A negative
  -- debit is a credit written by somebody in a hurry, and allowing it would mean
  -- every later sum had to cope with two ways of saying the same thing.
  CONSTRAINT "bk_journal_lines_sides_chk" CHECK (
    "debit" >= 0 AND "credit" >= 0
    AND ("debit" = 0 OR "credit" = 0)
    AND ("debit" + "credit") > 0
  ),
  CONSTRAINT "bk_journal_lines_journal_fkey"
    FOREIGN KEY ("journal_id") REFERENCES "bk_journals"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_journal_lines_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "bk_accounts"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_journal_lines_journal_idx"
  ON "bk_journal_lines" ("journal_id");
CREATE INDEX IF NOT EXISTS "bk_journal_lines_account_idx"
  ON "bk_journal_lines" ("account_id");

-- ---------------------------------------------------------------------------
-- Seed: the balance sheet accounts, and one P&L account per existing category
-- ---------------------------------------------------------------------------

-- Balance sheet and control accounts. Codes are stable identities; names are the
-- owner's to rename.
INSERT INTO "bk_accounts" ("code", "name", "kind", "subtype", "position", "is_system")
VALUES
  ('bank-current',      'Bank current account',            'asset',     'bank',          10,  TRUE),
  ('cash-in-hand',      'Cash in hand',                    'asset',     'cash',          20,  TRUE),
  ('debtors',           'Money owed to the business',      'asset',     'debtors',       30,  TRUE),
  ('prepayments',       'Prepayments',                     'asset',     'other',         40,  TRUE),
  ('fixed-assets',      'Equipment and fixed assets',      'asset',     'fixed_assets',  50,  TRUE),
  ('accumulated-depreciation',
                        'Depreciation to date',            'asset',     'depreciation',  60,  TRUE),
  ('creditors',         'Money the business owes',         'liability', 'creditors',     70,  TRUE),
  ('accruals',          'Accruals',                        'liability', 'other',         80,  TRUE),
  ('vat-control',       'VAT owed to or from HMRC',        'liability', 'vat_control',   90,  TRUE),
  ('paye-control',      'PAYE and National Insurance owed','liability', 'other',        100,  TRUE),
  ('corporation-tax',   'Corporation tax owed',            'liability', 'other',        110,  TRUE),
  ('directors-loan',    'Director''s loan account',        'liability', 'director_loan',120,  TRUE),
  ('share-capital',     'Share capital',                   'equity',    'share_capital',130,  TRUE),
  ('retained-earnings', 'Retained profit',                 'equity',    'reserves',     140,  TRUE),
  ('suspense',          'Suspense',                        'asset',     'suspense',     900,  TRUE)
ON CONFLICT ("code") DO NOTHING;

-- One P&L account per category, mirroring it. `pl-` prefixed so a category coded
-- 'sales' and the account that mirrors it never collide, and so it is obvious in
-- a list which accounts came from the categories.
--
-- Categories that are not profit and loss items (drawings, capital introduced,
-- VAT and tax payments, capital equipment) are skipped: they already have a
-- balance sheet account above that is the right place for them, and giving them
-- a P&L account too would mean two plausible answers to one question.
INSERT INTO "bk_accounts" ("code", "name", "kind", "subtype", "category_id", "position", "is_system")
SELECT
  'pl-' || c."code",
  c."name",
  CASE WHEN c."direction" = 'income' THEN 'income' ELSE 'expense' END,
  'profit_and_loss',
  c."id",
  1000 + c."position",
  TRUE
FROM "bk_categories" c
WHERE c."is_trading" = TRUE
ON CONFLICT ("code") DO NOTHING;

-- The director's loan category, so money moving between the company and the
-- director on a bank statement can be coded in the cashbook and land on the same
-- loan account a journal would reach. Without it the only way to record a top-up
-- is a journal, and a bank statement line is not a journal.
INSERT INTO "bk_categories"
  ("code", "name", "direction", "sa103_box", "ct600_group", "is_trading", "is_capital", "position", "is_system")
VALUES
  ('directors-loan', 'Director''s loan account', 'both', NULL, 'directors-loan', FALSE, FALSE, 195, TRUE)
ON CONFLICT ("code") DO NOTHING;

-- Point the loan account at that category, so both routes to it agree.
UPDATE "bk_accounts" a
SET "category_id" = c."id", "updated_at" = NOW()
FROM "bk_categories" c
WHERE a."code" = 'directors-loan'
  AND c."code" = 'directors-loan'
  AND a."category_id" IS DISTINCT FROM c."id";
