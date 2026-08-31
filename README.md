# 🗺️ MaraMap Backend

The backend API for MaraMap — a platform that turns social media content into an interactive map experience.

## What is MaraMap?

MaraMap connects content from social media (like Facebook and Instagram) to geographic locations. When you share a story with a location, it appears on a map where others can discover it.

The backend handles:
- **Content API** — delivers processed posts and map data to the web and mobile frontends.
- **Data Ingestion** — an admin uploads a Facebook export through the admin UI, and the backend runs the classification/import pipeline itself, server-side.

## Data Processing Workflow

An admin uploads a Facebook "Download Your Information" export zip through
`/admin/fb-import`; the backend runs the whole pipeline — nothing is run by
hand on a laptop anymore:

1. **Upload** — the browser PUTs the zip straight to Cloudflare R2 via a
   presigned URL (`POST /admin/fb-import/upload-url`), bypassing Cloud Run's
   32MB request limit.
2. **Prepare** (`POST /admin/fb-import/:batch/prepare`, streamed as NDJSON) —
   unzips the JSON entries, stages the referenced media into R2, then runs
   ingest and Gemini classification, and pauses for review.
3. **Review** — the admin corrects any miscategorized posts and can skip
   individual ones before confirming.
4. **Finalize** (`POST /admin/fb-import/:batch/confirm`) — runs the
   remaining analyze/format/merge/import stages, publishes staged media to
   its permanent R2 path, assigns trips, and fills in fallback geocoding.

Every stage is one of the numbered scripts in `etl_local/` (`01_ingest` →
`08_geocode`) — the backend doesn't reimplement them, it runs the same files
as child processes and uses R2 (instead of local disk) to carry each stage's
output to the next, since a batch's prepare and finalize requests can land on
different Cloud Run instances. There is one copy of the pipeline logic, not
a local one and a cloud one: a developer can still invoke any stage directly
(`BATCH=<folder> node etl_local/...`) for local debugging, but that's a
debugging path now, not how imports actually happen. Full internals:
[`etl_cloud/README.md`](./etl_cloud/README.md).

## Core Endpoints

| What | Endpoint | Purpose |
|------|----------|---------|
| **Browse posts** | `GET /api/v1/posts` | Get published posts with pagination |
| **Find locations** | `GET /api/v1/locations` | Get all geotagged content for the map |
| **Read post** | `GET /api/v1/posts/:id` | View a single post by ID |

## Getting Started

```bash
# Install dependencies
$ pnpm install

# Start development server
$ pnpm start:dev
```

Data import happens through the admin UI (`/admin/fb-import`) once the
server's running — see [Data Processing Workflow](#data-processing-workflow)
above. There's no local import command to run.

## How It Works

1. **The admin UI** uploads a Facebook export and triggers the pipeline on
   the backend — the same numbered scripts in `etl_local/`, now run
   server-side instead of on a laptop.
2. **Gemini AI** performs high-quality classification and tagging.
3. **Cloudflare R2** stores all media assets (images, videos) with public CDN URLs.
4. **Supabase** stores the structured post data, including media references and geographic coordinates.
5. **Frontend** consumes the API to display posts on an interactive map.

### Media Upload to Cloudflare R2

During the admin-UI import, media publishing is handled in-process by
`fb-import.service.ts`'s `publishMedia` step — a server-side R2 copy from
staging to the permanent path plus a DB URI rewrite, no separate script
involved.

`utils/upload-to-r2.js` still exists but is no longer part of that flow — the
only remaining caller is `etl_local/rerun-albums.js`, the manual recovery
path for FB "Download Your Information" album-only re-imports:

- **Parallel Uploads**: Uploads up to 20 files simultaneously for speed
- **Deduplication**: Caches local file URIs to skip redundant uploads
- **Format Support**: Handles JPEG, PNG, WebP, MP4, MOV, and other common formats
- **CDN URLs**: Updates Supabase records with public Cloudflare CDN URLs after upload

**Requirements**:
- `R2_ENDPOINT`: Cloudflare R2 endpoint (e.g., `https://<account-id>.r2.cloudflarestorage.com`)
- `R2_ACCESS_KEY_ID` & `R2_SECRET_ACCESS_KEY`: R2 API credentials
- `R2_BUCKET_NAME`: Target bucket name in R2
- `R2_PUBLIC_URL`: Public CDN URL for the bucket

### Admin Manual Uploads & manual-import Lifecycle

Besides the bulk ETL path above, the admin "new post" (`/admin/new`) and "edit post" (`/admin/edit/[id]`) screens let an editor upload images/videos directly through the API (`POST /api/v1/posts/upload-url`, both screens go through the same `MediaManager` component). This is the **only** producer and consumer of this staging prefix — the FB bulk-import pipeline is a fully separate flow(`pending-imports/`, see above) and never touches it. To avoid
orphaned files from abandoned drafts, uploads follow a **staged claim** flow:

1. Uploads land in a **manual-import prefix**: `manual-import/<userId>/…`.
2. When the post is created (`POST /posts`) or saved with a `media` field present (`PATCH /posts/:id`), the backend **claims** them — copies each into the shared permanent path (`your_facebook_activity/posts/media/…`, the same one the FB ETL writes to), best-effort deletes the staging copy, and rewrites the stored URIs. Anything never claimed (editor uploaded then closed the tab without saving) is left in `manual-import/`.
3. An R2 **Object Lifecycle rule** sweeps the leftovers, auto-deleting objects
   under `manual-import/` after a retention window.

**Object Lifecycle rules** — configured and **enabled** in the Cloudflare
dashboard (**R2 → bucket → Settings → Object lifecycle rules**). Two prefixes
accumulate throwaway objects and expire by age:

| Prefix | What's under it | Delete after |
|---|---|---|
| `manual-import/` | Manual-upload drafts never claimed into the permanent path (editor closed the tab, or a draft sat unsaved past the retention window — see the claim-failure caveat below). | 7 days |
| `pending-imports/` | FB-import working data — uploaded zips, staged media, per-batch workspace JSON + state. A finished or cancelled batch already deletes its own big files immediately; this rule is the safety net for abandoned (never-confirmed, never-cancelled) batches. | 7 days |

**Claim-failure caveat**: the claim step is best-effort — if the R2 copy
throws (including "object no longer exists" because a draft sat in
`manual-import/` past the 7-day window before finally being saved), the post
is still created/saved successfully, just with the original (now-expiring or
already-expired) staging URI left in `media`, and only a server log records
it. Nothing currently surfaces this to the admin or re-checks it later — a
published post can end up with a dead media link with no visible error. Seen
once in production already (media entry silently orphaned this way, fixed
manually). Worth hardening — see the discussion below on where the failure
window actually is.

A third rule (**Delete incomplete multipart uploads**, 7 days) is also
enabled, bucket-wide. This is the one that matters for large-file transfers
that started but never finished (e.g. a `media_stage` retry after a dropped
connection) — those don't show up in the normal object listing/delete APIs at
all, so the two age-based rules above never touch them; this rule is what
reclaims them.

Rules apply by object age, so nothing in active use is ever removed (imports
finish in minutes). Lifecycle config is bucket-level and can only be set with
an **Admin Read & Write** R2 token — the object-level upload token returns
`Access Denied` — which is why it lives in the dashboard, not in app code.

**Per-type upload limits**: images ≤ 8 MB (`jpg/png/webp/gif`), videos ≤ 64 MB
(`mp4/mov/webm`), enforced both client-side (instant feedback) and server-side.

### Rate Limiting

Every route is throttled per client IP via `@nestjs/throttler` (`ThrottlerGuard`
applied globally in `app.module.ts`), with stricter overrides on
abuse-sensitive or expensive routes:

| Scope | Limit | Why |
|---|---|---|
| Default (everything else — `posts`, `locations`, `stats/visit`, etc.) | 120 req / 60s per IP | Generous enough for a normal map session (several parallel reads per page load + panning) while still capping scripted abuse. |
| `POST /auth/login` | 5 req / 60s per IP | It's a credential-guessing target; legitimate use never needs rapid retries. |
| `admin/fb-import/*` (whole controller) | 10 req / 60s per IP | Single-admin tool — every route here triggers Gemini AI calls and/or R2 transfers, so a tight cap also guards against runaway cost from a buggy retry loop. |
| `GET /health-check` | Unthrottled (`@SkipThrottle()`) | Polled by Cloud Run / uptime monitors, not a target. |

Cloud Run terminates TLS and proxies every request, so `main.ts` sets
`trust proxy` — without it the guard would rate-limit the proxy's IP instead
of each real client, throttling everyone as one bucket. Limits are per
Cloud Run instance's in-memory store (no shared Redis), which is fine at
current scale but means a burst that lands across multiple scaled-out
instances isn't counted together — revisit with a shared storage adapter if
that becomes a problem.

## Architecture Notes

Corrective facts for anyone — human or AI agent — carrying assumptions in
from a typical NestJS + Supabase starter:

- **Storage is Cloudflare R2** (S3-compatible, via `@aws-sdk/client-s3`), not
  Supabase Storage. Public URLs are served from `R2_PUBLIC_URL` (a custom CDN
  domain). Browsers upload directly to R2 via presigned PUT URLs
  (`R2Service.presignPut`) to bypass Cloud Run's 32MB request-body limit.
- **The database is one content table, `fb_posts`** — there is no `users` or
  `posts` table, and no PostGIS: geo data is plain `lat`/`lng` floats inside
  `media`/`metadata` JSONB, not a `GEOGRAPHY` column. Full schema:
  [docs/SPEC.md](./docs/SPEC.md) §4.
- **Auth is two paths behind one endpoint.** `POST /auth/login` checks
  `email`/`password` against the `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars
  first (not Supabase Auth) and returns a self-issued JWT if they match;
  only then does it fall back to Supabase Auth sign-in, though nothing in
  this codebase currently exercises a non-admin role. `AdminGuard` verifies
  that JWT on every non-`@Public()` route.
- **The Supabase client uses the service-role key everywhere** — Row Level
  Security is bypassed. Authorization is enforced entirely in application
  code (`AdminGuard` plus explicit `is_hidden`/`user_id` filters in
  `fb-posts.service.ts`), not by Postgres RLS policies.
- **Deployment is two Cloud Run regions, driven by branch**, not a
  `dev`/`prod` label pair: `develop` → `northamerica-northeast1` (Montreal);
  `main` → `asia-east1` (Taiwan, production). See
  [docs/SETUP_GCP.md](./docs/SETUP_GCP.md).

## For Developers

For API specifications, database schema, and deployment details, see [SPEC.md](./SPEC.md).

### Testing

```bash
# Run tests
$ pnpm test

# Coverage report
$ pnpm test:cov

# End-to-end tests
$ pnpm test:e2e
```
