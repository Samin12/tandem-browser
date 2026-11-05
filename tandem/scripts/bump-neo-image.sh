#!/usr/bin/env bash
set -euo pipefail
tag=latest; dry=false
while [[ $# -gt 0 ]]; do
  case "$1" in --to) tag=${2:?Tag required}; shift 2 ;; --dry-run|--print) dry=true; shift ;; *) echo "Unknown argument: $1" >&2; exit 1 ;; esac
done
[[ "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || { echo 'Invalid GHCR tag' >&2; exit 1; }
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
registry=https://ghcr.io/v2/browseros-ai/neo
token=$(curl --retry 3 -fsS 'https://ghcr.io/token?service=ghcr.io&scope=repository:browseros-ai/neo:pull' | jq -er .token)
accept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
digest() {
  curl --retry 3 -fsSI -H "Authorization: Bearer $token" -H "Accept: $accept" "$registry/manifests/$1" | tr -d '\r' | awk 'tolower($1)=="docker-content-digest:" {print $2}'
}
wanted=$(digest "$tag")
[[ "$wanted" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo 'GHCR did not return a valid manifest digest' >&2; exit 1; }
if [[ "$tag" == latest ]]; then
  # Follow registry pagination rather than assuming the promoted tag is on page one.
  url="$registry/tags/list?n=1000"; tags=''; headers=$(mktemp)
  trap 'rm -f "$headers"' EXIT
  while [[ -n "$url" ]]; do
    page=$(curl --retry 3 -fsS -D "$headers" -H "Authorization: Bearer $token" "$url")
    tags+=$(jq -r '.tags[]' <<<"$page"); tags+=$'\n'
    next=$(tr -d '\r' < "$headers" | sed -nE 's/^[Ll]ink: <([^>]+)>; rel="next".*/\1/p')
    case "$next" in '') url='' ;; /v2/*) url="https://ghcr.io$next" ;; https://ghcr.io/v2/browseros-ai/neo/*) url="$next" ;; *) echo 'Unexpected registry pagination URL' >&2; exit 1 ;; esac
  done
  tag=''
  while IFS= read -r candidate; do
    [[ "$candidate" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?-[a-f0-9]{7,40}$ ]] || continue
    if [[ $(digest "$candidate") == "$wanted" ]]; then tag=$candidate; break; fi
  done < <(printf '%s' "$tags" | sort -r)
  [[ -n "$tag" ]] || { echo 'No version-commit tag matches promoted latest digest' >&2; exit 1; }
fi
[[ "$tag" =~ ^[0-9]+\.[0-9]+\.[0-9]+(\.[0-9]+)?-[a-f0-9]{7,40}$ ]] || { echo 'Pin must use a version-commit tag, not a mutable version alias' >&2; exit 1; }
pin="$root/tandem/deploy/neo-image.env"
from=$(sed -n 's/^TANDEM_NEO_IMAGE=//p' "$pin")
to="ghcr.io/browseros-ai/neo:$tag@$wanted"
changed=false
if [[ "$from" != "$to" ]]; then
  changed=true
  if ! "$dry"; then
    python3 - "$pin" "$to" <<'PY'
import datetime,pathlib,sys
p=pathlib.Path(sys.argv[1]); p.write_text('\n'.join('TANDEM_NEO_IMAGE='+sys.argv[2] if line.startswith('TANDEM_NEO_IMAGE=') else line for line in p.read_text().splitlines())+'\n')
c=p.parents[1]/'CHANGELOG.md'; text=c.read_text(); line='- Engine image: `'+sys.argv[2]+'`.\n'
i=text.find('\n## ')
end=text.find('\n## ',i+1) if i>=0 else -1
if end<0: end=len(text)
header=text[i+1:].splitlines()[0] if i>=0 else ''
if header.startswith('## '+str(datetime.date.today())+' — Imported upstream'):
    text=text[:end].rstrip()+'\n\n'+line+'\n'+text[end:]
else:
    section='## '+str(datetime.date.today())+' — Engine update\n\n### Imported upstream\n\n- No source changes.\n\n### Tandem changes\n\n- Update the pinned official engine image.\n\n### Compatibility\n\nRisk: **high** (runtime engine changed).\n\n'+line+'\n### Breaking\n\n- Review engine compatibility and run the contract check before deployment.\n\n'
    split=i if i>=0 else len(text)
    text=text[:split].rstrip()+'\n\n'+section+text[split:].lstrip()
c.write_text(text)
PY
  fi
fi
json=$(jq -nc --argjson changed "$changed" --arg from "$from" --arg to "$to" '{changed:$changed,from:$from,to:$to}')
printf '%s\n' "$json"
if [[ -n ${GITHUB_OUTPUT:-} ]]; then printf 'image=%s\n' "$json" >> "$GITHUB_OUTPUT"; fi
