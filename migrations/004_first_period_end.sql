-- ===========================================================================
-- 004_first_period_end.sql
--
-- The day the FIRST VAT period ends, from HMRC's registration letter.
--
-- HMRC ends every return period on the last day of a calendar month (the
-- three quarterly "stagger groups": Mar/Jun/Sep/Dec, Apr/Jul/Oct/Jan,
-- May/Aug/Nov/Feb). The first period therefore runs from the effective date
-- of registration to the first stagger month end, and is routinely longer or
-- shorter than the filing frequency suggests - registering on 10 July with
-- periods ending Oct/Jan/Apr/Jul gives 10 July to 31 October, not 9 October.
-- That end date cannot be derived from the start date alone (the owner picks
-- their stagger group with HMRC), so it is a setting.
--
-- Also present in 001_initial.sql for fresh installs; IF NOT EXISTS makes the
-- overlap harmless there.
-- ===========================================================================

ALTER TABLE "bk_settings" ADD COLUMN IF NOT EXISTS "first_period_end" DATE;
