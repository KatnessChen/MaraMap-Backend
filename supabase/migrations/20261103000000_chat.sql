-- Internal admin chatbot: saved conversations, plus the search the model calls
-- as a tool. See MaraMap-Frontend/docs/CHATBOT_PLAN.md.
create table chat_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- A snapshot rather than a foreign key, so an old answer still reads
  -- correctly after a cited post is renamed or deleted.
  citations jsonb not null default '[]',
  status text not null default 'done'
    check (status in ('done', 'stopped', 'truncated', 'failed')),
  error text,
  -- Assistant messages only.
  model text,
  thinking_level text,
  tool_calls jsonb,
  input_tokens int,
  cached_tokens int,
  output_tokens int,
  thinking_tokens int,
  cost_usd numeric(10, 6),
  first_token_ms int,
  latency_ms int,
  finish_reason text,
  created_at timestamptz not null default now()
);

create index chat_sessions_last_message_at_idx
  on chat_sessions (last_message_at desc);
create index chat_messages_session_id_created_at_idx
  on chat_messages (session_id, created_at);
-- Usage stats scan by time.
create index chat_messages_created_at_idx on chat_messages (created_at);

-- No policies on purpose: only the backend's service role reads these.
alter table chat_sessions enable row level security;
alter table chat_messages enable row level security;

-- Keywords are bound parameters here, unlike a PostgREST .or() string, so
-- model-written text containing commas or parentheses can't change the filter.
-- An empty keyword list means "everything matching the other filters", which
-- gives counting questions an exact total. Hidden posts are included: this is
-- only reachable through the admin-guarded chat endpoint.
create function chat_search_posts(
  p_user_id uuid,
  p_keywords text[] default '{}',
  p_category text default null,
  p_country text default null,
  p_race_name text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_limit int default 50,
  p_offset int default 0
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

-- Supabase exposes functions in public to the anon key by default, and this
-- one can read hidden posts.
revoke all on function chat_search_posts(uuid, text[], text, text, text, date, date, int, int)
  from public, anon, authenticated;
grant execute on function chat_search_posts(uuid, text[], text, text, text, date, date, int, int)
  to service_role;
