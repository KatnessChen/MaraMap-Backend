-- Computed column so /locations doesn't need to fetch the full `media`
-- array (avg ~21 items/post, up to 628) just to find one representative
-- geotagged photo. PostgREST exposes any function taking a single arg of
-- the table's row type as a selectable "computed column" — so the query
-- can select `rep_media:fb_posts_rep_media` instead of the raw `media`
-- column, and Postgres does the array scan server-side, returning only
-- the small derived object.
CREATE OR REPLACE FUNCTION fb_posts_rep_media(rec fb_posts)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH rep AS (
    SELECT m
    FROM jsonb_array_elements(COALESCE(rec.media, '[]'::jsonb)) m
    WHERE (m ->> 'lat') ~ '^-?[0-9]+(\.[0-9]+)?$'
      AND (m ->> 'lng') ~ '^-?[0-9]+(\.[0-9]+)?$'
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'lat', (SELECT (m ->> 'lat')::double precision FROM rep),
    'lng', (SELECT (m ->> 'lng')::double precision FROM rep),
    'uri', COALESCE((SELECT m ->> 'uri' FROM rep), rec.media -> 0 ->> 'uri'),
    'photo_count', COALESCE(jsonb_array_length(rec.media), 0)
  );
$$;
