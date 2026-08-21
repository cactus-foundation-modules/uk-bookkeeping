-- ===========================================================================
-- 010_accounting_periods.sql
--
-- Financial years, and closing one.
--
-- A VAT period and a financial year are different things and the module needs
-- both. A VAT quarter decides what goes on a return; a financial year decides
-- what goes on a set of accounts and on a corporation tax return, and it is the
-- unit a profit and loss account and a balance sheet are drawn up for. They do
-- not line up, they do not have to line up, and pretending one is the other is
-- how a company ends up filing a tax return for three months of trade.
--
-- Closing a year does two things. It posts a journal moving every profit and
-- loss balance to retained earnings, so the new year starts from zero and the
-- balance sheet carries the profit forward the way it should. And it freezes
-- the year: nothing dated inside a closed year can be added, changed or removed
-- until it is reopened.
--
-- That freeze is enforced in the application (lib/guards.ts) rather than by a
-- trigger, deliberately, and the distinction matters. A filed VAT return is a
-- statement made to HMRC and its rows get a HARD lock in the database, because
-- the consequence of altering one is a false return. A closed year is a
-- bookkeeping decision the owner made and can unmake - the accountant finds
-- something in March that belongs in the year to December, and reopening,
-- posting and re-closing is the ordinary answer rather than an emergency.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "bk_accounting_periods" (
  "id"                  TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  -- What the owner calls it. "Year to 31 March 2026", by default.
  "name"                TEXT NOT NULL,
  "start_date"          DATE NOT NULL,
  "end_date"            DATE NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'open',   -- open | closed
  -- The journal that moved the profit to reserves. Deleted when the year is
  -- reopened, which is why this is SET NULL rather than RESTRICT.
  "close_journal_id"    TEXT,
  "closed_at"           TIMESTAMPTZ,
  "closed_by_user_id"   TEXT,
  "notes"               TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "bk_accounting_periods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bk_accounting_periods_status_chk" CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "bk_accounting_periods_dates_chk" CHECK ("end_date" >= "start_date"),
  -- One year per start date. Overlap in general is checked in the application,
  -- where the refusal can be a sentence; this catches the obvious duplicate at
  -- the only place a constraint usefully can.
  CONSTRAINT "bk_accounting_periods_start_key" UNIQUE ("start_date"),
  CONSTRAINT "bk_accounting_periods_end_key" UNIQUE ("end_date"),
  -- DEFERRABLE, like every other foreign key in this module: a restore loads
  -- table by table and the journal may not be in yet.
  CONSTRAINT "bk_accounting_periods_close_journal_fkey"
    FOREIGN KEY ("close_journal_id") REFERENCES "bk_journals"("id")
    ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS "bk_accounting_periods_range_idx"
  ON "bk_accounting_periods" ("start_date", "end_date");
CREATE INDEX IF NOT EXISTS "bk_accounting_periods_status_idx"
  ON "bk_accounting_periods" ("status");

-- Marks the journal a year-end close posted, so reopening can find and remove
-- exactly that one and nothing else. 'year_end' joins 'manual', 'template' and
-- 'import' in bk_journals.source, which has no CHECK constraint on it.
COMMENT ON COLUMN "bk_accounting_periods"."close_journal_id" IS
  'The journal posted by closing this year. Its source is ''year_end''.';
