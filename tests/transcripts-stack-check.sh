#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="meet-transcripts-check-$$"
export MEET_ROOT="$ROOT"
JITSI_IMAGE_VERSION="$(<"$ROOT/UPSTREAM_VERSION")"
export JITSI_IMAGE_VERSION
compose=(docker compose --project-name "$PROJECT" --file "$ROOT/tests/transcripts-stack.yml")
cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" up -d app provider
for _attempt in {1..30}; do
  app_status="$("${compose[@]}" ps --format json app | python3 -c 'import json,sys; rows=[json.loads(line) for line in sys.stdin if line.strip()]; print(rows[0].get("Health", "") if rows else "")')"
  provider_status="$("${compose[@]}" ps --format json provider | python3 -c 'import json,sys; rows=[json.loads(line) for line in sys.stdin if line.strip()]; print(rows[0].get("Health", "") if rows else "")')"
  [[ "$app_status" == healthy && "$provider_status" == healthy ]] && break
  sleep 1
done
[[ "$app_status" == healthy && "$provider_status" == healthy ]]

"${compose[@]}" run --rm driver normal
"${compose[@]}" exec -T app node --input-type=module -e \
  'const x=await (await fetch("http://127.0.0.1:3000/transcripts")).json(); if(x.length!==1 || x[0].key!=="e2e-normal") process.exit(1); console.log("app stored normal transcript")'
"${compose[@]}" stop app >/dev/null
"${compose[@]}" run --rm --no-deps driver outage
"${compose[@]}" start app >/dev/null
for _attempt in {1..30}; do
  app_status="$("${compose[@]}" ps --format json app | python3 -c 'import json,sys; rows=[json.loads(line) for line in sys.stdin if line.strip()]; print(rows[0].get("Health", "") if rows else "")')"
  [[ "$app_status" == healthy ]] && break
  sleep 1
done
[[ "$app_status" == healthy ]]
"${compose[@]}" run --rm --no-deps driver recovery
"${compose[@]}" run --rm --no-deps driver save-off

"${compose[@]}" exec -T app node --input-type=module -e \
  'const r=await fetch("http://127.0.0.1:3000/transcripts"); const x=await r.json(); if(x.length!==1 || x[0].key!=="e2e-outage") process.exit(1); console.log("app stored recovered transcript; save-off was absent")'
printf 'transcripts isolated stack check: ok (%s)\n' "$PROJECT"
