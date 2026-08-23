-- ===========================================================================
-- 015_evidence_not_required.sql
--
-- The gap this closes: some entries are never going to have a receipt, and
-- there was no way to say so.
--
-- Money put onto a balance held with a supplier, a bank charge, a payment on
-- account - the paperwork either arrives later on somebody else's schedule or
-- does not exist at all. Until now every one of those counted as evidence
-- missing: on the overview, on the entries screen, and in the nag on the entry
-- itself, for as long as the records are kept. Six years of a job that was
-- never a job is how a genuinely missing receipt stops being noticeable.
--
-- One column, and it is a statement by a person rather than anything worked
-- out. Nothing infers it from the category or the amount, because "this needs
-- no receipt" is a judgement about what happened, and the whole module's rule
-- is that it never invents one of those.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

ALTER TABLE "bk_transactions"
  ADD COLUMN IF NOT EXISTS "evidence_not_required" BOOLEAN NOT NULL DEFAULT FALSE;
