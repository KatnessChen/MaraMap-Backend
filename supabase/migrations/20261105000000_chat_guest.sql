-- Conversations from the passcode-protected /chat page. Each guest only sees
-- their own; null means the conversation belongs to the admin side. The nickname
-- is whatever the guest typed, so it identifies nobody for certain.
alter table chat_sessions
  add column guest_id uuid,
  add column guest_nickname text;

create index chat_sessions_guest_id_last_message_at_idx
  on chat_sessions (guest_id, last_message_at desc);

-- Same search, with hidden posts now opt-in so a caller that forgets the flag
-- can't expose them.
drop function chat_search_posts(uuid, text[], text, text, text, date, date, int, int);

create function chat_search_posts(
  p_user_id uuid,
  p_keywords text[] default '{}',
  p_category text default null,
  p_country text default null,
  p_race_name text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_limit int default 50,
  p_offset int default 0,
  p_include_hidden boolean default false
)
returns table (
  id uuid,
  title text,
  content text,
  event_date date,
  category varchar,
  is_hidden boolean,
  metadata jsonb,
  match_count int,
  total_count bigint
)
language sql
stable
set search_path = public
as $$
  with patterns as (
    select '%' || replace(replace(replace(k, '\', '\\'), '%', '\%'), '_', '\_') || '%' as pattern
    from unnest(p_keywords) as k
    where btrim(k) <> ''
  ),
  scored as (
    select
      p.*,
      (
        select count(*)::int
        from patterns
        where concat_ws(
          E'\n',
          p.title,
          p.content,
          p.metadata->>'race_name',
          p.metadata->>'mountain_name',
          p.metadata->>'country',
          p.metadata->>'city'
        ) ilike patterns.pattern
      ) as match_count
    from fb_posts p
    where p.user_id = p_user_id
      and (p_include_hidden or p.is_hidden is false)
      and (p_category is null or p.category = p_category)
      and (p_country is null or p.metadata->>'country' ilike '%' || p_country || '%')
      and (p_race_name is null or p.metadata->>'race_name' ilike '%' || p_race_name || '%')
      and (p_date_from is null or p.event_date >= p_date_from)
      and (p_date_to is null or p.event_date <= p_date_to)
  ),
  hits as (
    select * from scored
    where match_count > 0 or not exists (select 1 from patterns)
  )
  select
    h.id,
    h.title,
    h.content,
    h.event_date,
    h.category,
    h.is_hidden,
    h.metadata,
    h.match_count,
    count(*) over () as total_count
  from hits h
  order by h.match_count desc, h.event_date desc, h.id
  limit p_limit
  offset p_offset
$$;

revoke all on function chat_search_posts(uuid, text[], text, text, text, date, date, int, int, boolean)
  from public, anon, authenticated;
grant execute on function chat_search_posts(uuid, text[], text, text, text, date, date, int, int, boolean)
  to service_role;
