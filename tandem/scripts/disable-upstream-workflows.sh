#!/usr/bin/env bash
set -euo pipefail
dry=false
case "${1:-}" in --dry-run) dry=true ;; '') ;; *) echo 'Usage: disable-upstream-workflows.sh [--dry-run]' >&2; exit 1 ;; esac
repo=${GH_REPO:-}
if [[ -z "$repo" ]]; then
  origin=$(git remote get-url origin)
  repo=$(sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##' <<<"$origin")
fi
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Set GH_REPO=owner/fork explicitly' >&2; exit 1; }
# Fetch all pages before acting; idempotently skip disabled workflows.
workflows=$(gh api --paginate "repos/$repo/actions/workflows?per_page=100" --jq '.workflows[] | select(.state == "active") | [.id,.path] | @tsv')
while IFS=$'\t' read -r id path; do
  [[ -n "$id" ]] || continue
  case "$path" in .github/workflows/tandem-*.yml) continue ;; esac
  if "$dry"; then echo "Would disable $path ($id)"; else gh api -X PUT "repos/$repo/actions/workflows/$id/disable"; echo "Disabled $path ($id)"; fi
done <<<"$workflows"
