-- Davis added a post about 約旦 (Jordan) but it never rendered on the
-- choropleth map: country_translations had no row for it, so
-- FbPostsService.countryEn() fell back to returning the untranslated
-- Chinese string, which never matches the GeoJSON's "Jordan" name.
insert into country_translations (zh, en) values
  ('約旦', 'Jordan')
on conflict (zh) do nothing;
