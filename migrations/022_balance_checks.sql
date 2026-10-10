-- ===========================================================================
-- 022_balance_checks.sql
--
-- Checking a cash account that has no statement to reconcile against.
--
-- A prepaid balance held with a supplier (a phone provider's credit, an
-- advertising wallet) is a cash account in the books, but the supplier may only
-- ever offer a balance on a web page, never a statement to import. The honest
-- check is: type in the balance the supplier shows, compare it with what the
-- books say, and keep a record that someone did.
--
-- One row per time somebody saved that comparison. Append-only in spirit - the
-- screen only ever adds rows - and it reaches no ledger, no VAT box and no
-- report: it is a note that a check was made and what it found.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "bk_balance_checks" (
  "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "bank_account_id"    TEXT NOT NULL,
  "as_at"              DATE NOT NULL,
  -- What the ledger said at the moment the check was saved, kept so a later
  -- correction does not quietly rewrite what was agreed on the day.
  "books_balance"      NUMERIC(14, 2) NOT NULL,
  "stated_balance"     NUMERIC(14, 2) NOT NULL,
  "difference"         NUMERIC(14, 2) NOT NULL,
  "note"               TEXT,
  "checked_by_user_id" TEXT,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_balance_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_balance_checks_difference_chk"
    CHECK ("difference" = "stated_balance" - "books_balance"),
  CONSTRAINT "bk_balance_checks_bank_fkey"
    FOREIGN KEY ("bank_account_id") REFERENCES "bk_bank_accounts"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS "bk_balance_checks_account_idx"
  ON "bk_balance_checks" ("bank_account_id", "as_at" DESC, "created_at" DESC);
