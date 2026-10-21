# AGENTS.md — standing instructions for AI agents

You are operating the **SLNews Scraper API** (`SLNewsAPIScapper`): a Render-deployed
news scraper and API. Follow the senior-dev git/GitHub model below. These rules are
non-negotiable; when in doubt, ask.

## Golden rules

1. **NEVER push to `master` directly.** Every change lands via a feature branch + PR.
   The repo is **private on a free GitHub account**, so GitHub branch protection and
   rulesets are unavailable (the APIs return `403`). The gate that actually runs is
   local: the Husky `pre-push` hook rejects pushes to `master` and runs the test
   suite. Bypassing it with `--no-verify` is only allowed in a documented emergency.
   Do not claim the branch is protected on GitHub — it is process-enforced.
2. **Conventional Commits**, one logical change per commit (atomic), subject ≤ 72
   chars, body explains WHY not what. Types: `feat:` `fix:` `refactor:` `perf:`
   `test:` `docs:` `ci:` `chore:` `security:` `revert:` (enforced by commitlint).
3. **The gates are local hooks + CI + PR discipline**: `lint-and-typecheck`,
   `test`, `build`, `docker` (PRs), `audit` must be green before merge. Run checks
   locally first: `npm test`, `npm run typecheck`, `npm run lint`.
4. **Never rewrite pushed/shared history.** Rebase/squash only on your own
   unpushed branch; if a force-push is unavoidable use `--force-with-lease`.
5. **No secrets in code.** `DATABASE_URL`, `API_KEY` live in environment settings.
   Customer API keys are stored only as SHA-256 hashes (`ApiKey.keyHash`); never
   log or print raw keys/tokens, and never commit a generated `slk_...` key.
6. Recovery first: `git reflog` (90-day undo), backup branch before risky
   operations, `git revert` (never history-rewrite) to roll back `master`.

## The workflow (feature branch → PR)

```bash
git switch master && git pull
git switch -c <type>/<desc>        # feat/ fix/ chore/ docs/ refactor/...
# ...atomic conventional commits...
npm test && npm run typecheck && npm run lint
git push -u origin <type>/<desc>
gh pr create --base master --head <type>/<desc>
# wait for CI, then: gh pr merge --squash --delete-branch
```

Standard push flow: `bash "C:\Users\amotc\.agents\skills\git-pushing\scripts\smart_commit.sh" "type(scope): msg"`
(its `git add .` is safe — `.reasonix/`, `reasonix.toml`, `*.patch` are gitignored).

## Repository map

- `src/index.ts` / `src/server.ts` — Express app: auth (`requireAuthentication` +
  `requireScopes`: static key, Clerk JWT, or DB customer key; scope-guarded),
  per-credential/IP API rate limiter (health exempt) plus a separate docs-UI
  limiter (`DOCS_RATE_LIMIT_MAX`), CORS (one startup warning when
  `CORS_ORIGIN` is unset in production), helmet, JSON 404, terminal error
  handler, pino-http logging with credential redaction, graceful shutdown
  (`createShutdownHandler`: drains idle connections, unref'd force-exit timer,
  duplicate signals ignored) and fatal `unhandledRejection`/`uncaughtException`
  handlers. Production logs are JSON; `pino-pretty` is dev-only.
- `src/auth/` — `requireAuthentication.ts` (static `API_KEY`, optional Clerk
  session JWT, and `slk_`-prefixed DB customer keys; fails closed with 500 when
  neither static key nor Clerk is configured), `authorize.ts` (scope guard:
  `v1:read` on `/v1/*`, `internal:read` on the legacy `/api/*` surface; 403
  names the missing scope in `required_scope`), `apiKeys.ts` (SHA-256 hashing,
  cached verification, per-UTC-day usage metering), `clerk.ts` (JWT verification
  / `CLERK_AUTHORIZED_PARTIES` checks).
- `src/scripts/api-keys.ts` — customer API key admin via
  `npm run keys:create -- --name "<customer>" --scopes v1:read [--expires-at ISO]`,
  `npm run keys:list`, `npm run keys:revoke -- --id <n>`; needs `DATABASE_URL`,
  stores only SHA-256 hashes, and prints the raw `slk_...` key once.
- `src/routes/news.ts` — legacy `/api/news` (FULL TEXT — app-internal path); still
  serves rows with `pubDateSource: 'missing'`, unlike the sellable `/v1` feed.
- `src/routes/v1.ts` — `/v1/news` business contract: **metadata + summary ONLY,
  never `paragraphs`** (`ARTICLE_META_SELECT`). `{ data, meta }` envelope. Excludes
  `pubDateSource: 'missing'` rows from the sellable feed.
- `src/routes/videos.ts` / `src/routes/v1-videos.ts` — `/api/videos` (internal)
  and `/v1/videos` (sellable metadata contract, excludes
  `publishedAtSource: 'missing'`), plus `POST /api/videos/sync` with an in-process
  overlap lock (`409`) and `VIDEO_SYNC_COOLDOWN_MS` cooldown (`429` +
  `Retry-After`/`retry_after_seconds`).
- `src/routes/stats.ts` — `/api/stats` and `/v1/stats` aggregate counts/freshness
  plus data-quality counters (`articles.missing_date`, `articles.empty_content`,
  `videos.missing_date`).
- `src/services/scraper.ts` — RSS + sitemap ingestion with retry/backoff, upsert on
  link, date/content provenance, metadata backfill inline per feed item
  (article-page image fetches capped at 10 per run inside a 60 s budget), and a
  bounded content-repair sweep (5 rows/run, 3 attempts each, run deadline).
- `src/services/video-scraper.ts` — YouTube feed ingestion with date provenance.
- `src/utils/` — `http.ts` (retry), `query.ts` (pagination/search/date parsing,
  strict ISO calendar validation), `listFilters.ts` (shared `parseListFilters` +
  `buildArticleWhere`/`buildVideoWhere` + `/v1` metadata mappers used by all four
  list routes), `dates.ts` (`parsePublishedDate` → `{ date, source, raw }`, never
  throws), `url.ts` (link normalization).
- `src/config/` — sources, video sources, Swagger (`swagger.ts` falls back to
  `dist/routes/*.js` so `/docs` works in the Docker image).
- `prisma/schema.prisma` — `Article`/`Video`/`ApiKey`/`ApiKeyUsage` models on
  Prisma 7 with `@prisma/adapter-pg`. Migration
  `20261021130000_date_content_provenance` adds date/content provenance
  (`pubDateSource`/`publishedAtSource`, `pubDateRaw`/`publishedAtRaw`,
  `contentSource`, `contentAttempts`, `lastContentAttemptAt`) and `updatedAt`;
  other migrations: `20261020120000_init` (baseline),
  `20261021000000_search_indexes`, `20261021120000_api_keys`. Deploy with
  `npm run db:migrate:deploy`, and run `npm run db:baseline` **once** against a
  pre-existing `db:push` database before the first migrate-deploy.
- `.husky/` — pre-commit (lint-staged), commit-msg (commitlint), pre-push
  (blocks master + runs tests). `docs/GIT-WORKFLOW.md` — full workflow doc.
- `docs/CODEBASE-AUDIT.md` — audit findings and implementation status.
- `.github/workflows/ci.yml` — CI (`lint-and-typecheck`, `test`, `integration` with
  a `postgres:16` service, `build`, `docker-on-PR`, `audit`);
  `.github/PULL_REQUEST_TEMPLATE.md`. `Dockerfile` + `.dockerignore` — optional
  container path. `LICENSE` (MIT), `.gitattributes` (`* text=auto`, binary
  patterns, `*.patch -text`), `.nvmrc` — Node 22; `engines` requires >= 22.12.
  `pino-pretty` is a devDependency (production logging is JSON).

## Business rules (do not violate)

- The scraper API is a future **sellable data product**; the SLNews app
  (`C:\Users\amotc\Documents\GitHub\SLNews`) is "customer #1". Keep the two
  services and their databases separate — never consolidate.
- **Link + summary model (locked in):** `/v1/news` sells metadata only (id, title,
  summary, source, category, url, published_at). Full article text stays internal
  to the app via legacy `/api/news`. The app's client is pinned to `/api/news` —
  do not switch it to `/v1`.
- The app repo is outside this workspace's write access: provide patches/commands
  for changes there; the user applies them.

## Environment notes

- Windows + `core.autocrlf=true`: working tree files are CRLF. `.prettierrc` has
  `endOfLine: auto` — never remove it or `npm run lint` breaks locally.
- Node.js **>= 22.12**. Local TS execution uses **tsx** (`tsx watch` for the
  server, `tsx src/scrape.ts` for ingestion); `ts-node` is gone — it is
  incompatible with TypeScript 7 (no JS compiler API). Do not reintroduce it.
- Docker is unavailable on this machine; use npm scripts + Vercel CLI. Tests are
  vitest one-shot (`npm test` = `vitest run`).
- Customer-key admin runs via `npm run keys:create|keys:list|keys:revoke` (tsx) and
  needs `DATABASE_URL`; key verification is cached (`API_KEY_CACHE_TTL_MS`, default
  30 s), so revocation/scope changes take up to that long per instance.
- `npm test`, `npm run typecheck`, `npm run lint` must pass before any commit.
