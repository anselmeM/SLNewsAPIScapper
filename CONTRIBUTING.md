# Contributing

Thanks for contributing to the SLNews Scraper API. This repo follows a strict feature-branch + PR workflow — `master` is the deployable branch and Render deploys it automatically.

## How the gate actually works

GitHub **branch protection and rulesets are not available on this repo**: it is private on a free GitHub account, and both APIs return `403` ("Upgrade to GitHub Pro or make this repository public"). Nothing on GitHub blocks a direct push to `master` — the rules are enforced by the process below and by the tooling:

| Gate                                                       | What it enforces                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Local Husky hooks (`pre-commit`, `commit-msg`, `pre-push`) | Prettier on staged files, Conventional Commits, no direct push to `master`, tests before push     |
| GitHub Actions CI                                          | `lint-and-typecheck`, `test`, `integration`, `build`, `docker` (PRs), `audit` must pass on the PR |
| PR discipline                                              | Every change lands on `master` through a reviewed, squash-merged PR                               |
| Render `autoDeployTrigger: checksPass`                     | `master` deploys only after the GitHub checks for that commit pass                                |

The feature-branch + PR workflow is therefore mandatory, not optional. Do not push to `master` directly and do not bypass the hooks with `--no-verify` except in a documented emergency.

## Setup

```bash
npm install              # runs prisma generate + husky (hooks)
npm test                 # vitest run (unit suite — database-free)
npm run typecheck        # tsc --noEmit
npm run lint             # prettier --check on src/
```

Requires Node.js **>= 22.12** (`.nvmrc` pins Node 22). For a local database, copy `.env.example` to `.env` and apply the committed migration with `npm run db:migrate:deploy` (or `npm run db:push` for a throwaway DB).

`npm test` is deliberately database-free (every Prisma call is mocked). The separate real-Postgres integration suite (`npm run test:integration`) validates migrations and real SQL paths and runs in CI's `integration` job; to run it locally, point `DATABASE_URL` at a **disposable** database (it truncates tables), apply migrations, then run the suite:

```bash
export DATABASE_URL="postgresql://postgres@localhost:5432/slnews_test"
npx prisma migrate deploy
npm run test:integration
```

Without `DATABASE_URL` the integration suite skips cleanly (exit 0), so unit runs never require a database.

Hooks are active after install: pre-commit (formats staged files), commit-msg (enforces Conventional Commits), pre-push (blocks direct pushes to `master` + runs the test suite).

## Making a change

1. Start from a fresh `master`:
   ```bash
   git switch master && git pull
   ```
2. Create a branch: `git switch -c <type>/<desc>` — types: `feat` `fix`
   `refactor` `perf` `test` `docs` `ci` `chore` `security` `revert`.
3. Commit atomically with Conventional Commits (subject ≤ 72 chars; explain WHY
   in the body).
4. Run local checks: `npm test && npm run typecheck && npm run lint`.
5. Push the branch and open a PR (see template). Wait for CI, then merge with
   **squash** and delete the branch.

## PR checklist

- [ ] Conventional Commits, atomic changes
- [ ] Local checks pass (`npm test`, `npm run typecheck`, `npm run lint`)
- [ ] CI green: `lint-and-typecheck`, `test`, `integration`, `build`, `docker` (PRs), `audit`
- [ ] No secrets/PII or debug leftovers
- [ ] Tests added/updated for changed behavior
- [ ] Docs updated if workflow/API/env changed
- [ ] PR < ~400 lines; description explains WHY

## Notes

- Full workflow details: `docs/GIT-WORKFLOW.md`.
- Standing rules for AI agents: `AGENTS.md`.
- API contract notes (v1 = metadata only; legacy `/api` = full text): `AGENTS.md`.
- Licensed under the MIT License — see `LICENSE`.
