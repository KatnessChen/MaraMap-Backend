# 🏗️ MaraMap-Backend: Nest.js Backend & Database Spec

## 1. Module Overview

This Nest.js application serves as the central nervous system for the Journify platform. It operates with two primary responsibilities:

- **The Ingestion Gateway:** Receiving raw, unstructured data from the Chrome Extension scraper, persisting it safely, and dispatching processing jobs to the n8n AI worker asynchronously.
- **The Content API:** Serving structured, polished blog posts and geospatial map data to the Next.js frontend.

**Design Philosophy:** The backend must remain lightweight and fast. Heavy computational tasks, such as AI processing and image downloading, are strictly delegated to the n8n worker.

**Environments (from day one):** The project uses exactly two environments. **Dev** runs in **Eastern Canada** (GCP northamerica-northeast1/2) for low-latency development and debugging. **Production** runs in **Taiwan** (GCP asia-east1) for end users. All infrastructure, config, and CI/CD are set up for these two environments from the start.

---

## 2. Core API Endpoints

### 2.1 Ingestion API (Extension → Backend)

Receives raw HTML/text from the Chrome Extension.

| Property           | Value                             |
| ------------------ | --------------------------------- |
| **Endpoint**       | `POST /api/v1/ingest`             |
| **Authentication** | Bearer Token (Admin/User API Key) |

**Behavior:**

1. Validates the incoming payload.
2. Performs an idempotency check (`source_id`) to prevent duplicate scrapes.
3. Saves the record to the database with a `PENDING` status.
4. Triggers the internal n8n webhook asynchronously.
5. Immediately returns **202 Accepted**.

### 2.2 Content API (Backend → Next.js Frontend)

Serves the published content to the reader-facing blog and map interfaces.

| Endpoint    | Method                  | Description                                                                  |
| ----------- | ----------------------- | ---------------------------------------------------------------------------- |
| Blog List   | `GET /api/v1/posts`     | Supports pagination and filtering by `PUBLISHED` status.                     |
| Post Detail | `GET /api/v1/posts/:id` | Single post by ID.                                                           |
| Map Markers | `GET /api/v1/locations` | Returns only `id`, `title`, and `location_geo` for efficient map clustering. |

---

## 3. Supabase Database Setup Guide

We will use managed Supabase as our PostgreSQL database provider to handle relational data, PostGIS geospatial coordinates, and image storage. Create **two Supabase projects**: one for **dev** (region preferred near Eastern Canada if available, otherwise any; used only by the dev environment) and one for **production** (Asia region for Taiwan users).

### Step 1: Initialize the Project

1. Create **two** projects in the [Supabase Dashboard](https://supabase.com/dashboard)—one for **dev**, one for **production**.
2. For each project (dev and production), navigate to the **SQL Editor**.

### Step 2: Enable Geospatial Support (PostGIS)

Enable PostGIS for map support. Run the following in the SQL Editor **for both dev and production projects**:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

### Step 3: Define the Schema

Execute the following SQL script in **both** dev and production Supabase projects to create the multi-tenant schema:

```sql
-- Create Users Table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  plan_tier TEXT DEFAULT 'FREE',
  config JSONB DEFAULT '{"enable_map": false}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create Posts Table
CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  source_id TEXT UNIQUE NOT NULL,  -- Facebook Post ID
  title TEXT,
  content JSONB,                   -- Tiptap JSON format
  raw_text TEXT,
  location_name TEXT,
  location_geo GEOGRAPHY(POINT),   -- Stores Lat/Lng
  published_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'PENDING',   -- PENDING, PUBLISHED, HIDDEN
  meta JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for map queries
CREATE INDEX posts_geo_index ON posts USING GIST (location_geo);
```

### Step 4: Configure Storage for Images

In **both** dev and production Supabase projects:

1. Navigate to **Storage** in the Supabase Dashboard.
2. Create a new bucket named **social-images**.
3. Set the bucket to **Public** so the Next.js frontend can render the images directly.

---

## 4. Google Cloud Platform (GCP) Deployment Strategy

For a 24/7 robust cloud environment, we containerize the Nest.js application using Docker and deploy it to Google Cloud. We deploy **two Cloud Run services** from the start:

- **Dev:** region **northamerica-northeast2** (Toronto)—Eastern Canada, for the development team.
- **Production:** region **asia-east1** (Taiwan)—for end users.

### Recommended Compute Option: Google Cloud Run

While a Compute Engine VM is an option, **Cloud Run** is the ideal choice for this stateless API.

- **Cost-Effective:** It scales automatically based on traffic. To ensure 24/7 responsiveness without "cold start" delays, we can set `min-instances=1` per environment.
- **Zero Server Maintenance:** OS patching and networking are fully managed by GCP.
- **Containerized Workflow:** We build the Nest.js Docker image once, push to Artifact Registry (multi-region or per-region), and deploy to **dev** (East Canada) and **production** (Taiwan) separately.

### Environment Variables Required in GCP

Each Cloud Run service (dev and production) has its own configuration. The following secrets must be injected per environment (different values for dev vs production):

| Variable                    | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `SUPABASE_URL`              | The project URL.                                                   |
| `SUPABASE_SERVICE_ROLE_KEY` | For backend admin access (bypassing RLS).                          |
| `N8N_WEBHOOK_URL`           | The trigger URL for our AI agent.                                  |
| `INTERNAL_API_SECRET`       | To secure the endpoint that n8n calls when updating post statuses. |

---

## 5. Multi-Region Strategy: Dev (Eastern Canada) vs Production (Taiwan)

The development team is in Eastern Canada; end users are in Taiwan. Resources are split into two environments from the start: **dev** (East Canada) and **production** (Taiwan).

### 5.1 Principles

| Concern                  | Strategy                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| **User experience**      | Production API, frontend, and DB are in Taiwan/Asia to minimize latency.                            |
| **Developer experience** | Dev environment, CI/CD, logs, and debugging are in Eastern Canada for fast iteration.               |
| **Cost**                 | Production in a single region (Asia); dev in a single region (East Canada); add CDN only if needed. |

### 5.2 Region Overview

| Resource                                | Production                                                                                      | Dev                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Nest.js API (Cloud Run)**             | **asia-east1** (Taiwan)                                                                         | **northamerica-northeast1** (Montreal) or **northamerica-northeast2** (Toronto)                 |
| **Supabase (DB + Storage)**             | Asia (e.g. Singapore / East Asia per Supabase options)                                          | Separate dev project; region near East Canada if available, otherwise same schema in any region |
| **Container image (Artifact Registry)** | Same image; push to **asia-east1** and **northamerica-northeast1** (multi-region or per-region) | Same as production                                                                              |
| **n8n workflows**                       | Same region as production API (Asia) to keep webhook latency low                                | East Canada, connected to dev API                                                               |
| **Next.js frontend**                    | **Taiwan / East Asia** (e.g. Vercel); if on GCP, use **asia-east1**                             | East Canada or same as production for testing                                                   |

### 5.3 Supabase Regions

- **Production:** Create the production Supabase project in **Asia** (e.g. Singapore / Tokyo). Taiwan users get the lowest DB latency; the dev team may connect for admin/debug with higher but acceptable latency.
- **Dev:** Create a separate **dev** Supabase project. Prefer a region near Eastern Canada if Supabase offers it; otherwise use the same schema in any region. Never use the production DB for day-to-day dev.

### 5.4 CI/CD and Operations

- **CI/CD (e.g. GitHub Actions):**
  - Build the Docker image once and push to Artifact Registry (multi-region or separate asia / northamerica).
  - Deploy **dev** to **northamerica-northeast1**; deploy **production** to **asia-east1**.
- **Logging and monitoring:** Use Cloud Logging / Cloud Monitoring and filter by **region**. The team inspects both dev (East Canada) and production (Asia) services.
- **Environment variables:** Dev and production use different `SUPABASE_URL`, `N8N_WEBHOOK_URL`, etc., pointing to each environment’s Supabase and n8n.

### 5.5 Architecture Overview

```
[End users — Taiwan]
     │
     ▼
Next.js (Asia) ──► Nest.js API (asia-east1) ──► Supabase (production, Asia)
                         │
                         └──► n8n (Asia)  // async processing

[Dev team — Eastern Canada]
     │
     ▼
CI/CD ──► build image ──► Artifact Registry (multi-region or per-region)
                │
                ├──► Cloud Run dev (Montreal/Toronto)
                └──► Cloud Run production (Taiwan)
```
