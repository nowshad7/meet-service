#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MEET="$ROOT/scripts/meet"
USAGE="usage: tests/stack-check.sh <deployment> | --dir <image deployment folder>"
failed=0

if [[ "${1:-}" == --dir ]]; then
  DIR="${2:?$USAGE}"
  stack() {
    docker compose --project-directory "$DIR" "$@"
  }
  plugins_setting() {
    sed -n 's/^MEET_PLUGINS=//p' "$DIR/.env"
  }
else
  DEPLOYMENT="${1:?$USAGE}"
  stack() {
    "$MEET" compose "$DEPLOYMENT" "$@"
  }
  plugins_setting() {
    "$MEET" env "$DEPLOYMENT" | sed -n 's/^MEET_PLUGINS=//p'
  }
fi

fail() {
  echo "FAIL: $*"
  failed=1
}

prosody() {
  stack exec -T prosody "$@"
}

check_endpoint() {
  if stack exec -T "$1" curl -fsS -o /dev/null "http://127.0.0.1:$2"; then
    echo "ok: $1 healthy"
  else
    fail "$1 is not healthy ($2)"
  fi
}

check_bridge_registered() {
  if stack exec -T jicofo sh -c \
    'curl -fsS http://127.0.0.1:8888/stats | jq -e ".bridge_selector.operational_bridge_count >= 1"' >/dev/null 2>&1; then
    echo "ok: jicofo has an operational bridge"
  else
    fail "jicofo has no operational videobridge"
  fi
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

stack ps
check_endpoint prosody 5280/health
check_endpoint jvb 8080/about/health
check_bridge_registered

domain="$(prosody printenv XMPP_DOMAIN || true)"
domain="${domain:-meet.jitsi}"
muc="$(prosody printenv XMPP_MUC_DOMAIN || true)"
muc="${muc:-muc.$domain}"
plugins=",$(plugins_setting),"

[[ "$plugins" == *,events,* ]] && expect_module "events.$domain" meet_events
[[ "$plugins" == *,control,* ]] && expect_module "$domain" meet_control
[[ "$plugins" == *,room-gate,* ]] && expect_module "$domain" reservations
[[ "$plugins" == *,transcription,* ]] && expect_module "$muc" meet_transcription
[[ "$plugins" == *,privacy,* ]] && expect_module "$muc" meet_privacy
[[ "$plugins" == *,single-session,* ]] && expect_module "$muc" meet_single_session

if stack logs prosody 2>&1 | grep -E 'mod_meet_|meet_(events|control|privacy|single_session|transcription)' | grep -iE 'error|failed'; then
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
