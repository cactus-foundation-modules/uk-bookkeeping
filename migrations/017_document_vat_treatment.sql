-- ===========================================================================
-- 017_document_vat_treatment.sql
--
-- What a document says about HOW its VAT works, as opposed to at what rate.
--
-- 016 gave a document a rate and nothing else, which is half the question and
-- the less important half. An invoice from an overseas supplier showing 0% and
-- the words "reverse charge" is NOT a zero-rated purchase: the supplier charges
-- nothing because the BUYER accounts for the VAT, on both sides of their own
-- return - box 1 and box 4, netting to nothing. Read as zero-rated it puts
-- nothing in either box, and a VAT return goes off to HMRC understating both.
--
-- Rate and treatment are genuinely two columns and not one. The same 20% is
-- charged domestically, self-accounted on an overseas service, and self-accounted
-- again on UK construction work, and those three land in different boxes.
--
-- Same rules as every column 016 added: it is a GUESS, it is never an accounting
-- figure on its own, and it is frozen once the receipt is evidence on a filed
-- return. The guard is superseded a third time to cover it, for the reason 003
-- gives - a refusal list that does not list a column does not refuse it.
-- ===========================================================================

ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_vat_treatment" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bk_attachments_guessed_treatment_chk'
  ) THEN
    -- The same seven the transaction lines take. Deliberately spelled out rather
    -- than referenced: a CHECK cannot read another table's constraint, and a
    -- silent divergence here would be a document whose treatment cannot be
    -- copied onto the entry it was read for.
    ALTER TABLE "bk_attachments" ADD CONSTRAINT "bk_attachments_guessed_treatment_chk"
      CHECK ("guessed_vat_treatment" IS NULL OR "guessed_vat_treatment" IN (
        'domestic', 'ni_eu_acquisition', 'ni_eu_dispatch', 'reverse_charge_services',
        'import_pva', 'domestic_reverse_charge', 'outside_scope'
      ));
  END IF;
END
$$;

-- --- The locked-attachment guard, widened once more ------------------------
-- Restore safety unchanged from 002, 003 and 016: still a BEFORE UPDATE OR
-- DELETE guard reading only its own row's OLD/NEW, TRUNCATE fires no row
-- triggers, and restore performs only INSERTs after the TRUNCATE.
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
       OR NEW."scan_status"             IS DISTINCT FROM OLD."scan_status"
       OR NEW."scanned_at"              IS DISTINCT FROM OLD."scanned_at"
       OR NEW."guessed_counterparty"    IS DISTINCT FROM OLD."guessed_counterparty"
       OR NEW."counterparty_confidence" IS DISTINCT FROM OLD."counterparty_confidence"
       OR NEW."guessed_direction"       IS DISTINCT FROM OLD."guessed_direction"
       OR NEW."guessed_document_date"   IS DISTINCT FROM OLD."guessed_document_date"
       OR NEW."guessed_document_number" IS DISTINCT FROM OLD."guessed_document_number"
       OR NEW."guessed_net"             IS DISTINCT FROM OLD."guessed_net"
       OR NEW."guessed_vat"             IS DISTINCT FROM OLD."guessed_vat"
       OR NEW."guessed_total"           IS DISTINCT FROM OLD."guessed_total"
       OR NEW."guessed_vat_rate_code"   IS DISTINCT FROM OLD."guessed_vat_rate_code"
       OR NEW."guessed_vat_treatment"   IS DISTINCT FROM OLD."guessed_vat_treatment"
       OR NEW."guessed_vat_number"      IS DISTINCT FROM OLD."guessed_vat_number"
       OR NEW."reading_confirmed"       IS DISTINCT FROM OLD."reading_confirmed"
       OR NEW."extracted_text"          IS DISTINCT FROM OLD."extracted_text"
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
