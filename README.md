# Sierra Leone News API Scraper

Aggregates articles from Sierra Leone's top news outlets — **The Sierra Leone Telegraph**, **Politico SL**, and **Concord Times** — via RSS feeds and sitemaps, ingests news videos from broadcaster channels, stores everything in PostgreSQL, and serves it through a REST API.

Two API surfaces are exposed:

- **`/v1/*` — the sellable product contract.** Versioned, paginated metadata + summary only (`{ data, meta }` envelope). Full article text is **never** returned; customers get the headline, summary, source, category, link, and published date.
- **`/api/*` — the internal surface.** The legacy routes used by the SLNews app (customer #1). `/api/news` returns the full article rows, including `paragraphs`. The app's client is pinned to `/api/news` — do not switch it to `/v1`, and do not expose `/api/*` to paying customers.

## Stack

- **Neon** — Serverless PostgreSQL
- **Render** — Hosting (web service + cron)
- **Prisma 7** — ORM + migrations
- **Express 5** — REST API
- **Cheerio + rss-parser** — Content scraping
- **TypeScript 7 + tsx** — Build and local execution

## Requirements

- Node.js **>= 22.12** (`package.json` `engines`; `.nvmrc` pins Node 22)
- A PostgreSQL database (Neon or local)

## Quick start

```bash
cp .env.example .env     # fill DATABASE_URL + API_KEY; set NODE_ENV=development locally
npm install              # runs prisma generate + installs Husky hooks
npm run db:migrate:deploy  # apply the committed Prisma migration
npm run dev              # API only (tsx watch, no scraping)
```

The API listens on `PORT` (default `3000`). For a throwaway local database you can use `npm run db:push` instead of `db:migrate:deploy`; production always uses migrations.

## API

Every `/api/*` and `/v1/*` data route requires an API credential:

```http
Authorization: Bearer <API_KEY>
```

When `CLERK_SECRET_KEY` is set, a Clerk session JWT is also accepted on the same header. Requests without valid credentials get `401`; if the server has neither `API_KEY` nor Clerk configured, data routes return `500` (fail closed).

| Method | Endpoint           | Auth   | Description                                                                                                                    |
| ------ | ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/`                | Public | Service metadata and endpoint list                                                                                             |
| GET    | `/api/news`        | Bearer | **Internal** full-text articles (legacy page/limit pagination; `source`, `q`)                                                  |
| GET    | `/api/news/:id`    | Bearer | **Internal** full article row by ID, including `paragraphs`                                                                    |
| GET    | `/api/videos`      | Bearer | **Internal** videos (legacy page/limit pagination; `channel`, `category`, `q`)                                                 |
| GET    | `/api/videos/:id`  | Bearer | Video by numeric ID or YouTube video ID                                                                                        |
| POST   | `/api/videos/sync` | Bearer | Trigger a synchronous video feed ingestion                                                                                     |
| GET    | `/api/stats`       | Bearer | Aggregate counts and freshness metrics                                                                                         |
| GET    | `/api/health`      | Public | Liveness/readiness probe (`503` when the database is unreachable)                                                              |
| GET    | `/v1/news`         | Bearer | **Sellable** paginated article metadata + summary (`page`/`cursor`, `page_size`, `source`, `category`, `from`, `to`, `q`)      |
| GET    | `/v1/videos`       | Bearer | **Sellable** paginated video metadata + playback URLs (`page`/`cursor`, `page_size`, `channel`, `category`, `from`, `to`, `q`) |
| GET    | `/v1/stats`        | Bearer | Same aggregate stats as `/api/stats`                                                                                           |
| GET    | `/docs`            | Public | Swagger UI (OpenAPI document)                                                                                                  |
| GET    | `/v1/docs`         | Public | Swagger UI, versioned alias                                                                                                    |

Public routes (`/`, `/docs`, `/v1/docs`, `/api/health`) need no credentials. Only `/api/health` is exempt from the rate limiter.

### Pagination

`/v1/news` and `/v1/videos` support two mutually exclusive pagination modes:

- **Page-based (default).** `?page=2&page_size=50`. `meta` contains `page`, `page_size`, an exact `total`, `has_more`, and a `next_cursor` (a keyset position for the last row when `has_more` is true, otherwise `null`).
- **Cursor-based (keyset).** `?page_size=50&cursor=<opaque>`. Passing `page` and `cursor` together returns `400`. Cursor mode skips the `COUNT(*)`: `meta.page` and `meta.total` are `null`, `meta.page_size` is echoed, `meta.has_more` reports whether more rows exist, and `meta.next_cursor` is the cursor for the next page (`null` on the last page).

A client can start with page mode and switch to cursor mode by passing the `next_cursor` from a page-mode response, or start directly with a cursor obtained from a previous cursor-mode response.

Cursors are opaque (a base64url-encoded keyset position) — do not parse, construct, or reuse one across different filters; pass back exactly what `meta.next_cursor` returned.

```bash
GET /v1/news?page_size=50&cursor=<opaque>   # pass meta.next_cursor from a page-mode or cursor-mode response
```

The legacy `/api/news` and `/api/videos` routes stay page-based for the pinned SLNews app: `limit` above 100 is still clamped silently as before, but `page` is capped at 10,000 and absurd/deep offsets now return `400` instead of a Prisma overflow `500`.

### Rate limiting

- **100 requests / 15 minutes** per caller by default.
- Keyed by the caller's **bearer token** (SHA-256 hashed — raw credentials are never stored or logged), falling back to the **client IP**.
- Configurable with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.
- `TRUST_PROXY_HOPS` (default `1`) tells Express how many reverse-proxy hops to trust for `X-Forwarded-For`; Render terminates TLS in front of the app, so `1` is correct there.
- Exceeding the limit returns `429` with `Retry-After` and `RateLimit-*` headers.
- The limiter's store is in-memory: run a **single instance** (as the blueprint does); with multiple instances each gets its own budget.

### Caching and CORS

Authenticated data responses use `Cache-Control: private` so intermediary caches cannot serve one caller's data to another. CORS exposes `X-Total-Count` plus the `RateLimit-*` and `Retry-After` headers so browser clients can read pagination and throttle state.

### Search indexes

Keyword search (`q`) is still a case-insensitive `ILIKE '%term%'` over title/description (and channel for videos). The `prisma/migrations/20261021000000_search_indexes` migration adds the indexes that keep those scans cheap as the archive grows:

- `pg_trgm` GIN trigram indexes on `Article.title`/`description` and `Video.title`/`description`/`channelTitle` — most effective for search terms of **3+ characters** (shorter terms are below trigram granularity).
- GIN indexes on the `category` arrays for `hasSome` category filters.
- Composite `(source, pubDate)` and `(pubDate, id)` indexes, plus `(channelTitle, publishedAt)` and `(publishedAt, id)` for videos, to support filtered feeds and the keyset cursor order.

The migration runs as part of the normal deploy (`prisma migrate deploy`), needs the migration role to be able to `CREATE EXTENSION pg_trgm` (Neon and Render PostgreSQL support it), and builds indexes **non-concurrently**, which takes a brief write lock — run it in a quiet window on a large existing table. Existing databases still need the one-time `npm run db:baseline` before the first `db:migrate:deploy` (see [Deploy to Render](#deploy-to-render)).

## Scripts

| Command                     | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| `npm run build`             | Compile TypeScript to `dist/` (`tsc -p tsconfig.build.json`)     |
| `npm run dev`               | Start the API with watch/reload (`tsx watch src/server.ts`)      |
| `npm run dev:all`           | Run ingestion once, then start the API (`tsx src/index.ts`)      |
| `npm start`                 | Start the compiled API (`node dist/server.js`)                   |
| `npm run scrape`            | Run one ingestion cycle and exit (`tsx src/scrape.ts`)           |
| `npm test`                  | Run the Vitest suite once (`vitest run`)                         |
| `npm run typecheck`         | Typecheck the project (`tsc --noEmit`)                           |
| `npm run lint`              | Prettier check on `src/`                                         |
| `npm run format`            | Prettier write on `src/`                                         |
| `npm run db:push`           | Push the Prisma schema without migrations (local/dev only)       |
| `npm run db:migrate:deploy` | Apply committed migrations (`prisma migrate deploy`)             |
| `npm run db:baseline`       | Mark the baseline migration as applied (existing databases only) |

## Environment variables

| Variable                   | Required          | Default                 | Purpose                                                                    |
| -------------------------- | ----------------- | ----------------------- | -------------------------------------------------------------------------- |
| `DATABASE_URL`             | Yes               | —                       | PostgreSQL connection string (Neon in production)                          |
| `API_KEY`                  | Yes in production | —                       | Static bearer key. Without it (and without Clerk) data routes return `500` |
| `PORT`                     | No                | `3000`                  | HTTP port                                                                  |
| `NODE_ENV`                 | No                | `development`           | `production` enables JSON logs and production behavior                     |
| `LOG_LEVEL`                | No                | `info` (prod) / `debug` | Pino log level                                                             |
| `CORS_ORIGIN`              | No                | `*`                     | Allowed browser origin(s); pin it in production                            |
| `CLERK_SECRET_KEY`         | No                | —                       | Enables Clerk session-JWT auth alongside `API_KEY`                         |
| `CLERK_AUTHORIZED_PARTIES` | No                | —                       | Comma-separated `azp` allowlist for Clerk JWTs                             |
| `TRUST_PROXY_HOPS`         | No                | `1`                     | Reverse-proxy hops trusted for `X-Forwarded-For`                           |
| `RATE_LIMIT_MAX`           | No                | `100`                   | Max requests per window per caller                                         |
| `RATE_LIMIT_WINDOW_MS`     | No                | `900000` (15 min)       | Rate-limit window in milliseconds                                          |

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/anselmeM/SLNewsAPIScapper)

`render.yaml` is the source of truth. It provisions two services:

- **`sl-news-api`** (web): builds with `npm ci --include=dev && npx prisma migrate deploy && npm run build`, starts with `node dist/server.js`, health-checks `/api/health`, and deploys only after GitHub checks pass (`autoDeployTrigger: checksPass`).
- **`sl-news-scraper`** (cron): hourly (`0 * * * *`), runs `node dist/scrape.js`.

Setup:

1. Click the button above, or on Render choose **New → Blueprint** and connect this repo.
2. Provide `DATABASE_URL` and `API_KEY` when prompted (plus optional `CORS_ORIGIN`, `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES`). **`API_KEY` is required**: without it every data route returns `500` while `/api/health` still reports green.
3. **The cron service needs a paid plan.** Render does not offer free cron jobs; the blueprint uses `plan: starter` (smallest paid plan). The web service can stay on the free plan, which spins down after inactivity.
4. Deploy. The web build applies committed migrations with `prisma migrate deploy` before compiling.

> **CRITICAL — one-time step for an EXISTING database.** If your database already has the `Article`/`Video` tables (created by the old `prisma db push` workflow), run this **once** against that database **before** the first deploy that runs `prisma migrate deploy`:
>
> ```bash
> # with DATABASE_URL pointing at the existing production database
> npm run db:baseline
> ```
>
> `db:baseline` marks the `20261020120000_init` migration as already applied without running its SQL. Skipping it makes `prisma migrate deploy` fail with **P3005** ("database schema is not empty") and the deploy stops. Fresh/empty databases need **no** baseline — the migration creates the schema.

### Upgrading an existing deployment

1. Set `DATABASE_URL` to the existing database (locally or in a one-off Render shell).
2. Run `npm run db:baseline` once. It only records the baseline migration as applied; it does not modify data.
3. Deploy normally. Every later deploy applies only new migrations via `prisma migrate deploy`.

If you run `db:baseline` against a database on which the baseline SQL was never applied, later migrations will fail — only baseline databases created by the old `db:push` workflow.

### Docker (optional)

The repo ships a multi-stage `Dockerfile` and a `.dockerignore` (so the host `node_modules`, `.git`, `.env*`, and docs never enter the build context):

```bash
docker build -t sl-news-api .
docker run --rm -p 3000:3000 --env-file .env sl-news-api
```

The image runs as a non-root user with `NODE_ENV=production`, and `/docs` resolves the OpenAPI spec from the compiled `dist/routes/*.js` in the image.

## CI

`.github/workflows/ci.yml` runs on pushes to `master`/`main` and on pull requests:

- `lint-and-typecheck` — Prisma validate, Prettier, `tsc --noEmit`
- `test` — Vitest suite
- `build` — `npm run build` (no database needed)
- `docker` — image build on pull requests only
- `audit` — `npm audit --omit=dev --audit-level=high`

All jobs run with `contents: read`, per-job timeouts, and workflow-level `concurrency` with `cancel-in-progress`. Render's `autoDeployTrigger: checksPass` means `master` only deploys after these checks are green.
