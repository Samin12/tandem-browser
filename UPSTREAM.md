# Staying compatible with BrowserOS Neo

Tandem Browser is an AGPL-3.0 fork of
[browseros-ai/BrowserOS](https://github.com/browseros-ai/BrowserOS). It has two
independent update paths:

1. Source commits are merged from `upstream/main`, preserving upstream history.
2. The official `ghcr.io/browseros-ai/neo` image is pinned in
   `tandem/deploy/neo-image.env` as `<version>-<commit>@sha256:<digest>`.
   Tandem builds only its gateway/client code, never Chromium. A new source merge
   does not implicitly change the running engine; a new image pin does.

All custom code lives under `tandem/`, `.github/workflows/tandem-*.yml`, the
fork-specific `.github/README.md`, and this `UPSTREAM.md`. Preserve that boundary;
upstream files and workflows remain mergeable. The sync guard rejects upstream
merges that change `tandem/` or `tandem-*` workflows. Root/fork documentation may
still need manual conflict resolution. `origin` is the fork; `upstream` is
BrowserOS with pushing disabled.

## Daily automation

`tandem-upstream-sync.yml` runs at **09:17 UTC** and on workflow dispatch. It:

1. Fetches upstream main, detects new commits and merges onto a fresh sync branch.
2. Aborts conflicts and opens/updates a blocker issue with conflicted paths and
   local resolution commands. Protected Tandem changes block separately.
3. Records the upstream range, count, feat/fix/perf/other subjects (preserving PR
   numbers), declared breaking changes and risk in `tandem/CHANGELOG.md`.
4. Anonymously resolves the GHCR `latest` manifest digest, follows tag pagination,
   and finds a version/commit tag with identical contents. It checks for image
   updates **even without new source commits** (`force_image_check` is available
   on dispatch; checks currently always run, so true explicitly forces the same
   unconditional behavior). An image-only change gets its own sync branch.
5. Checks the source and pinned image entrypoint contract: CDP 9110, MCP 9010,
   noVNC 6080, profile `/data/profile`, remote MCP enabled, expected image ports.
6. Pushes and creates/updates **one open `upstream-sync` PR**, replacing the
   automation branch with a lease when refreshing it. Adds `risk:low` or
   `risk:high`, changelog, image changes and a review checklist.
7. Enables merge-commit auto-merge only for low risk. High risk disables any
   prior auto-merge, requests the repository owner's review and comments why.
   GitHub cannot request review from the PR author; a warning then leaves manual
   owner review necessary. Optional webhook notification includes the PR/issue.

It never deploys. Deployments update deliberately using `tandem/deploy/tandem update`.

High risk means any changed path under `packages/browseros/docker/neo/**`, any
`LICENSE*` file, root `CLA.md`, or any upstream commit subject/body containing
`BREAKING` or `!:`. Matching reasons are listed. Runtime engine image changes are
also conservatively high risk, including image-only updates. Everything else is
low risk; low is a heuristic, not proof of safety. Required CI and review still
matter. Contract-check failure creates a blocker issue and prevents pushing.
The workflow guard runs daily, on main pushes and on demand, disabling every
active workflow except `.github/workflows/tandem-*.yml`. Run it manually once at
setup: upstream release/CI jobs use private runners and secrets. There is a race
on the first push/newly imported workflow: the guard cannot undo jobs already
queued. Cancel any accidentally queued upstream runs manually during setup.

## Required GitHub settings (maintainer action)

- Add repository secret **TANDEM_SYNC_TOKEN**, a fine-grained PAT restricted to
  `Samin12/tandem-browser` with **Contents: read and write**, **Pull requests:
  read and write**, **Workflows: read and write**, **Issues: read and write**
  (blocker reporting and labels), and **Metadata: read** (implicit). Ensure the
  owning account can push and approve the token for the repository as needed.
  Store/rotate it as a secret; never commit it. Workflows permission is necessary
  because upstream merges modify workflow files. The workflow falls back to
  GITHUB_TOKEN with a loud warning: pushes may fail and PRs it creates do not
  trigger CI. Set the PAT for reliable required checks.
- Protect `main` with required status **tandem-ci-ok** and prevent bypass/force
  pushes. The aggregate requires unit, contract and e2e to succeed. Consider
  owner approval rules for sensitive files; automated high-risk review requests
  are workflow policy, not a substitute for enforced repository rules.
- Turn on **Allow auto-merge** and **Allow merge commits**. Grant workflow PR
  creation if using the fallback token. Schedules run only from the default
  branch, so make `main` the default after the foundation is ready.
- Optionally add **TANDEM_NOTIFY_WEBHOOK**. The notifier POSTs both `text` and
  `content` with the link for Slack/Discord-style receivers. No runtime secrets
  are included in notifications.
- Run the Tandem workflow guard once after installing these workflows. Do not
  disable the Tandem workflows. Draft desktop releases are produced by manual
  dispatch (artifacts only) or `tandem-desktop-v*` tags (draft release assets).

## Manual source sync and image rollbacks

Work from a clean checkout of main (the script creates commits locally):

```sh
git switch main
git pull --ff-only origin main
# If not already configured: git remote add upstream https://github.com/browseros-ai/BrowserOS.git
git fetch upstream main
./tandem/scripts/upstream-sync.sh
# Optional --branch-prefix sync/upstream; --push explicitly pushes the branch.
./tandem/scripts/bump-neo-image.sh --dry-run
./tandem/scripts/bump-neo-image.sh
./tandem/scripts/check-upstream-contract.sh --image "$(sed -n 's/^TANDEM_NEO_IMAGE=//p' tandem/deploy/neo-image.env)"
# Commit any image/changelog changes and open a PR; run CI before merging.
```

The source script prints JSON on stdout (git progress on stderr), and writes
`summary=<compact JSON>` to `$GITHUB_OUTPUT` when set. Exit 0 means merged or
up-to-date, 2 means conflicts (merge aborted), 3 means protected paths changed
(merge left on the sync branch for inspection). JSON includes status, branch,
from/to, commits, risk, reasons and breaking for a successful merge; conflict and
protected reports include files. The image script prints `{changed,from,to}` and
supports `--dry-run`/`--print` and `--to <version>-<commit>`.

To roll back the engine, make a review branch and run:

```sh
./tandem/scripts/bump-neo-image.sh --to 0.52.1.2-ee2c294
# Review the digest and changelog, run source + image contract checks, commit/PR.
```

The manual tag is re-resolved to today's digest. For an exact prior rebuild use
the **complete historical tag@digest** from git history in `neo-image.env` instead;
retain comments plus exactly one `TANDEM_NEO_IMAGE=` line. Run the contract check
and CI for the rollback. After approval, back up the VPS and run `./tandem update`.
Chromium profile downgrades can be incompatible: use a pre-upgrade encrypted
backup if the older engine cannot read the newer profile. Pause scheduled sync
if intentionally holding an older engine, or it will propose latest again.

For conflicts, use the blocker issue's commands: branch from current main, merge
upstream/main, resolve each reported file, commit, update the changelog, check
contracts and CI, then open a PR. Never force upstream code into Tandem-owned
paths. To test workflow cleanup without changing GitHub:

```sh
./tandem/scripts/disable-upstream-workflows.sh --dry-run
# Maintainer only, when ready: ./tandem/scripts/disable-upstream-workflows.sh
```

## License and attribution

Retain upstream LICENSE/NOTICE/CLA and attribution; do not relicense BrowserOS
code or imply Tandem is an official BrowserOS product. Network users of modified
AGPL software must have the corresponding source available under the applicable
license, including your deployed modifications and build/deploy information.
Provide a source link identifying the deployed revision. Recheck license and
trademark obligations when packaging desktop builds or exposing a service;
upstream license/CLA changes are high risk and require review.
