-- ===========================================================================
-- 026_prepaid_vat_estimate.sql - let the overview's "VAT this period" figure
-- count VAT already paid to suppliers up front.
--
-- A supplier paid on a proforma before they invoice makes the payment the tax
-- point, so the VAT on it belongs to the period the money left. The books only
-- hear about it when the invoice is approved, which can be a period later, and
-- until then the overview's running estimate says more is owed than is.
--
-- With this on, the overview asks any module contributing to the
-- `uk-bookkeeping.prepaid-vat` point (Purchase Orders, today) for paid orders
-- not yet in the books, and adds their VAT to the reclaim side of the ESTIMATE.
-- The VAT return itself is never touched: what is filed is only ever what the
-- books hold.
--
-- Off by default: an estimate that suddenly moves on update is a surprise, not
-- a feature.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "include_prepaid_vat" BOOLEAN NOT NULL DEFAULT FALSE;
