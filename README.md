# 🗺️ MaraMap Backend

The backend API for MaraMap — a platform that turns social media content into an interactive map experience.

## What is MaraMap?

MaraMap connects content from social media (like Facebook and Instagram) to geographic locations. When you share a story with a location, it appears on a map where others can discover it.

The backend handles two things:

1. **Ingestion** — accepts scraped content from our Chrome Extension and prepares it for processing
2. **Content API** — delivers published posts and map data to the web and mobile frontends

All heavy processing (AI analysis, image optimization) happens asynchronously through our n8n worker, keeping the API fast and responsive.

## Core Endpoints

| What | Endpoint | Purpose |
|------|----------|---------|
| **Add content** | `POST /api/v1/ingest` | Submit scraped posts from the extension |
| **Browse posts** | `GET /api/v1/posts` | Get published posts with pagination |
| **Find locations** | `GET /api/v1/locations` | Get all geotagged content for the map |
| **Read post** | `GET /api/v1/posts/:id` | View a single post by ID |

## Getting Started

```bash
# Install dependencies
$ pnpm install

# Start development server
$ pnpm start:dev

# Production build
$ pnpm start:prod
```

## How It Works

1. **Chrome Extension** captures content from social media and sends it to `/api/v1/ingest`
2. **Backend** receives the content, validates it, and queues an async job
3. **n8n Worker** processes the content — extracts information, identifies location, optimizes images
4. **Frontend** displays the processed posts on the map and in a feed

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
