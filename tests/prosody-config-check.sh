#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="ghcr.io/jitsi/prosody:$(<"$ROOT/UPSTREAM_VERSION")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -R "$ROOT/prosody/conf.d" "$WORK/conf.d"
cp "$ROOT/tests/prosody-config-check.lua" "$WORK/check.lua"
printf 'VirtualHost "meet.jitsi"\nInclude "conf.d/*.cfg.lua"\n' >"$WORK/prosody.cfg.lua"
chmod -R a+rX "$WORK"

check() {
  docker run --rm --user "$(id -u)" --entrypoint lua5.4 -v "$WORK:/check:ro" "$@" "$IMAGE" /check/check.lua
}

check -e CHECK_CASE=nothing-set
check -e CHECK_CASE=all-set -e MEET_EVENTS=1 -e XMPP_DOMAIN=example.org \
  -e MEET_APP_API_URL=http://app.internal/meet/api -e MEET_APP_API_TOKEN=test-token \
  -e MEET_APP_CONTROL_KEYS_URL=http://app.internal/control-keys -e MEET_TEXT_REMOVED=Removed.
