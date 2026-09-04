-- Correct 3 country_translations.en values that don't match
-- MaraMap-Frontend/public/countries.geojson's `properties.name` — found by
-- cross-referencing all 75 seeded rows against the real GeoJSON after the
-- 2026-09-03 seed pulled these from the frontend's unverified COUNTRY_EN_MAP
-- rather than the backend's GeoJSON-proven COUNTRY_NAME_MAP. Until this
-- migration, these 3 countries' choropleth fill on MapView.tsx would never
-- match, no matter how many visited posts they had.
update country_translations set en = 'United Republic of Tanzania' where zh = '坦尚尼亞';
update country_translations set en = 'Republic of Serbia' where zh = '塞爾維亞';
update country_translations set en = 'United Arab Emirates' where zh = '阿拉伯聯合大公國';
