-- Table: per-page view counts
create table if not exists page_views (
  path         text primary key,
  human_views  bigint not null default 0,
  bot_views    bigint not null default 0
);

-- Function: atomic increment (avoids race conditions)
create or replace function increment_page_view(p_path text, p_field text)
returns void
language plpgsql
as $$
begin
  insert into page_views (path, human_views, bot_views)
  values (
    p_path,
    case when p_field = 'human_views' then 1 else 0 end,
    case when p_field = 'bot_views'   then 1 else 0 end
  )
  on conflict (path) do update
    set human_views = page_views.human_views + case when p_field = 'human_views' then 1 else 0 end,
        bot_views   = page_views.bot_views   + case when p_field = 'bot_views'   then 1 else 0 end;
end;
$$;
