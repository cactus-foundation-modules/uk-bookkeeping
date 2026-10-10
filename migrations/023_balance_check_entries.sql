-- ===========================================================================
-- 023_balance_check_entries.sql
--
-- Which entries an agreeing balance check covers.
--
-- A bill paid out of a prepaid balance (a phone provider's credit, say) has no
-- statement line to be ticked off against, because the supplier never sends a
-- statement. 022 added the check itself; this records WHICH entries it vouches
-- for. When a check agrees to the penny, every posted entry paid from that
-- account and settled on or before its date is covered by it: the books and the
-- supplier say the same total, so the movements that make it up are accounted
-- for. A check that does not agree covers nothing.
--
-- A link table, not a column on bk_transactions: posted entries are guarded
-- against change (002_immutability.sql), and "a check has since covered this" is
-- not a change to the entry.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "bk_balance_check_entries" (
  "balance_check_id" TEXT NOT NULL,
  "transaction_id"   TEXT NOT NULL,
  CONSTRAINT "bk_balance_check_entries_pkey" PRIMARY KEY ("balance_check_id", "transaction_id"),
  CONSTRAINT "bk_balance_check_entries_check_fkey"
    FOREIGN KEY ("balance_check_id") REFERENCES "bk_balance_checks"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_balance_check_entries_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "bk_transactions"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS "bk_balance_check_entries_transaction_idx"
  ON "bk_balance_check_entries" ("transaction_id");
