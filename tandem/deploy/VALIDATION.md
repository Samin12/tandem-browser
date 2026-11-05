# Implementation validation — 2026-11-05

Run from `/Users/saminyasar/Developer/tandem-browser` unless shown otherwise.
No real-repo commits/pushes, GitHub writes, VPS installs, GUI interactions or
production-stack starts were performed. Other workers' running containers were
left alone. All validation containers used `--rm`; the disposable dotenv Compose
project was brought down. The real image pin remains unchanged because GHCR
`latest` resolves to its existing digest.

## Static/configuration checks

```sh
docker run --rm -v "$PWD:/mnt" koalaman/shellcheck:stable tandem/deploy/*.sh tandem/deploy/tandem tandem/scripts/*.sh
docker run --rm -v "$PWD:/repo" --workdir /repo rhysd/actionlint:latest -color .github/workflows/tandem-*.yml
for script in tandem/deploy/*.sh tandem/deploy/tandem tandem/scripts/*.sh; do bash -n "$script" || exit; done
./tandem/deploy/tandem --help
./tandem/deploy/install.sh
```

- Shellcheck and actionlint: **exit 0, no diagnostics** on final files.
- `bash -n`: **exit 0** for all 10 shell files including the wrapper/library.
- Wrapper help: **exit 0**, prints the complete command list.
- Installer on this non-root Mac: **expected exit 1**, `Run as root on the VPS
  (not on your Mac).` It installed nothing.

For each of `compose.yaml`, `compose.local.yaml`, and `compose.ci.yaml`, ran:

```sh
docker compose --env-file tandem/deploy/neo-image.env --env-file tandem/deploy/.env -f tandem/deploy/<file> config --format json
```

A throwaway, test-only `.env` supplied domain/email/data/hash/token/origin and was
removed in a `finally` block. **All three exit 0**. Parsed output assertions passed
for Neo's sole loopback-published 8790, gateway's `service:neo` namespace and no
ports, read-only/capability hardening, exact `tandem/` build context, and service
sets. A disposable actual container confirmed `.env`'s `$$argon2id$$v=19$$test`
arrives as `$argon2id$v=19$test` (Compose config output itself re-escapes dollars).
Exact fixture implementation:

```sh
python3 /Users/saminyasar/.cache/tandem-sync-test/test-compose.py
```

**Exit 0**; prints PASS for each config and the actual-container hash assertion.
The probe project was removed with `docker compose ... down --remove-orphans`.

```sh
docker run --rm -v "$PWD/tandem/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" -e TANDEM_DOMAIN=browser.example.invalid -e TANDEM_ACME_EMAIL=test@example.invalid caddy:2.10.2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

**Exit 0**, `Valid configuration`. No certificates requested or server started.

## Live read-only integrations

```sh
./tandem/scripts/bump-neo-image.sh --dry-run
./tandem/scripts/bump-neo-image.sh --to 0.52.1.2-ee2c294 --dry-run
./tandem/scripts/check-upstream-contract.sh
image=$(sed -n 's/^TANDEM_NEO_IMAGE=//p' tandem/deploy/neo-image.env)
./tandem/scripts/check-upstream-contract.sh --image "$image"
GH_REPO=Samin12/tandem-browser ./tandem/scripts/disable-upstream-workflows.sh --dry-run
```

**All exit 0**. Both bump calls returned `changed:false` and the existing
`0.52.1.2-ee2c294@sha256:dc004fe28e9a84050a98a84e9abca418e92a8b9056e8a02571741ce4af4d5856`.
Source and pinned-image checks print `Neo engine contract OK`. The fork workflow
dry-run found no currently active workflows to disable. The first discovery run
used gh's fork-parent default and listed parent workflows read-only; the tool was
then fixed to infer `origin` explicitly, so actual cleanup cannot accidentally
target the parent via that default. Nothing was disabled anywhere.

## Real upstream merge tests (scratch only)

```sh
python3 /Users/saminyasar/.cache/tandem-sync-test/test-sync.py
python3 /Users/saminyasar/.cache/tandem-sync-test/test-additional.py
```

**Both exit 0** on corrected fixtures. The local source repository is a partial
clone; the scratch clone needed its upstream marked as a promisor remote to fetch
missing historical blobs. This configuration change affected scratch only.
The additional synthetic remote needed local fetches to transfer fixture objects
before updating refs; no scratch or real repository was ever pushed.

- Clone of local repo under `~/.cache/tandem-sync-test/real-upstream-v2`, real
  upstream remote fetched; reset test main to `940d8397d772df1a77a0d6de2e653121873a73f1`
  (two weeks before the test date), plus a fake Tandem foundation commit.
- Actual script merged **131 commits** to `55664d0af96d944d892a0b20f099b30fbfaeb3d1`,
  created `sync/upstream-20261105-55664d0a`, produced a two-parent merge and separate
  changelog commit, and emitted correct JSON plus `summary=` in GITHUB_OUTPUT.
  Classified **high**, with 15 Neo paths as reasons.
- Second invocation: **exit 0**, exactly `{"status":"up-to-date"}`.
- Forced conflict in actual upstream Neo entrypoint: **exit 2**, reports that
  path in JSON and leaves no MERGE_HEAD after abort.
- Synthetic upstream addition `tandem/upstream-intrusion.txt`: **exit 3**, JSON
  protected-path report identifies the added file.
- Synthetic harmless upstream documentation commit: **low**, count 1; original
  PR number `#98765` preserved in the changelog.
- Synthetic `fix!:` + `BREAKING CHANGE` commit: **high**, breaking reason present.
- Sensitive Neo README edit followed by a revert (empty net diff): **high**,
  proving risk looks at all touched commit paths.
- Real GHCR `--to` mutation in scratch: **changed:true**, fake old pin replaced
  by the correct version/commit/digest, comments/one-variable format preserved,
  engine image line added to changelog. Real pin unchanged.

Machine-readable evidence: `~/.cache/tandem-sync-test/results.json` and
`~/.cache/tandem-sync-test/additional-results.json`.

## Backup/restore operations fixture

```sh
image=$(sed -n 's/^TANDEM_NEO_IMAGE=//p' tandem/deploy/neo-image.env)
docker run --rm -v "$PWD:/repo:ro" -v /Users/saminyasar/.cache/tandem-sync-test:/tests:ro --entrypoint bash "$image" /tests/test-ops-linux.sh
```

**Exit 0**. Uses synthetic profile data on the disposable container's Linux
filesystem and a fake Docker command (does not operate real services). Passed:
unencrypted-backup refusal before any service stop; explicit plaintext override;
cache exclusions; restore contents; uid 1000/10001 and mode 0700; retained old
data; stale symlink omission; last-N retention; unsafe traversal refusal before
service changes; literal-dollar env round-trip and 0600 mode; Hermes URL template;
and service-restart cleanup on a simulated tar failure. Mac bind-mount ownership
assertions failed initially because Colima reports host-mapped ownership; the
same assertions pass on native Linux filesystem storage.

## Remaining acceptance and maintainer actions

- Packages are parallel work: gateway/web/desktop unit tests, typechecks, actual
  gateway build/e2e and desktop distributions were **wired but not run here**.
  Desktop typecheck uses `bun x tsc --noEmit` because its package has no typecheck
  script. Password hashing mounts the checkout's package/helper read-only into
  the gateway runtime, supporting its minimal Dockerfile that omits scripts.
- No real Ubuntu/Debian installer execution, Docker apt/UFW/systemd mutation,
  certificate issuance, real service stop/restart, encrypted age round-trip,
  browser tab restoration, reboot recovery, or desktop login was attempted.
- No PR/issue/release creation or webhook calls were exercised. The lead must
  set TANDEM_SYNC_TOKEN, main/default-branch protection requiring tandem-ci-ok,
  auto-merge/merge-commit settings, optionally TANDEM_NOTIFY_WEBHOOK, and run the
  workflow guard after review. See UPSTREAM.md for exact permissions.
- Runtime engine bumps are conservatively **high** risk in addition to the
  specified source-path/breaking rules. The sync token also needs Issues write
  for blocker issues/labels. force_image_check is accepted but image resolution
  is already unconditional on every run.
