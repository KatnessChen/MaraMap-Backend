-- bot_views was fed by PageViewTracker.tsx's client-side beacon, which only
-- fires after JS executes in a real browser. Real AI crawlers (GPTBot,
-- ClaudeBot, etc.) fetch raw HTML/JSON directly and never run that JS, so
-- the counter was structurally blind to the traffic it was meant to
-- measure (17 hits total, homepage only). crawler_visits
-- (20260909000000_crawler_visits.sql), written server-side from every
-- request, replaces it as the source of truth for bot traffic.
alter table page_views drop column if exists bot_views;

drop function if exists increment_page_view(text, text);

create or replace function increment_page_view(p_path text)
returns void
language plpgsql
as $$
begin
  insert into page_views (path, human_views)
  values (p_path, 1)
  on conflict (path) do update
    set human_views = page_views.human_views + 1;
end;
$$;
