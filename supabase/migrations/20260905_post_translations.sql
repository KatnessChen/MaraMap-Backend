-- zh->en translation pipeline: article title/content cache + a proper-noun
-- glossary for race and mountain names, editable via admin (mirrors
-- country_translations/city_translations in 20260903_location_translations.sql).
--
-- Content translation is triggered lazily (first English reader of a given
-- post) rather than batch-translated upfront, to avoid paying to translate
-- articles nobody ever reads in English. `content_status` is the
-- concurrency claim for that: a request atomically flips it from NULL to
-- 'pending' (via `UPDATE ... WHERE content_status IS NULL`) before calling
-- Gemini; only the request that wins the flip calls the API. 'failed', or a
-- 'pending' row older than a short timeout, is treated as retryable by the
-- next request. `title` is populated eagerly for every post in one cheap
-- batch (see src/translations/translations.service.ts) since list/map/home
-- views need an English title for every card, not just the ones someone has
-- opened.
create table if not exists post_translations (
  post_id uuid not null references fb_posts(id) on delete cascade,
  locale text not null,
  title text,
  content text,
  content_status text check (content_status in ('pending', 'done', 'failed')),
  -- when the current content_status='pending' claim was taken; a claim older
  -- than the retry timeout (see translations.service.ts) is treated as a
  -- crashed attempt and can be reclaimed by the next reader.
  content_claimed_at timestamptz,
  source text check (source in ('machine', 'human')),
  model text,
  translated_at timestamptz,
  reviewed_at timestamptz,
  primary key (post_id, locale)
);

-- Proper-noun glossaries, keyed on the raw zh string as it appears in
-- fb_posts.metadata (there's no normalized race/mountain entity — see
-- MarathonMetadataDto.race_name / metadata.mountain_name). `needs_review`
-- flags an AI-guessed entry an admin hasn't confirmed yet; `source` records
-- where the en value came from so a reviewer can judge how much to trust it.
create table if not exists race_translations (
  zh text primary key,
  en text not null,
  source text not null,
  needs_review boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists mountain_translations (
  zh text primary key,
  en text not null,
  source text not null,
  needs_review boolean not null default false,
  updated_at timestamptz not null default now()
);

-- World Marathon Majors: 7 established races + Cape Town, confirmed as the
-- 8th major and debuting as one in the May 2027 edition (per Abbott World
-- Marathon Majors' own announcement, checked 2026-09). A Shanghai bid for a
-- 9th major is still only a candidacy pending a December 2026 evaluation —
-- deliberately NOT seeded here since it isn't official yet. This also
-- resolves the "客戶改稱「九大馬」，但尚未確認新增的兩場是哪兩場" TODO left
-- in etl_local/02_classify/ai-classify.js: as of now it's eight, not nine.
--
-- Rows marked '(observed variant)' are exact strings seen in the live
-- fb_posts.metadata.race_name data (year prefixes, abbreviations) — kept as
-- separate rows rather than relying on lookup-time normalization to catch
-- every case a post happens to use.
insert into race_translations (zh, en, source, needs_review) values
  ('東京馬拉松', 'Tokyo Marathon', 'official', false),
  ('日本東京馬拉松', 'Tokyo Marathon', 'official', false), -- observed variant
  ('波士頓馬拉松', 'Boston Marathon', 'official', false),
  ('倫敦馬拉松', 'London Marathon', 'official', false),
  ('倫敦馬', 'London Marathon', 'official', false), -- observed variant
  ('柏林馬拉松', 'Berlin Marathon', 'official', false),
  ('芝加哥馬拉松', 'Chicago Marathon', 'official', false),
  ('紐約馬拉松', 'New York City Marathon', 'official', false),
  ('雪梨馬拉松', 'Sydney Marathon', 'official', false),
  ('開普敦馬拉松', 'Cape Town Marathon', 'official', false),
  -- Domestic races confirmed via the race's own bilingual official site
  -- (taipeicitymarathon.com) during planning research.
  ('台北馬拉松', 'Taipei Marathon', 'official', false),
  ('臺北馬拉松', 'Taipei Marathon', 'official', false), -- 臺/台 variant seen in the data
  -- Inferred, not independently verified against an official source —
  -- surfaced in the admin glossary review queue rather than asserted as fact.
  ('台北渣打馬', 'Taipei Standard Chartered Marathon', 'inferred', true),
  ('台北渣打馬拉松', 'Taipei Standard Chartered Marathon', 'inferred', true)
on conflict (zh) do nothing;

-- All 100 Baiyue (百岳) peaks, cross-checked from both
-- en.wikipedia.org/wiki/100_Peaks_of_Taiwan (source table, not the article's
-- prose) and zh.wikipedia.org/wiki/台灣百岳 (interactive map's rank->title
-- links). One correction applied: the English article's rank-44 row reads
-- "Zhijiayangdashan (佳陽山)", but the Chinese article's own map links rank
-- 44 to 志佳陽大山, not 佳陽山 (which is rank 50, a distinct, separate
-- peak) — used 志佳陽大山 for rank 44 here. This is still a
-- community-maintained encyclopedia, not a government registry (no such
-- registry exists for these — see planning notes), so source is 'wikipedia'
-- rather than 'official'; spot-check before treating any single row as
-- gospel.
--
-- Most of the mountain names actually seen in fb_posts.metadata.mountain_name
-- are small suburban/urban hills outside the Baiyue list entirely (七星山,
-- 南港山, 劍潭山, etc.) — expected, since Baiyue are specifically the 100
-- peaks over ~3,000m. Those fall through to the AI-translate-and-review path
-- by design; there's no external "official name" source for them to seed
-- from, and a straightforward transliteration is the right answer for a
-- minor hill anyway.
insert into mountain_translations (zh, en, source, needs_review) values
  ('玉山', 'Yushan', 'wikipedia', false),
  ('雪山', 'Xueshan', 'wikipedia', false),
  ('玉山東峰', 'Yushan East Peak', 'wikipedia', false),
  ('玉山北峰', 'Yushan North Peak', 'wikipedia', false),
  ('玉山南峰', 'Yushan South Peak', 'wikipedia', false),
  ('秀姑巒山', 'Xiuguluanshan', 'wikipedia', false),
  ('馬博拉斯山', 'Mabolasishan', 'wikipedia', false),
  ('南湖大山', 'Nanhudashan', 'wikipedia', false),
  ('東小南山', 'Dongxiaonanshan', 'wikipedia', false),
  ('中央尖山', 'Central Range Point', 'wikipedia', false),
  ('雪山北峰', 'Xueshan North Peak', 'wikipedia', false),
  ('關山', 'Guanshan', 'wikipedia', false),
  ('大水堀山', 'Dashuikushan', 'wikipedia', false),
  ('南湖大山東峰', 'Nanhushan East Peak', 'wikipedia', false),
  ('東郡大山', 'Dongjundashan', 'wikipedia', false),
  ('奇萊山北峰', 'Qilaishan North Peak', 'wikipedia', false),
  ('向陽山', 'Xiangyangshan', 'wikipedia', false),
  ('大劍山', 'Dajianshan', 'wikipedia', false),
  ('雲峰', 'Yunfeng', 'wikipedia', false),
  ('奇萊山', 'Qilaishan', 'wikipedia', false),
  ('馬利加南山', 'Malijiananshan', 'wikipedia', false),
  ('南湖北山', 'Nanhubeishan', 'wikipedia', false),
  ('大雪山', 'Daxueshan', 'wikipedia', false),
  ('品田山', 'Pintianshan', 'wikipedia', false),
  ('玉山西峰', 'Yushan West Peak', 'wikipedia', false),
  ('頭鷹山', 'Touyingshan', 'wikipedia', false),
  ('三叉山', 'Sanchashan', 'wikipedia', false),
  ('大霸尖山', 'Dabajianshan', 'wikipedia', false),
  ('南湖大山南峰', 'Nanhushan South Peak', 'wikipedia', false),
  ('東巒大山', 'Dongluandashan', 'wikipedia', false),
  ('無明山', 'Wumingshan', 'wikipedia', false),
  ('巴巴山', 'Babashan', 'wikipedia', false),
  ('馬西山', 'Maxishan', 'wikipedia', false),
  ('合歡山北峰', 'Hehuanshan North Peak', 'wikipedia', false),
  ('合歡北峰', 'Hehuanshan North Peak', 'wikipedia', false), -- observed variant (missing 山)
  ('合歡山東峰', 'Hehuanshan East Peak', 'wikipedia', false),
  ('小霸尖山', 'Xiaobajianshan', 'wikipedia', false),
  ('合歡山主峰', 'Hehuanshan Main Peak', 'wikipedia', false),
  ('南玉山', 'South Yushan', 'wikipedia', false),
  ('畢綠山', 'Bilushan', 'wikipedia', false),
  ('桌社大山', 'Zhuoshedashan', 'wikipedia', false),
  ('奇萊山南峰', 'Qilaishan South Peak', 'wikipedia', false),
  ('南雙頭山', 'Nanshuangtoushan', 'wikipedia', false),
  ('能高山南峰', 'Nenggaoshan South Peak', 'wikipedia', false),
  ('志佳陽大山', 'Zhijiayangdashan', 'wikipedia', false),
  ('白姑大山', 'Baigudashan', 'wikipedia', false),
  ('八通關山', 'Batongguanshan', 'wikipedia', false),
  ('新康山', 'Xinkangshan', 'wikipedia', false),
  ('丹大山', 'Dandashan', 'wikipedia', false),
  ('桃山', 'Taoshan', 'wikipedia', false),
  ('佳陽山', 'Jiayangshan', 'wikipedia', false),
  ('火石山', 'Huoshishan', 'wikipedia', false),
  ('池有山', 'Chiyoushan', 'wikipedia', false),
  ('伊澤山', 'Yizeshan', 'wikipedia', false),
  ('卑南主山', 'Beinanzhushan', 'wikipedia', false),
  ('干卓萬山', 'Ganzhuowanshan', 'wikipedia', false),
  ('太魯閣大山', 'Taroko Mountain', 'wikipedia', false),
  ('轆轆山', 'Lulushan', 'wikipedia', false),
  ('喀西帕南山', 'Kaxipananshan', 'wikipedia', false),
  ('內嶺爾山', 'Neilingershan', 'wikipedia', false),
  ('鈴鳴山', 'Lingmingshan', 'wikipedia', false),
  ('郡大山', 'Jundashan', 'wikipedia', false),
  ('能高山', 'Nenggaoshan', 'wikipedia', false),
  ('萬東山西峰', 'Wandongshan West Peak', 'wikipedia', false),
  ('劍山', 'Jianshan', 'wikipedia', false),
  ('屏風山', 'Pingfengshan', 'wikipedia', false),
  ('小關山', 'Xiaoguanshan', 'wikipedia', false),
  ('義西請馬至山', 'Yixiqingmazhishan', 'wikipedia', false),
  ('牧山', 'Mushan', 'wikipedia', false),
  ('玉山前鋒', 'Yushan Front Peak', 'wikipedia', false),
  ('玉山主峰', 'Yushan', 'wikipedia', false), -- observed variant (主峰 = "main peak", same peak as rank 1)
  ('石門山', 'Shimenshan', 'wikipedia', false),
  ('無雙山', 'Wushuangshan', 'wikipedia', false),
  ('塔關山', 'Taguanshan', 'wikipedia', false),
  ('馬比杉山', 'Mabishanshan', 'wikipedia', false),
  ('達芬尖山', 'Dafenjianshan', 'wikipedia', false),
  ('雪山東峰', 'Xueshan East Peak', 'wikipedia', false),
  ('南華山', 'Nanhuashan', 'wikipedia', false),
  ('關山嶺山', 'Guanshanlingshan', 'wikipedia', false),
  ('海諾南山', 'Hainuonanshan', 'wikipedia', false),
  ('中雪山', 'Zhongxueshan', 'wikipedia', false),
  ('閂山', 'Shuanshan', 'wikipedia', false),
  ('甘薯峰', 'Ganshufeng', 'wikipedia', false),
  ('西合歡山', 'Hehuanshan West Peak', 'wikipedia', false),
  ('審馬陣山', 'Shenmazhenshan', 'wikipedia', false),
  ('喀拉業山', 'Kalayeshan', 'wikipedia', false),
  ('庫哈諾辛山', 'Kuhanuoxinshan', 'wikipedia', false),
  ('加利山', 'Jialishan', 'wikipedia', false),
  ('白石山', 'Baishishan', 'wikipedia', false),
  ('磐石山', 'Panshishan', 'wikipedia', false),
  ('帕托魯山', 'Patuolushan', 'wikipedia', false),
  ('北大武山', 'Beidawushan', 'wikipedia', false),
  ('西巒大山', 'Xiluandashan', 'wikipedia', false),
  ('塔芬山', 'Tafenshan', 'wikipedia', false),
  ('立霧主山', 'Liwuzhushan', 'wikipedia', false),
  ('安東軍山', 'Andongjunshan', 'wikipedia', false),
  ('光頭山', 'Guangtoushan', 'wikipedia', false),
  ('羊頭山', 'Yangtoushan', 'wikipedia', false),
  ('布拉克桑山', 'Bulakesangshan', 'wikipedia', false),
  ('駒盆山', 'Jupenshan', 'wikipedia', false),
  ('六順山', 'Liushunshan', 'wikipedia', false),
  ('鹿山', 'Lushan', 'wikipedia', false)
on conflict (zh) do nothing;
