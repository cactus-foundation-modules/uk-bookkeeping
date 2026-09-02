-- ===========================================================================
-- 020_transfers.sql
--
-- Moving money between two accounts the business already owns.
--
-- Why this is not a third direction on bk_transactions. Every settlement branch
-- in lib/ledger.ts reads "CASE WHEN direction = 'income' THEN … ELSE …", so a
-- third value falls into the ELSE on all of them and posts as a purchase: debit
-- an expense category, credit creditors, then the bank. Quietly wrong is the
-- worst kind. A transfer is also neither a sale nor a cost, has no category, and
-- has no VAT on it - and bk_transaction_lines requires all three.
--
-- So a transfer is a journal, which is what journals are for: two sides that add
-- up to nothing, reaching no VAT box. It debits the receiving account's nominal
-- and credits the sending one's. What this file adds is the small amount of
-- structure needed to tell a transfer apart from an ordinary journal, and to let
-- the two statement lines it explains be ticked off against it.
-- ===========================================================================

-- --- Marking a journal as a transfer -----------------------------------------
-- The two bank accounts are stored on the journal as well as being implied by
-- its lines. The lines carry NOMINAL account ids, and going from those back to
-- the bank accounts means a join through bk_accounts every time a screen wants
-- to say "Current → Savings". Storing the pair is what keeps the transfer form
-- able to reload itself, and the check constraint below is what keeps the two
-- representations from drifting.
ALTER TABLE "bk_journals"
  ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'journal';
ALTER TABLE "bk_journals"
  ADD COLUMN IF NOT EXISTS "from_bank_account_id" TEXT;
ALTER TABLE "bk_journals"
  ADD COLUMN IF NOT EXISTS "to_bank_account_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_journals_kind_chk') THEN
    ALTER TABLE "bk_journals"
      ADD CONSTRAINT "bk_journals_kind_chk" CHECK ("kind" IN ('journal', 'transfer'));
  END IF;

  -- A transfer names both accounts and they are different ones. An ordinary
  -- journal names neither. Anything else is a half-written row.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_journals_transfer_accounts_chk') THEN
    ALTER TABLE "bk_journals"
      ADD CONSTRAINT "bk_journals_transfer_accounts_chk" CHECK (
        ("kind" = 'transfer'
          AND "from_bank_account_id" IS NOT NULL
          AND "to_bank_account_id" IS NOT NULL
          AND "from_bank_account_id" <> "to_bank_account_id")
        OR ("kind" <> 'transfer'
          AND "from_bank_account_id" IS NULL
          AND "to_bank_account_id" IS NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_journals_from_bank_fkey') THEN
    ALTER TABLE "bk_journals"
      ADD CONSTRAINT "bk_journals_from_bank_fkey"
      FOREIGN KEY ("from_bank_account_id") REFERENCES "bk_bank_accounts"("id")
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_journals_to_bank_fkey') THEN
    ALTER TABLE "bk_journals"
      ADD CONSTRAINT "bk_journals_to_bank_fkey"
      FOREIGN KEY ("to_bank_account_id") REFERENCES "bk_bank_accounts"("id")
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "bk_journals_kind_idx" ON "bk_journals" ("kind", "date" DESC);

-- --- Reconciling a statement line against a transfer -------------------------
-- Until now a reconciliation pointed at a transaction and nothing else. A
-- transfer is a journal, so the two statement lines that explain it - the money
-- out of one account and the money into the other - had nowhere to point.
--
-- transaction_id becomes nullable and journal_id joins it, exactly one of the
-- two filled in. Everything that sums by bank_transaction_id keeps working
-- untouched and now counts transfers, which is the whole point: a line covered
-- by a transfer is a line that has been explained.
ALTER TABLE "bk_reconciliations" ALTER COLUMN "transaction_id" DROP NOT NULL;
ALTER TABLE "bk_reconciliations" ADD COLUMN IF NOT EXISTS "journal_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_reconciliations_target_chk') THEN
    ALTER TABLE "bk_reconciliations"
      ADD CONSTRAINT "bk_reconciliations_target_chk" CHECK (
        ("transaction_id" IS NOT NULL AND "journal_id" IS NULL)
        OR ("transaction_id" IS NULL AND "journal_id" IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bk_reconciliations_journal_fkey') THEN
    ALTER TABLE "bk_reconciliations"
      ADD CONSTRAINT "bk_reconciliations_journal_fkey"
      FOREIGN KEY ("journal_id") REFERENCES "bk_journals"("id")
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- The existing unique index on (bank_transaction_id, transaction_id) stops
-- guarding anything once transaction_id can be NULL, because in a unique index
-- no NULL equals another. This is its opposite number, and it is what stops one
-- statement line being matched to the same transfer twice.
CREATE UNIQUE INDEX IF NOT EXISTS "bk_reconciliations_journal_pair_key"
  ON "bk_reconciliations" ("bank_transaction_id", "journal_id")
  WHERE "journal_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "bk_reconciliations_journal_idx"
  ON "bk_reconciliations" ("journal_id");

-- --- The lock guard learns about journals -------------------------------------
-- 007 froze a match once the entry behind it was in a filed VAT return. A
-- transfer reaches no VAT box, so filing never locks one - but a closed
-- accounting year does, and when it does the match is part of the story of that
-- year and stays put. Same rule, second table.
CREATE OR REPLACE FUNCTION bk_guard_locked_reconciliation() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "bk_transactions"
    WHERE "id" = OLD."transaction_id" AND "locked_period_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'That entry was included in a submitted VAT return, so how it was matched to the bank cannot be changed.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "bk_journals"
    WHERE "id" = OLD."journal_id" AND "locked_period_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'That transfer falls in a period that has been closed, so how it was matched to the bank cannot be changed.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
