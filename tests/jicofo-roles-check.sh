#!/usr/bin/env bash
# Every shipped JWT deployment must leave Jicofo authentication off: with it on,
# Jicofo makes every token holder an owner and the token's role is ignored.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ghcr.io/jitsi/jicofo:$(<"$ROOT/UPSTREAM_VERSION")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

render_jicofo() {
  docker run --rm --entrypoint tpl "$@" "$IMAGE" /defaults/jicofo.conf
}

# Reads a setting the way the deployment sees it, with ${NAME} references resolved.
setting() {
  # shellcheck disable=SC1090
  (source "$1" >/dev/null 2>&1 && printf '%s' "${!2:-}")
}

expect_token_roles() {
  local name="$1" env_file="$2" jicofo_auth="$3"
  [[ "$(setting "$env_file" AUTH_TYPE)" == jwt ]] || fail "$name: expected AUTH_TYPE=jwt"
  if render_jicofo -e "ENABLE_AUTH=$(setting "$env_file" ENABLE_AUTH)" -e AUTH_TYPE=jwt \
       -e "JICOFO_ENABLE_AUTH=$jicofo_auth" | grep -q 'authentication {'; then
    fail "$name: Jicofo authentication is on, every token holder becomes a moderator"
  fi
  echo "ok: $name leaves room roles to the token"
}

render_jicofo -e ENABLE_AUTH=1 -e AUTH_TYPE=jwt | grep -q 'type = JWT' \
  || fail "upstream jicofo.conf no longer enables JWT authentication from ENABLE_AUTH; revisit this check"

expect_token_roles deploy/env.example "$ROOT/deploy/env.example" \
  "$(setting "$ROOT/deploy/env.example" JICOFO_ENABLE_AUTH)"

cp -R "$ROOT/scripts" "$ROOT/deployments" "$ROOT/compose" "$ROOT/web" "$ROOT/UPSTREAM_VERSION" "$WORK/"
# scripts/meet refuses names starting with "_", so check the template under another name.
mv "$WORK/deployments/_template" "$WORK/deployments/template"
for dir in "$WORK"/deployments/*/; do
  name="$(basename "$dir")"
  sed 's/=$/=test-secret/' "$dir/secrets.env.example" >"$dir/secrets.env"
  derived="$("$WORK/scripts/meet" env "$name" | sed -n 's/^JICOFO_ENABLE_AUTH=//p')"
  expect_token_roles "deployments/$name" "$dir/deployment.env" "$derived"
done
