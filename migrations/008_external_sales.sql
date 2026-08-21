-- Sales recorded by another module.
--
-- The books can be told about a sale by something other than a person typing it
-- in: a shop that raises an invoice knows, at that moment, exactly what was
-- charged and at what rate, and re-keying it here is both work and a chance to
-- get it wrong. lib/external-sales.ts is what takes that hand-off; these three
-- settings are what govern it.
--
-- Deliberately named for the capability rather than for any one module. The
-- books do not know what a shop is, and must not: anything that can state a
-- sale with a VAT breakdown can hand one over.
--
-- The off switch matters more than it looks. A business that also imports its
-- bank statements would otherwise record the same sale twice - once as the
-- invoice and again as the money landing - and a VAT return built on a double
-- count is a wrong return, not an untidy one.
--
-- Idempotent, and never edited after release: a later change is a new numbered
-- file (see 001_initial.sql's header for why).

ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "external_sales_enabled" BOOLEAN NOT NULL DEFAULT TRUE;

-- Which category they are filed under. NULL means "whatever is coded 'sales'",
-- which is the seeded system category every install starts with - so this stays
-- correct without anybody choosing anything, and a business that has renamed or
-- reorganised its categories can point it somewhere else.
ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "external_sales_category_id" TEXT;

-- 'posted' records them as records. 'draft' parks each one for a human to look
-- at first, which suits a business whose bookkeeper wants eyes on everything
-- before it counts towards a return.
ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "external_sales_status" TEXT NOT NULL DEFAULT 'posted';

DO $$ BEGIN
  ALTER TABLE "bk_settings"
    ADD CONSTRAINT "bk_settings_external_sales_status_chk"
    CHECK ("external_sales_status" IN ('draft', 'posted'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- RESTRICT rather than SET NULL: a category the books are actively filing sales
-- into should not be deletable out from under them without a word. DEFERRABLE
-- for the same reason every other foreign key here is - a restore loads rows in
-- whatever order it likes.
DO $$ BEGIN
  ALTER TABLE "bk_settings"
    ADD CONSTRAINT "bk_settings_external_sales_category_fkey"
    FOREIGN KEY ("external_sales_category_id") REFERENCES "bk_categories"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Finding the entry a given invoice already made, which is what stops a second
-- hand-off recording the same sale twice.
CREATE INDEX IF NOT EXISTS "bk_transactions_source_ref_idx"
  ON "bk_transactions" ("source", "source_ref");
