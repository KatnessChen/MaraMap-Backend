# 🗺️ MaraMap Backend

The backend API for MaraMap — a platform that turns social media content into an interactive map experience.

## What is MaraMap?

MaraMap connects content from social media (like Facebook and Instagram) to geographic locations. When you share a story with a location, it appears on a map where others can discover it.

The backend handles:
- **Content API** — delivers processed posts and map data to the web and mobile frontends.
- **Data Ingestion** — handled via local processing scripts that extract and classify Facebook export data.

## Data Processing Workflow

Instead of uploading zip files via API, we use local scripts for efficiency and cost control:

1. **Extraction**: `node scripts/extract-fb-data.js` - Extracts text and media (with GPS) from Facebook JSON exports.
2. **Classification**: `node scripts/ai-classify.js` - Uses Gemini AI (2.5 Flash) to categorize posts (marathon, travel, etc.) and generate tags.
3. **Upload Media**: `node scripts/upload-to-r2.js` - Uploads images and videos to Cloudflare R2 in parallel, updates database records with CDN URLs.
4. **Import**: `node scripts/import-to-supabase.js` - Pushes the final structured data into Supabase `fb_posts` table.

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

# Run Data Import (Requires GEMINI_API_KEY and SUPABASE keys in .env)
$ node scripts/extract-fb-data.js
$ node scripts/ai-classify.js
$ node scripts/upload-to-r2.js       # Upload images/videos to Cloudflare R2
$ node scripts/import-to-supabase.js
```

## How It Works

1. **Local Scripts** process the raw Facebook export folder.
2. **Gemini AI** performs high-quality classification and tagging.
3. **Cloudflare R2** stores all media assets (images, videos) with public CDN URLs.
4. **Supabase** stores the structured post data, including media references and geographic coordinates.
5. **Frontend** consumes the API to display posts on an interactive map.

### Media Upload to Cloudflare R2

The `upload-to-r2.js` script handles media migration:

- **Parallel Uploads**: Uploads up to 20 files simultaneously for speed
- **Deduplication**: Caches local file URIs to skip redundant uploads
- **Format Support**: Handles JPEG, PNG, WebP, MP4, MOV, and other common formats
- **CDN URLs**: Updates Supabase records with public Cloudflare CDN URLs after upload

**Requirements**:
- `R2_ENDPOINT`: Cloudflare R2 endpoint (e.g., `https://<account-id>.r2.cloudflarestorage.com`)
- `R2_ACCESS_KEY_ID` & `R2_SECRET_ACCESS_KEY`: R2 API credentials
- `R2_BUCKET_NAME`: Target bucket name in R2
- `R2_PUBLIC_URL`: Public CDN URL for the bucket

## Environments

Each environment is separate:
- **Dev** (Montreal) — for development and testing
- **Production** (Taiwan) — for users in Asia

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
