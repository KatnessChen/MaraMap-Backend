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

Serves the processed content to the frontend map and list interfaces.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /posts` | GET | Paginated posts. Supports filters: `category`, `startDate`, `endDate`, `search`. |
| `GET /locations` | GET | All geotagged posts for map pins. Supports same filters as `/posts`. |
| `GET /categories` | GET | Returns unique categories (e.g., 馬拉松, 旅遊) and their counts. |

### 2.2 Parameters

- `page`: Page number (default: 1)
- `limit`: Items per page (default: 10)
- `category`: Filter by AI category (Traditional Chinese)
- `startDate` / `endDate`: Date range filter (YYYY-MM-DD)
- `search`: Keyword search in title or content (case-insensitive)

---

## 3. Data Ingestion Workflow

Instead of an upload API, we use specialized scripts in the `scripts/` directory:

1.  **Extraction (`extract-fb-data.js`)**: Parses raw Facebook JSON exports, fixes encoding (mojibake), and extracts text + media metadata.
2.  **AI Classification (`ai-classify.js`)**: Uses Gemini 2.5 Flash to categorize posts into Chinese categories (馬拉松, 旅遊, 跑步訓練, 日常生活) and generate tags.
3.  **Cloud Migration (`upload-to-r2.js`)**: Efficiently uploads local images/videos to Cloudflare R2 in parallel and updates the database with CDN URLs.
4.  **Database Import (`import-to-supabase.js`)**: Performs an `upsert` to Supabase to keep the production data in sync.

---

## 4. Database Schema (Supabase / PostgreSQL)

The core data is stored in the `fb_posts` table:

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
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, fb_timestamp)
);

CREATE INDEX idx_fb_posts_user_id ON fb_posts (user_id);
CREATE INDEX idx_fb_posts_date ON fb_posts (event_date DESC);
```

### Media JSONB Structure:
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
