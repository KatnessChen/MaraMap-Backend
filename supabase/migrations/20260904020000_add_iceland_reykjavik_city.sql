-- Iceland (冰島) had zero rows in city_translations because it was never
-- present in the original LOCATION_DATA source list that seeded the
-- 2026-09-03 migration. Same gap exists for Russia/Laos/Palau/Faroe
-- Islands/Mongolia, but this one adds only the city the user asked for.
insert into city_translations (country_zh, zh, en) values ('冰島', '雷克雅維克', 'Reykjavik')
on conflict (country_zh, zh) do nothing;
