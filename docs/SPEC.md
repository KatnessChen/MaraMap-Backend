# 🏗️ MaraMap-Backend: Nest.js Backend & Database Spec

## 1. Module Overview

This Nest.js application serves as the Content API for the MaraMap platform. Its primary responsibilities are:

- **The Content API:** Serving structured, AI-classified blog posts and geotagged map data to the Next.js frontend.
- **Data Ingestion (Script-based):** Handling data extraction, AI classification, and cloud storage migration via local scripts for maximum efficiency and cost control.

**Design Philosophy:** The backend is a lean Content API. All heavy lifting (parsing raw data, AI analysis, media migration) happens via controlled local scripts before the data reaches the production API.

**Environment:** 
- **Production:** Runs in **Taiwan** (GCP asia-east1) for optimal low-latency service to end users.

---

## 2. Core API Endpoints (api/v1)

### 2.1 Post & Map API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/posts` | GET | Public | Paginated posts. Filters: `category`, `sub_category`, `startDate`, `endDate`, `search`, `tag`, `continent`, `country`, `city`, `user_id`. `status`/`order` only apply for admin callers. |
| `/posts/search` | GET | Public | Fuzzy search across title/content, `limit`/`offset` paginated. |
| `/posts/:id` | GET | Public | Single post detail. |
| `/posts/:id` | PATCH | Admin | Edit a post. Blocked if `is_ai_editing_locked` is set. |
| `/posts/:id` | DELETE | Admin | Delete a post. |
| `/posts/trip/:tripId` | GET | Public | All posts sharing a `trip_id`, for the "same trip" panel. |
| `/personal-best` | GET | Public | Aggregated PB timeline per participant, per distance. Cached (see §4.4). |
| `/locations` | GET | Public | Flattened map pins. Filters: `category`, `sub_category`, `start_date`, `end_date`, `search`, `geoOnly` (default `true`, set `false` to include posts without coordinates). `Cache-Control: public, max-age=60, stale-while-revalidate=300`. |
| `/locations/by-country` | GET | Public | All races/events for a given country (required `country` query param). |
| `/categories` | GET | Public | Category + sub-category counts (馬拉松/旅遊/登山). |
| `/geocode` | GET | Admin | One-off `country`/`city` → `{lat, lng}` lookup via Nominatim, used by the admin edit UI's "自動定位" button. |

### 2.2 Auth & Stats

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/auth/login` | POST | Public | `{ email, password }` → JWT bearer token (checked against `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars, not Supabase auth). |
| `/stats` | GET | Public | `?participant=Name` → `{ fm_count, country_count }` from `participant_stats`. |
| `/stats/visit` | POST | Public | Records a page view (human vs. bot, into `page_views`). |
| `/stats/visits` | GET | Public | Total human/bot view counts. |
| `/stats/refresh` | POST | Admin | Forces the daily `refreshAllStats()` cron job to run immediately. |

All non-`@Public()` routes require `Authorization: Bearer <token>` from `/auth/login` (see `AdminGuard`).

---

## 3. Data Ingestion Workflow (`etl_local/`)

Numbered pipeline stages. As of 2026-07-24 these run two ways, not one: an
admin can upload a Facebook export zip through `/admin/fb-import` and the
backend runs the whole thing server-side (see `etl_cloud/README.md` for that
orchestration), or a developer can still invoke any stage by hand
(`BATCH=<folder> node etl_local/...`) for local debugging. Either way it is
the same script files below — the cloud path `spawn()`s them as child
processes rather than reimplementing them:

1. **`01_ingest/ingest-fb-data.js`** — parses raw Facebook JSON/album exports, fixes mojibake, extracts text + media metadata (incl. `rerun-albums.js` for FB "Download Your Information" album-only re-imports).
2. **`02_classify/ai-classify.js`** — Gemini-based classification into 馬拉松/旅遊/登山 + tags.
3. **`03_analyze/{00_base,01_marathon,02_hiking}/analyze.js`** — category-specific structured field extraction (race name/participants/stats for marathon, mountain name/elevation/peak number for hiking).
4. **`04_format/analyze.js`** — formatting pass before merge.
5. **`05_merge/merge.js`** — merges per-year batches into a single dataset.
6. **`06_import/import-to-supabase.js`** — upserts into `fb_posts`, deduped by a content signature (`cleanup-skipped*.js` handle rows that fail media/db checks).
7. **`07_trips/assign-trips.js`** — assigns `trip_id` to group same-trip posts.
8. **`08_geocode/geocode-fallback.js`** — batch-fills `metadata.fallback_lat/fallback_lng` via Nominatim for posts with no real EXIF GPS (layered: race/mountain venue name → same-trip sibling → city+country).

---

## 4. Database Schema (Supabase / PostgreSQL)

### 4.1 `fb_posts`

```sql
CREATE TABLE fb_posts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fb_timestamp bigint NOT NULL,
  event_date date NOT NULL,
  title text,
  content text,
  category varchar(50),
  tags jsonb DEFAULT '[]'::jsonb,
  media jsonb DEFAULT '[]'::jsonb,
  metadata jsonb,                        -- see §4.2
  sub_categories jsonb DEFAULT '[]'::jsonb,
  cover_image text,
  trip_id uuid,
  is_hidden boolean DEFAULT false,
  is_personal_best boolean DEFAULT false,
  is_ai_editing_locked boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, fb_timestamp)
);
```

`continent` and `is_overseas` (legacy top-level columns predating the `metadata` model) and the unused `fb_posts_search_idx` full-text index were removed in `supabase/migrations/20260714000000_drop_legacy_columns.sql` (2026-07-14) — the 38 rows whose only continent data lived in the legacy column were backfilled into `metadata.continent` first.

Indexes as of 2026-07-14 (`supabase inspect db index-sizes`):

```sql
-- pre-existing
CREATE UNIQUE INDEX fb_posts_pkey ON fb_posts (id);
CREATE UNIQUE INDEX fb_posts_user_id_fb_timestamp_key ON fb_posts (user_id, fb_timestamp);
CREATE INDEX idx_fb_posts_user_id ON fb_posts (user_id);
CREATE INDEX idx_fb_posts_date ON fb_posts (event_date DESC);
CREATE INDEX idx_fb_posts_is_hidden ON fb_posts (is_hidden); -- not in any migration file, likely added by hand via the Supabase SQL editor

-- added by supabase/migrations/20260713_add_query_indexes.sql
CREATE INDEX idx_fb_posts_user_hidden_date ON fb_posts (user_id, is_hidden, event_date DESC);
CREATE INDEX idx_fb_posts_category ON fb_posts (category);
CREATE INDEX idx_fb_posts_trip_id ON fb_posts (trip_id) WHERE trip_id IS NOT NULL;
CREATE INDEX idx_fb_posts_sub_categories ON fb_posts USING GIN (sub_categories);
CREATE INDEX idx_fb_posts_metadata_country_trgm ON fb_posts USING GIN ((metadata ->> 'country') gin_trgm_ops);
CREATE INDEX idx_fb_posts_metadata_city_trgm ON fb_posts USING GIN ((metadata ->> 'city') gin_trgm_ops);
CREATE INDEX idx_fb_posts_metadata_continent_trgm ON fb_posts USING GIN ((metadata ->> 'continent') gin_trgm_ops);
```

### 4.2 `metadata` JSONB structure

Shape varies by category; all fields optional.

```json
{
  "country": "台灣",
  "city": "嘉義縣",
  "continent": "亞洲",
  "race_name": "東京馬拉松",
  "trip_id": "...",
  "fallback_lat": 24.14,
  "fallback_lng": 121.27,

  "mountain_name": "玉山",
  "peak_number": 1,
  "elevation_m": 3952,
  "mountains": ["玉山"],

  "participants": [
    {
      "name": "Davis",
      "distance": "超馬",
      "time": "6:11:24",
      "is_pb": false,
      "stats": {
        "distance_km": 50,
        "FM_count": null,
        "HM_count": null,
        "UM_count": null,
        "foreign_count": null
      }
    }
  ]
}
```

`fallback_lat`/`fallback_lng` are filled by `etl/08_geocode/geocode-fallback.js` or the admin edit UI's `/geocode` button, and are what `findLocations` falls back to when no photo has real EXIF GPS.

### 4.3 Media JSONB structure

```json
[
  {
    "uri": "https://maramap-assets.vizino.ai/...",
    "type": "photo | video",
    "lat": 25.077,
    "lng": 121.508,
    "taken_at": 1772933523
  }
]
```
Average ~21 media items per post that has any, up to 628 for one post — `findLocations` currently selects the full array to find one representative geotagged photo, a known remaining perf cost (see the performance-audit notes).

### 4.4 Other tables

```sql
-- Page-view counters, incremented via /stats/visit
CREATE TABLE page_views (
  path         text primary key,
  human_views  bigint not null default 0,
  bot_views    bigint not null default 0
);
CREATE FUNCTION increment_page_view(p_path text, p_field text) ...; -- atomic upsert

-- Cached per-participant aggregates, refreshed by a daily cron (refreshAllStats)
CREATE TABLE participant_stats (
  id uuid PRIMARY KEY,
  participant_name text UNIQUE,
  total_distance_km numeric,
  fm_count int,
  hm_count int,
  um_count int,
  last_updated timestamptz
);
```

`/personal-best` results pass through the in-memory `@nestjs/cache-manager` (registered globally, 1h TTL, key `pb:${userId}`, invalidated on any post `update`) — not Redis, so it does not survive a restart or share state across multiple instances. `/geocode` is not cached — each call hits Nominatim directly.

---

## 5. Storage Strategy (Cloudflare R2)

- **Platform:** Cloudflare R2 (S3-compatible).
- **Domain:** `https://maramap-assets.vizino.ai` (Managed by Cloudflare CDN).
- **Latency Optimization:** Uses Cloudflare's global edge network to cache assets in Taiwan, minimizing cross-Pacific latency from Ottawa.
- **Cost:** $0 Egress fees when accessed via the custom domain.

---

## 6. Architecture Overview

```
[Taiwan Client] <───> [Cloudflare CDN / R2] (Media Cache)
      │
      ▼
[GCP Cloud Run (Taiwan)] <───> [Supabase (Asia)] (Metadata)
      │
      │ (Local Ingestion from Ottawa)
      ▼
[Specialized Scripts] ──► [Gemini AI] (Classification)
```
