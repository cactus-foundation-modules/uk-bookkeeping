-- ===========================================================================
-- 005_bank_statements.sql
--
-- Bank accounts, imported statements, the statement lines themselves, and the
-- link between a statement line and the bookkeeping entries that explain it.
--
-- Why the statement lines are records in their own right, rather than being
-- turned straight into drafts and thrown away: reconciliation. "Does what the
-- bank says match what the books say" is a question you can only answer if the
-- bank's own version is still there to compare against. Keeping the lines also
-- means a second import of an overlapping range recognises what it has already
-- seen instead of quietly creating January twice.
--
-- Every foreign key here is DEFERRABLE INITIALLY DEFERRED. lib/backup/restore.ts
-- truncates and re-inserts table by table inside one transaction, so a forward
-- reference is routinely unsatisfied halfway through; deferring the check to
-- COMMIT makes insert order irrelevant.
-- ===========================================================================

-- --- Bank accounts -----------------------------------------------------------
-- One row per real account the business has: a current account, a card, petty
-- cash. Statements are imported against one of these, and a statement line
-- belongs to exactly one.
CREATE TABLE IF NOT EXISTS "bk_bank_accounts" (
  "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "name"              TEXT NOT NULL,
  "kind"              TEXT NOT NULL DEFAULT 'bank',   -- bank | card | cash
  "bank_name"         TEXT,
  -- Only ever the last four digits and the sort code, which is what a statement
  -- prints and what a human needs to tell two accounts apart. A full account
  -- number buys nothing here and is one more thing to leak.
  "account_last4"     TEXT,
  "sort_code"         TEXT,
  -- What the account held before the books start. The reconciliation arithmetic
  -- needs somewhere to begin.
  "opening_balance"   NUMERIC(10,2) NOT NULL DEFAULT 0,
  "opening_date"      DATE,
  "archived"          BOOLEAN NOT NULL DEFAULT FALSE,
  "position"          INTEGER NOT NULL DEFAULT 0,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_bank_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_bank_accounts_kind_chk" CHECK ("kind" IN ('bank', 'card', 'cash'))
);

-- --- Imported statements -----------------------------------------------------
-- One row per file brought in. Holds the figures the statement itself declares
-- (opening and closing balance, total in, total out) so the import can be
-- checked against its own arithmetic rather than trusted.
CREATE TABLE IF NOT EXISTS "bk_bank_statements" (
  "id"                  TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "bank_account_id"     TEXT NOT NULL,
  "filename"            TEXT NOT NULL,
  "format"              TEXT NOT NULL DEFAULT 'csv',   -- csv | pdf
  "preset"              TEXT,
  "period_start"        DATE,
  "period_end"          DATE,
  "opening_balance"     NUMERIC(10,2),
  "closing_balance"     NUMERIC(10,2),
  "total_paid_in"       NUMERIC(10,2),
  "total_paid_out"      NUMERIC(10,2),
  "row_count"           INTEGER NOT NULL DEFAULT 0,
  "imported_count"      INTEGER NOT NULL DEFAULT 0,
  "duplicate_count"     INTEGER NOT NULL DEFAULT 0,
  -- What the parser made of the file. Kept so a wrong reading can be explained
  -- six months later without the file to hand.
  "mapping"             JSONB,
  "created_by_user_id"  TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_bank_statements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_bank_statements_format_chk" CHECK ("format" IN ('csv', 'pdf')),
  CONSTRAINT "bk_bank_statements_account_fkey"
    FOREIGN KEY ("bank_account_id") REFERENCES "bk_bank_accounts"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_bank_statements_account_idx"
  ON "bk_bank_statements" ("bank_account_id", "period_start");

-- --- Statement lines ---------------------------------------------------------
-- The bank's own version of events, stored as it was read. `amount` is signed:
-- positive is money in, negative is money out, which is one column to reason
-- about instead of two that can both be filled in.
CREATE TABLE IF NOT EXISTS "bk_bank_transactions" (
  "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "bank_account_id"   TEXT NOT NULL,
  "statement_id"      TEXT,
  "date"              DATE NOT NULL,
  -- Everything the statement printed for this line, wrapped lines and all.
  "details"           TEXT NOT NULL DEFAULT '',
  -- Our best reading of who it was with, and any reference the line carried.
  "counterparty"      TEXT NOT NULL DEFAULT '',
  "reference"         TEXT,
  "transaction_type"  TEXT,                        -- 'Card Transaction', 'Domestic Transfer', …
  "amount"            NUMERIC(10,2) NOT NULL,
  -- The running balance the statement printed, where it printed one. Used to
  -- check the import read the columns the right way round, and nothing else.
  "statement_balance" NUMERIC(10,2),
  -- Stable identity for a statement line, so re-importing an overlapping range
  -- recognises what it already has. Account, date, amount, and a normalised
  -- form of the details - see lib/bank-transactions.ts, which is the only place
  -- allowed to compute one.
  "fingerprint"       TEXT NOT NULL,
  -- unreconciled: nothing in the books explains it yet.
  -- reconciled:   matched entries account for the whole amount.
  -- ignored:      deliberately set aside (an internal transfer, a duplicate the
  --               bank itself printed twice), with a reason.
  "status"            TEXT NOT NULL DEFAULT 'unreconciled',
  "ignored_reason"    TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_bank_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_bank_transactions_status_chk"
    CHECK ("status" IN ('unreconciled', 'reconciled', 'ignored')),
  CONSTRAINT "bk_bank_transactions_amount_chk" CHECK ("amount" <> 0),
  CONSTRAINT "bk_bank_transactions_account_fkey"
    FOREIGN KEY ("bank_account_id") REFERENCES "bk_bank_accounts"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_bank_transactions_statement_fkey"
    FOREIGN KEY ("statement_id") REFERENCES "bk_bank_statements"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_bank_transactions_account_date_idx"
  ON "bk_bank_transactions" ("bank_account_id", "date");
CREATE INDEX IF NOT EXISTS "bk_bank_transactions_status_idx"
  ON "bk_bank_transactions" ("status");
-- The duplicate guard. Scoped to the account, because two accounts genuinely can
-- carry the same payment on the same day for the same amount.
CREATE UNIQUE INDEX IF NOT EXISTS "bk_bank_transactions_fingerprint_key"
  ON "bk_bank_transactions" ("bank_account_id", "fingerprint");

-- --- Reconciliation links ----------------------------------------------------
-- Many-to-many on purpose. One statement line can settle several entries (a card
-- payment covering two invoices), and one entry can be settled by several
-- statement lines (a deposit and then the balance). `amount` says how much of
-- the entry this particular line accounts for, so both directions add up.
CREATE TABLE IF NOT EXISTS "bk_reconciliations" (
  "id"                    TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "bank_transaction_id"   TEXT NOT NULL,
  "transaction_id"        TEXT NOT NULL,
  "amount"                NUMERIC(10,2) NOT NULL,
  -- manual: a human picked it. suggested: the matcher proposed it and a human
  -- accepted it. Kept apart so "how much of this was done by the machine" is a
  -- question the audit log can answer.
  "match_method"          TEXT NOT NULL DEFAULT 'manual',
  "created_by_user_id"    TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_reconciliations_method_chk"
    CHECK ("match_method" IN ('manual', 'suggested', 'import')),
  CONSTRAINT "bk_reconciliations_bank_fkey"
    FOREIGN KEY ("bank_transaction_id") REFERENCES "bk_bank_transactions"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_reconciliations_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "bk_transactions"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS "bk_reconciliations_pair_key"
  ON "bk_reconciliations" ("bank_transaction_id", "transaction_id");
CREATE INDEX IF NOT EXISTS "bk_reconciliations_transaction_idx"
  ON "bk_reconciliations" ("transaction_id");

-- --- Wiring the existing tables in -------------------------------------------
-- Which account an entry was paid from or into. Nullable, because an entry
-- recorded before its statement arrives does not know yet, and because an entry
-- settled in cash may never have one.
ALTER TABLE "bk_transactions"
  ADD COLUMN IF NOT EXISTS "bank_account_id" TEXT;
ALTER TABLE "bk_transactions"
  ADD COLUMN IF NOT EXISTS "statement_id" TEXT;
CREATE INDEX IF NOT EXISTS "bk_transactions_bank_account_idx"
  ON "bk_transactions" ("bank_account_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bk_transactions_bank_account_fkey'
  ) THEN
    ALTER TABLE "bk_transactions"
      ADD CONSTRAINT "bk_transactions_bank_account_fkey"
      FOREIGN KEY ("bank_account_id") REFERENCES "bk_bank_accounts"("id")
      ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

-- --- The accounting year, for the director's loan year-end position ----------
-- Month and day only. A year end is "31 March", not a particular 31 March, and
-- storing a full date would mean rewriting it every April.
ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "year_end_month" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "year_end_day" INTEGER NOT NULL DEFAULT 31;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bk_settings_year_end_chk'
  ) THEN
    ALTER TABLE "bk_settings" ADD CONSTRAINT "bk_settings_year_end_chk"
      CHECK ("year_end_month" BETWEEN 1 AND 12 AND "year_end_day" BETWEEN 1 AND 31);
  END IF;
END
$$;
