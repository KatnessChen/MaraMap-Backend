-- The 2026-09-03 seed migration's city_translations INSERT intended 180
-- rows (see supabase/migrations/20260903_location_translations.sql), but a
-- diff against the live table found exactly 1 missing: ('香港', '香港',
-- 'Hong Kong'). All 179 other rows, including the structurally identical
-- ('澳門', '澳門', 'Macau') a few lines above it in the same statement,
-- applied correctly — cause unconfirmed (possibly a transient issue during
-- the original `supabase db push`), but the fix is simply to insert the one
-- row that's missing.
insert into city_translations (country_zh, zh, en) values ('香港', '香港', 'Hong Kong')
on conflict (country_zh, zh) do nothing;
