# Contributing

Thanks for contributing to the SLNews Scraper API. This repo follows a strict
branch + PR workflow — `master` is protected and deploys to Render automatically.

## Setup

```bash
npm install          # runs prisma generate + husky (hooks)
npm test             # vitest run (one-shot)
npx tsc --noEmit     # typecheck
npm run lint         # prettier --check
```

Hooks are active after install: pre-commit (formats staged files), commit-msg
(enforces Conventional Commits), pre-push (blocks direct pushes to `master` +
runs the test suite).

## Making a change

1. Start from a fresh `master`:
   ```bash
   git switch master && git pull
   ```
2. Create a branch: `git switch -c <type>/<desc>` — types: `feat` `fix`
   `refactor` `perf` `test` `docs` `ci` `chore` `security` `revert`.
3. Commit atomically with Conventional Commits (subject ≤ 72 chars; explain WHY
   in the body).
4. Run local checks: `npm test && npx tsc --noEmit && npm run lint`.
5. Push the branch and open a PR (see template). Wait for CI, then merge with
   **squash** and delete the branch.

## PR checklist

- [ ] Conventional Commits, atomic changes
- [ ] Local checks pass (`npm test`, `npx tsc --noEmit`, `npm run lint`)
- [ ] CI green: `lint-and-typecheck`, `test`, `audit`
- [ ] No secrets/PII or debug leftovers
- [ ] Tests added/updated for changed behavior
- [ ] Docs updated if workflow/API/env changed
- [ ] PR < ~400 lines; description explains WHY

## Notes

- Full workflow details: `docs/GIT-WORKFLOW.md`.
- Standing rules for AI agents: `AGENTS.md`.
- Business/API contract notes (v1 = metadata only): see `docs/` and the app
  repo's `docs/SCRAPER-API-BUSINESS.md`.
