-- ===========================================================================
-- 014_category_accounts.sql
--
-- The gap this closes: a category added through the settings screen had no
-- ledger account, and nothing said so until the books stopped balancing.
--
-- 006_accounts_and_journals.sql gave every SEEDED category an account, and
-- 009_ledger_mapping.sql made that mapping the thing the whole ledger turns on:
-- lib/ledger.ts posts the analysis side of a cashbook line to the account its
-- category points at. A category pointing at nothing posts to Suspense instead,
-- so the trial balance carries a balance nobody put there, the profit and loss
-- account is short by the same amount, and ledgerHealth() reports the books
-- unhealthy. The only way to get one was to add a category - which the settings
-- screen has always offered and which has never created the account to go with
-- it.
--
-- Creating the category and its account together is now lib/categories.ts's
-- job. This file catches up the ones added before that was true, and it is
-- written so it does nothing at all on an install where nothing is missing.
--
-- Shape of what it creates: a profit and loss account named after the category,
-- coded 'pl-<category code>', positioned after it - which is exactly what 006
-- did, so a category added last month ends up indistinguishable from one that
-- shipped with the module.
--
-- The one case it deliberately gets approximately right rather than exactly
-- right: a category whose CT600 grouping is 'capital' or 'distributions' is a
-- balance sheet posting, and this makes it a profit and loss account anyway. It
-- can only have got here through the API, there is no honest way to guess which
-- balance sheet account was meant, and a visible cost on the profit and loss
-- account is a far easier thing to notice and move than a silent Suspense
-- balance. The settings screen can now point it at the right one in a click.
--
-- Idempotent, and never edited after release - see 001_initial.sql's header.
-- ===========================================================================

-- Pass one: the obvious code. ON CONFLICT DO NOTHING covers an install where
-- 'pl-<code>' is already taken by an archived account from an earlier life.
INSERT INTO "bk_accounts"
  ("code", "name", "kind", "subtype", "category_id", "position", "report_group", "is_system")
SELECT
  'pl-' || c."code",
  c."name",
  CASE WHEN c."direction" = 'income' THEN 'income' ELSE 'expense' END,
  'profit_and_loss',
  c."id",
  1000 + c."position",
  CASE
    WHEN c."ct600_group" IN (
      'turnover', 'other-income', 'non-trade-income', 'property-income',
      'cost-of-sales', 'staff-costs', 'admin-expenses', 'depreciation',
      'finance-costs', 'tax'
    ) THEN c."ct600_group"
    WHEN c."direction" = 'income' THEN 'other-income'
    ELSE 'admin-expenses'
  END,
  FALSE
FROM "bk_categories" c
WHERE NOT EXISTS (SELECT 1 FROM "bk_accounts" a WHERE a."category_id" = c."id")
ON CONFLICT ("code") DO NOTHING;

-- Pass two: whatever pass one could not name. Same row, code suffixed with the
-- category's own id so the fallback is stable rather than a count of attempts.
INSERT INTO "bk_accounts"
  ("code", "name", "kind", "subtype", "category_id", "position", "report_group", "is_system")
SELECT
  'pl-' || c."code" || '-' || substr(md5(c."id"), 1, 6),
  c."name",
  CASE WHEN c."direction" = 'income' THEN 'income' ELSE 'expense' END,
  'profit_and_loss',
  c."id",
  1000 + c."position",
  CASE
    WHEN c."ct600_group" IN (
      'turnover', 'other-income', 'non-trade-income', 'property-income',
      'cost-of-sales', 'staff-costs', 'admin-expenses', 'depreciation',
      'finance-costs', 'tax'
    ) THEN c."ct600_group"
    WHEN c."direction" = 'income' THEN 'other-income'
    ELSE 'admin-expenses'
  END,
  FALSE
FROM "bk_categories" c
WHERE NOT EXISTS (SELECT 1 FROM "bk_accounts" a WHERE a."category_id" = c."id")
ON CONFLICT ("code") DO NOTHING;
