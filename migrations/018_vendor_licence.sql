-- Gov-Vendor-License-IDs.
--
-- HMRC's Test Fraud Prevention Headers endpoint rejects a submission that omits
-- this header ("Header required (gov-vendor-license-ids)"), even though their
-- own page marks the value as one that cannot always be collected. Every Cactus
-- install is a separately licensed deployment, so each one gets a licence
-- identifier of its own, minted once and never rotated: HMRC ask that the value
-- be hashed consistently, which it cannot be if it changes.
--
-- The column holds the RAW identifier. The header carries a SHA-256 of it, so
-- the identifier itself never leaves this database.

ALTER TABLE "bk_settings"
  ADD COLUMN IF NOT EXISTS "vendor_license_id" TEXT;

-- Mint one for the install that is already here, so the first VAT call after an
-- update sends the header rather than waiting for somebody to open Settings.
UPDATE "bk_settings"
   SET "vendor_license_id" = gen_random_uuid()::text,
       "updated_at"        = NOW()
 WHERE "id" = 'singleton'
   AND "vendor_license_id" IS NULL;
