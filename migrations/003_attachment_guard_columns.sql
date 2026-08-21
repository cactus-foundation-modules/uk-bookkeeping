-- uk-bookkeeping 003_attachment_guard_columns.sql
--
-- Closes a gap in 002's attachment guard. 002's comment promised that on a
-- locked row the four storage-pointer columns (url, media_provider, media_key,
-- media_id) were "the only thing that gets through". That was not true: the
-- refusal list named transaction_id, name, filename, mime_type, size, sha256
-- and locked_period_id, which left position, uploaded_by_user_id and
-- created_at freely mutable on locked rows. This migration adds those three to
-- the refused set, making the guard match what 002 claimed. The storage
-- pointers stay deliberately free so core's media-reference rewriter can
-- repoint a moved blob (see 002 for the whole story).
--
-- 002 itself is left untouched - released module migrations are never edited,
-- they are superseded by a later numbered file, which is this one.
--
-- Restore safety is unchanged from 002's analysis: this is still a BEFORE
-- UPDATE OR DELETE guard that only reads its own row's OLD/NEW, TRUNCATE fires
-- no row triggers, and restore performs only INSERTs after the TRUNCATE.

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
       OR NEW."position"    IS DISTINCT FROM OLD."position"
       OR NEW."uploaded_by_user_id" IS DISTINCT FROM OLD."uploaded_by_user_id"
       OR NEW."created_at"  IS DISTINCT FROM OLD."created_at"
       OR NEW."locked_period_id"    IS DISTINCT FROM OLD."locked_period_id"
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
