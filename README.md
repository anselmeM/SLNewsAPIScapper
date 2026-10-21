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

Every `/api/*` and `/v1/*` data route requires an API credential in the `Authorization` header:

```http
Authorization: Bearer <API_KEY | Clerk session JWT | slk_... customer key>
```

Credentials carry scopes: **`v1:read`** for the sellable `/v1/*` routes and **`internal:read`** for the legacy full-text `/api/*` routes. A missing or invalid credential gets `401`; a valid credential that lacks the scope for the route gets `403`. If neither `API_KEY` nor Clerk is configured, data routes return `500` (fail closed). See [API keys and scopes](#api-keys-and-scopes).

| Method | Endpoint           | Auth                     | Description                                                                                                                    |
| ------ | ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/`                | Public                   | Service metadata and endpoint list                                                                                             |
| GET    | `/api/news`        | Bearer · `internal:read` | **Internal** full-text articles (legacy page/limit pagination; `source`, `q`)                                                  |
| GET    | `/api/news/:id`    | Bearer · `internal:read` | **Internal** full article row by ID, including `paragraphs`                                                                    |
| GET    | `/api/videos`      | Bearer · `internal:read` | **Internal** videos (legacy page/limit pagination; `channel`, `category`, `q`)                                                 |
| GET    | `/api/videos/:id`  | Bearer · `internal:read` | Video by numeric ID or YouTube video ID                                                                                        |
| POST   | `/api/videos/sync` | Bearer · `internal:read` | Trigger a synchronous video feed ingestion (`409` if already running, `429` during cooldown)                                   |
| GET    | `/api/stats`       | Bearer · `internal:read` | Aggregate counts, runtime metrics, freshness and data-quality counters                                                         |
| GET    | `/api/health`      | Public                   | **Liveness** — 200 while the process is alive; never queries the database                                                      |
| GET    | `/api/ready`       | Public                   | **Readiness** — cached database probe; 503 when the database is unreachable                                                    |
| GET    | `/v1/news`         | Bearer · `v1:read`       | **Sellable** paginated article metadata + summary (`page`/`cursor`, `page_size`, `source`, `category`, `from`, `to`, `q`)      |
| GET    | `/v1/videos`       | Bearer · `v1:read`       | **Sellable** paginated video metadata + playback URLs (`page`/`cursor`, `page_size`, `channel`, `category`, `from`, `to`, `q`) |
| GET    | `/v1/stats`        | Bearer · `v1:read`       | Same aggregate stats as `/api/stats`                                                                                           |
| GET    | `/docs`            | Public                   | Swagger UI (public; own `DOCS_RATE_LIMIT_MAX` limiter)                                                                         |
| GET    | `/v1/docs`         | Public                   | Swagger UI, versioned alias (same docs limiter)                                                                                |

Public routes (`/`, `/docs`, `/v1/docs`, `/api/health`, `/api/ready`) need no credentials. Both probes (`/api/health`, `/api/ready`) are exempt from the rate limiter; the docs UI has its own limiter (see [Rate limiting](#rate-limiting)).

### API keys and scopes

Two scopes gate the two API surfaces:

| Scope           | Grants                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `v1:read`       | All sellable routes: `/v1/news`, `/v1/videos`, `/v1/stats`                                                             |
| `internal:read` | The legacy full-text surface used by the SLNews app: `/api/news`, `/api/videos`, `POST /api/videos/sync`, `/api/stats` |

Three kinds of credential are accepted:

- **Static `API_KEY`** — `Authorization: Bearer <API_KEY>`. Gets `STATIC_KEY_SCOPES` (default `internal:read,v1:read`, preserving the pre-scopes behaviour).
- **Clerk session JWT** — when `CLERK_SECRET_KEY` is set. Gets `CLERK_SCOPES` (default `internal:read,v1:read`).
- **Customer API keys** — DB-backed per-customer credentials with a `slk_` prefix. They get exactly the scopes stored on their row; the prefix routes verification to the database, so only these tokens cause a DB lookup.

In production, narrow the legacy credentials instead of leaving blanket access: e.g. a static key limited to the app's internal path and customers limited to `v1:read`:

```bash
STATIC_KEY_SCOPES=internal:read   # the pinned app still reads /api/news full text
CLERK_SCOPES=v1:read              # signed-in customers can only read the sellable surface
```

Unknown scope names in `STATIC_KEY_SCOPES`/`CLERK_SCOPES` are ineffective (they never match a route's required scope).

**Customer key administration** (needs `DATABASE_URL`; run locally or as a one-off Render job/shell):

```bash
# Create: prints the raw slk_... key exactly once — only its SHA-256 hash is stored
npm run keys:create -- --name "Acme News" --scopes v1:read
npm run keys:create -- --name "Acme News" --scopes v1:read --expires-at 2027-01-01T00:00:00Z

# List: id, name, scopes, active, createdAt, lastUsedAt, expiresAt, today's requests
npm run keys:list

# Revoke (sets active=false; the row and its usage history remain)
npm run keys:revoke -- --id 3
```

**Responses:** `401` for a missing/unknown/revoked/expired credential, `403` for a valid credential without the route's scope (the body includes `required_scope`), and `503` if the database is unavailable while verifying a customer key (so an outage is never mistaken for a revoked key).

**Verification cache:** successful verifications are cached for `API_KEY_CACHE_TTL_MS` (default 30 s) per instance and unknown keys are negatively cached for 5 s. Revocation and scope changes therefore take effect within that window (restart the API to apply immediately). Bad tokens without the `slk_` prefix never touch the database.

**Usage metering:** each successful customer-key verification records a per-key, per-UTC-day request count (`ApiKeyUsage`) and throttles `lastUsedAt` to at most once a minute. Writes are fire-and-forget/advisory — they never block or fail authentication — and `npm run keys:list` shows today's count. There is no billing/quota integration yet; quotas are currently only the existing per-credential rate limit. Raw keys and bearer tokens are never logged; only the key id and its scopes are.

### Health and readiness

- **`GET /api/health` — liveness.** Answers "is the process up?" with `200` and `{ status: 'ok', service: 'sl-news-api', uptime_seconds, timestamp }`. It never queries the database, sends `Cache-Control: no-store`, and is exempt from the rate limiter, so a database outage cannot make the platform restart an otherwise healthy process. Render's `healthCheckPath` stays `/api/health`.
- **`GET /api/ready` — readiness.** Answers "can this instance serve traffic?" by checking the database through a probe cached for 5 seconds: `200 { status: 'ready', database: 'connected', timestamp }` or `503 { status: 'degraded', database: 'disconnected', timestamp }`. Also `Cache-Control: no-store` and limiter-exempt. **Monitoring and alerting should poll `/api/ready`**, not `/api/health`.

### Request IDs

Every response carries an `X-Request-Id` header. A syntactically valid inbound id (`[A-Za-z0-9._-]{8,128}`) is echoed so traces propagate across services; anything else is replaced with a generated UUID (which also prevents log/trace injection). The id is carried in the pino access logs and included as `request_id` in 404/4xx/5xx JSON error bodies — quote it when reporting a request. It is not in the CORS exposed-header list, so cross-origin browser JavaScript cannot read it (server-to-server and same-origin clients can).

### Monitoring and alerting

External alerting is not wired up in this repo (no Sentry/OTel/Prometheus), so hook the built-in signals into Render notifications or your own tooling:

- Poll `/api/ready` and page on `503` (database unreachable).
- Poll `/api/stats` (bearer key required) and alert on `freshness.articles.stale` / `freshness.videos.stale`. `freshness.*.lag_seconds` is the current ingestion delay; a feed with no ingested data reports `lag_seconds: null` and `stale: true` (no data is not healthy). The threshold is `FRESHNESS_MAX_AGE_MS` (default 2 hours).
- Use `X-Request-Id` to correlate a support report with the matching access-log line or 5xx error.
- Track the data-quality counters on `/api/stats`: `articles.missing_date`, `articles.empty_content` and `videos.missing_date`. Rising `empty_content`/`missing_date` means extraction or repair is falling behind.
- `/api/stats` `runtime` (`uptime_seconds`, `process_started_at`, `memory_rss_mb`, `node_version`, `requests_total`, `requests_by_status`) describes the current process only: the counters are in-memory and reset on every deploy/restart, so treat them as process-local signals rather than durable metrics.

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

### Date filters

`from` / `to` accept ISO dates or date-times on the list routes. Validation is strict:

- impossible calendar dates such as `2026-02-30`, `2026-13-01` or `2026-00-10` return `400` instead of being silently rolled over by `Date`;
- a date-only `to` (e.g. `to=2026-08-07`) means "end of that UTC day" (23:59:59.999) and that adjustment happens **before** the `from > to` check, so a same-day window like `from=2026-08-07T12:00:00Z&to=2026-08-07` is valid;
- `from` later than `to` returns `400`.

### Video sync trigger

`POST /api/videos/sync` runs a full video ingestion synchronously (the hourly cron is the normal path). Overlap is guarded:

- a second request while a sync is in flight returns `409 { "error": "Video sync already in progress" }`;
- after a run finishes, a `VIDEO_SYNC_COOLDOWN_MS` cooldown (default 30 s; `0` disables it) applies, returning `429 { "error": "Video sync is cooling down", "retry_after_seconds": n }` with a matching `Retry-After` header;
- the guard is in-process state, so keep the API to a single instance (as the blueprint does).

### Rate limiting

- **100 requests / 15 minutes** per caller by default.
- Keyed by the caller's **bearer token** (SHA-256 hashed — raw credentials are never stored or logged), falling back to the **client IP**.
- Configurable with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.
- `TRUST_PROXY_HOPS` (default `1`) tells Express how many reverse-proxy hops to trust for `X-Forwarded-For`; Render terminates TLS in front of the app, so `1` is correct there.
- Exceeding the limit returns `429` with `Retry-After` and `RateLimit-*` headers.
- The docs UI is throttled separately: `/docs` and `/v1/docs` use their own limiter (`DOCS_RATE_LIMIT_MAX`, default **300 per window**) and are skipped by the API limiter, so loading Swagger never consumes a caller's API budget. `DOCS_RATE_LIMIT_MAX=0` is treated as invalid and falls back to the default; the window is shared via `RATE_LIMIT_WINDOW_MS`.
- The limiter's store is in-memory: run a **single instance** (as the blueprint does); with multiple instances each gets its own budget.

### Caching and CORS

Authenticated data responses use `Cache-Control: private` so intermediary caches cannot serve one caller's data to another. CORS exposes `X-Total-Count` plus the `RateLimit-*` and `Retry-After` headers so browser clients can read pagination and throttle state.

### Search indexes

Keyword search (`q`) is still a case-insensitive `ILIKE '%term%'` over title/description (and channel for videos). The `prisma/migrations/20261021000000_search_indexes` migration adds the indexes that keep those scans cheap as the archive grows:

- `pg_trgm` GIN trigram indexes on `Article.title`/`description` and `Video.title`/`description`/`channelTitle` — most effective for search terms of **3+ characters** (shorter terms are below trigram granularity).
- GIN indexes on the `category` arrays for `hasSome` category filters.
- Composite `(source, pubDate)` and `(pubDate, id)` indexes, plus `(channelTitle, publishedAt)` and `(publishedAt, id)` for videos, to support filtered feeds and the keyset cursor order.

The migration runs as part of the normal deploy (`prisma migrate deploy`), needs the migration role to be able to `CREATE EXTENSION pg_trgm` (Neon and Render PostgreSQL support it), and builds indexes **non-concurrently**, which takes a brief write lock — run it in a quiet window on a large existing table. Existing databases still need the one-time `npm run db:baseline` before the first `db:migrate:deploy` (see [Deploy to Render](#deploy-to-render)).

## Ingestion pipeline

`npm run scrape` (used by the hourly Render cron) and `npm run dev:all` (ingest, then serve) run one ingestion cycle: RSS/Atom article feeds → Telegraph sitemap backfill → YouTube channel feeds.

- **Shared HTTP retry path.** Feeds, article pages, sitemap pages, and YouTube feeds all go through the same client (`fetchWithRetry`, with feeds parsed from the fetched body via `rss-parser`'s `parseString` — 15 s feed timeout). Transient network errors, `5xx`, and `429` are retried up to 3 attempts with exponential backoff (1 s, 2 s, 4 s, capped at 30 s) plus bounded jitter. `429`/`503` honour `Retry-After` (delta-seconds or HTTP-date, capped at 30 s); other `4xx` are not retried (a `404` on a numbered sitemap page means "end of sitemap"). Each request can also carry an absolute deadline so retries never extend a run past its budget.
- **Graceful run deadline.** `INGESTION_DEADLINE_MS` (default 45 minutes) is a wall-clock budget for the whole cycle. Once it is reached, no new article source, sitemap page/item, or video channel is started; in-flight work is allowed to finish and the run exits cleanly. Pending work resumes on the next hourly run — it is a graceful stop, not a hard cancellation.
- **Batched dedupe.** Each feed does one `article.findMany` link lookup and each video channel one `video.findMany` videoId lookup, instead of one query per item; the sitemap walk keeps one in-memory set of known links.
- **One page fetch per new article.** Paragraphs and `og:image` are extracted from the same article-page request; an image already present in the feed HTML is preferred and skips the page fetch entirely. Existing articles only get the cheap inline metadata backfill (image page fetches remain capped at 10 per run within 60 s).
- **Sitemap convergence.** The walk keeps its 20-page and 50-ingest-per-run caps and now stops after 2 consecutive fully-known pages. `404`/`410` is treated as the normal end of the sitemap; any other failure logs an error and stops the walk (it no longer pretends the sitemap ended).
- **User agent.** Defaults to the existing browser-like Chrome UA; set `SCRAPER_USER_AGENT` to a descriptive bot identifier without changing scraping behaviour.

**Known limitations:** there is no persisted sitemap cursor or `<lastmod>` high-water mark, so each run still re-reads the newest sitemap pages; URL canonicalization is unchanged (scheme/`www`/AMP variants can still create duplicate rows); category taxonomy normalization and the empty `category` on sitemap-ingested archive rows are untouched; existing video rows are still skipped rather than refreshed.

## Data quality and provenance

Every stored date and body records **why** it has the value it does, so bad publisher markup cannot silently poison the sellable feed.

**Date provenance.** `pubDate` (articles) and `publishedAt` (videos) carry a source: `published` (trusted), `clamped` (an implausible date was adjusted), or `missing` (no usable date). The publisher's original string is retained in `pubDateRaw`/`publishedAtRaw`. Parsing never throws:

- blank or unparseable → stored as the ingestion time, flagged `missing`;
- more than **24 hours in the future** → clamped to `now`, flagged `clamped`;
- more than **10 years old** → clamped to the 10-year floor, flagged `clamped`.

**Sellable feeds exclude undated rows.** `/v1/news` and `/v1/videos` filter out rows whose date source is `missing`, so customers never see an item the pipeline knows is undated. The legacy `/api/news` and `/api/videos` routes (used by the pinned SLNews app) **do** include them, because the app needs every article. (Rows created before this change predate the flag — see Known gaps.)

**Content provenance.** `contentSource` is `page` (body fetched from the article page), `feed` (body came from the feed payload), or `empty` (no body found); legacy rows may be `null` (unknown) or the older `summary` marker. `contentAttempts` and `lastContentAttemptAt` track failed extraction attempts. Sitemap ingestion no longer fabricates a body from the summary — a page with no extractable paragraphs is stored as `paragraphs: []` with `contentSource: 'empty'`, and a non-empty body is never overwritten.

**Bounded repair.** Existing feed-seen rows with an empty body are repaired inline during the feed pass, and a sweep after the feeds retries up to **5 articles per run**, **3 attempts each**, within a 60 s budget and the run deadline (pending rows wait for the next hourly run).

**Monitoring counters.** `/api/stats` (and `/v1/stats`) include `articles.missing_date`, `articles.empty_content` (rows whose `contentSource` is `empty` or the legacy `summary`) and `videos.missing_date`. Articles and videos also have an `updatedAt` timestamp now.

**Known gaps:** legacy rows keep `contentSource: null` and an assumed `published` date source (there is no historical re-parse/backfill, so pre-existing undated rows are still served by `/v1` until re-ingested); existing video rows are skipped and not retro-repaired; undated rows are hidden from `/v1` rather than moved to a quarantine table; there is no admin tooling for provenance review/repair; and date accuracy still depends on publisher markup.

## Scripts

| Command                     | Purpose                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run build`             | Compile TypeScript to `dist/` (`tsc -p tsconfig.build.json`)                             |
| `npm run dev`               | Start the API with watch/reload (`tsx watch src/server.ts`)                              |
| `npm run dev:all`           | Run ingestion once, then start the API (`tsx src/index.ts`)                              |
| `npm start`                 | Start the compiled API (`node dist/server.js`)                                           |
| `npm run scrape`            | Run one ingestion cycle and exit (`tsx src/scrape.ts`)                                   |
| `npm test`                  | Run the Vitest suite once (`vitest run`)                                                 |
| `npm run typecheck`         | Typecheck the project (`tsc --noEmit`)                                                   |
| `npm run lint`              | Prettier check on `src/`                                                                 |
| `npm run format`            | Prettier write on `src/`                                                                 |
| `npm run db:push`           | Push the Prisma schema without migrations (local/dev only)                               |
| `npm run db:migrate:deploy` | Apply committed migrations (`prisma migrate deploy`)                                     |
| `npm run db:baseline`       | Mark the baseline migration as applied (existing databases only)                         |
| `npm run keys:create`       | Create a customer API key (`-- --name "<customer>" --scopes v1:read [--expires-at ISO]`) |
| `npm run keys:list`         | List customer keys, scopes, status and today's request count                             |
| `npm run keys:revoke`       | Revoke a customer key (`-- --id <n>`)                                                    |
| `npm run test:integration`  | Real-Postgres integration suite (needs a disposable `DATABASE_URL`)                      |

## Testing

Two suites, split by whether they need a database:

- **Unit suite — `npm test`** (`vitest run`). Database-free and fast: every Prisma call is mocked. This is what the pre-push hook and the CI `test` job run, and it stays that way — `vitest.config.mts` explicitly excludes `src/__tests__/integration/`.
- **Real-Postgres integration suite — `npm run test:integration`** (`vitest run --config vitest.integration.config.mts`). Runs against a live PostgreSQL database to exercise what mocked tests cannot: the committed migrations (`prisma migrate deploy`), pagination/keyset over duplicate dates, `q`/category/`from`–`to` filters as real SQL, missing-date provenance exclusion on `/v1/*` vs inclusion on legacy `/api/*`, customer API-key scopes + usage metering, `/api/stats` provenance counters, and `Article.link` uniqueness.

  CI runs this automatically in the `integration` job against a `postgres:16` service container. To run it locally, use a **disposable** database (the suite truncates `Article`, `Video`, `ApiKey` and `ApiKeyUsage` before every test — never point it at production):

  ```bash
  # any empty/disposable database works; the example matches the CI service
  # (CI uses passwordless trust auth inside its throwaway service container)
  export DATABASE_URL="postgresql://postgres@localhost:5432/slnews_test"
  npx prisma migrate deploy
  npm run test:integration
  ```

  Without `DATABASE_URL` the suite skips cleanly (`9 skipped`, exit 0), so local unit runs never require a database. The integration suite is a representative slice of the HTTP/SQL surface, not a replacement for the unit suite.

## Environment variables

| Variable                   | Required          | Default                 | Purpose                                                                     |
| -------------------------- | ----------------- | ----------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`             | Yes               | —                       | PostgreSQL connection string (Neon in production)                           |
| `API_KEY`                  | Yes in production | —                       | Static bearer key. Without it (and without Clerk) data routes return `500`  |
| `PORT`                     | No                | `3000`                  | HTTP port                                                                   |
| `NODE_ENV`                 | No                | `development`           | `production` enables JSON logs and production behavior                      |
| `LOG_LEVEL`                | No                | `info` (prod) / `debug` | Pino log level                                                              |
| `CORS_ORIGIN`              | No                | `*`                     | Allowed browser origin(s); pin it in production                             |
| `CLERK_SECRET_KEY`         | No                | —                       | Enables Clerk session-JWT auth alongside `API_KEY`                          |
| `CLERK_AUTHORIZED_PARTIES` | No                | —                       | Comma-separated `azp` allowlist for Clerk JWTs                              |
| `STATIC_KEY_SCOPES`        | No                | `internal:read,v1:read` | Scopes granted to the static `API_KEY` (narrow in production)               |
| `CLERK_SCOPES`             | No                | `internal:read,v1:read` | Scopes granted to verified Clerk session JWTs (narrow in production)        |
| `API_KEY_CACHE_TTL_MS`     | No                | `30000` (30 s)          | Customer-key verification cache TTL; bounds revocation/scope-change lag     |
| `TRUST_PROXY_HOPS`         | No                | `1`                     | Reverse-proxy hops trusted for `X-Forwarded-For`                            |
| `RATE_LIMIT_MAX`           | No                | `100`                   | Max API requests per window per caller                                      |
| `RATE_LIMIT_WINDOW_MS`     | No                | `900000` (15 min)       | Rate-limit window shared by the API and docs limiters                       |
| `DOCS_RATE_LIMIT_MAX`      | No                | `300`                   | Max `/docs` + `/v1/docs` requests per window (separate budget)              |
| `VIDEO_SYNC_COOLDOWN_MS`   | No                | `30000` (30 s)          | Cooldown after `POST /api/videos/sync`; `0` disables it                     |
| `FRESHNESS_MAX_AGE_MS`     | No                | `7200000` (2 h)         | Ingestion lag above which `/api/stats` marks a feed `stale`                 |
| `INGESTION_DEADLINE_MS`    | No                | `2700000` (45 min)      | Wall-clock budget per ingestion cycle; stops starting new work when reached |
| `SCRAPER_USER_AGENT`       | No                | browser-like Chrome UA  | User-Agent override for all scraper HTTP requests                           |

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/anselmeM/SLNewsAPIScapper)

`render.yaml` is the source of truth. It provisions two services:

- **`sl-news-api`** (web): builds with `npm ci --include=dev && npx prisma migrate deploy && npm run build`, starts with `node dist/server.js`, health-checks `/api/health` (liveness), and deploys only after GitHub checks pass (`autoDeployTrigger: checksPass`).
- **`sl-news-scraper`** (cron): hourly (`0 * * * *`), runs `node dist/scrape.js`; each run is bounded by `INGESTION_DEADLINE_MS` (default 45 min) and resumes pending work next cycle.

Setup:

1. Click the button above, or on Render choose **New → Blueprint** and connect this repo.
2. Provide `DATABASE_URL` and `API_KEY` when prompted (plus optional `CORS_ORIGIN`, `CLERK_SECRET_KEY`, `CLERK_AUTHORIZED_PARTIES`, `STATIC_KEY_SCOPES`, `CLERK_SCOPES`, `API_KEY_CACHE_TTL_MS`, `FRESHNESS_MAX_AGE_MS`, `INGESTION_DEADLINE_MS`, `SCRAPER_USER_AGENT`). **`API_KEY` is required**: without it every data route returns `500`, while the liveness probe `/api/health` still reports green (it does not check the database or auth).
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

### Customer API keys in production

- The `20261021120000_api_keys` migration creates `ApiKey` and `ApiKeyUsage`. The web build applies it with `prisma migrate deploy` like any other migration (an existing database still needs its one-time baseline first).
- Run the admin CLI with `DATABASE_URL` pointing at the production database (locally or in a one-off Render shell/job): `npm run keys:create -- --name "Acme News" --scopes v1:read`, then `npm run keys:list` / `npm run keys:revoke -- --id <n>`.
- Static `API_KEY` and Clerk behaviour is unchanged by this migration. A **DB-keys-only** deployment is not supported: the server still requires at least one of `API_KEY` / `CLERK_SECRET_KEY`, otherwise every data route returns the legacy `500` misconfiguration.

### Docker (optional)

The repo ships a multi-stage `Dockerfile` and a `.dockerignore` (so the host `node_modules`, `.git`, `.env*`, and docs never enter the build context):

```bash
docker build -t sl-news-api .
docker run --rm -p 3000:3000 --env-file .env sl-news-api
```

The image runs as a non-root user with `NODE_ENV=production`, and `/docs` resolves the OpenAPI spec from the compiled `dist/routes/*.js` in the image.

## Operations

- **Graceful shutdown.** On `SIGTERM`/`SIGINT` the server stops accepting connections and drains idle ones, then disconnects Prisma and exits `0`. A 10 s force-exit fallback is `unref()`ed and cleared on the graceful path, duplicate signals are ignored, and a failed Prisma disconnect still exits `0` (logged as an error). The handler is exported as `createShutdownHandler` and unit-tested.
- **Fatal errors.** `unhandledRejection` and `uncaughtException` are logged (name/message/stack, no request bodies or credentials) and exit `1` instead of leaving a half-alive process that the platform keeps routing traffic to.
- **CORS.** `CORS_ORIGIN` unset falls back to `*` for backward compatibility, but a production startup now logs **one warning** telling the operator to set it. Configure `CORS_ORIGIN` in production.
- **Logging.** Production logs are JSON (pino); `pino-pretty` is a **devDependency** used only for local development and is never loaded in production (it is not needed at runtime).

## Repository hygiene

- **License:** MIT — see [LICENSE](LICENSE).
- **Line endings:** `.gitattributes` sets `* text=auto` so text files are normalized to LF in the repository (checkouts still honour `core.autocrlf` on Windows). Binary assets (images, fonts) are marked `binary`, and `*.patch` is `-text` so the SLNews app patch stays byte-for-byte.
- **Local formatting:** `.prettierrc` uses `endOfLine: auto`, so the CRLF working tree on Windows does not break `npm run lint`.

## CI

`.github/workflows/ci.yml` runs on pushes to `master`/`main` and on pull requests:

- `lint-and-typecheck` — Prisma validate, Prettier, `tsc --noEmit`
- `test` — Vitest unit suite (database-free; the integration suite is excluded)
- `integration` — real-Postgres integration suite against a `postgres:16` service container (applies migrations, then runs `npm run test:integration`)
- `build` — `npm run build` (no database needed)
- `docker` — image build on pull requests only
- `audit` — `npm audit --omit=dev --audit-level=high`

All jobs run with `contents: read`, per-job timeouts, and workflow-level `concurrency` with `cancel-in-progress`. Render's `autoDeployTrigger: checksPass` means `master` only deploys after these checks are green.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 SLNews Scraper API contributors.
