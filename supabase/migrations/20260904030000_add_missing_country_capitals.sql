-- Russia/Laos/Palau/Faroe Islands/Mongolia had zero rows in city_translations
-- for the same reason Iceland did (see 20260904020000): never present in the
-- original LOCATION_DATA source list. Adds one representative city per
-- country (capital, or largest city where the legal capital is impractical
-- e.g. Palau's Ngerulmud), matching the "1 city" pattern already used for
-- other minor countries (Chile, Finland, Kenya, etc.).
insert into city_translations (country_zh, zh, en) values
  ('俄羅斯', '莫斯科', 'Moscow'),
  ('寮國', '永珍', 'Vientiane'),
  ('帛琉', '科羅爾', 'Koror'),
  ('法羅群島', '托爾斯港', 'Tórshavn'),
  ('蒙古', '烏蘭巴托', 'Ulaanbaatar')
on conflict (country_zh, zh) do nothing;
