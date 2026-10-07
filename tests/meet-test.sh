#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PRIVATE="$WORK/private-deployments"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

fill_secrets() {
  sed 's/=$/=test-secret/' "$1/secrets.env.example" >"$1/secrets.env"
}

meet() {
  "$WORK/scripts/meet" "$@"
}

private_meet() {
  MEET_DEPLOYMENTS_DIR="$PRIVATE" "$WORK/scripts/meet" "$@"
}

expect() {
  grep -qxF -- "$1" <<<"$actual" || fail "expected '$1' in:"$'\n'"$actual"
}

cp -R "$ROOT/scripts" "$ROOT/deployments" "$ROOT/compose" "$ROOT/web" "$ROOT/UPSTREAM_VERSION" "$WORK/"
fill_secrets "$WORK/deployments/example-production"
fill_secrets "$WORK/deployments/example"

actual="$(meet env example-production)"
expect "COMPOSE_PROJECT_NAME=meet-example-production"
expect "MEET_DEPLOYMENT_DIR=$WORK/deployments/example-production"
expect "MEET_EVENTS=1"
expect "XMPP_MODULES=muc_size,persistent_lobby,muc_end_meeting,meet_control"
expect "XMPP_MUC_MODULES=token_affiliation,token_lobby_bypass,token_lobby_autostart,meet_single_session,meet_privacy"
expect 'XMPP_MUC_CONFIGURATION=app_id = "example-app",asap_key_server = "https://app.example.org/meet/keys",token_verification_allowlist = { "hidden.meet.jitsi" }'
expect "JWT_ASAP_KEYSERVER=https://app.example.org/meet/keys"
expect "PROSODY_RESERVATION_ENABLED=1"
expect "PROSODY_RESERVATION_REST_BASE_URL=https://app.example.org/meet/api"
expect "ENABLE_RECORDING=1"
expect "JIBRI_FINALIZE_RECORDING_SCRIPT_PATH=/usr/local/bin/meet-finalize.sh"
expect "JICOFO_ENABLE_REST=1"
expect "compose $WORK/compose/recording.yml"
grep -q "test-secret" <<<"$actual" && fail "env must not print secrets"

actual="$(meet env example)"
expect "MEET_FEATURES="
expect "compose $WORK/deployments/example/compose.yml"
grep -q "recording.yml" <<<"$actual" && fail "example should not add recording"

private_meet new-deployment acme >/dev/null
[[ -f "$PRIVATE/acme/deployment.env" ]] || fail "new-deployment should create the folder in MEET_DEPLOYMENTS_DIR"
[[ ! -e "$WORK/deployments/acme" ]] || fail "new-deployment should leave the repository's deployments/ alone"
[[ ! -e "$PRIVATE/acme/brand/.gitkeep" ]] || fail "new-deployment should drop the template's .gitkeep"
if meet env acme 2>/dev/null; then fail "acme should only exist in MEET_DEPLOYMENTS_DIR"; fi

sed -i 's/^MEET_PLUGINS=.*/MEET_PLUGINS=events,nope/' "$PRIVATE/acme/deployment.env"
fill_secrets "$PRIVATE/acme"
if private_meet env acme 2>"$WORK/err"; then fail "unknown plugin should be refused"; fi
grep -qF "unknown plugin 'nope'" "$WORK/err" || fail "should name the unknown plugin"

sed -i 's/^MEET_PLUGINS=.*/MEET_PLUGINS=privacy/; s/^AUTH_TYPE=.*/AUTH_TYPE=internal/' "$PRIVATE/acme/deployment.env"
actual="$(cd "$WORK" && MEET_DEPLOYMENTS_DIR=private-deployments scripts/meet env acme)"
expect "MEET_DEPLOYMENT_DIR=$PRIVATE/acme"
expect "MEET_EVENTS=0"
expect "XMPP_MODULES=muc_size,persistent_lobby"
expect "XMPP_MUC_CONFIGURATION="

sed -i 's/^MEET_FEATURES=.*/MEET_FEATURES=app-proxy/' "$PRIVATE/acme/deployment.env"
if private_meet env acme 2>"$WORK/err"; then fail "app-proxy without MEET_APP_PROXY_HOST should be refused"; fi
grep -qF "MEET_APP_PROXY_HOST must be set" "$WORK/err" || fail "should name the missing proxy host"
echo "MEET_APP_PROXY_HOST=app.local" >>"$PRIVATE/acme/deployment.env"
actual="$(private_meet env acme)"
expect "compose $WORK/compose/app-proxy.yml"

# The optional backend key remains empty during init, and inactive transcription is inert.
sed -i 's/^MEET_FEATURES=.*/MEET_FEATURES=transcription/' "$PRIVATE/acme/deployment.env"
actual="$(private_meet env acme)"
expect "MEET_TRANSCRIPTION_ENABLED=0"
grep -q 'transcriber.yml\|compose/transcription.yml' <<<"$actual" && fail "empty backend must add no transcription compose"
echo 'JIGASI_TRANSCRIBER_WHISPER_URL=ws://whisper.internal:8000' >>"$PRIVATE/acme/deployment.env"
if private_meet env acme 2>"$WORK/err"; then fail "transcription requires JWT authentication"; fi
sed -i 's/^AUTH_TYPE=.*/AUTH_TYPE=jwt/' "$PRIVATE/acme/deployment.env"
actual="$(private_meet env acme)"
expect "MEET_TRANSCRIPTION_ENABLED=1"
expect "ENABLE_TRANSCRIPTIONS=1"
expect "JIGASI_XMPP_USER=jigasi"
expect "JIGASI_TRANSCRIBER_USER=transcriber"
expect "JIGASI_BREWERY_MUC=jigasibrewery"
expect "XMPP_MUC_MODULES=token_affiliation,token_lobby_bypass,token_lobby_autostart,meet_privacy,meet_transcription"
expect "compose $WORK/.upstream/$(<"$ROOT/UPSTREAM_VERSION")/transcriber.yml"
expect "compose $WORK/compose/transcription.yml"
sed -i 's/^MEET_FEATURES=.*/MEET_FEATURES=app-proxy/' "$PRIVATE/acme/deployment.env"
actual="$(private_meet env acme)"
expect "MEET_TRANSCRIPTION_ENABLED=0"
grep -q 'transcriber.yml\|compose/transcription.yml' <<<"$actual" && fail "feature off must add no transcriber"
sed -i 's/^JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY=.*/JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY=/' "$PRIVATE/acme/secrets.env"
sed -i 's/^MEET_APP_API_TOKEN=.*/MEET_APP_API_TOKEN=/' "$PRIVATE/acme/secrets.env"
count_kept_secrets() { grep -c '=test-secret$' "$PRIVATE/acme/secrets.env"; }
before="$(count_kept_secrets)"
MEET_UPSTREAM_REPO=/nonexistent private_meet init acme >/dev/null 2>&1 || true
grep -qxF "JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY=" "$PRIVATE/acme/secrets.env" || fail "optional provider key must stay empty"
[[ "$(count_kept_secrets)" -eq "$before" ]] || fail "init must keep existing secrets"
grep -qE '^MEET_APP_API_TOKEN=[0-9a-f]{48}$' "$PRIVATE/acme/secrets.env" \
  || fail "init should fill the empty secret"

mkdir -p "$WORK/bin" "$WORK/.upstream/$(<"$ROOT/UPSTREAM_VERSION")" "$PRIVATE/acme/brand"
touch "$WORK/.upstream/$(<"$ROOT/UPSTREAM_VERSION")/docker-compose.yml"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"%s/docker.log"\n' "$WORK" >"$WORK/bin/docker"
chmod +x "$WORK/bin/docker"
echo "custom close page" >"$PRIVATE/acme/brand/close.html"
echo "console.log('extra')" >"$PRIVATE/acme/brand/extra.js"
up_acme() { PATH="$WORK/bin:$PATH" private_meet up acme >/dev/null; }

brand="$WORK/.data/acme/meet/brand"
up_acme
grep -q "^compose --project-directory .* up -d$" "$WORK/docker.log" || fail "up should run docker compose up -d"
cmp -s "$brand/brand.css" "$ROOT/web/brand/brand.css" || fail "default brand file missing"
cmp -s "$brand/close.html" "$PRIVATE/acme/brand/close.html" || fail "deployment brand should override defaults"
[[ -f "$brand/extra.js" ]] || fail "deployment brand should add its files"

inode_before="$(stat -c %i "$brand/plugin.head.html")"
touch "$brand/stale.js"
up_acme
[[ "$(stat -c %i "$brand/plugin.head.html")" == "$inode_before" ]] || fail "brand files must be updated in place"
[[ ! -e "$brand/stale.js" ]] || fail "files no longer in any brand source should be removed"

cat >"$WORK/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
case "$*" in
  *" logs "*) yes "jicofo log line, Added new videobridge" | head -n 200000; exit ;;
  *" exec -T jicofo "*) exit "$FAKE_JICOFO_STATUS" ;;
esac
exit 0
DOCKER
health_example() { PATH="$WORK/bin:$PATH" FAKE_JICOFO_STATUS="$1" meet health example >"$WORK/health.log" 2>&1; }

health_example 0 || fail "health should pass when jicofo reports an operational bridge, got:"$'\n'"$(<"$WORK/health.log")"
grep -qxF "jicofo: OK, a bridge is operational" "$WORK/health.log" || fail "health should report the operational bridge"
if health_example 1; then fail "health should fail without an operational bridge"; fi
grep -qxF "jicofo: no operational videobridge" "$WORK/health.log" || fail "health should name the missing bridge"

echo "scripts/meet: ok"
