-- ===========================================================================
-- 024_vat_payment_status.sql - what HMRC says about whether a filed return has
-- been paid.
--
-- A separate table rather than columns on bk_vat_periods: a submitted period is
-- frozen by bk_guard_submitted_period (002_immutability.sql), and "HMRC has now
-- been paid" is news that arrives long after submission. It is HMRC's view, read
-- from their liabilities, and never mixed into this module's own figures.
--
-- One row per period, written the first time we ask. Once status is 'paid' the
-- module stops asking about that period for good.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "bk_vat_payment_status" (
  "period_id"          TEXT NOT NULL,
  "status"             TEXT NOT NULL,
  "original_amount"    NUMERIC(10,2),
  "outstanding_amount" NUMERIC(10,2),
  "hmrc_due_date"      DATE,
  "first_checked_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "checked_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "paid_seen_at"       TIMESTAMPTZ,
  CONSTRAINT "bk_vat_payment_status_pkey" PRIMARY KEY ("period_id"),
  CONSTRAINT "bk_vat_payment_status_status_chk"
    CHECK ("status" IN ('unpaid', 'part_paid', 'paid', 'unknown')),
  CONSTRAINT "bk_vat_payment_status_period_fkey"
    FOREIGN KEY ("period_id") REFERENCES "bk_vat_periods"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
