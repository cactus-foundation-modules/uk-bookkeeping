-- ===========================================================================
-- 021_manual_invoices.sql
--
-- The gap this closes: money recorded by hand as coming in - a failed delivery
-- charge, a cash sale, a bank transfer nobody raised paperwork for - left an
-- entry in the books and no invoice behind it. A shop's own sales get one from
-- the shop; these had nothing, so the customer had nothing to be sent and the
-- entry sat in the "evidence missing" list for ever.
--
-- Four columns on the settings row, because "what goes at the top of the
-- invoice and what number comes next" are facts about the business, not about
-- any one entry:
--   business_address     where the invoice says the seller is
--   invoice_prefix       the letters before the number ("INV-")
--   next_invoice_number  the counter. Taken with one UPDATE ... RETURNING, so two
--                        people recording a payment in the same second cannot be
--                        handed the same number.
--   auto_invoice_manual_income
--                        the off switch for a business that raises its invoices
--                        somewhere else and only wants the money recorded here.
--
-- A counter column rather than a SEQUENCE: backup and restore have to know about
-- every sequence by name, and an ordinary integer travels with the settings row
-- without anybody having to remember to teach them anything.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "business_address" TEXT,
  ADD COLUMN IF NOT EXISTS "invoice_prefix" TEXT NOT NULL DEFAULT 'INV-',
  ADD COLUMN IF NOT EXISTS "next_invoice_number" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "auto_invoice_manual_income" BOOLEAN NOT NULL DEFAULT TRUE;

-- The number of the invoice made for an entry, kept on the entry itself so a
-- failed print can be retried under the SAME number rather than burning another
-- (a gap in a run of invoice numbers is the first thing an inspector asks
-- about). Unique where present, so the counter cannot hand one out twice.
ALTER TABLE "bk_transactions" ADD COLUMN IF NOT EXISTS "invoice_number" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "bk_transactions_invoice_number_key"
  ON "bk_transactions" ("invoice_number") WHERE "invoice_number" IS NOT NULL;
