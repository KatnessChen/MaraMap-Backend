-- Indexes for query patterns that currently full-scan fb_posts.
-- Existing indexes (idx_fb_posts_user_id, idx_fb_posts_date) don't cover
-- is_hidden, category, sub_categories, trip_id, or the metadata->> text
-- filters used across FbPostsService (findAll, findLocations, findByCountry,
-- getCategories, findByTripId).

-- Covers the (user_id, is_hidden, event_date DESC) pattern used by every
-- public-facing list/location query.
CREATE INDEX IF NOT EXISTS idx_fb_posts_user_hidden_date
  ON fb_posts (user_id, is_hidden, event_date DESC);

-- category = '...' (findAll, findLocations) and category IN (...) (getCategories)
CREATE INDEX IF NOT EXISTS idx_fb_posts_category
  ON fb_posts (category);

-- trip_id = '...' (findByTripId); most rows have no trip_id so partial index
-- keeps it small.
CREATE INDEX IF NOT EXISTS idx_fb_posts_trip_id
  ON fb_posts (trip_id)
  WHERE trip_id IS NOT NULL;

-- sub_categories.contains([x]) (findAll, findLocations) — jsonb array
-- containment needs GIN, a btree index can't serve @> queries.
CREATE INDEX IF NOT EXISTS idx_fb_posts_sub_categories
  ON fb_posts USING GIN (sub_categories);

-- metadata->>'country' / 'city' / 'continent' ILIKE '%...%' (findAll).
-- Trigram GIN lets ILIKE with a leading wildcard use an index instead of a
-- full scan; a plain btree expression index can't help with '%...%' at all.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_fb_posts_metadata_country_trgm
  ON fb_posts USING GIN ((metadata ->> 'country') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_fb_posts_metadata_city_trgm
  ON fb_posts USING GIN ((metadata ->> 'city') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_fb_posts_metadata_continent_trgm
  ON fb_posts USING GIN ((metadata ->> 'continent') gin_trgm_ops);
