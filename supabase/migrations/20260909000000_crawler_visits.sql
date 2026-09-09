-- Table: per-request log of known AI crawler/agent hits.
--
-- Unlike page_views (aggregate human_views/bot_views counters fed by the
-- frontend's client-side beacon, PageViewTracker.tsx — which only fires
-- when JS executes and so misses most AI crawlers that fetch raw HTML/JSON
-- directly), this is a server-side per-visit log, written from
-- CrawlerLogMiddleware for every request matching a known AI crawler UA.
-- Kept granular (one row per hit) so it can answer "which posts/routes are
-- which bots actually hitting" — the data behind deciding what to gate.
create table if not exists crawler_visits (
  id          bigint generated always as identity primary key,
  bot_name    text not null,
  method      text not null,
  path        text not null,
  user_agent  text not null,
  ip          text,
  created_at  timestamptz not null default now()
);

create index if not exists crawler_visits_path_idx on crawler_visits (path);
create index if not exists crawler_visits_bot_name_idx on crawler_visits (bot_name);
create index if not exists crawler_visits_created_at_idx on crawler_visits (created_at);
