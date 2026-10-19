-- ===========================================================================
-- 025_api_call_test_scenario.sql - record the Gov-Test-Scenario a sandbox call
-- was sent with.
--
-- HMRC's approvals team read the call log as evidence, and the sandbox only
-- answers liabilities and payments with data when a test scenario is named. The
-- header is not a fraud prevention header, so it never reached fraud_headers; a
-- 200 on the log with nothing saying why it differed from the 404 before it was
-- hard to defend. NULL for every call made without one, and for all production
-- calls, where the header is never sent.
--
-- Written with the row, before the request goes out, and then as write-once as
-- the other "what was sent" columns: bk_guard_api_call_row is replaced below to
-- refuse a change to it.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

ALTER TABLE "bk_hmrc_api_calls" ADD COLUMN IF NOT EXISTS "test_scenario" TEXT;

CREATE OR REPLACE FUNCTION bk_guard_api_call_row() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'bk_hmrc_api_calls is the evidence that fraud prevention headers were sent; rows cannot be removed.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW."at"            IS DISTINCT FROM OLD."at"
     OR NEW."environment"   IS DISTINCT FROM OLD."environment"
     OR NEW."method"        IS DISTINCT FROM OLD."method"
     OR NEW."path"          IS DISTINCT FROM OLD."path"
     OR NEW."fraud_headers" IS DISTINCT FROM OLD."fraud_headers"
     OR NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id"
     OR NEW."test_scenario" IS DISTINCT FROM OLD."test_scenario"
  THEN
    RAISE EXCEPTION
      'HMRC API call % records what was sent and cannot be rewritten.',
      OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF (OLD."status_code"    IS NOT NULL AND NEW."status_code"    IS DISTINCT FROM OLD."status_code")
     OR (OLD."duration_ms"    IS NOT NULL AND NEW."duration_ms"    IS DISTINCT FROM OLD."duration_ms")
     OR (OLD."correlation_id" IS NOT NULL AND NEW."correlation_id" IS DISTINCT FROM OLD."correlation_id")
     OR (OLD."receipt_id"     IS NOT NULL AND NEW."receipt_id"     IS DISTINCT FROM OLD."receipt_id")
     OR (OLD."error_code"     IS NOT NULL AND NEW."error_code"     IS DISTINCT FROM OLD."error_code")
     OR (OLD."error_body"     IS NOT NULL AND NEW."error_body"     IS DISTINCT FROM OLD."error_body")
  THEN
    RAISE EXCEPTION
      'HMRC API call % already has an outcome recorded and cannot be changed.',
      OLD."id" USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;
