-- ===========================================================================
-- 007_journal_immutability.sql
--
-- The database half of two guarantees about journals:
--   1. A journal in a filed VAT period cannot be changed or deleted, the same
--      way a transaction in one cannot.
--   2. A posted journal balances. Debits equal credits, exactly, always.
--
-- RESTORE SAFETY - the same rules as 002_immutability.sql apply here, and one
-- more that is specific to the balance check.
--
-- lib/backup/restore.ts truncates and re-inserts row by row inside one
-- transaction. A per-row BEFORE INSERT check of "does this journal balance"
-- would fail on the first line of every journal it restored, because the second
-- line has not arrived yet. So the balance check is a CONSTRAINT TRIGGER,
-- DEFERRABLE INITIALLY DEFERRED: it runs at COMMIT, by which time every line of
-- every journal is present and the sums are whole. That is also exactly what is
-- wanted during ordinary use, where the lines of a new journal are inserted one
-- at a time inside a transaction.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_guard_locked_journal() RETURNS trigger AS $$
BEGIN
  IF OLD."locked_period_id" IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'Journal % was included in a submitted VAT return and cannot be deleted. Post a reversing journal in the current open period instead.',
        OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    ELSE
      RAISE EXCEPTION
        'Journal % was included in a submitted VAT return and cannot be changed. Post a reversing journal in the current open period instead.',
        OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_journals_immutable ON "bk_journals";
CREATE TRIGGER bk_journals_immutable
  BEFORE UPDATE OR DELETE ON "bk_journals"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_locked_journal();

-- The line guard reads the line's OWN denormalised lock rather than the
-- parent's. Reading the parent would mean a lookup that fires during a restore
-- and would have to be special-cased; a local column has no such problem.
CREATE OR REPLACE FUNCTION bk_guard_locked_journal_line() RETURNS trigger AS $$
BEGIN
  IF OLD."locked_period_id" IS NOT NULL THEN
    RAISE EXCEPTION
      'Journal line % belongs to a journal in a submitted VAT return and cannot be changed or removed.',
      OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_journal_lines_immutable ON "bk_journal_lines";
CREATE TRIGGER bk_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON "bk_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_locked_journal_line();

-- No new line may join a locked journal. Restore-safe because a restored line
-- carries its own locked_period_id and therefore never reaches the lookup.
CREATE OR REPLACE FUNCTION bk_guard_insert_into_locked_journal() RETURNS trigger AS $$
BEGIN
  IF NEW."locked_period_id" IS NULL AND EXISTS (
    SELECT 1 FROM "bk_journals"
    WHERE "id" = NEW."journal_id" AND "locked_period_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot add a line to journal %: it was included in a submitted VAT return.',
      NEW."journal_id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_journal_lines_no_insert_locked ON "bk_journal_lines";
CREATE TRIGGER bk_journal_lines_no_insert_locked
  BEFORE INSERT ON "bk_journal_lines"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_insert_into_locked_journal();

-- ---------------------------------------------------------------------------
-- The balance check
-- ---------------------------------------------------------------------------
-- A posted journal's debits must equal its credits. Exactly - these are NUMERIC,
-- not floats, so "exactly" is a thing that can be asserted rather than hoped for.
--
-- Draft journals are exempt. A journal being typed is half-finished by
-- definition, and refusing to save it until it balances would mean it could not
-- be saved at all until the last line went in.
CREATE OR REPLACE FUNCTION bk_check_journal_balanced() RETURNS trigger AS $$
DECLARE
  target_id   TEXT;
  journal_row RECORD;
  sums        RECORD;
BEGIN
  target_id := COALESCE(NEW."journal_id", OLD."journal_id");

  SELECT "id", "status" INTO journal_row FROM "bk_journals" WHERE "id" = target_id;
  -- The journal itself has gone (a cascade delete took it, or a restore has not
  -- reached it yet). Nothing left to check.
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF journal_row."status" <> 'posted' THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM("debit"), 0) AS debits, COALESCE(SUM("credit"), 0) AS credits
    INTO sums FROM "bk_journal_lines" WHERE "journal_id" = target_id;

  IF sums.debits <> sums.credits THEN
    RAISE EXCEPTION
      'Journal % does not balance: debits come to %, credits to %.',
      target_id, to_char(sums.debits, 'FM999999990.00'), to_char(sums.credits, 'FM999999990.00')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF sums.debits = 0 THEN
    RAISE EXCEPTION 'Journal % has no lines, so there is nothing to post.', target_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_journal_lines_balanced ON "bk_journal_lines";
CREATE CONSTRAINT TRIGGER bk_journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON "bk_journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bk_check_journal_balanced();

-- Posting a journal has to be checked too, since the status change is on the
-- header and the lines may not be touched at all.
CREATE OR REPLACE FUNCTION bk_check_journal_balanced_on_post() RETURNS trigger AS $$
DECLARE
  sums RECORD;
BEGIN
  IF NEW."status" <> 'posted' THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM("debit"), 0) AS debits, COALESCE(SUM("credit"), 0) AS credits
    INTO sums FROM "bk_journal_lines" WHERE "journal_id" = NEW."id";

  IF sums.debits <> sums.credits THEN
    RAISE EXCEPTION
      'Journal % does not balance: debits come to %, credits to %.',
      NEW."id", to_char(sums.debits, 'FM999999990.00'), to_char(sums.credits, 'FM999999990.00')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF sums.debits = 0 THEN
    RAISE EXCEPTION 'Journal % has no lines, so there is nothing to post.', NEW."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_journals_balanced ON "bk_journals";
CREATE CONSTRAINT TRIGGER bk_journals_balanced
  AFTER INSERT OR UPDATE ON "bk_journals"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bk_check_journal_balanced_on_post();

-- ---------------------------------------------------------------------------
-- Reconciliation links follow the transaction they explain
-- ---------------------------------------------------------------------------
-- A reconciliation is not part of the VAT return, so it does not need the full
-- immutability treatment. It does need one rule: once the entry it points at has
-- been filed, the link is part of the story of that return and stays put.
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
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- UPDATE and DELETE only. TRUNCATE does not fire row triggers, so a restore's
-- re-insert of these rows is untouched by this.
DROP TRIGGER IF EXISTS bk_reconciliations_locked ON "bk_reconciliations";
CREATE TRIGGER bk_reconciliations_locked
  BEFORE UPDATE OR DELETE ON "bk_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_locked_reconciliation();
