-- Backfill + drop legacy fb_posts columns that predate the metadata JSONB
-- model and are no longer read/written by any current code path.
--
-- Verified before writing this migration:
--   - is_overseas: populated on all 617 rows (576 false / 41 true), but no
--     API or ETL code reads or writes it.
--   - continent: populated on 106/617 rows; 38 of those have a value here
--     but NOT in metadata->>'continent' (the field the app actually reads),
--     so those posts' continent is invisible in the app today even though
--     the data exists. Backfill first so that data isn't lost.
--   - fb_posts_search_idx: GIN full-text index (title || content), 0 index
--     scans recorded, not referenced by any query in the codebase.

-- 1. Backfill metadata.continent from the legacy column where the app-facing
--    field is missing but the legacy one has an answer.
UPDATE fb_posts
SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{continent}', to_jsonb(continent))
WHERE continent IS NOT NULL
  AND (metadata ->> 'continent') IS NULL;

-- 2. Drop the unused full-text search index.
DROP INDEX IF EXISTS fb_posts_search_idx;

-- 3. Drop the legacy columns now that their data is preserved in metadata
--    (is_overseas has no equivalent used anywhere — dropped as-is).
ALTER TABLE fb_posts DROP COLUMN IF EXISTS continent;
ALTER TABLE fb_posts DROP COLUMN IF EXISTS is_overseas;
