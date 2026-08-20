-- uk-bookkeeping 002_immutability.sql
--
-- The database half of the "a filed VAT return cannot be edited" guarantee. The
-- other two halves are the UI (no controls) and the application guards
-- (lib/guards.ts); this one is what survives a buggy service function, a
-- careless migration, a rogue module, or an admin API that forgot its check.
--
-- ===========================================================================
-- RESTORE SAFETY - read before changing anything in this file
-- ===========================================================================
-- lib/backup/restore.ts runs
--     TRUNCATE TABLE ... RESTART IDENTITY CASCADE
-- followed by plain INSERTs, all in one transaction, WITHOUT setting
-- session_replication_role = replica and WITHOUT disabling triggers. So:
--
--   * TRUNCATE does not fire row triggers, so UPDATE/DELETE guards are free.
--   * Any BEFORE INSERT guard must let a legitimately restored row through.
--     The two below only ever look at the NEW row's own locked_period_id, and a
--     restored child arrives with that column already populated, so it never
--     reaches the parent lookup.
--   * There is deliberately NO trigger stopping an insert dated inside a closed
--     period. A restore re-inserts years of transactions dated inside
--     long-submitted periods; such a trigger would reject most of a restore and
--     the failure would only show up during an actual disaster recovery.
--     Backdating is a policy about what a human may type today, not a property
--     of the data, and it lives in lib/guards.ts.
--
-- What this file does NOT protect against, said plainly: the application
-- connects as the table owner, and a table owner can ALTER TABLE ... DISABLE
-- TRIGGER. Anyone holding the connection string can open psql and do exactly
-- that. No amount of trigger code changes that. What it can do is make
-- interference visible, which is why lib/health.ts reads pg_trigger and puts a
-- red banner across every bookkeeping page when one of these is missing or off.

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------
-- On the message text: plpgsql RAISE has one placeholder, `%`. There is no
-- `%d`. The verb is written out per branch rather than being assembled from
-- lower(TG_OP) plus a letter, which produces "updated"/"deleted" and reads like
-- a bug forever after.
CREATE OR REPLACE FUNCTION bk_guard_locked_transaction() RETURNS trigger AS $$
BEGIN
  IF OLD."locked_period_id" IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'Transaction % was included in a submitted VAT return and cannot be deleted. Post an adjustment in the current open period instead.',
        OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    ELSE
      RAISE EXCEPTION
        'Transaction % was included in a submitted VAT return and cannot be changed. Post an adjustment in the current open period instead.',
        OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_transactions_immutable ON "bk_transactions";
CREATE TRIGGER bk_transactions_immutable
  BEFORE UPDATE OR DELETE ON "bk_transactions"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_locked_transaction();

-- The `OLD."locked_period_id" IS NOT NULL` test is what makes the lock one-way.
-- Submission's own
--     UPDATE ... SET locked_period_id = $1 WHERE locked_period_id IS NULL
-- is permitted because OLD is still null at that moment; every write after it is
-- refused, including one that tries to clear the lock again.

-- ---------------------------------------------------------------------------
-- Lines
-- ---------------------------------------------------------------------------
-- Same shape, reading the row's OWN denormalised lock rather than the parent's.
-- Reading the parent would mean a lookup that fires during restore and would
-- have to be special-cased; a local column has no such problem.
CREATE OR REPLACE FUNCTION bk_guard_locked_child() RETURNS trigger AS $$
BEGIN
  IF OLD."locked_period_id" IS NOT NULL THEN
    RAISE EXCEPTION
      'Row % belongs to a transaction in a submitted VAT return and cannot be changed or removed.',
      OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_transaction_lines_immutable ON "bk_transaction_lines";
CREATE TRIGGER bk_transaction_lines_immutable
  BEFORE UPDATE OR DELETE ON "bk_transaction_lines"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_locked_child();

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------
-- Not the plain child guard, and the difference matters. Core moves a media blob
-- whenever it is optimised, renamed, replaced or re-filed into another folder,
-- and repoints every module's stored copy of the address through the
-- core.media-reference-rewriters extension point. A locked attachment must be
-- allowed to follow its file, or moving one receipt in the media library would
-- fail with an accounting error and leave the download 404ing.
--
-- So: the evidence is frozen, the address is not. Everything that says WHAT the
-- attachment is - which transaction, name, filename, type, size, content hash -
-- is refused on a locked row. The four storage-pointer columns may still change,
-- and a change to them is the only thing that gets through.
CREATE OR REPLACE FUNCTION bk_guard_locked_attachment() RETURNS trigger AS $$
BEGIN
  IF OLD."locked_period_id" IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION
        'Attachment % is evidence for a submitted VAT return and cannot be removed.',
        OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."transaction_id" IS DISTINCT FROM OLD."transaction_id"
       OR NEW."name"        IS DISTINCT FROM OLD."name"
       OR NEW."filename"    IS DISTINCT FROM OLD."filename"
       OR NEW."mime_type"   IS DISTINCT FROM OLD."mime_type"
       OR NEW."size"        IS DISTINCT FROM OLD."size"
       OR NEW."sha256"      IS DISTINCT FROM OLD."sha256"
       OR NEW."locked_period_id" IS DISTINCT FROM OLD."locked_period_id"
    THEN
      RAISE EXCEPTION
        'Attachment % is evidence for a submitted VAT return and cannot be changed. Only its storage address may be updated, and only by the media library.',
        OLD."id" USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_attachments_immutable ON "bk_attachments";
CREATE TRIGGER bk_attachments_immutable
  BEFORE UPDATE OR DELETE ON "bk_attachments"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_locked_attachment();

-- ---------------------------------------------------------------------------
-- Nothing new may join a locked transaction
-- ---------------------------------------------------------------------------
-- Restore-safe: a restored child carries its own locked_period_id and therefore
-- never reaches the EXISTS test.
CREATE OR REPLACE FUNCTION bk_guard_insert_into_locked() RETURNS trigger AS $$
BEGIN
  IF NEW."locked_period_id" IS NULL AND EXISTS (
    SELECT 1 FROM "bk_transactions"
    WHERE "id" = NEW."transaction_id" AND "locked_period_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot add to transaction %: it was included in a submitted VAT return.',
      NEW."transaction_id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_transaction_lines_no_insert_locked ON "bk_transaction_lines";
CREATE TRIGGER bk_transaction_lines_no_insert_locked
  BEFORE INSERT ON "bk_transaction_lines"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_insert_into_locked();

DROP TRIGGER IF EXISTS bk_attachments_no_insert_locked ON "bk_attachments";
CREATE TRIGGER bk_attachments_no_insert_locked
  BEFORE INSERT ON "bk_attachments"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_insert_into_locked();

-- ---------------------------------------------------------------------------
-- Submitted periods
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bk_guard_submitted_period() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'submitted' THEN
    RAISE EXCEPTION
      'VAT period % has been submitted to HMRC and can no longer be changed or removed.',
      OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_vat_periods_immutable ON "bk_vat_periods";
CREATE TRIGGER bk_vat_periods_immutable
  BEFORE UPDATE OR DELETE ON "bk_vat_periods"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_submitted_period();

-- ---------------------------------------------------------------------------
-- Append-only tables
-- ---------------------------------------------------------------------------
-- None of these is reachable by an ON DELETE CASCADE from anything that can be
-- deleted - a cascade would fire the guard and abort the parent's delete.
-- bk_period_snapshots.period_id is ON DELETE RESTRICT, and a period holding
-- snapshots is a submitted period, which cannot be deleted anyway.
CREATE OR REPLACE FUNCTION bk_guard_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; existing rows cannot be changed or removed.',
    TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_audit_log_append_only ON "bk_audit_log";
CREATE TRIGGER bk_audit_log_append_only
  BEFORE UPDATE OR DELETE ON "bk_audit_log"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_append_only();

DROP TRIGGER IF EXISTS bk_period_snapshots_append_only ON "bk_period_snapshots";
CREATE TRIGGER bk_period_snapshots_append_only
  BEFORE UPDATE OR DELETE ON "bk_period_snapshots"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_append_only();

DROP TRIGGER IF EXISTS bk_period_snapshot_lines_append_only ON "bk_period_snapshot_lines";
CREATE TRIGGER bk_period_snapshot_lines_append_only
  BEFORE UPDATE OR DELETE ON "bk_period_snapshot_lines"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_append_only();

-- ---------------------------------------------------------------------------
-- HMRC API call log
-- ---------------------------------------------------------------------------
-- Write-once rather than strictly append-only, because the row is deliberately
-- inserted BEFORE the request goes out - so a call that times out still leaves a
-- trace - and completed afterwards with what came back. That completion is the
-- only update this table accepts: it may fill in outcome columns that are still
-- null, and nothing else. A second attempt to rewrite an outcome, a change to
-- what was sent, or a delete, is refused.
CREATE OR REPLACE FUNCTION bk_guard_api_call_row() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'bk_hmrc_api_calls is the evidence that fraud prevention headers were sent; rows cannot be removed.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."at"            IS DISTINCT FROM OLD."at"
     OR NEW."environment"   IS DISTINCT FROM OLD."environment"
     OR NEW."method"        IS DISTINCT FROM OLD."method"
     OR NEW."path"          IS DISTINCT FROM OLD."path"
     OR NEW."fraud_headers" IS DISTINCT FROM OLD."fraud_headers"
     OR NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id"
  THEN
    RAISE EXCEPTION
      'HMRC API call % records what was sent and cannot be rewritten.',
      OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF (OLD."status_code"    IS NOT NULL AND NEW."status_code"    IS DISTINCT FROM OLD."status_code")
     OR (OLD."duration_ms"    IS NOT NULL AND NEW."duration_ms"    IS DISTINCT FROM OLD."duration_ms")
     OR (OLD."correlation_id" IS NOT NULL AND NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id")
     OR (OLD."receipt_id"     IS NOT NULL AND NEW."receipt_id"     IS DISTINCT FROM OLD."receipt_id")
     OR (OLD."error_code"     IS NOT NULL AND NEW."error_code"     IS DISTINCT FROM OLD."error_code")
     OR (OLD."error_body"     IS NOT NULL AND NEW."error_body"     IS DISTINCT FROM OLD."error_body")
  THEN
    RAISE EXCEPTION
      'HMRC API call % already has an outcome recorded and cannot be changed.',
      OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bk_hmrc_api_calls_append_only ON "bk_hmrc_api_calls";
CREATE TRIGGER bk_hmrc_api_calls_append_only
  BEFORE UPDATE OR DELETE ON "bk_hmrc_api_calls"
  FOR EACH ROW EXECUTE FUNCTION bk_guard_api_call_row();
