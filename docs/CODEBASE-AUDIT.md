# Codebase Audit — SLNews Scraper API

**Audit date:** 2026-10-18
**Commit audited:** `edfaeb8` (master, working tree clean)
**Scope:** entire repository (`src/`, `prisma/`, configs, CI, Docker, Render blueprint, docs)
**Method:** read-only audit by 5 agents (security, ingestion/data, API/contract, CI/ops, lead synthesis), with targeted reproduction of high-risk claims. No files were modified, nothing was deployed, no live scraping was performed.

**Gates at audit time (clean machine, no parallel load):**

| Gate                                       | Result                                                    |
| ------------------------------------------ | --------------------------------------------------------- |
| `npm test`                                 | ✅ 125/125 tests pass (10 files, ~15 s)                   |
| `npx tsc --noEmit`                         | ✅ clean                                                  |
| `npm run lint` (Prettier)                  | ✅ clean                                                  |
| CI (`lint-and-typecheck`, `test`, `audit`) | ✅ green at HEAD                                          |
| Dependency audit                           | 0 high/critical, 2 moderate (dev-only, `vitest` < 4.1.11) |

**Severity rubric:** P0 = active credential/data exposure, fix before next deploy · P1 = release or product blocker · P2 = should fix soon · P3 = polish/tech debt.

---

## Executive summary

The application core is in good shape: the scraper works, the `/v1` metadata-only contract is correctly enforced, auth is typed and tested, the HTTP layer has caching/404/health/error handling, and the test suite passes cleanly. The weaknesses are concentrated in the **production/deployment shell** and in **data quality under failure**:

| #    | Finding                                                                                  | Sev    | Effort |
| ---- | ---------------------------------------------------------------------------------------- | ------ | ------ |
| P0-1 | Raw `Authorization` header (API key, Clerk JWT) is written to production logs            | **P0** | S      |
| P1-1 | Rate limiter is one global bucket behind Render; anonymous traffic can 429 everyone      | P1     | S      |
| P1-2 | No migrations; `prisma db push` mutates prod schema on every boot                        | P1     | M      |
| P1-3 | Render blueprint is incomplete/invalid; CI is not actually a deploy gate                 | P1     | S–M    |
| P1-4 | Docker path is broken and has never been exercised                                       | P1     | M      |
| P1-5 | Hourly metadata backfill is O(all articles) and never terminates                         | P1     | M–L    |
| P1-6 | Missing/invalid dates and failed extractions fabricate feed data with no repair path     | P1     | M      |
| P1-7 | One shared credential, no scopes/quotas/metering/revocation — blocks selling the product | P1     | L      |

The highest-leverage fixes are cheap: log redaction, `trust proxy`, declaring `API_KEY` in the blueprint, and switching to Prisma migrations. See [Remediation plan](#remediation-plan).

---

## Implementation status (2026-10-21)

Status of these findings against the working tree on `perf/scraper-resilience`
(the audit fixes landed in `37bae0f`, the pagination/index work in `a3d3603`, and the
health/observability work in `cba9a91`; the scraper-resilience work is uncommitted at
the time of writing). The audit itself was taken at `edfaeb8`; the full finding text
is preserved below, with a short inline status note on each reviewed finding.

| Finding    | Status    | What changed — and what remains                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1       | ✅ Fixed  | `pino-http` redacts `req.headers.authorization` and `req.headers.cookie` (`src/logger.ts`, `src/server.ts`); a regression test captures the log stream and asserts the token never appears.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P1-1       | ✅ Fixed  | Numeric `TRUST_PROXY_HOPS` (default `1`), key = SHA-256 of the bearer token or a normalized `ipKeyGenerator` IP, `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`. A separate anonymous-traffic limiter and a shared store were not added.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P1-2       | ✅ Fixed  | Baseline migration `prisma/migrations/20261020120000_init` committed; `prisma migrate deploy` runs in the Render build; `db push` removed from `build`/start. Existing databases need one `npm run db:baseline` first; no CI schema-drift check yet.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P1-3       | ✅ Fixed  | `render.yaml` declares `API_KEY`/CORS/Clerk/`LOG_LEVEL`/`NODE_ENV`, cron on `plan: starter`, `autoDeployTrigger: checksPass`; the git docs now say the real gate is the local hook + CI + PR discipline (branch protection returns `403` on the free private repo). Fail-fast boot env validation was not added.                                                                                                                                                                                                                                                                                                                                                                  |
| P1-4       | ✅ Fixed  | `.dockerignore` added; `prisma/` + `prisma.config.ts` copied before `npm ci`; `NODE_ENV=production` in the runner; Swagger falls back to `dist/routes/*.js`; Docker build runs on PRs. Dev dependencies are still copied into the runner image.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P1-5       | ✅ Fixed  | Metadata backfill is now inline per feed item (no full-table scan); article-page image fetches are capped at 10 per run inside a 60 s budget. Attempt tracking/negative cache and a separate archive repair job were not added.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P2-3       | ✅ Fixed  | Authenticated data responses send `Cache-Control: private`; CORS exposes `X-Total-Count` plus the `RateLimit-*`/`Retry-After` headers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P2-1       | ✅ Fixed  | `src/utils/pagination.ts` centralizes page parsing: legacy `/api` still clamps `limit` > 100, but `page` is capped at 10,000 and absurd/deep offsets return `400` instead of a Prisma `500`; `/v1` adds mutually exclusive `cursor` keyset pagination (`meta.next_cursor`, `page`/`total` null, no count query). Remaining: page mode still runs an exact count and `/api` has no cursor mode.                                                                                                                                                                                                                                                                                    |
| P2-2       | ✅ Fixed  | New `20261021000000_search_indexes` migration adds `pg_trgm` GIN trigram indexes (Article title/description, Video title/description/channelTitle), GIN indexes on the `category` arrays, and composite `(source, pubDate)`/`(pubDate, id)` indexes (+ video equivalents). Search is still `ILIKE '%term%'` (best for 3+ character terms); keyset predicate correctness is unit-tested with a mocked Prisma, not executed against a real database in CI.                                                                                                                                                                                                                          |
| P2-11      | ✅ Fixed  | `ts-node` replaced with `tsx` (TypeScript 7 has no JS compiler API); entrypoints load `dotenv/config`; `build` is `tsc -p tsconfig.build.json`; `NODE_ENV=production` in Render and Docker. Env validation is still per-request, not fail-fast at boot.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P2-4       | ◐ Partial | Swagger now resolves `dist/routes/*.js` when `src/routes` is absent, so `/docs` is non-empty in the Docker image. Nullability (e.g. `summary: null`), complete item schemas + `/v1/*/{id}`, and spec validation in CI remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P2-10      | ◐ Partial | CI has `contents: read`, concurrency + cancel-in-progress, per-job timeouts, a no-DB `build` job, a Docker build on PRs, and `npm audit --omit=dev --audit-level=high` (dependency audit now reports 0 vulnerabilities). SHA-pinned actions, coverage, and a `prisma migrate diff` gate remain.                                                                                                                                                                                                                                                                                                                                                                                   |
| P2-12      | ◐ Partial | `check-db.ts` is deleted and `vitest.config.ts` renamed to `.mts`. Root tooling is still outside `tsconfig` (`include: ["src/**/*"]`) and declaration output is unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P2-5       | ✅ Fixed  | `/api/health` is now a liveness probe (200, never queries the database) and the new `/api/ready` is the readiness probe (database check cached for 5 s, 200/503); both are `no-store` and exempt from the rate limiter, and Render's `healthCheckPath` stays `/api/health`. Remaining: `/api/ready` is still unauthenticated and limiter-exempt (the 5 s cache bounds DB load), and no connection-pool saturation signal is exposed.                                                                                                                                                                                                                                              |
| P2-6       | ✅ Fixed  | `X-Request-Id` (validated/echoed or generated UUID) is returned, carried in the pino access logs, and included as `request_id` in 404/4xx/5xx bodies; `/api/stats` + `/v1/stats` add `runtime` (uptime, start time, RSS, Node version, per-process request counters) and `freshness.articles`/`freshness.videos` (`latest_ingested_at`, `lag_seconds`, `stale` vs `FRESHNESS_MAX_AGE_MS`, default 2 h; empty feed ⇒ stale). Remaining: no Sentry/OTel/Render alert wiring, no Prometheus metrics endpoint, counters reset on restart, and no per-key usage metering.                                                                                                              |
| P2-7       | ✅ Fixed  | Batched dedupe: one `article.findMany(link in …)` per feed and one `video.findMany(videoId in …)` per channel (the sitemap walk keeps one in-memory link set); new articles fetch the page once for paragraphs + `og:image` (feed-HTML image preferred); the sitemap walk stops after 2 consecutive fully-known pages and treats only 404/410 as the normal end. Remaining: no persisted sitemap cursor/`lastmod` high-water mark (each run re-reads the newest pages), URL canonicalization unchanged (scheme/www/AMP variants can still duplicate rows), category taxonomy + sitemap `category: []` untouched, and existing video rows are still skipped rather than refreshed. |
| P2-8       | ✅ Fixed  | Retries now honour `Retry-After` on 429/503 (delta-seconds or HTTP-date, capped 30 s), use exponential backoff (1 s/2 s/4 s, capped 30 s) plus bounded jitter, do not retry other 4xx, and accept an absolute per-request deadline; feeds go through `fetchWithRetry` + `parser.parseString` (15 s) instead of rss-parser's hard-coded no-retry fetch; a run-wide `INGESTION_DEADLINE_MS` (default 45 min) gracefully stops starting new work. Remaining: the default UA is still browser-like (override with `SCRAPER_USER_AGENT`), no conditional GET/ETag or persisted response cache, and no per-host rate limiter (only fixed inter-request pauses).                         |
| P1-6, P1-7 | ⛔ Open   | Date/content provenance and the credential/tenant model are untouched — still release and product blockers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P2-9, P3   | ⛔ Open   | DB-backed tests and the polish items remain as written below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## What is already healthy (verified, not assumed)

- **`/v1` contract is correct:** `ARTICLE_META_SELECT` never selects `paragraphs` (`src/routes/v1.ts:18-26`); tests assert the DB query itself excludes full text (`src/__tests__/api.test.ts:268-279`).
- **Auth fails closed:** missing `API_KEY` and Clerk config ⇒ 500, never open (`src/auth/requireAuthentication.ts:50-54`); timing-safe compare; case-insensitive `Bearer`; rejected tokens log a stable reason code only.
- **HTTP hygiene:** helmet, JSON 404, health/readiness `no-store` + `/api/ready` 503 degraded path, well-formed 429 with `Retry-After`, ETag/304 revalidation works (Express default), gzip compression, graceful SIGTERM/SIGINT shutdown.
- **No secrets tracked:** `.env` gitignored and absent; history scan found no keys; `render.yaml` uses `sync: false`.
- **Git hooks work** on this Windows/CRLF tree (master-push blocked locally, commitlint + lint-staged active); lockfile is consistent (`npm ci` safe).
- **Docker runs non-root** with a functional health check (the build itself was broken at audit time — fixed per P1-4).
- **No secrets or keys in code**, no SQL injection path (`q` is parameterized through Prisma).

---

## P0 — fix before the next deploy

### P0-1 · Every request logs the raw `Authorization` header

**Status (2026-10-20): ✅ Fixed.** `pinoHttp` now runs with
`redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' }`
(`LOG_REDACTION` in `src/logger.ts`, wired in `src/server.ts:79`), and
`src/__tests__/security.test.ts` proves a token never reaches a captured log
stream. Production also runs with `NODE_ENV=production`.

**Evidence:** `src/server.ts:28-30` mounts `pinoHttp({ logger })` with no serializers or redaction; `src/logger.ts:5-13` sets no redaction. pino-http's default request serializer copies **all** headers (`node_modules/pino-std-serializers/lib/req.js:88` — `_req.headers = req.headers`). Reproduced: a log line contained `"authorization":"Bearer <token>"`. Existing tests miss it because pino-http is disabled under `NODE_ENV=test` (`src/server.ts:28`) and auth tests mock the logger.

**Impact:** the long-lived static `API_KEY` (and any Clerk session JWT) is persisted in Render logs and log drains. Anyone with dashboard/log access can impersonate every customer. There is no revocation path: rotating the key requires redeploying the API and every consumer.

**Fix:** `pinoHttp({ logger, redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' } })` (or a custom `req` serializer that drops headers). Add a regression test with an in-memory pino destination. Also set `NODE_ENV=production` in prod (P2-11) to reduce debug-level noise.

**Effort S · Confidence high (reproduced).**

---

## P1 — release / product blockers

### P1-1 · Rate limiting is a single global bucket; anonymous traffic can exhaust it

**Status (2026-10-20): ✅ Fixed.** `app.set('trust proxy', parseTrustProxyHops(process.env.TRUST_PROXY_HOPS))` now
runs before the limiter (default 1 hop, never `true`), the key generator returns the SHA-256 of the
`Authorization` header when present and `ipKeyGenerator(req.ip)` otherwise, and max/window come from
`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` (`src/server.ts:37-56,82-94`). Covered by
`src/__tests__/rate-limit.test.ts`. The suggested separate limiter for unauthenticated traffic and a shared
store (needed if the service ever runs more than one instance) were **not** added.

**Evidence:** nothing ever calls `app.set('trust proxy', …)` (grep: absent). The limiter is mounted at `src/server.ts:43`, **before** auth (`src/server.ts:74-82`), and express-rate-limit's default key generator uses `req.ip` (`node_modules/express-rate-limit/dist/index.cjs:827-839`). Behind Render's proxy `req.ip` is the proxy address. Reproduced: 101 requests with 101 distinct `X-Forwarded-For` values produced 429 on request #101; a second "client" then received 429; the library also printed `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` with a stack trace to stderr.

**Impact:** the 100-req/15-min budget is shared by **all customers** (and the app) per instance. Any anonymous actor can send 100 cheap 401s and 429 every paying client for 15 minutes; health checks stay exempt, so Render never notices. Per-customer quotas are impossible.

**Fix:** `app.set('trust proxy', 1)` before the limiter (never `true`); key by credential with IP fallback (`keyGenerator: (req) => req.headers.authorization ?? ipKeyGenerator(req.ip)`); make max/15-min window env-configurable; use a looser separate limiter for unauthenticated traffic. Use a shared store if the service ever runs more than one instance.

**Effort S · Confidence high (reproduced).**

### P1-2 · Schema is applied with `prisma db push` on every boot; there are no migrations

**Status (2026-10-20): ✅ Fixed.** `prisma/migrations/20261020120000_init/` (baseline) is committed,
`render.yaml` runs `npx prisma migrate deploy` in the web build before `npm run build`, and `db push` is
no longer part of `build` or any start command (`package.json` keeps `db:push` as a local-only script).
**One-time caveat:** a database created by the old `db:push` workflow must run `npm run db:baseline` once
before the first migrate-deploy (otherwise `migrate deploy` fails with P3005); fresh databases need nothing.
Not added: a CI `prisma migrate diff --exit-code` drift gate and the backup/restore runbook.

**Evidence:** `prisma/migrations/` does not exist. `render.yaml:8` runs `npx prisma db push --url "$DATABASE_URL" && node dist/server.js`; `package.json:11` (`build`) also runs `db push`.

**Impact:** no versioned schema history, no review, no ordered rollout, no rollback. A Render rollback re-runs the old `startCommand` against a newer database (schema regression or refused destructive change, which blocks boot). A Neon blip at boot stops the API instead of letting it serve 503. CI cannot detect schema drift.

**Fix:** `prisma migrate dev` → commit `prisma/migrations/`; apply with `prisma migrate deploy` in a Render `preDeployCommand` (paid) or a one-off job/GH Action; remove `db push` from `startCommand` and `build`; add `prisma migrate diff --exit-code` to CI; document backup/restore.

**Effort M · Confidence high.**

### P1-3 · The Render blueprint is incomplete/invalid and CI is not a deploy gate

**Status (2026-10-20): ✅ Fixed.** `render.yaml` now declares `API_KEY`, `CORS_ORIGIN`, `CLERK_SECRET_KEY`,
`CLERK_AUTHORIZED_PARTIES`, `LOG_LEVEL` and `NODE_ENV` (with `sync: false` for secrets), runs the cron on
`plan: starter` (Render's smallest paid plan — free cron is not offered), and sets
`autoDeployTrigger: checksPass` on both services. `AGENTS.md`, `CONTRIBUTING.md` and `docs/GIT-WORKFLOW.md`
no longer claim GitHub branch protection; they state the gate is the local hook + CI + PR discipline.
Not added: fail-fast environment validation at boot (a missing `API_KEY` still surfaces as per-request 500s).

**Evidence:**

- `render.yaml:10-14` declares only `DATABASE_URL` and `PORT`. `API_KEY` is missing; with it unset, every protected route returns 500 (`src/auth/requireAuthentication.ts:50-54`) while `/api/health` stays green (`src/server.ts:64-72`). `NODE_ENV`, `CORS_ORIGIN`, `CLERK_*` are also undeclared.
- `render.yaml:20` sets the cron job to `plan: free`; Render free instances cover web/Postgres/KeyValue only — cron starts at `0.5c-512mb` with a $1/month minimum. The hourly data supply is not provisionable from this blueprint as written.
- No `autoDeployTrigger` is set, so Render's default deploys **every push to master regardless of CI status**.
- `AGENTS.md:9-16`, `CONTRIBUTING.md:4`, and `docs/GIT-WORKFLOW.md:3-15` claim `master` is branch-protected with required status checks. The repo is private on free GitHub (`gh repo view` → `"isPrivate": true`); protection and rulesets APIs return 403 ("Upgrade to GitHub Pro or make this repository public"). The documented gate does not exist.

**Impact:** a fresh blueprint deploy is health-check-green but 100% broken for data routes; ingestion may not be created at all; a red CI run can reach production; contributors are told a protection exists that doesn't.

**Fix:** declare `API_KEY` (and optional Clerk/CORS/LOG_LEVEL/NODE_ENV) with `sync: false`; use a paid cron plan, or move ingestion to a GitHub Actions schedule; set `autoDeployTrigger: checksPass` on both services; make the repo public/upgrade GitHub, or correct the docs to say "local hook + CI discipline only"; add fail-fast env validation at boot.

**Effort S–M · Confidence high (GitHub/Render facts from API/docs at audit time).**

### P1-4 · The Docker path is broken and unexercised

**Status (2026-10-20): ✅ Fixed.** `.dockerignore` was added (`node_modules`, `dist`, `.git`, `.env*`,
`*.patch`, `docs`); the Dockerfile copies `prisma/` and `prisma.config.ts` before `npm ci`; the runner sets
`NODE_ENV=production`; `resolveApiGlobs()` falls back to `dist/routes/*.js` so `/docs` is non-empty in the
image; and CI now builds the image on every PR (`ci.yml` `docker` job). Still open from the original fix
list: dev dependencies are not pruned from the runner's copied `node_modules`.

**Evidence:**

- `Dockerfile:3-4` copies only `package*.json`, then runs `npm ci`, whose `postinstall` is `npx prisma generate` (`package.json:7`). The Prisma schema isn't copied until line 15 — verified: `prisma generate` with no schema exits non-zero ("Could not find Prisma Schema"). **The image build fails at step 4.**
- No `.dockerignore`: `COPY . .` (`Dockerfile:5`) would also pull the host `node_modules` (Windows binaries), `.git`, `dist`, and any local `.env` into the context/image.
- Runner copies the full builder `node_modules` (`Dockerfile:12`) including ~286 dev-only packages (image bloat/attack surface).
- No `src/` is copied, so `swagger-jsdoc`'s `apis: ['src/routes/*.ts']` (`src/config/swagger.ts:33`) resolves to zero paths — verified `paths` = 0 from a cwd without `src/`; `/docs` would render an empty spec.
- `docker.yml` runs only on `v*` tags and there are no tags, so the workflow has never executed.

**Impact:** containerized releases fail (or ship bloated, doc-less images). This path is silently untested.

**Fix:** add `.dockerignore` (`node_modules`, `dist`, `.git`, `.env`, `*.patch`); copy `prisma/` before `npm ci` (or `npm ci --ignore-scripts`, then generate); prune dev deps in the runner (`npm ci --omit=dev`, keep `prisma` only if needed); generate the OpenAPI spec at build time or copy `dist/routes/*.js` and point the glob there; `ENV NODE_ENV=production`; build the image on PRs with `push: false`.

**Effort M · Confidence high (generate failure reproduced; empty-spec reproduced).**

### P1-5 · Hourly metadata backfill is O(all articles), unbounded, and runs before ingestion

**Status (2026-10-20): ✅ Fixed (bounded).** The full-table scan is gone: metadata is filled inline for each
feed item already being processed (`src/services/scraper.ts:164-275`), and the remaining article-page image
fetches are capped at `MAX_IMAGE_FETCHES_PER_RUN = 10` and a `BACKFILL_BUDGET_MS = 60_000` wall-clock budget
shared across sources. The (unreachable) archive-wide repair pass — attempt tracking/negative cache and a
separate daily paginated job — was not implemented, so metadata for rows that never reappear in a feed is
still never repaired.

**Evidence:** `backfillArticleMeta()` (`src/services/scraper.ts:149-197`) runs first in every cycle (`:202`). Its gate (`:150-153`) counts rows missing image/description/category and is **permanently non-zero**: sitemap-ingested rows have `category: []` (`:380`) and archive articles never reappear in the ~10-item RSS window. It then loads **every article** into memory (`:157-160`) although only current feed items are processed (`:162-196`), and for each missing image performs an article-page fetch with three 8-second attempts (`:97-126`). No cap, no time budget, no attempt tracking, and no try/catch around the initial DB query (a DB error aborts the whole ingestion cycle).

**Impact (measured):** ~1 KB retained per article → ~54 MB for 50k rows, ~107 MB for 100k rows, on a 512 MB free cron instance, reloaded every hour forever, plus repeated network fetches for rows that can never be fixed. At 50–100 new rows/day this becomes a multi-year OOM cliff and a growing hourly latency/egress cost. It can also push a run past the 60-minute slot, delaying subsequent runs.

**Fix:** query only links present in the current feed (`link: { in: feedLinks }`), add `metaBackfillAttempts`/`lastAttemptAt` with a negative cache, add a wall-clock budget, run **after** ingestion, wrap in try/catch, and move archive-wide repair to a separate daily paginated job.

**Effort M–L · Confidence high.**

### P1-6 · Missing/invalid dates and failed extractions fabricate feed data with no repair path

**Evidence:** `safeParseDate()` returns `new Date()` for a missing date (`src/services/scraper.ts:26-38`) and is used for every RSS row (`:242`); the sitemap path does the same (`:377`); video parsing falls back to now (`src/services/video-scraper.ts:42,59`). The sitemap walker fabricates an article body from the summary/title (`scraper.ts:382`) and stores `description: ''` (`:379`). The RSS path can store `paragraphs: []` (`:223-229`). Upserts use `update: {}` (`:236-250`), and the backfill only fills image/description/category — failed extractions are never retried. There is no `updatedAt` and no completeness signal.

**Impact:** `/v1/news` sorts and filters on `pubDate` (`src/routes/v1.ts:210-218`), so the sellable "latest news" product is corrupted: undated items jump to the top; a batch with identical fallback timestamps is ordered oldest-first by the `id desc` tiebreak; archive backfill can place old news at the top; future dates are never clamped and hide an item from `to=` filters. Customer #1 (the app) reads `/api/news` full text and can render empty or summary-as-body articles. None of this is detectable in stats.

**Fix:** strict date parsing with raw-string retention and a `dateConfidence`/`pubDateSource` column; clamp to `[now − 10y, now + 1d]`; quarantine undated items instead of faking; add `contentStatus`/`contentAttempts` and never fabricate bodies; add a repair sweep; add `updatedAt`.

**Effort M · Confidence high.**

### P1-7 · One shared credential with no scopes, revocation, quotas, or metering — the selling model is blocked

**Evidence:** auth accepts a single `process.env.API_KEY` (`src/auth/requireAuthentication.ts:47-63`) or **any** verified Clerk JWT (`:66-71`). The same middleware guards the sellable `/v1/*` metadata routes **and** the internal full-text `/api/news` route (`src/server.ts:74-82`), which returns whole rows including `paragraphs` (`src/routes/news.ts:112-119`). The app receives the key client-side (`slnews-app-pin-legacy.patch`), so it is extractable by anyone who inspects the PWA. There is no per-key identity, usage count, quota, scope, rotation, or revocation.

**Impact:** every customer credential unlocks the internal full-text path, defeating the locked link+summary contract. The "sellable data product" cannot meter, bill, rate-limit per customer, revoke a leaked key, or distinguish internal app traffic from customer traffic. Clerk access is all-or-nothing (any signed-in user of the instance). One leaked key compromises the whole product.

**Fix (productization):** an `ApiKey`/`Customer` model with hashed keys, labels, scopes (`v1:read`, `internal:read`), per-key quotas and usage counters, expiry/rotation with overlap, and a separate internal key mounted only on `/api/*`. Map Clerk org/role claims to the same scopes; require `CLERK_AUTHORIZED_PARTIES` in production. Keep the app on `/api/news` (locked rule).

**Effort L · Confidence high (design analysis of verified code).**

---

## P2 — fix soon

### P2-1 · `/api` vs `/v1` validation and pagination diverge; unbounded `page` becomes a 500 and a huge OFFSET

**Status (2026-10-20): ✅ Fixed.** `src/utils/pagination.ts` is the shared parser: legacy `/api` keeps the
silent `limit` clamp for the pinned app but caps `page` at 10,000 and rejects absurd/deep offsets with `400`
(`PAGE_TOO_DEEP_ERROR`) before Prisma sees them; `/v1` keeps strict `400`s and adds mutually exclusive
`cursor` keyset pagination (`meta.next_cursor`, `page`/`total` null, no count query). Remaining: page mode
still runs an exact `count(*)`, and `/api` keeps page-based pagination only.

`/api/news` and `/api/videos` silently clamp `limit > 100` (`src/routes/news.ts:84`, `src/routes/videos.ts:88`), while `/v1` returns 400 (`src/routes/v1.ts:160-171`, `src/routes/v1-videos.ts:99-110`). Legacy routes have no page ceiling; `page=1e9` produces `skip=19,999,999,980`, and verified against the real Prisma client, `page=1e21` (`skip ≥ 2e19`) throws `PrismaClientValidationError`, which the route catch turns into **500** instead of 400 (same for `/api/news/1e21`). Duplicated constants exist in four files (`news.ts:11-12`, `v1.ts:11-13`, `videos.ts:10-11`, `v1-videos.ts:9-11`). **Fix:** one shared pagination/query builder; reject non-safe skips with 400; align clamp-vs-400 policy; add keyset (`pubDate,id`) pagination for `/v1`.

### P2-2 · Search and filters are unindexed full scans, executed twice per request

**Status (2026-10-20): ✅ Fixed.** `prisma/migrations/20261021000000_search_indexes/migration.sql` adds the
`pg_trgm` extension and GIN trigram indexes (`Article.title`/`description`,
`Video.title`/`description`/`channelTitle`), GIN indexes on the `category` arrays, and composite
`(source, pubDate)`/`(pubDate, id)` indexes (plus the Video equivalents); `schema.prisma` models the
composite/category indexes. Queries are unchanged — `ILIKE '%term%'`, where trigram indexes are most
effective for 3+ character terms — page mode still runs exact counts, and CI unit-tests the keyset predicate
with a mocked Prisma rather than executing it against a real database.

`contains … mode: 'insensitive'` compiles to `ILIKE '%term%'` on `title`/`description` (and `channelTitle` for video); `category` uses unindexed array `hasSome`. Every list request also runs an exact `count(*)` with the same predicate (`news.ts:112-115`, `v1.ts:220-223`, `videos.ts:117`, `v1-videos.ts:144-152`). `prisma/schema.prisma:22-24,40-42` has only single-column indexes (`pubDate`, `source`, `createdAt`). Latency and DB CPU grow linearly with the archive. **Fix:** `pg_trgm` + GIN on lowercased title/description (or FTS `tsvector`), GIN on `category`, composite `(source, pubDate)` and `(pubDate, id)`; use `take + 1` for `has_more` and cache/drop exact totals; keyset pagination.

### P2-3 · `Cache-Control: public` on authenticated responses; CORS hides pagination/limit headers

**Status (2026-10-20): ✅ Fixed.** Data routes now send `Cache-Control: private, max-age=…, s-maxage=…`
(`news.ts`, `v1.ts`, `videos.ts`, `v1-videos.ts`, `stats.ts`; health stays `no-store`), and `cors()` exposes
`['X-Total-Count', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After']`
(`src/server.ts:66-72`).

All data routes set `public, max-age…, s-maxage…` with no `Vary: Authorization` (`news.ts:118,162`, `v1.ts:225`, `videos.ts:120,192`, `v1-videos.ts:154`, `stats.ts:54`). Any intermediary cache may store an authenticated response and serve it to unauthenticated callers once a CDN/proxy is added; detail responses can also hold stale null descriptions for an hour. `cors({ origin })` (`server.ts:23-24`) exposes no custom headers, so browser clients cannot read `X-Total-Count` or `RateLimit-*`/`Retry-After`. **Fix:** `private` (or `Vary: Authorization` if a CDN is intended and keyed correctly) and `exposedHeaders: ['X-Total-Count', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After']`.

### P2-4 · OpenAPI docs drift from behavior and are empty in Docker

**Status (2026-10-20): ◐ Partially fixed.** The Docker half is fixed: `resolveApiGlobs()` prefers
`src/routes/*.ts` and falls back to `dist/routes/*.js`, so the shipped image serves a populated spec. The
contract half remains: `/v1/news` still documents `summary` as a required string while `Article.description`
is nullable, `/v1/videos` items still have no `properties`, `/v1/*/{id}` item endpoints and CI spec
validation are still missing.

/v1/news declares `summary` as a required non-null string (`v1.ts:108-115`) but maps the nullable `Article.description` straight through (`v1.ts:230`; `schema.prisma:14`) — verified `{"summary":null}`. `/v1/videos` items are `required` with no `properties` (`v1-videos.ts:79-81`). `/api/*` 200 responses have no schemas; `/v1/stats` is mounted but undocumented (`server.ts:76` vs `stats.ts:9`); `403` is documented although no scope model exists (`v1.ts:143-146`); health and root are undocumented; there is no `/v1/news/{id}` or `/v1/videos/{id}` for customers to fetch one item; and the spec is empty in the Docker layout (P1-4). **Fix:** correct nullability, complete schemas, add item endpoints (additive), validate the spec in CI (e.g. `swagger-parser`), add a contract test for `summary: null`.

### P2-5 · Health endpoint is an unthrottled, unauthenticated DB-query DoS vector and couples liveness to the DB

**Status (2026-10-21): ✅ Fixed.** `/api/health` is now liveness only — it answers from process state, never
queries the database, sends `no-store`, and is limiter-exempt — while the new `/api/ready` performs the cached
(5 s TTL) database probe and returns a `503` degraded body when the database is unreachable. `render.yaml`
keeps `/api/health` as the platform health check; monitoring is expected to poll `/api/ready`. Remaining:
readiness is unauthenticated and limiter-exempt (bounded only by the 5 s cache), and no connection-pool metric
is exposed.

`/api/health` runs `prisma.$queryRaw` on every request (`server.ts:64-72`) and is explicitly exempt from the limiter (`:38`). Anonymous traffic can pin the Prisma pool/Neon compute and inflate cost; a DB blip turns liveness red and Render restarts the service after 60 s of failures. **Fix:** cache the probe for a few seconds, split `/live` (process) from `/ready` (DB), and rate-limit anonymous health hits conservatively.

### P2-6 · No observability, alerting, freshness signal, or usage metering

**Status (2026-10-21): ✅ Fixed.** Request ids are now explicit (`X-Request-Id` validated/echoed or a
generated UUID), carried in pino access logs, and returned as `request_id` in 404/4xx/5xx bodies;
`/api/stats` (and `/v1/stats`) expose `runtime` (uptime, start time, RSS, Node version, per-process request
counters) and `freshness.articles`/`freshness.videos` (`latest_ingested_at`, `lag_seconds`, `stale` vs
`FRESHNESS_MAX_AGE_MS`, default 2 h; no data ⇒ stale). Remaining: no Sentry/OTel/Render alert wiring, no
Prometheus/`/metrics` endpoint, counters are per-process and reset on restart, and there is still no per-key
usage metering (P1-7).

Request IDs are generated by pino-http but never returned (`X-Request-Id` absent); no metrics/tracing/Sentry; no alert when ingestion dies; no freshness check despite `stats` exposing latest dates; in-memory rate-limit store resets on restart; no backup/RPO/RTO documentation. **Fix:** `x-request-id` response header (+ include in 500 bodies), Sentry/OTel or Render alerts, freshness in `/ready`/stats, shared limiter store when >1 instance, per-key usage counters (P1-7), Neon backup/PITR notes.

### P2-7 · Pipeline quality: N+1 queries, stale metadata, duplicate fetches, non-converging sitemap, weak URL/category normalization

**Status (2026-10-21): ✅ Fixed (dedupe / single fetch / convergence).** Feeds now batch-dedupe with one
`article.findMany({ link: { in: … } })` per feed, video channels with one
`video.findMany({ videoId: { in: … } })`, and the sitemap walk against one in-memory link set. New articles
use a single page fetch that returns both the selector paragraphs and `og:image` (a feed-HTML image skips the
fetch), and the sitemap walk converges after 2 consecutive fully-known pages while keeping its 20-page and
50-ingest caps; 404/410 is the normal end and any other failure stops the walk with an error. Remaining: no
persisted sitemap cursor/`lastmod` high-water mark, so the newest sitemap pages are still re-read every run;
URL canonicalization is unchanged (scheme/`www`/AMP/param-order variants can still duplicate a row);
category taxonomy normalization and the empty `category` on sitemap-ingested archive rows are untouched; and
existing video rows are skipped rather than refreshed (metadata can go stale).

- Per-item `findUnique` then `upsert` (`scraper.ts:216-236`, `video-scraper.ts:90-118`) — 2–3 round trips per item.
- The video `findUnique`-skip makes the `upsert` update branch unreachable, so video titles/descriptions never refresh (`video-scraper.ts:95-118`).
- Article pages are fetched twice when the feed HTML has no image (`scrapeFullContent` + `findArticleImage`, `scraper.ts:223,231`).
- The sitemap walker fetches pages 1–20 every run, ignores `<lastmod>`, loads all Telegraph links into memory each run, stops silently at ~40k posts, and archive rows never get categories (`scraper.ts:283-399`).
- URL normalization misses scheme/www/AMP/param-order/index.html variants (`utils/url.ts`), so the same article can be stored twice under `link @unique`.
- Category values are publisher-cased (`Politics`) while docs/examples use lowercase (`v1.ts:76`) and filtering is exact (`v1.ts:192-194`), so documented category queries can return zero rows; sitemap rows are `[]` and can never match. **Fix:** batch `findMany({ link: { in } })`; parse each page once; cursor + `lastmod`; canonical URL key/hash; normalize categories to a canonical taxonomy at ingest; add a per-source freshness summary.

### P2-8 · HTTP resilience: no `Retry-After`, RSS bypasses retry, no run deadline, spoofed UA

**Status (2026-10-21): ✅ Fixed (retry / deadline / resilience).** `fetchWithRetry` retries transient
network errors, `5xx` and `429` (3 attempts) with exponential backoff (1 s/2 s/4 s, capped 30 s) plus bounded
jitter; `429`/`503` honour `Retry-After` (delta-seconds or HTTP-date, capped 30 s); other `4xx` are not
retried; requests accept an absolute deadline that also caps each attempt's timeout. RSS/Atom feeds now use
the same retry path (`fetchWithRetry` + `parser.parseString`, 15 s) instead of rss-parser's hard-coded
no-retry URL fetch, and the whole ingestion cycle has a graceful `INGESTION_DEADLINE_MS` budget (default
45 min) after which no new source/page/channel starts. Remaining: the default User-Agent is still the
browser-like Chrome string (overridable via `SCRAPER_USER_AGENT`), there is no conditional GET
(`ETag`/`If-Modified-Since`) or persisted response cache, and there is no per-host rate limiter — only fixed
inter-request pauses.

`fetchWithRetry` retries 429/5xx with fixed 1s/2s backoff but never reads `Retry-After`, adds no jitter, and has no total budget (`src/utils/http.ts:26-46`). RSS feeds bypass it via `parser.parseURL` (`scraper.ts:164,208`), which has a hard-coded 60 s timeout and no retry. Worst-case cycles (6 feeds × 60 s + up to 50 sitemap pages × (3×10 s + 1.5 s) + image fetches) can exceed the hourly slot, and Render delays the next run. The scraper sends a Chrome UA with no contact identity and no robots/ToS policy — a reputational/legal risk for a product built on publishers' content. **Fix:** honor `Retry-After`, add jitter/per-host limiter/global run deadline, fetch feed XML through `fetchWithRetry` + `parseString`, conditional GET (`ETag`/`If-Modified-Since`), descriptive UA + source policy.

### P2-9 · Tests are Prisma-mocked only, miss the risky paths, and are load-sensitive

All API tests mock `../db.js`, so nullability, `skip` overflow → 500, `select` behavior, indexes, and migrations are invisible. Missing coverage: error handler (`server.ts:89-92`), 429/trust-proxy/XFF, `/docs` non-empty spec, health `no-store`, `/v1/videos` success filters, null `summary`, stats 500 path. `scraper.test.ts:69` asserts `article.create` was never called although production uses `upsert` (dead assertion). The suite takes ~15 s idle but exceeded 15 s hook timeouts when 4–5 agents ran in parallel; one audit run of `npm test` failed this way, and api-auditor observed 1 flake in 3 runs. **Fix:** a Postgres-backed integration suite (CI `services: postgres`), shared server import + silent test logger, contract tests for the OpenAPI shapes, and a test that mounts pino-http with a capturing stream.

### P2-10 · CI/CD is under-hardened and doesn't gate builds

**Status (2026-10-20): ◐ Partially fixed.** `ci.yml` now has `permissions: contents: read`, workflow
`concurrency` with `cancel-in-progress`, per-job `timeout-minutes`, a `build` job that runs without a
database, a Docker build job on pull requests, and `npm audit --omit=dev --audit-level=high` (the dependency
audit now reports **0 vulnerabilities**; `ts-node` was also replaced by `tsx`, since ts-node is incompatible
with TypeScript 7). Still open: actions pinned to mutable tags (no SHA pinning/Dependabot), no coverage
thresholds, no `prisma migrate diff --exit-code` drift check.

`ci.yml` has no `concurrency`/`cancel-in-progress`, no `timeout-minutes`, no `permissions:` block, and pins actions to mutable tags (`actions/checkout@v4`, `setup-node@v4`, Docker actions). Three jobs each re-run `npm ci`, and two redundantly run `npx prisma generate` (postinstall already does). There is no build job (`npm run build` is broken anyway — P2-11), the Docker build never runs, `npm audit --audit-level=high` audits dev deps too (and already blocked PR #8 once) while moderate runtime issues could pass, and there is no coverage, no `engines`/`.nvmrc` (CI Node 22 vs local Node 24 vs `@types/node` 26), and no schema-drift check. **Fix:** add concurrency/timeouts/least-privilege permissions, SHA-pin actions + Dependabot, drop redundant steps, add `build` + PR Docker build jobs, coverage thresholds, `engines`/`.nvmrc`, `npm audit --omit=dev`, and a `prisma migrate diff --exit-code` gate.

### P2-11 · Local development and prod env are broken by dependency/config drift

**Status (2026-10-20): ✅ Fixed.** The `dev`/`dev:all`/`scrape` scripts run through `tsx` (ts-node removed —
it has no JS compiler API on TypeScript 7); `src/server.ts`, `src/index.ts` and `src/scrape.ts` import
`dotenv/config`; `build` is now `tsc -p tsconfig.build.json` with no database side effects; and
`NODE_ENV=production` is set in `render.yaml` and the Docker runner. Not added: fail-fast environment
validation (the app still fails per request rather than refusing to boot on missing `API_KEY`).

- **`npm run dev`, `npm run dev:all`, and `npm run scrape` all crash.** `typescript@7.0.2` exposes no JS compiler API (`require('typescript').sys === undefined`), so `ts-node` fails with `TypeError: Cannot read properties of undefined (reading 'fileExists')` — verified. Use `tsx`, or pin TypeScript 5.x for ts-node, or run Node's native type stripping.
- **`.env` is never loaded by the app:** no `dotenv` import in `src/` (only `prisma.config.ts:1`), yet README/CONTRIBUTING instruct `cp .env.example .env`. Local `npm start`/`npm run dev` silently lack `DATABASE_URL`/`API_KEY`.
- **`NODE_ENV` is unset in Render and Docker**, so `isProduction` is false (`src/logger.ts:3-13`): production runs `debug` level with pino-pretty (multi-line, unparseable logs) and ships `pino-pretty` as a runtime dependency.
- **`npm run build` requires a live database and can mutate it:** `build` is `npx prisma db push && tsc` (`package.json:11`); verified it exits 1 with no `DATABASE_URL`, and with one set it pushes the schema — README tells users to paste the production Neon URL into `.env`.

**Fix:** `import 'dotenv/config'` (or `node --env-file`) + fail-fast env validation; `build: "tsc"` and a separate `db:push`; `NODE_ENV=production` in render/Docker; replace `ts-node`; add `engines` and `.nvmrc`.

### P2-12 · Root TypeScript is untypechecked and `check-db.ts` is broken

**Status (2026-10-20): ◐ Partially fixed.** `check-db.ts` was deleted and the Vitest config was renamed to
`vitest.config.mts` (clearing the ESM-in-CJS warning). Root tooling is still outside the typecheck
(`tsconfig.json` `include: ["src/**/*"]`) and the build still emits declarations/maps for a service.

`tsconfig.json:17` includes only `src/**/*`; verified with `tsc --listFilesOnly` that `check-db.ts` and `prisma.config.ts` are not checked. `check-db.ts:3` uses `new PrismaClient()` without the required Prisma 7 adapter (`src/db.ts:4-8`) — verified it throws `PrismaClientInitializationError`. Also `npx tsc` compiles `src/__tests__` into `dist/`, `declaration`/`declarationMap`/`sourceMap` are emitted for a service, and `vitest.config.ts` triggers Vite's "ESM syntax in CJS" warning (no `"type": "module"`). **Fix:** rewrite/delete `check-db.ts`, typecheck root tooling in a separate config, exclude tests from the build, drop unneeded declaration output, and fix the vitest module warning.

---

## P3 — polish and tech debt

| Finding                                                                                                                    | Evidence / fix                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Four near-duplicate list handlers** and constants; drift already caused P2-1/P2-4                                        | `news.ts`, `v1.ts`, `videos.ts`, `v1-videos.ts`; extract a shared query/where/pagination builder + `sendError()` helper                                                                                                                                                                                                                       |
| **Date validation accepts calendar rollover** (`2026-02-30` → Mar 2) and can reject valid same-day windows                 | `query.ts:54-67`: validates `from > to` **before** applying the date-only end-of-day adjustment; strict calendar parsing + adjust first                                                                                                                                                                                                       |
| **Error handler flattens 4xx to 500 and logs request bodies**; timing-safe compare throws on multibyte equal-length tokens | `server.ts:89-92` ignores `err.status` (malformed JSON becomes 500) and logs the whole error incl. `body`; `requireAuthentication.ts:15-18` compares UTF-16 length then raw UTF-8 buffers — verified `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`; hash both sides (SHA-256) then compare                                                            |
| **Graceful shutdown is incomplete**                                                                                        | `server.ts:103-125`: force-exit timer not cleared/unref'd, no `closeIdleConnections()`, no `unhandledRejection`/`uncaughtException` handlers                                                                                                                                                                                                  |
| **`POST /api/videos/sync` is an open trigger for any credential holder**                                                   | `videos.ts:141-153`: synchronous full ingestion, no lock/cooldown/admin scope; cron already handles it — 202 + job id or admin-only                                                                                                                                                                                                           |
| **Public docs/discovery**                                                                                                  | `/`, `/docs`, `/v1/docs` unauthenticated and outside the limiter (`server.ts:45-62`); root advertises the internal full-text `/api/news` route; docs promise a 403 that doesn't exist                                                                                                                                                         |
| **Wildcard CORS default**                                                                                                  | `server.ts:23`; pin `CORS_ORIGIN` in production                                                                                                                                                                                                                                                                                               |
| **Dependency/package hygiene**                                                                                             | `@types/*` in `dependencies`; stale `@types/express-rate-limit` v5; `pino-pretty` runtime dep; no `engines`/`.nvmrc`/`LICENSE`/`.gitattributes`; no ESLint (Prettier only); no coverage config; `serve` duplicates `start`; empty `scripts/` dir; `dist/` not cleaned before build; 2 moderate dev-only advisories (vitest < 4.1.11)          |
| **Docs drift**                                                                                                             | `README.md:26-30` omits `/v1/*`, videos, stats, `/docs`, and auth (every documented call 401s); scripts table wrong (`npm run dev` described as "scrape then start"); `README.md:49` "auto-scales" false on free plan; `AGENTS.md` repo map misses videos/stats; `CONTRIBUTING.md:47-48` points at a `docs/` business file that doesn't exist |
| **Category taxonomy**                                                                                                      | Mixed-case publisher categories vs lowercase docs; sitemap rows `[]`; exact `hasSome` filtering silently excludes data — see P2-7                                                                                                                                                                                                             |
| **No `updatedAt`**                                                                                                         | Can't detect stale/updated articles; `summary`/`thumbnail_url` returned as `null` despite required docs                                                                                                                                                                                                                                       |

---

## Remediation plan

### Now — this week (release blockers, ~1–2 days total)

1. **Redact secrets from logs** (P0-1) — one-line `redact` option + regression test.
2. **Fix rate limiting** (P1-1) — `app.set('trust proxy', 1)`, credential/IP key generator.
3. **Make the blueprint honest** (P1-3) — declare `API_KEY`/`NODE_ENV`/CORS/Clerk vars, paid cron or GH-schedule ingestion, `autoDeployTrigger: checksPass`, add boot-time env validation.
4. **Adopt Prisma migrations** (P1-2) — commit baseline, `migrate deploy` outside `startCommand`, remove `db push` from `build`.
5. **Repair the build paths** (P1-4, P2-11) — `.dockerignore`, copy schema before `npm ci`, `build: tsc`, `NODE_ENV=production`, dotenv/env validation, replace `ts-node` with `tsx`.
6. **Harden CI** (P2-10) — concurrency, timeouts, `permissions`, SHA pins, build job, coverage baseline.
7. **Fix the error handler + timing-safe compare** (P3) — honor `err.status`, stop logging bodies, hash-then-compare.
8. **Update README** endpoints/auth/deploy table.

### Next — 2–4 weeks

- **Bound the backfill** (P1-5): feed-scoped query, attempts/negative cache, time budget, run after ingestion.
- **Data quality** (P1-6): date provenance + clamping + quarantine, content status/repair, `updatedAt`.
- **Query layer** (P2-1/P2-2): shared pagination/where builder, safe-int guards, keyset pagination for `/v1`; add `pg_trgm`/GIN/composite indexes in a migration.
- **Cache/CORS/OpenAPI** (P2-3/P2-4): `private` or `Vary`, exposed headers, corrected schemas + item endpoints + spec validation.
- **Health/observability** (P2-5/P2-6): split liveness/readiness, cache probe, `x-request-id`, alerting on freshness/5xx.
- **Pipeline quality + resilience** (P2-7/P2-8): batch dedupe, single fetch per page, sitemap cursor, canonical URLs, category taxonomy, Retry-After/jitter/deadline, polite UA.
- **Tests** (P2-9): Postgres-backed integration suite, contract tests, silent test logger.

### Later — productization (1–2 months)

- **Credentials & metering** (P1-7): API-key table with hashes/scopes/expiry, per-key quotas + usage counters, internal-only key for `/api/*`, Clerk org/role mapping, rotation/revocation runbook.
- **Commercial surface:** plans/tiers, billing hooks, `/v1/news/{id}` + `/v1/videos/{id}`, bulk export/webhooks on new content, freshness SLA, per-customer analytics.
- **Legal/ops:** publisher attribution/copyright review, robots/ToS policy for scraping, backups/RPO/RTO, on-call/alerting, uptime/cost model on Neon + Render (free-tier spin-down vs paid always-on).

---

## Verified non-issues (checked, no action needed)

These were plausible risks that the audit disproved — recorded so they aren't "fixed" later:

- `/v1` metadata-only contract is correctly enforced (no `paragraphs` in select or payload).
- Auth fails closed when unconfigured; static-key comparison is timing-safe for normal ASCII; `Bearer` is case-insensitive; rejected tokens don't leak into 401s.
- ETag/304 revalidation already works; health is `no-store`; JSON 404 works; 429 responses include `Retry-After` and rate-limit headers; helmet applies; `X-Powered-By` removed.
- Prisma CLI is present at Render/Docker runtime; `prisma db push --url` is a valid flag (the design, not the flag, is the problem); cron runs cannot overlap on Render (manual `/api/videos/sync` can).
- No secrets in code or git history; `.env` absent and ignored; `render.yaml` uses `sync: false`.
- Git hooks work on this CRLF tree (master-push blocked locally); lockfile consistent; Docker runs non-root.
- Prisma-down health degrades to 503 as intended; graceful shutdown handlers exist (P3 gaps only).
- The `src/__tests__` suite passes cleanly when not competing with parallel agent load.

---

## Caveats

- **No database access** during the audit: index/query-plan impact is inferred from `schema.prisma` + Prisma query shapes, not `EXPLAIN`. The measured backfill memory figure is an in-process heap probe on representative row counts, not a production profile.
- **Render/GitHub behavior** (cron plan availability, auto-deploy default, branch-protection API 403) comes from the official docs and `gh` API responses at audit time; confirm against the actual dashboard before changing plans.
- **Tests are Prisma-mocked**, so several P1/P2 failure modes are invisible to them — that is itself finding P2-9.
- **No live scraping** was performed, so feed URLs/selectors and YouTube channel IDs were checked for format/plausibility only (one ID, `UC_sierraloaded_official`, looks vanity-style rather than a random channel ID — worth a smoke test).
- The locked business rules from `AGENTS.md` were respected: `/v1` stays metadata+summary only, the app stays pinned to `/api/news` full text; findings propose additive scoping/optimization, not contract reversal.
