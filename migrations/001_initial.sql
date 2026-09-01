-- uk-bookkeeping 001_initial.sql
--
-- Records, categories, VAT periods, snapshots, audit log, settings and the HMRC
-- connection. Triggers live in 002_immutability.sql, deliberately apart, so the
-- guard that makes a filed return unchangeable can be read as one file.
--
-- Everything here is idempotent: this file is correct for a fresh install and
-- harmless to re-run. It is NEVER edited after release - the checksum recorded
-- in core's ModuleMigration table would no longer match, and an edit in place
-- only ever reaches fresh installs anyway. Later schema changes are new
-- numbered files.
--
-- No Postgres ENUM types anywhere, on purpose: text plus a CHECK constraint.
-- Adding a value to an enum is an ALTER TYPE that cannot always run inside a
-- transaction, the module teardown list names tables rather than types so an
-- uninstall would strand them, and the backup serialiser has to quote enum type
-- names specially. Text costs nothing here.
--
-- Money is NUMERIC(10,2) throughout, matching shop. Exact decimal, summed in
-- Postgres, never through a JavaScript float. See lib/money.ts.

-- ---------------------------------------------------------------------------
-- Chart of categories
-- ---------------------------------------------------------------------------
-- `code` is the stable identity; `name` is what the owner sees and may rename.
CREATE TABLE IF NOT EXISTS "bk_categories" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "code"            TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "direction"       TEXT NOT NULL,
  "sa103_box"       TEXT,
  "ct600_group"     TEXT,
  "is_trading"      BOOLEAN NOT NULL DEFAULT TRUE,
  "is_capital"      BOOLEAN NOT NULL DEFAULT FALSE,
  "position"        INTEGER NOT NULL DEFAULT 0,
  "archived"        BOOLEAN NOT NULL DEFAULT FALSE,
  "is_system"       BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_categories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_categories_code_key" UNIQUE ("code"),
  CONSTRAINT "bk_categories_direction_chk"
    CHECK ("direction" IN ('income', 'expense', 'both'))
);

-- ---------------------------------------------------------------------------
-- VAT periods
-- ---------------------------------------------------------------------------
-- A period may be created locally from the scheme setting before HMRC is ever
-- connected, then matched to a real obligation by date range once it is. Never
-- assume quarters: monthly, quarterly and annual all fall out of two columns.
CREATE TABLE IF NOT EXISTS "bk_vat_periods" (
  "id"                        TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "period_key"                TEXT,
  "start_date"                DATE NOT NULL,
  "end_date"                  DATE NOT NULL,
  "due_date"                  DATE,
  "status"                    TEXT NOT NULL DEFAULT 'open',
  "scheme"                    TEXT NOT NULL,
  "source"                    TEXT NOT NULL DEFAULT 'local',
  "obligation_status"         TEXT,
  "vrn"                       TEXT,
  "finalised_at"              TIMESTAMPTZ,
  "finalised_by_user_id"      TEXT,
  "submitted_at"              TIMESTAMPTZ,
  "submitted_by_user_id"      TEXT,
  "submitted_externally"      BOOLEAN NOT NULL DEFAULT FALSE,
  "hmrc_processing_date"      TIMESTAMPTZ,
  "hmrc_form_bundle_number"   TEXT,
  "hmrc_charge_ref_number"    TEXT,
  "hmrc_payment_indicator"    TEXT,
  "hmrc_receipt_id"           TEXT,
  "hmrc_receipt_timestamp"    TEXT,
  "hmrc_correlation_id"       TEXT,
  "created_at"                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_vat_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_vat_periods_status_chk"
    CHECK ("status" IN ('open', 'finalised', 'submitted')),
  CONSTRAINT "bk_vat_periods_scheme_chk"
    CHECK ("scheme" IN ('accrual', 'cash')),
  CONSTRAINT "bk_vat_periods_dates_chk" CHECK ("end_date" >= "start_date"),
  CONSTRAINT "bk_vat_periods_range_key" UNIQUE ("start_date", "end_date")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bk_vat_periods_period_key_key"
  ON "bk_vat_periods" ("period_key") WHERE "period_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "bk_vat_periods_status_idx"
  ON "bk_vat_periods" ("status");

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bk_transactions" (
  "id"                      TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "entry_type"              TEXT NOT NULL DEFAULT 'normal',
  "direction"               TEXT NOT NULL,
  "tax_point_date"          DATE NOT NULL,
  "settled_date"            DATE,
  "counterparty"            TEXT NOT NULL,
  "description"             TEXT NOT NULL DEFAULT '',
  "reference"               TEXT,
  "status"                  TEXT NOT NULL DEFAULT 'posted',
  -- "There is no receipt for this one, and there is not meant to be." A
  -- transfer onto a balance held with a supplier, a bank charge, a payment on
  -- account: the paperwork arrives later or never, and an entry that will never
  -- have evidence should not sit on the "still to do" pile for six years.
  -- Deliberately a statement by a human rather than anything inferred.
  "evidence_not_required"   BOOLEAN NOT NULL DEFAULT FALSE,
  "source"                  TEXT NOT NULL DEFAULT 'manual',
  "source_ref"              TEXT,
  "import_batch_id"         TEXT,
  "corrects_transaction_id" TEXT,
  "correction_reason"       TEXT,
  "finalised_period_id"     TEXT,
  "locked_period_id"        TEXT,
  "locked_at"               TIMESTAMPTZ,
  "created_by_user_id"      TEXT,
  "updated_by_user_id"      TEXT,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_transactions_direction_chk"
    CHECK ("direction" IN ('income', 'expense')),
  CONSTRAINT "bk_transactions_entry_type_chk"
    CHECK ("entry_type" IN ('normal', 'adjustment', 'opening_balance')),
  CONSTRAINT "bk_transactions_status_chk"
    CHECK ("status" IN ('draft', 'posted')),
  CONSTRAINT "bk_transactions_adjustment_chk" CHECK (
    ("entry_type" = 'adjustment' AND "corrects_transaction_id" IS NOT NULL)
    OR ("entry_type" <> 'adjustment' AND "corrects_transaction_id" IS NULL)
  ),
  -- DEFERRABLE, every one of them. A backup restore inserts row by row, so a
  -- self-reference or a forward reference is routinely unsatisfied halfway
  -- through the load. Checking at COMMIT makes insert order irrelevant.
  CONSTRAINT "bk_transactions_corrects_fkey"
    FOREIGN KEY ("corrects_transaction_id") REFERENCES "bk_transactions"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_transactions_locked_period_fkey"
    FOREIGN KEY ("locked_period_id") REFERENCES "bk_vat_periods"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_transactions_finalised_period_fkey"
    FOREIGN KEY ("finalised_period_id") REFERENCES "bk_vat_periods"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_transactions_tax_point_idx"
  ON "bk_transactions" ("tax_point_date");
CREATE INDEX IF NOT EXISTS "bk_transactions_settled_idx"
  ON "bk_transactions" ("settled_date");
CREATE INDEX IF NOT EXISTS "bk_transactions_locked_idx"
  ON "bk_transactions" ("locked_period_id");
CREATE INDEX IF NOT EXISTS "bk_transactions_finalised_idx"
  ON "bk_transactions" ("finalised_period_id");
CREATE INDEX IF NOT EXISTS "bk_transactions_counterparty_idx"
  ON "bk_transactions" (lower("counterparty"));
CREATE INDEX IF NOT EXISTS "bk_transactions_status_idx"
  ON "bk_transactions" ("status");
CREATE INDEX IF NOT EXISTS "bk_transactions_import_batch_idx"
  ON "bk_transactions" ("import_batch_id");

-- ---------------------------------------------------------------------------
-- Transaction lines
-- ---------------------------------------------------------------------------
-- Lines exist because one receipt genuinely does split across categories and
-- rates: a tank of fuel with a sandwich on it.
CREATE TABLE IF NOT EXISTS "bk_transaction_lines" (
  "id"                TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "transaction_id"    TEXT NOT NULL,
  "position"          INTEGER NOT NULL DEFAULT 0,
  "category_id"       TEXT NOT NULL,
  "description"       TEXT NOT NULL DEFAULT '',
  "vat_treatment"     TEXT NOT NULL DEFAULT 'domestic',
  "vat_rate_code"     TEXT NOT NULL,
  "vat_rate_percent"  NUMERIC(5,2) NOT NULL DEFAULT 0,
  "net_amount"        NUMERIC(10,2) NOT NULL,
  "vat_amount"        NUMERIC(10,2) NOT NULL DEFAULT 0,
  "gross_amount"      NUMERIC(10,2) NOT NULL,
  "is_capital"        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Denormalised copy of the parent's hard lock, so the guard trigger on this
  -- table never has to read the parent. A local column is what keeps it
  -- restore-safe: a restored child arrives already carrying its own lock.
  "locked_period_id"  TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_transaction_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_transaction_lines_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "bk_transactions"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_transaction_lines_category_fkey"
    FOREIGN KEY ("category_id") REFERENCES "bk_categories"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_transaction_lines_rate_code_chk" CHECK ("vat_rate_code" IN
    ('standard', 'reduced', 'zero', 'exempt', 'outside_scope')),
  CONSTRAINT "bk_transaction_lines_treatment_chk" CHECK ("vat_treatment" IN
    ('domestic', 'ni_eu_acquisition', 'ni_eu_dispatch',
     'reverse_charge_services', 'import_pva', 'domestic_reverse_charge',
     'outside_scope')),
  -- The one arithmetic invariant worth a constraint. Exact, because these are
  -- NUMERIC and not floats.
  CONSTRAINT "bk_transaction_lines_gross_chk"
    CHECK ("gross_amount" = "net_amount" + "vat_amount")
);
CREATE INDEX IF NOT EXISTS "bk_transaction_lines_transaction_idx"
  ON "bk_transaction_lines" ("transaction_id");
CREATE INDEX IF NOT EXISTS "bk_transaction_lines_category_idx"
  ON "bk_transaction_lines" ("category_id");

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------
-- Evidence. HMRC expects records kept six years, so these are never garbage
-- collected: the module registers a core.media-usage-providers extension so the
-- library reports them as in use, AND keeps its own provider/key so a download
-- still works if the library row is deleted.
CREATE TABLE IF NOT EXISTS "bk_attachments" (
  "id"                  TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "transaction_id"      TEXT NOT NULL,
  "name"                TEXT NOT NULL,
  "filename"            TEXT NOT NULL,
  "url"                 TEXT NOT NULL,
  "media_provider"      TEXT,
  "media_key"           TEXT,
  "media_id"            TEXT,
  "mime_type"           TEXT NOT NULL,
  "size"                INTEGER NOT NULL DEFAULT 0,
  "sha256"              TEXT,
  "position"            INTEGER NOT NULL DEFAULT 0,
  "locked_period_id"    TEXT,
  "uploaded_by_user_id" TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_attachments_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "bk_transactions"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_attachments_transaction_idx"
  ON "bk_attachments" ("transaction_id");
CREATE INDEX IF NOT EXISTS "bk_attachments_media_idx"
  ON "bk_attachments" ("media_id");

-- ---------------------------------------------------------------------------
-- Period snapshots
-- ---------------------------------------------------------------------------
-- The frozen record of what was filed. `boxes` holds the nine values exactly as
-- sent, as STRINGS, so no JSON number ever gets near them.
CREATE TABLE IF NOT EXISTS "bk_period_snapshots" (
  "id"                 TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "period_id"          TEXT NOT NULL,
  "kind"               TEXT NOT NULL,
  "scheme"             TEXT NOT NULL,
  "boxes"              JSONB NOT NULL,
  "boxes_unrounded"    JSONB NOT NULL,
  "vrn"                TEXT,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "created_by_user_id" TEXT,
  -- Tamper-evidence chain, computed in application code and NOT in a trigger:
  -- a trigger would recompute hashes during a restore and destroy the very
  -- chain it was meant to protect.
  "chain_index"        BIGINT NOT NULL,
  "prev_hash"          TEXT,
  "row_hash"           TEXT NOT NULL,
  CONSTRAINT "bk_period_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_period_snapshots_period_fkey"
    FOREIGN KEY ("period_id") REFERENCES "bk_vat_periods"("id")
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bk_period_snapshots_kind_chk" CHECK ("kind" IN ('finalised', 'submitted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "bk_period_snapshots_chain_key"
  ON "bk_period_snapshots" ("chain_index");
CREATE INDEX IF NOT EXISTS "bk_period_snapshots_period_idx"
  ON "bk_period_snapshots" ("period_id");

-- Exactly which rows, at exactly which values, produced those boxes. Given a
-- snapshot you can reconstruct the arithmetic without trusting the live tables
-- at all - which is the whole of the digital-links audit trail.
CREATE TABLE IF NOT EXISTS "bk_period_snapshot_lines" (
  "id"              TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "snapshot_id"     TEXT NOT NULL,
  "transaction_id"  TEXT NOT NULL,
  "line_id"         TEXT NOT NULL,
  "direction"       TEXT NOT NULL,
  "vat_treatment"   TEXT NOT NULL,
  "vat_rate_code"   TEXT NOT NULL,
  "net_amount"      NUMERIC(10,2) NOT NULL,
  "vat_amount"      NUMERIC(10,2) NOT NULL,
  "boxes"           JSONB NOT NULL,
  CONSTRAINT "bk_period_snapshot_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_period_snapshot_lines_snapshot_fkey"
    FOREIGN KEY ("snapshot_id") REFERENCES "bk_period_snapshots"("id")
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_period_snapshot_lines_snapshot_idx"
  ON "bk_period_snapshot_lines" ("snapshot_id");

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
-- Append only, hash-chained in application code (lib/audit.ts).
CREATE TABLE IF NOT EXISTS "bk_audit_log" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "at"            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "actor_user_id" TEXT,
  "actor_email"   TEXT,
  "action"        TEXT NOT NULL,
  "entity_type"   TEXT NOT NULL,
  "entity_id"     TEXT,
  "summary"       TEXT NOT NULL,
  "detail"        JSONB,
  "ip_truncated"  TEXT,
  "chain_index"   BIGINT NOT NULL,
  "prev_hash"     TEXT,
  "row_hash"      TEXT NOT NULL,
  CONSTRAINT "bk_audit_log_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bk_audit_log_chain_key"
  ON "bk_audit_log" ("chain_index");
CREATE INDEX IF NOT EXISTS "bk_audit_log_entity_idx"
  ON "bk_audit_log" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "bk_audit_log_at_idx"
  ON "bk_audit_log" ("at");

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "bk_settings" (
  "id"                      TEXT NOT NULL DEFAULT 'singleton',
  "business_name"           TEXT,
  "business_type"           TEXT NOT NULL DEFAULT 'ltd',
  "vrn"                     TEXT,
  "vat_registered_from"     DATE,
  "scheme"                  TEXT NOT NULL DEFAULT 'accrual',
  "scheme_changed_at"       TIMESTAMPTZ,
  "period_frequency"        TEXT NOT NULL DEFAULT 'quarterly',
  "first_period_start"      DATE,
  -- The day the FIRST period ends, from HMRC's registration letter. HMRC ends
  -- every period on a calendar month end, so the first period - registration
  -- date to the first stagger month end - is routinely longer or shorter than
  -- the filing frequency suggests and cannot be derived from the start alone.
  "first_period_end"        DATE,
  "hmrc_environment"        TEXT NOT NULL DEFAULT 'sandbox',
  -- Error correction thresholds, configurable so an HMRC rule change is a
  -- settings edit and not a release. Defaults are the current Method 1 limits
  -- in VAT Notice 700/45 (checked 2026-08-20).
  "error_threshold_fixed"   NUMERIC(12,2) NOT NULL DEFAULT 10000.00,
  "error_threshold_percent" NUMERIC(5,2)  NOT NULL DEFAULT 1.00,
  "error_threshold_cap"     NUMERIC(12,2) NOT NULL DEFAULT 50000.00,
  -- How boxes 6 to 9 are reduced to whole pounds. HMRC's notices do not state a
  -- rule and both practices exist in the wild, so it is a setting with a
  -- documented default rather than whichever Math function was nearest to hand.
  "box_rounding"            TEXT NOT NULL DEFAULT 'nearest',
  "attachment_max_bytes"    INTEGER NOT NULL DEFAULT 15728640,
  "retention_years"         INTEGER NOT NULL DEFAULT 6,
  -- Optional override for Gov-Vendor-Public-IP. Left empty the module resolves
  -- the site's own hostname instead; see lib/hmrc/fraud-headers.ts.
  "vendor_public_ip"        TEXT,
  -- The install's own licence identifier, minted once. Gov-Vendor-License-IDs
  -- carries a SHA-256 of it, never the value itself; see migrations/018 and
  -- lib/hmrc/vendor-licence.ts for why it must never be rotated.
  "vendor_license_id"       TEXT DEFAULT gen_random_uuid()::text,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_settings_singleton_chk" CHECK ("id" = 'singleton'),
  CONSTRAINT "bk_settings_business_type_chk"
    CHECK ("business_type" IN ('ltd', 'sole_trader')),
  CONSTRAINT "bk_settings_scheme_chk" CHECK ("scheme" IN ('accrual', 'cash')),
  CONSTRAINT "bk_settings_env_chk" CHECK ("hmrc_environment" IN ('sandbox', 'production')),
  CONSTRAINT "bk_settings_rounding_chk" CHECK ("box_rounding" IN ('nearest', 'down')),
  CONSTRAINT "bk_settings_freq_chk"
    CHECK ("period_frequency" IN ('monthly', 'quarterly', 'annual'))
);

-- ---------------------------------------------------------------------------
-- HMRC connection
-- ---------------------------------------------------------------------------
-- One VRN per install in v1. Tokens are encrypted at rest with core's
-- lib/crypto/secrets.ts. A restored backup carries ciphertext written under a
-- DIFFERENT ENCRYPTION_KEY, so reads use tryDecryptSecret and a null means
-- "reconnect", not "error".
CREATE TABLE IF NOT EXISTS "bk_hmrc_connection" (
  "id"                        TEXT NOT NULL DEFAULT 'singleton',
  "vrn"                       TEXT,
  "environment"               TEXT NOT NULL DEFAULT 'sandbox',
  "status"                    TEXT NOT NULL DEFAULT 'never',
  "access_token_encrypted"    TEXT,
  "access_token_expires_at"   TIMESTAMPTZ,
  "refresh_token_encrypted"   TEXT,
  "refresh_token_expires_at"  TIMESTAMPTZ,
  "scope"                     TEXT,
  "connected_at"              TIMESTAMPTZ,
  "connected_by_user_id"      TEXT,
  "last_refresh_at"           TIMESTAMPTZ,
  "last_refresh_error"        TEXT,
  "updated_at"                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_hmrc_connection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_hmrc_connection_singleton_chk" CHECK ("id" = 'singleton'),
  CONSTRAINT "bk_hmrc_connection_status_chk"
    CHECK ("status" IN ('never', 'connected', 'expired', 'revoked'))
);

-- Short-lived CSRF state for the authorisation redirect.
CREATE TABLE IF NOT EXISTS "bk_hmrc_oauth_states" (
  "state"       TEXT NOT NULL,
  "user_id"     TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "return_to"   TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at"  TIMESTAMPTZ NOT NULL,
  CONSTRAINT "bk_hmrc_oauth_states_pkey" PRIMARY KEY ("state")
);

-- ---------------------------------------------------------------------------
-- HMRC API call log
-- ---------------------------------------------------------------------------
-- Every outbound call. Not decoration: production approval requires evidence
-- that fraud prevention headers were sent correctly, and this table IS that
-- evidence. The Authorization header and any token are never written.
CREATE TABLE IF NOT EXISTS "bk_hmrc_api_calls" (
  "id"             TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "at"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "environment"    TEXT NOT NULL,
  "method"         TEXT NOT NULL,
  "path"           TEXT NOT NULL,
  "status_code"    INTEGER,
  "duration_ms"    INTEGER,
  "correlation_id" TEXT,
  "receipt_id"     TEXT,
  "fraud_headers"  JSONB,
  "error_code"     TEXT,
  "error_body"     JSONB,
  "actor_user_id"  TEXT,
  CONSTRAINT "bk_hmrc_api_calls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "bk_hmrc_api_calls_at_idx" ON "bk_hmrc_api_calls" ("at");

-- ---------------------------------------------------------------------------
-- CSV import batches
-- ---------------------------------------------------------------------------
-- Imported rows land as drafts and are reviewed before they become records.
-- A draft reaches no VAT box and can be deleted freely.
CREATE TABLE IF NOT EXISTS "bk_import_batches" (
  "id"                  TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "filename"            TEXT NOT NULL,
  "preset"              TEXT,
  "row_count"           INTEGER NOT NULL DEFAULT 0,
  "created_count"       INTEGER NOT NULL DEFAULT 0,
  "duplicate_count"     INTEGER NOT NULL DEFAULT 0,
  "mapping"             JSONB,
  "created_by_user_id"  TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_import_batches_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
INSERT INTO "bk_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;
INSERT INTO "bk_hmrc_connection" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- System categories. Never deletable, only archivable: a 2019 return must still
-- be able to explain itself in 2026, and it can only do that if the categories
-- its lines point at are still there. The last five are not profit and loss
-- items, but they are things a small business genuinely records, and leaving
-- them out only means they get filed under "other expenses" and wreck the P&L.
INSERT INTO "bk_categories"
  ("code", "name", "direction", "sa103_box", "ct600_group", "is_trading", "is_capital", "position", "is_system")
VALUES
  ('sales',              'Sales and turnover',                  'income',  'SA103F.15', 'turnover',        TRUE,  FALSE,  10, TRUE),
  ('other-income',       'Other business income',               'income',  'SA103F.16', 'other-income',    TRUE,  FALSE,  20, TRUE),
  ('cogs',               'Cost of goods and materials',         'expense', 'SA103F.17', 'cost-of-sales',   TRUE,  FALSE,  30, TRUE),
  ('subcontractors',     'Subcontractor costs',                 'expense', 'SA103F.18', 'cost-of-sales',   TRUE,  FALSE,  40, TRUE),
  ('wages',              'Wages, salaries and staff costs',     'expense', 'SA103F.19', 'staff-costs',     TRUE,  FALSE,  50, TRUE),
  ('motor',              'Motor expenses',                      'expense', 'SA103F.20', 'admin-expenses',  TRUE,  FALSE,  60, TRUE),
  ('travel',             'Travel and subsistence',              'expense', 'SA103F.21', 'admin-expenses',  TRUE,  FALSE,  70, TRUE),
  ('premises',           'Rent, rates, power and insurance',    'expense', 'SA103F.22', 'admin-expenses',  TRUE,  FALSE,  80, TRUE),
  ('repairs',            'Repairs and renewals',                'expense', 'SA103F.23', 'admin-expenses',  TRUE,  FALSE,  90, TRUE),
  ('office',             'Phone, stationery and office costs',  'expense', 'SA103F.24', 'admin-expenses',  TRUE,  FALSE, 100, TRUE),
  ('advertising',        'Advertising and entertainment',       'expense', 'SA103F.25', 'admin-expenses',  TRUE,  FALSE, 110, TRUE),
  ('loan-interest',      'Interest on bank and other loans',    'expense', 'SA103F.26', 'finance-costs',   TRUE,  FALSE, 120, TRUE),
  ('bank-charges',       'Bank and card charges',               'expense', 'SA103F.27', 'finance-costs',   TRUE,  FALSE, 130, TRUE),
  ('bad-debts',          'Irrecoverable debts',                 'expense', 'SA103F.28', 'admin-expenses',  TRUE,  FALSE, 140, TRUE),
  ('professional',       'Accountancy, legal and professional', 'expense', 'SA103F.29', 'admin-expenses',  TRUE,  FALSE, 150, TRUE),
  ('depreciation',       'Depreciation and loss on sale',       'expense', 'SA103F.30', 'depreciation',    TRUE,  FALSE, 160, TRUE),
  ('other-expenses',     'Other business expenses',             'expense', 'SA103F.31', 'admin-expenses',  TRUE,  FALSE, 170, TRUE),
  ('capital-equipment',  'Equipment and capital purchases',     'expense', NULL,        'capital',         FALSE, TRUE,  180, TRUE),
  ('drawings',           'Drawings or dividends',               'expense', NULL,        'distributions',   FALSE, FALSE, 190, TRUE),
  ('capital-introduced', 'Money introduced by the owner',       'income',  NULL,        'capital',         FALSE, FALSE, 200, TRUE),
  ('vat-payment',        'VAT paid to or refunded by HMRC',     'both',    NULL,        'tax',             FALSE, FALSE, 210, TRUE),
  ('tax-payment',        'Corporation or income tax paid',      'expense', NULL,        'tax',             FALSE, FALSE, 220, TRUE)
ON CONFLICT ("code") DO NOTHING;
