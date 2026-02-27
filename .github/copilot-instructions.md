# GitHub Copilot Instructions — MaraMap Backend

## Project Overview

MaraMap-Backend is a **NestJS** REST API that serves the MaraMap platform. It has two responsibilities:

1. **Ingestion Gateway** — receives raw HTML/text from a Chrome Extension, persists it, and dispatches async jobs to an n8n AI worker.
2. **Content API** — serves structured blog posts and geospatial map data to the Next.js frontend.

> Keep the backend **lightweight and fast**. Delegate all heavy work (AI processing, image downloading) to the n8n worker.

> For detailed project goals and specifications, refer to `/SPEC.md`.

---

## NestJS Module Structure & Coding Conventions

- Use the standard NestJS feature-module pattern: each domain (e.g. `posts`, `ingest`, `locations`) lives in its own folder under `src/`.
- Each module folder contains: `*.module.ts`, `*.controller.ts`, `*.service.ts`, and optionally `dto/`, `entities/`, `guards/`, `interceptors/`.
- Use **DTOs** (Data Transfer Objects) with `class-validator` decorators for all incoming request bodies.
- Use **pipes** (`ValidationPipe`) globally for DTO validation.
- All async operations must use `async/await`; no raw `.subscribe()` unless working directly with RxJS streams.
- Use `@nestjs/config` with a typed config service for all environment variable access — never read `process.env` directly in business logic.
- Use **NestJS exception filters** (`NotFoundException`, `BadRequestException`, etc.) for error responses.
- File naming convention: `kebab-case` for filenames, `PascalCase` for classes.

---

## API Design Rules

### URL Structure

All endpoints are prefixed with `/api/v1/`.

| Route                  | Method | Description                                      |
| ---------------------- | ------ | ------------------------------------------------ |
| `/api/v1/ingest`       | POST   | Receive raw scrape payload from Chrome Extension |
| `/api/v1/posts`        | GET    | List published posts (pagination + filter)       |
| `/api/v1/posts/:id`    | GET    | Single post by UUID                              |
| `/api/v1/locations`    | GET    | Map markers (`id`, `title`, `location_geo` only) |

### Authentication

- All endpoints requiring auth use **Bearer Token** (Admin/User API Key) via the `Authorization` header.
- Use a NestJS `AuthGuard` to validate the token. Never perform auth logic inline in controllers.

### Response Conventions

- **Success:** return the resource or a minimal acknowledgement object; do **not** wrap in a `{ data: ... }` envelope unless it's a paginated list.
- **Paginated lists:** return `{ items: [...], total: number, page: number, limit: number }`.
- **Ingestion endpoint** (`POST /api/v1/ingest`): always return **HTTP 202 Accepted** immediately after queuing — never block on n8n processing.
- **Errors:** use NestJS built-in HTTP exceptions so the response shape is consistent: `{ statusCode, message, error }`.

### Ingestion Endpoint Behavior

When handling `POST /api/v1/ingest`:

1. Validate the DTO.
2. Check `source_id` for idempotency — if the record already exists, return **409 Conflict**.
3. Save the record to the `posts` table with `status = 'PENDING'`.
4. Fire-and-forget: trigger the n8n webhook asynchronously (do **not** await the result before responding).
5. Return **202 Accepted**.

---

## Database Schema & Supabase Conventions

The project uses **Supabase** (managed PostgreSQL + PostGIS + Storage).

### Tables

#### `users`

```sql
id          UUID PRIMARY KEY DEFAULT uuid_generate_v4()
email       TEXT UNIQUE NOT NULL
plan_tier   TEXT DEFAULT 'FREE'
config      JSONB DEFAULT '{"enable_map": false}'
created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
```

#### `posts`

```sql
id            UUID PRIMARY KEY DEFAULT uuid_generate_v4()
user_id       UUID REFERENCES users(id) ON DELETE CASCADE
source_id     TEXT UNIQUE NOT NULL   -- Facebook Post ID; used for idempotency
title         TEXT
content       JSONB                  -- Tiptap JSON format
raw_text      TEXT
location_name TEXT
location_geo  GEOGRAPHY(POINT)       -- PostGIS Lat/Lng
published_at  TIMESTAMP WITH TIME ZONE
status        TEXT DEFAULT 'PENDING' -- PENDING | PUBLISHED | HIDDEN
meta          JSONB
created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
```

> A GIST index exists on `location_geo` for efficient spatial queries.

### Status Values

Always use the string literals `'PENDING'`, `'PUBLISHED'`, `'HIDDEN'` for `posts.status`. Consider defining these as a TypeScript enum or const object to avoid magic strings.

### Supabase Client Usage

- Use the **service-role key** (bypasses RLS) for all server-side operations.
- Wrap Supabase calls in service classes, never call the Supabase client directly from controllers.
- Handle Supabase errors explicitly — check for `.error` on every response and throw the appropriate NestJS exception.

### Image Storage

Images live in the `social-images` bucket (public). Reference by the public URL when returning post data to the frontend.

---

## Environment Variables

All required environment variables. Access via `ConfigService`, not `process.env`.

| Variable                  | Description                                             |
| ------------------------- | ------------------------------------------------------- |
| `SUPABASE_URL`            | Supabase project URL                                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key for admin access            |
| `N8N_WEBHOOK_URL`         | n8n trigger URL for AI processing jobs                  |
| `INTERNAL_API_SECRET`     | Secret used to authenticate callbacks from n8n → backend |

Never log or expose these values. Use `@nestjs/config` validation schema to enforce they are present at startup.

---

## Environments & Deployment

Two environments only — **dev** and **production**:

| Resource        | Dev                                    | Production               |
| --------------- | -------------------------------------- | ------------------------ |
| Cloud Run       | `northamerica-northeast1` (Montreal)   | `asia-east1` (Taiwan)    |
| Supabase        | Separate dev project (East Canada region preferred) | Asia region project |
| n8n             | East Canada, connected to dev API      | Asia, connected to prod API |

### Rules

- **Dev and production always have separate Supabase projects and separate environment variable sets.** Never point dev at the production database.
- The Docker image is built once and deployed to both Cloud Run services.
- Config that differs between environments (URLs, keys) must come from environment variables injected by Cloud Run — no hardcoded values in source code.
