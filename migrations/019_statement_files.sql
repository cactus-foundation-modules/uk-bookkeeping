-- ===========================================================================
-- 019_statement_files.sql
--
-- Keep the statement file itself, not just what we read out of it.
--
-- Until now an import parsed the file, wrote the lines, and threw the bytes
-- away. That is fine right up until somebody asks the obvious question - "show
-- me the statement that line came off" - which is exactly the question an
-- inspector asks, and the one an owner asks when a figure looks wrong six
-- months later. HMRC expects the records kept six years; the record is the
-- statement, not our reading of it.
--
-- So the file goes into the media library beside every other piece of evidence,
-- under Bookkeeping / <year> / <month> / Bank Statements / <account name>, and
-- these columns are the address. Same three-part address the attachment rows
-- keep, and for the same reason: the url is what serves it, the provider and
-- key are what re-read it if the library row is ever deleted, and the media id
-- is what ties it to the library row while that row exists.
--
-- Every column is nullable or defaulted. A statement imported before this
-- migration has no file and never will - there is nothing to backfill from -
-- and one imported by a site with no media provider set up still imports.
-- ===========================================================================

ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "url" TEXT;
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "media_provider" TEXT;
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "media_key" TEXT;
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "media_id" TEXT;
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "mime_type" TEXT;
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "size" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "sha256" TEXT;

-- When the file was last replaced, which is a different question from when the
-- statement was first imported. A statement re-imported to correct it keeps its
-- created_at - the entries hanging off its lines are dated from that - and
-- records the update here.
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "updated_by_user_id" TEXT;

-- How many times this statement has been brought in again. Shown to the person
-- doing it ("this is the third time"), because a statement that keeps needing
-- re-importing is usually a sign the wrong file is being exported.
ALTER TABLE "bk_bank_statements"
  ADD COLUMN IF NOT EXISTS "update_count" INTEGER NOT NULL DEFAULT 0;

-- Finding the statement a re-import should update. An account plus the period
-- it covers is what identifies a statement - the filename is whatever the
-- bank's export happened to call it that day, and the same month downloaded
-- twice routinely arrives under two different names.
CREATE INDEX IF NOT EXISTS "bk_bank_statements_period_idx"
  ON "bk_bank_statements" ("bank_account_id", "period_start", "period_end");
