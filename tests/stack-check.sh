#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEET="$ROOT/scripts/meet"
DEPLOYMENT="${1:?usage: tests/stack-check.sh <deployment>}"
failed=0

fail() {
  echo "FAIL: $*"
  failed=1
}

setting() {
  "$MEET" env "$DEPLOYMENT" | sed -n "s/^$1=//p"
}

prosody() {
  "$MEET" compose "$DEPLOYMENT" exec -T prosody "$@"
}

loaded_modules() {
  prosody prosodyctl --config /run/prosody/config/prosody.cfg.lua shell module list "$1" 2>/dev/null
}

ban_hook_count() {
  prosody prosodyctl --config /run/prosody/config/prosody.cfg.lua shell 2>/dev/null <<EOF
> local n = 0 for _, handler in ipairs(prosody.hosts["$1"].events.get_handlers("muc-occupant-pre-join") or {}) do if debug.getinfo(handler, "S").source:match("mod_meet_control") then n = n + 1 end end return "ban hooks: " .. n
EOF
}

expect_module() {
  local host="$1" module="$2"
  if grep -qw "$module" <<<"$(loaded_modules "$host")"; then
    echo "ok: mod_$module on $host"
  else
    fail "mod_$module is not loaded on $host"
  fi
}

"$MEET" health "$DEPLOYMENT" || fail "deployment is not healthy"

domain="$(prosody printenv XMPP_DOMAIN || true)"
domain="${domain:-meet.jitsi}"
muc="$(prosody printenv XMPP_MUC_DOMAIN || true)"
muc="${muc:-muc.$domain}"
plugins=",$(setting MEET_PLUGINS),"

[[ "$plugins" == *,events,* ]] && expect_module "events.$domain" meet_events
[[ "$plugins" == *,control,* ]] && expect_module "$domain" meet_control
[[ "$plugins" == *,room-gate,* ]] && expect_module "$domain" reservations
[[ "$plugins" == *,privacy,* ]] && expect_module "$muc" meet_privacy
[[ "$plugins" == *,single-session,* ]] && expect_module "$muc" meet_single_session

if "$MEET" logs "$DEPLOYMENT" prosody 2>&1 | grep -E 'mod_meet_|meet_(events|control|privacy|single_session)' | grep -iE 'error|failed'; then
  fail "prosody logged errors for mod_meet_* modules"
fi

if [[ "$plugins" == *,control,* ]]; then
  status="$(prosody curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:5280/kick-user")"
  if [[ "$status" == 400 ]]; then
    echo "ok: /kick-user answers"
  else
    fail "/kick-user answered $status, expected 400"
  fi
  if [[ "$(ban_hook_count "$muc")" == *"ban hooks: 1"* ]]; then
    echo "ok: mod_meet_control ban hook on $muc"
  else
    fail "mod_meet_control has no ban hook on $muc, kicked users could rejoin"
  fi
fi

((failed == 0)) && echo "stack check: ok"
exit "$failed"
