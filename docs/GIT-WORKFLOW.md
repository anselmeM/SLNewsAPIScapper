# Git Workflow

Branch-based workflow for this repo. `master` is the deployable default branch
(Render auto-deploys it **after GitHub checks pass**) — **never commit or push to
`master` directly**.

## Branch model

| Branch           | Purpose                                            |
| ---------------- | -------------------------------------------------- |
| `master`         | Deployable history; only updated via PRs           |
| `feature/<name>` | New capability (e.g. `feature/v1-news`)            |
| `fix/<name>`     | Bug fix                                            |
| `chore/<name>`   | Tooling / infra / docs (e.g. `chore/git-workflow`) |

Rule: work happens on a branch, lands on `master` through a PR.

## What actually enforces the rule

GitHub **branch protection and rulesets are not available here**: the repo is
private on a free GitHub account and both APIs return `403` ("Upgrade to GitHub
Pro or make this repository public"). Do not claim the branch is protected on
GitHub. The gates that really run are:

| Gate                                   | Enforces                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Local Husky hooks                      | `pre-commit`: Prettier on staged files · `commit-msg`: Conventional Commits · `pre-push`: blocks `master`/`main` + runs `npm test` |
| GitHub Actions CI                      | `lint-and-typecheck`, `test`, `build`, `docker` (pull requests only), `audit` on every PR/push                                     |
| PR discipline                          | A reviewer-approved, squash-merged PR is the only path to `master`                                                                 |
| Render `autoDeployTrigger: checksPass` | A commit reaches production only after its GitHub checks are green                                                                 |

## Hooks (installed via Husky)

| Hook         | Enforces                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | `lint-staged` — Prettier formats only the staged files                                                                       |
| `commit-msg` | `commitlint` — Conventional Commits (`feat:`, `fix:`, `refactor:`, `ci:`, `chore:`, `docs:`, `test:`, …; subject ≤ 72 chars) |
| `pre-push`   | Rejects pushes to `master`/`main` + runs `npm test`                                                                          |

Bypass is possible (`git commit --no-verify`, `git push --no-verify`) but should
stay rare — the hooks exist to catch issues in seconds instead of CI minutes.
`--no-verify` on push is a documented-emergency-only escape hatch, because it also
skips the test suite and the only local block on pushing `master`.

## Commit style

Conventional Commits. Example:

```
feat(api): add versioned /v1/news metadata endpoint
refactor(scraper): harden fetch with retry and backoff
fix: reject fractional limit values with 400
```

Keep commits atomic — one logical change each. Squash/fixup WIP noise before
opening a PR (see "Before a PR" below).

## Push flow

Preferred — use the git-pushing skill script (stages everything, commits with a
conventional message, pushes with `-u`):

```bash
bash "C:\Users\amotc\.agents\skills\git-pushing\scripts\smart_commit.sh" "feat(api): add /v1/news"
```

Manual equivalent:

```bash
git add .
git commit -m "feat(api): add /v1/news"
git push -u origin <branch>
```

Never push to `master` — the `pre-push` hook blocks it.

## Before a PR

1. `git fetch origin` and rebase onto latest `master`:
   ```bash
   git rebase origin/master
   ```
   (merge instead only if the branch is shared with others)
2. Clean the history: `git rebase -i origin/master` — squash fixup/typo commits,
   reword vague messages, drop noise.
3. If history was rewritten, push with `git push --force-with-lease` (never bare
   `--force`).
4. Verify locally: `npm test`, `npm run typecheck`, `npm run lint`.
5. Open the PR using `.github/PULL_REQUEST_TEMPLATE.md` (Summary / Changes /
   Technical Notes / Impact).

## CI and merge

CI (`.github/workflows/ci.yml`) runs `lint-and-typecheck`, `test`, `build`,
`docker` (container build on PRs only), and `audit`. It is the real review gate:
branch protection cannot require it, so wait for all jobs to be green before
merging. Merge with **squash** and delete the branch:

```bash
gh pr merge --squash --delete-branch
```

Because `render.yaml` sets `autoDeployTrigger: checksPass`, Render deploys the new
`master` commit only after those checks pass.

## Recovery

- Lost commits or branch? `git reflog` is your 90-day safety net.
- Messed up a rebase? `git rebase --abort`; create a backup branch before risky
  history rewrites.
- Accidentally on `master`? Branch off it and reset: work stays in the branch.
