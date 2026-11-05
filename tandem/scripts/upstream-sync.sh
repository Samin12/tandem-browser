#!/usr/bin/env bash
set -euo pipefail
push=false; prefix=sync/upstream
while [[ $# -gt 0 ]]; do
  case "$1" in --push) push=true; shift ;; --branch-prefix) prefix=${2:?Prefix required}; shift 2 ;; *) echo "Unknown argument: $1" >&2; exit 1 ;; esac
done
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"
[[ -z $(git status --porcelain) ]] || { echo 'Sync requires a clean worktree' >&2; exit 1; }
emit() { printf '%s\n' "$1"; if [[ -n ${GITHUB_OUTPUT:-} ]]; then printf 'summary=%s\n' "$1" >> "$GITHUB_OUTPUT"; fi; }
git fetch upstream main >&2
to=$(git rev-parse upstream/main)
from=$(git merge-base HEAD "$to")
if git merge-base --is-ancestor "$to" HEAD; then emit '{"status":"up-to-date"}'; exit 0; fi
branch="$prefix-$(date -u +%Y%m%d)-${to:0:8}"
git check-ref-format --branch "$branch" >/dev/null
# Never reuse or overwrite a local branch; a fresh checkout is expected in CI.
git switch -c "$branch" >&2
before=$(git rev-parse HEAD)
if ! git merge --no-ff upstream/main -m "chore(upstream): merge browseros-ai/BrowserOS@$to" >&2; then
  files=$(git diff --name-only --diff-filter=U | jq -Rsc 'split("\n") | map(select(length>0))')
  git merge --abort >&2
  emit "$(jq -nc --arg branch "$branch" --arg from "$from" --arg to "$to" --argjson files "$files" '{status:"conflict",branch:$branch,from:$from,to:$to,files:$files}')"
  exit 2
fi
protected=$(git diff --name-only "$before" HEAD -- tandem/ '.github/workflows/tandem-*.yml' | jq -Rsc 'split("\n") | map(select(length>0))')
if [[ "$protected" != '[]' ]]; then
  emit "$(jq -nc --arg branch "$branch" --arg from "$from" --arg to "$to" --argjson files "$protected" '{status:"protected-path-change",branch:$branch,from:$from,to:$to,files:$files}')"
  exit 3
fi
summary=$(python3 - "$from" "$to" "$branch" <<'PY'
import datetime,json,pathlib,re,subprocess,sys
start,end,branch=sys.argv[1:]
def git(*args): return subprocess.check_output(['git',*args],text=True).strip()
shas=git('rev-list','--reverse',f'{start}..{end}').splitlines()
commits=[{'sha':sha,'subject':git('show','-s','--format=%s',sha),'body':git('show','-s','--format=%b',sha)} for sha in shas]
files=sorted(set(git('log','--format=','--name-only',f'{start}..{end}').splitlines()))
reasons=[]
for f in files:
    if f.startswith('packages/browseros/docker/neo/') or re.match(r'(^|/)LICENSE[^/]*$',f) or f=='CLA.md': reasons.append('Sensitive upstream path: '+f)
breaking=[c['sha'][:8]+' '+c['subject'] for c in commits if re.search(r'BREAKING|!:',c['subject']+'\n'+c['body'])]
reasons += ['Breaking commit: '+b for b in breaking]
risk='high' if reasons else 'low'
groups={k:[] for k in ('feat','fix','perf','other')}
for c in commits:
    match=re.match(r'^(feat|fix|perf)(?:\([^)]*\))?!?:',c['subject'])
    group=match.group(1) if match else 'other'
    # Original subjects preserve upstream PR references, e.g. (#123).
    refs=sorted(set(re.findall(r'#\d+',c['body']))-set(re.findall(r'#\d+',c['subject'])))
    groups[group].append('- `'+c['sha'][:8]+'` '+c['subject']+(' ('+', '.join(refs)+')' if refs else ''))
section=f'## {datetime.date.today()} — Imported upstream {end[:8]}\n\n### Imported upstream\n\nRange: `{start}..{end}` ({len(commits)} commits).\n\n'
for name,items in groups.items():
    if items: section+='#### '+name+'\n\n'+'\n'.join(items)+'\n\n'
section+='### Tandem changes\n\n- Automatic upstream source merge.\n\n### Compatibility\n\nRisk: **'+risk+'**.\n\n'
section+='\n'.join('- '+r for r in reasons) if reasons else '- No sensitive paths or declared breaking commits matched.'
section+='\n\n### Breaking\n\n'+ ('\n'.join('- '+b for b in breaking) if breaking else '- None declared upstream.')+'\n\n'
p=pathlib.Path('tandem/CHANGELOG.md'); old=p.read_text(); index=old.find('\n## ')
if index<0: index=len(old)
p.write_text(old[:index].rstrip()+'\n\n'+section+old[index:].lstrip())
print(json.dumps(dict(status='merged',branch=branch,**{'from':start,'to':end},commits=len(commits),risk=risk,reasons=reasons,breaking=breaking),separators=(',',':')))
PY
)
git add tandem/CHANGELOG.md
git commit -m "docs(tandem): record upstream ${to:0:8}" >&2
if "$push"; then git push -u origin "$branch" >&2; fi
emit "$summary"
