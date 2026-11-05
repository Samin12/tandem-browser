#!/usr/bin/env bash
# GitHub Actions driver; upstream-sync.sh and bump-neo-image.sh are the local entrypoints.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'This driver runs only in GitHub Actions.' >&2; exit 1; }
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); cd "$root"
export GH_REPO=${GITHUB_REPOSITORY:?}
owner=${GH_REPO%%/*}
notify() {
  if [[ -n ${TANDEM_NOTIFY_WEBHOOK:-} ]]; then
    jq -nc --arg text "$1" '{text:$text,content:$text}' | curl --retry 2 -fsS -X POST -H 'Content-Type: application/json' --data-binary @- "$TANDEM_NOTIFY_WEBHOOK" >/dev/null || echo '::warning::Notification failed'
  fi
}
issue() {
  local title=$1 body=$2 number link
  number=$(gh issue list --state open --search "$title in:title" --json number,title --jq ".[] | select(.title == \"$title\") | .number" | head -1)
  bodyfile=$(mktemp); printf '%s\n' "$body" > "$bodyfile"
  if [[ -n "$number" ]]; then
    gh issue edit "$number" --body-file "$bodyfile" >/dev/null
    link=$(gh issue view "$number" --json url -q .url)
  else link=$(gh issue create --title "$title" --body-file "$bodyfile"); fi
  rm -f "$bodyfile"; notify "$title: $link"; printf '%s\n' "$link"
}
set +e
summary=$("$root/tandem/scripts/upstream-sync.sh")
code=$?
set -e
if [[ $code == 2 ]]; then
  files=$(jq -r '.files[] | "- `" + . + "`"' <<<"$summary")
  branch=$(jq -r .branch <<<"$summary")
  body=$(cat <<BODY
Upstream merge conflicts require manual resolution:

$files

Run in a clean local checkout:
\`\`\`sh
git switch main
git pull --ff-only origin main
git fetch upstream main
git switch -c $branch
git merge --no-ff upstream/main
# Resolve the files above, then:
git add <resolved-files>
git commit
./tandem/scripts/check-upstream-contract.sh
# Run Tandem CI, update tandem/CHANGELOG.md, then:
git push -u origin $branch
# Open a PR against main for review.
\`\`\`
BODY
)
  issue 'Upstream sync blocked: merge conflicts' "$body"
  exit 1
elif [[ $code == 3 ]]; then
  issue 'Upstream sync blocked: protected Tandem paths' "The upstream merge changed protected Tandem files. Inspect before merging: $summary"
  exit 1
elif [[ $code != 0 ]]; then echo 'Upstream source sync failed' >&2; exit "$code"; fi
status=$(jq -r .status <<<"$summary")
image=$("$root/tandem/scripts/bump-neo-image.sh")
changed=$(jq -r .changed <<<"$image")
if [[ "$status" == up-to-date && "$changed" == false ]]; then echo 'Source and promoted engine image are up to date.'; exit 0; fi
sha=$(git rev-parse upstream/main)
if [[ "$status" == up-to-date ]]; then
  git switch -c "sync/upstream-$(date -u +%Y%m%d)-${sha:0:8}"
  summary=$(jq -nc --arg sha "$sha" '{status:"image-only",from:$sha,to:$sha,commits:0,risk:"high",reasons:["Promoted engine image changed"],breaking:[]}')
fi
risk=$(jq -r .risk <<<"$summary")
if [[ "$changed" == true ]]; then
  git add tandem/deploy/neo-image.env tandem/CHANGELOG.md
  git commit -m 'chore(tandem): pin promoted Neo engine image'
  risk=high
fi
# Source and actual pinned contents must both pass before a sync PR is pushed.
ref=$(sed -n 's/^TANDEM_NEO_IMAGE=//p' tandem/deploy/neo-image.env)
if ! "$root/tandem/scripts/check-upstream-contract.sh" --image "$ref"; then
  issue 'Upstream sync blocked: Neo engine contract changed' "Source or engine contract check failed for $sha and $ref. Review the Actions log and update the Tandem protocol/integration deliberately. No sync branch was pushed."
  exit 1
fi
# Reuse the single existing automation PR, even across dates and source versions.
existing=$(gh pr list --state open --base main --label upstream-sync --json number,headRefName --jq '.[0] // empty')
if [[ -n "$existing" ]]; then
  branch=$(jq -r .headRefName <<<"$existing")
  [[ "$branch" == sync/upstream-* ]] || { echo 'Refusing to overwrite a non-sync PR branch' >&2; exit 1; }
  # Withdraw prior auto-merge before a refreshed branch can trigger new checks.
  number=$(jq -r .number <<<"$existing")
  if [[ $(gh pr view "$number" --json autoMergeRequest -q '.autoMergeRequest != null') == true ]]; then
    gh pr merge "$number" --disable-auto
  fi
  git fetch origin "$branch"
  lease=$(git rev-parse FETCH_HEAD)
  git branch -M "$branch"
  push_args=(--force-with-lease="refs/heads/$branch:$lease")
else branch=$(git branch --show-current); push_args=(); fi
pushlog=$(mktemp)
if ! git push "${push_args[@]}" -u origin "$branch" >"$pushlog" 2>&1; then
  cat "$pushlog" >&2
  if grep -Eqi 'workflow|permission|403|refusing to allow' "$pushlog"; then
    issue 'Upstream sync blocked: TANDEM_SYNC_TOKEN permission' 'Push rejected. Add repository secret TANDEM_SYNC_TOKEN: a fine-grained PAT scoped to this fork with Contents: read/write, Pull requests: read/write, Workflows: read/write, Issues: read/write (for blocker reporting), and Metadata: read. Approve the token for the repository, rerun upstream sync, and inspect the Actions log. GITHUB_TOKEN cannot reliably push upstream workflow changes or trigger PR CI.'
  fi
  rm -f "$pushlog"; exit 1
fi
rm -f "$pushlog"
for label in upstream-sync risk:low risk:high; do gh label create "$label" --force --color 1d76db >/dev/null; done
bodyfile=$(mktemp)
python3 - "$bodyfile" "$summary" "$image" "$risk" <<'PY'
import json,pathlib,sys
p,summary,image,risk=sys.argv[1:]; s=json.loads(summary); i=json.loads(image)
t=pathlib.Path('tandem/CHANGELOG.md').read_text(); a=t.find('\n## '); b=t.find('\n## ',a+1)
section=t[a:b if b>=0 else len(t)].strip()
body=section+'\n\n## Sync assessment\n\nRisk: **'+risk+'**\n\n'
body+='\n'.join('- '+r for r in s['reasons'])+'\n'
body+='\nEngine image: '+('`'+i['from']+'` → `'+i['to']+'`' if i['changed'] else 'unchanged')+'\n\n'
body+='- [ ] Required `tandem-ci-ok` passes\n- [ ] Review breaking changes, AGPL and upstream attribution\n- [ ] High risk changes approved by the owner\n\nThis workflow never deploys.\n'
pathlib.Path(p).write_text(body)
PY
count=$(jq -r .commits <<<"$summary")
title="Upstream sync: BrowserOS@${sha:0:8} (+$count commits)"
if [[ -n "$existing" ]]; then
  number=$(jq -r .number <<<"$existing")
  gh pr edit "$number" --title "$title" --body-file "$bodyfile" --add-label "upstream-sync,risk:$risk" --remove-label "risk:$([[ "$risk" == low ]] && echo high || echo low)"
  link=$(gh pr view "$number" --json url -q .url)
else link=$(gh pr create --base main --head "$branch" --title "$title" --body-file "$bodyfile" --label "upstream-sync,risk:$risk"); fi
rm -f "$bodyfile"
if [[ "$risk" == low ]]; then
  gh pr merge "$link" --auto --merge
else
  # Cancel an earlier low-risk auto-merge before requesting human review.
  gh pr merge "$link" --disable-auto || true
  gh pr edit "$link" --add-reviewer "$owner" || echo '::warning::Owner review request failed (GitHub cannot request the PR author); owner approval is still required.'
  reason=$(jq -r '.reasons | join("; ")' <<<"$summary")
  gh pr comment "$link" --body "High risk: ${reason:-engine image changed}. Engine changed: $changed. Auto-merge is disabled; owner review is required."
fi
notify "Tandem upstream sync ($risk): $link"
printf '%s\n' "$link"
