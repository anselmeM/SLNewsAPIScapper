# AGENTS.md — standing instructions for AI agents

You are operating the **SLNews Scraper API** (`SLNewsAPIScapper`): a Render-deployed
news scraper and API. Follow the senior-dev git/GitHub model below. These rules are
non-negotiable; when in doubt, ask.

## Golden rules

1. **NEVER push to `master` directly.** `master` is branch-protected (PR required,
   status checks required, enforced for admins). Every change lands via a feature
   branch + PR. Local `pre-push` hook enforces the same rule — do not bypass it
   with `--no-verify` except in a documented emergency.
2. **Conventional Commits**, one logical change per commit (atomic), subject ≤ 72
   chars, body explains WHY not what. Types: `feat:` `fix:` `refactor:` `perf:`
   `test:` `docs:` `ci:` `chore:` `security:` `revert:` (enforced by commitlint).
3. **CI is the gate**: `lint-and-typecheck`, `test`, `audit` must be green before
   merge. Run checks locally first: `npm test`, `npx tsc --noEmit`, `npm run lint`.
4. **Never rewrite pushed/shared history.** Rebase/squash only on your own
   unpushed branch; if a force-push is unavoidable use `--force-with-lease`.
5. **No secrets in code.** `DATABASE_URL`, `API_KEY` live in environment settings.
6. Recovery first: `git reflog` (90-day undo), backup branch before risky
   operations, `git revert` (never history-rewrite) to roll back `master`.

## The workflow (feature branch → PR)

```bash
git switch master && git pull
git switch -c <type>/<desc>        # feat/ fix/ chore/ docs/ refactor/...
# ...atomic conventional commits...
npm test && npx tsc --noEmit && npm run lint
git push -u origin <type>/<desc>
gh pr create --base master --head <type>/<desc>
# wait for CI, then: gh pr merge --squash --delete-branch
```

Standard push flow: `bash "C:\Users\amotc\.agents\skills\git-pushing\scripts\smart_commit.sh" "type(scope): msg"`
(its `git add .` is safe — `.reasonix/`, `reasonix.toml`, `*.patch` are gitignored).

## Repository map

- `src/index.ts` / `src/server.ts` — Express app: auth (`requireApiKey`, Bearer,
  timing-safe), rate limiter (health exempt), JSON 404, pino-http logging.
- `src/routes/news.ts` — legacy `/api/news` (FULL TEXT — app-internal path).
- `src/routes/v1.ts` — `/v1/news` business contract: **metadata + summary ONLY,
  never `paragraphs`** (`ARTICLE_META_SELECT`). `{ data, meta }` envelope.
- `src/services/scraper.ts` — RSS + sitemap ingestion, retry/backoff, upsert on
  link, metadata backfill.
- `prisma/schema.prisma` — `Article` model; Prisma 7 + `@prisma/adapter-pg`.
- `.husky/` — pre-commit (lint-staged), commit-msg (commitlint), pre-push
  (blocks master + runs tests). `docs/GIT-WORKFLOW.md` — full workflow doc.
- `.github/workflows/ci.yml` — CI; `.github/PULL_REQUEST_TEMPLATE.md`.

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
- Docker is unavailable on this machine; use npm scripts + Vercel CLI. Tests are
  vitest one-shot (`npm test` = `vitest run`).
- `npm test`, `npx tsc --noEmit`, `npm run lint` must pass before any commit.
