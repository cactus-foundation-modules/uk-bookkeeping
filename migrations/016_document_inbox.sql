-- ===========================================================================
-- 016_document_inbox.sql
--
-- Receipts and invoices that arrive before the entry does.
--
-- Until now a piece of evidence could only exist as the child of an entry, so
-- the paperwork had to be filed in the order it was least convenient to file
-- it: open the books, type the entry, then go and find the PDF. In practice a
-- receipt arrives by email on the day and the entry gets typed when the bank
-- statement turns up three weeks later, and the two jobs want doing in that
-- order.
--
-- So an attachment may now have no entry. A row with a NULL transaction_id is
-- an unfiled document sitting in the inbox, and attaching it later is an UPDATE
-- rather than an upload. One table rather than two, deliberately: the download
-- route, the media-usage provider, the media-reference rewriter, the backup
-- serialiser and the six-year retention promise all already work on this table
-- and none of them needs to learn a second one.
--
-- Both existing triggers are already NULL-safe. bk_guard_insert_into_locked
-- tests `WHERE "id" = NEW."transaction_id"`, which matches no rows when that is
-- NULL, so an unfiled document inserts freely. bk_guard_locked_attachment only
-- fires on rows that carry a locked_period_id, which an unfiled one never does.
--
-- What we read off the document lives on the same row. It is a GUESS, and the
-- column names say so - the day a human confirms or corrects it,
-- reading_confirmed goes true and the confidence goes to 100. Nothing here is
-- ever used as an accounting figure on its own; it only pre-fills a form that a
-- person then presses Save on.
--
-- Every foreign key here is DEFERRABLE INITIALLY DEFERRED, same as the rest of
-- the module: lib/backup/restore.ts truncates and re-inserts table by table
-- inside one transaction, so a forward reference is routinely unsatisfied
-- halfway through.
-- ===========================================================================

-- --- An attachment may now stand on its own --------------------------------
-- Idempotent: DROP NOT NULL on a column that is already nullable is a no-op.
ALTER TABLE "bk_attachments" ALTER COLUMN "transaction_id" DROP NOT NULL;

-- --- What we made of the document ------------------------------------------
-- scan_status:
--   not_scanned - never looked at. Every row that existed before this file.
--   read        - text came out and the guesses below were taken from it.
--   no_text     - a photograph, or a PDF that is a picture of a page. There is
--                 nothing to read without OCR, which this module does not do,
--                 and saying so plainly beats an empty guess that looks like a
--                 failure.
--   unreadable  - the file would not parse at all.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "scan_status" TEXT NOT NULL DEFAULT 'not_scanned';
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "scanned_at" TIMESTAMPTZ;

-- Who the document says it is from. The whole point of the exercise: knowing
-- the supplier is what lets an unfiled receipt be offered against the right
-- bank line three weeks later.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_counterparty" TEXT;
-- 0 to 100. Not a probability and not presented as one - it decides the order
-- of a list and whether the screen says "this is" or "this might be".
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "counterparty_confidence" INTEGER NOT NULL DEFAULT 0;
-- income when the document is one we ISSUED (its VAT number is our own),
-- expense otherwise. NULL when there is nothing to go on.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_direction" TEXT;
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_document_date" DATE;
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_document_number" TEXT;
-- Money, NUMERIC(10,2) like everything else in this module. NULL means "not
-- found on the document", which is a different and more useful statement than
-- zero - a zero would autofill a form with a figure nobody wrote down.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_net" NUMERIC(10,2);
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_vat" NUMERIC(10,2);
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_total" NUMERIC(10,2);
-- Which of the five rate codes the VAT figure implies, worked out from the
-- ratio rather than from any wording. NULL where no VAT figure was found.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_vat_rate_code" TEXT;
-- The supplier's VAT registration number, normalised to GB999999999. Worth its
-- own column: it is the one thing on an invoice that identifies a business
-- exactly, so the second document from the same supplier is recognised even if
-- their letterhead changed.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "guessed_vat_number" TEXT;
-- A human has looked at the reading above and said yes, or corrected it. From
-- then on nothing re-guesses over the top of it.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "reading_confirmed" BOOLEAN NOT NULL DEFAULT FALSE;
-- The text we read, capped in application code. Kept so a re-guess costs no
-- download and so "why did it think that" is answerable six months later with
-- the file long since moved.
ALTER TABLE "bk_attachments"
  ADD COLUMN IF NOT EXISTS "extracted_text" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bk_attachments_scan_status_chk'
  ) THEN
    ALTER TABLE "bk_attachments" ADD CONSTRAINT "bk_attachments_scan_status_chk"
      CHECK ("scan_status" IN ('not_scanned', 'read', 'no_text', 'unreadable'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bk_attachments_guessed_direction_chk'
  ) THEN
    ALTER TABLE "bk_attachments" ADD CONSTRAINT "bk_attachments_guessed_direction_chk"
      CHECK ("guessed_direction" IS NULL OR "guessed_direction" IN ('income', 'expense'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bk_attachments_guessed_rate_chk'
  ) THEN
    ALTER TABLE "bk_attachments" ADD CONSTRAINT "bk_attachments_guessed_rate_chk"
      CHECK ("guessed_vat_rate_code" IS NULL OR "guessed_vat_rate_code" IN
        ('standard', 'reduced', 'zero', 'exempt', 'outside_scope'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bk_attachments_confidence_chk'
  ) THEN
    ALTER TABLE "bk_attachments" ADD CONSTRAINT "bk_attachments_confidence_chk"
      CHECK ("counterparty_confidence" BETWEEN 0 AND 100);
  END IF;
END
$$;

-- The inbox list, and the amount lookup that offers unfiled documents against a
-- statement line. Both are partial on transaction_id IS NULL, because the
-- filed ones outnumber the unfiled ones by years to weeks and the index has no
-- business carrying them.
CREATE INDEX IF NOT EXISTS "bk_attachments_unfiled_idx"
  ON "bk_attachments" ("created_at" DESC) WHERE "transaction_id" IS NULL;
CREATE INDEX IF NOT EXISTS "bk_attachments_unfiled_total_idx"
  ON "bk_attachments" ("guessed_total") WHERE "transaction_id" IS NULL;
-- Recognising the same supplier's second document by their VAT number.
CREATE INDEX IF NOT EXISTS "bk_attachments_vat_number_idx"
  ON "bk_attachments" ("guessed_vat_number") WHERE "guessed_vat_number" IS NOT NULL;

-- --- Learned names ----------------------------------------------------------
-- A bank statement prints SQ *THE COFFEE SHOP 1234 and the invoice says "The
-- Coffee Shop Limited". Nothing derives one from the other, and no amount of
-- cleverness in a matcher will: the connection is a fact about this business
-- that somebody has to state once. So it is stored the once, the first time a
-- human corrects a guess, and every later document and every later statement
-- line gets it for free.
--
-- `alias` is the NORMALISED form - lower case, punctuation and card noise
-- stripped - because that is what a lookup has to hand. lib/counterparty
-- -aliases.ts is the only place allowed to compute one, same rule as the
-- statement fingerprint.
CREATE TABLE IF NOT EXISTS "bk_counterparty_aliases" (
  "id"                  TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "alias"               TEXT NOT NULL,
  -- Spelled as the books spell it, so filing under it matches what is already
  -- there rather than growing a second supplier with the same name.
  "counterparty"        TEXT NOT NULL,
  -- learned: taken from a correction a human made. manual: typed on purpose.
  "source"              TEXT NOT NULL DEFAULT 'learned',
  "hits"                INTEGER NOT NULL DEFAULT 1,
  "created_by_user_id"  TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_counterparty_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_counterparty_aliases_source_chk" CHECK ("source" IN ('learned', 'manual'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "bk_counterparty_aliases_alias_key"
  ON "bk_counterparty_aliases" ("alias");
CREATE INDEX IF NOT EXISTS "bk_counterparty_aliases_counterparty_idx"
  ON "bk_counterparty_aliases" (lower("counterparty"));

-- --- The locked-attachment guard, widened to cover the new columns ----------
-- 003 exists because 002 promised the storage pointers were "the only thing
-- that gets through" and three columns were in fact left mutable. Adding twelve
-- more columns without saying anything would put that hole straight back, so
-- the refusal list is extended here in the same breath as the columns.
--
-- The storage pointers (url, media_provider, media_key, media_id) stay
-- deliberately free, so core's media-reference rewriter can still repoint a
-- moved blob on a filed receipt. See 002 for the whole story.
--
-- Consequence, and it is the intended one: a receipt that has been filed on a
-- submitted VAT return cannot be re-read or re-guessed. The evidence is frozen,
-- and so is what we said about it.
--
-- Restore safety is unchanged from 002 and 003: still a BEFORE UPDATE OR DELETE
-- guard reading only its own row's OLD/NEW, TRUNCATE fires no row triggers, and
-- restore performs only INSERTs after the TRUNCATE.
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
