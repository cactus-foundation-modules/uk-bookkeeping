-- ===========================================================================
-- 013_asset_prompts.sql
--
-- The gap this closes: buying a desk is TWO records, and only one of them was
-- ever prompted for.
--
-- Coding a purchase to a capital category keeps its cost out of the profit and
-- loss account, which is correct and is also the entire extent of what used to
-- happen. Nothing asked for the asset register entry that goes with it, and an
-- asset that is not in the register gets no capital allowances - so the cost
-- sits on the balance sheet doing nothing, the corporation tax computation is
-- silently short by it, and the only symptom is a tax bill that is too big by
-- an amount nobody can see. `bk_fixed_assets` has had a `transaction_id`
-- column since 011 waiting for exactly this and nothing has ever written it.
--
-- Two columns and a draft state:
--
--   bk_transaction_lines.register_asset - the tick. PER LINE, on purpose: one
--   receipt can be a desk and a chair, and that is two assets with two
--   depreciation lives, not one entry with a flag on it. Deliberately NOT the
--   same thing as is_capital, which is an accounting treatment that follows the
--   category. A stage payment on a building is capital and is not a second
--   asset; unticking it must not quietly move the cost into the P&L.
--
--   bk_fixed_assets.status - 'draft' until a human has said what the
--   depreciation and the capital allowances are. A draft is inert: no
--   depreciation is charged on it and it claims no allowances, because both of
--   those are judgements and the whole module's rule is that it never invents
--   one. Existing rows default to 'active', which is what they are.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The tick
-- ---------------------------------------------------------------------------
-- FALSE rather than following is_capital, for every row that already exists.
-- Backfilling a tick would manufacture a draft asset for every capital line
-- ever recorded the moment this deploys, and an owner who has already put those
-- assets in the register by hand would be handed a screen full of duplicates of
-- their own work. New entries get the tick offered; history is left alone.
ALTER TABLE "bk_transaction_lines"
  ADD COLUMN IF NOT EXISTS "register_asset" BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- The draft state
-- ---------------------------------------------------------------------------
ALTER TABLE "bk_fixed_assets"
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';

-- Which line of which purchase it came from. The position rather than the line
-- id, because saving an edited entry replaces its lines wholesale - they have
-- no identity a human refers to - so a foreign key to the line row would be
-- broken by an ordinary correction, and a broken link means a second draft for
-- an asset that is already on the register.
ALTER TABLE "bk_fixed_assets"
  ADD COLUMN IF NOT EXISTS "transaction_line_position" INTEGER;

DO $$ BEGIN
  ALTER TABLE "bk_fixed_assets"
    ADD CONSTRAINT "bk_fixed_assets_status_chk" CHECK ("status" IN ('draft', 'active'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One asset per ticked line, enforced here rather than hoped for in TypeScript.
-- This is what makes re-saving an entry a no-op instead of a duplicate, and it
-- is also why the position had to exist: keying on the transaction alone would
-- allow the desk and the chair on one receipt to be one asset between them.
CREATE UNIQUE INDEX IF NOT EXISTS "bk_fixed_assets_source_line_idx"
  ON "bk_fixed_assets" ("transaction_id", "transaction_line_position")
  WHERE "transaction_id" IS NOT NULL AND "transaction_line_position" IS NOT NULL;

-- Drafts are read constantly - the count sits on the dashboard - and there are
-- never many of them. Partial index, so it costs nothing once they are dealt
-- with, which is the state the register should spend most of its life in.
CREATE INDEX IF NOT EXISTS "bk_fixed_assets_draft_idx"
  ON "bk_fixed_assets" ("acquired_date")
  WHERE "status" = 'draft';
