-- The 2026-09-03 seed migration accidentally inserted Taiwan twice: the
-- correct '台灣' and a typo'd '台 灣' (stray space). Verified unreferenced
-- before removal: zero rows in city_translations point at '台 灣' (all 12
-- Taiwan cities use the correct '台灣'), and zero fb_posts have
-- metadata->>'country' = '台 灣'.
delete from country_translations where zh = '台 灣';
