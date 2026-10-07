#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

run_tool() {
  local name="$1" image="$2"
  shift 2
  if command -v "$name" >/dev/null; then
    "$name" "$@"
  else
    docker run --rm -v "$ROOT:/work" -w /work "$image" "$@"
  fi
}

check_deploy_compose() {
  local dir
  dir="$(mktemp -d)"
  cp -R deploy/. "$dir"
  cp "$dir/env.example" "$dir/.env"
  cp "$dir/secrets.env.example" "$dir/secrets.env"
  COMPOSE_PROFILES=recording,app-proxy docker compose --project-directory "$dir" config --quiet
  rm -rf "$dir"
}

step() {
  echo "== $*"
}

step luacheck
run_tool luacheck ghcr.io/lunarmodules/luacheck:v1.2.0 --config tests/.luacheckrc prosody/plugins tests

step busted
run_tool busted ghcr.io/lunarmodules/busted:v2.3.0 --output=utfTerminal tests/plugins

step shellcheck
run_tool shellcheck koalaman/shellcheck:v0.11.0 -x scripts/meet services/recording-finalize/finalize.sh tests/*.sh
run_tool shellcheck koalaman/shellcheck:v0.11.0 --shell=bash images/s6/scripts/meet-defaults

step recording finalize
tests/finalize-test.sh

step scripts/meet
tests/meet-test.sh

step transcription language bridge
run_tool node node:22-alpine --test tests/transcription-language.test.mjs

step reference app
run_tool node node:22-alpine --test --test-reporter=spec examples/app-node/app.test.mjs

step contract examples and reference app payloads
samples="$(mktemp)"
trap 'rm -f "$samples"' EXIT
run_tool node node:22-alpine tests/contract-samples.mjs >"$samples"
tests/contract-check.py "$samples"

step prosody config fragments
tests/prosody-config-check.sh

step transcription generated config
tests/transcription-config-check.sh

step image definitions
UPSTREAM_VERSION="$(<UPSTREAM_VERSION)" docker buildx bake --check

step deploy compose
check_deploy_compose

echo "all checks passed"
