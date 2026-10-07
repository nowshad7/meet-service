#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
VERSION="$(<"$ROOT/UPSTREAM_VERSION")"

# Render actual pinned image templates, without starting meeting services.
render() {
  local service="$1" template="$2"
  docker run --rm --entrypoint tpl \
    -e ENABLE_TRANSCRIPTIONS=1 -e MEET_TRANSCRIPTION_ENABLED=1 \
    -e ENABLE_AUTH=1 -e AUTH_TYPE=jwt -e JWT_APP_ID=test-app -e JWT_APP_SECRET=test-only \
    -e JIGASI_BREWERY_MUC=pilotbrewery -e JIGASI_XMPP_USER=pilot-jigasi \
    -e JIGASI_XMPP_PASSWORD=test-brewery-password \
    -e JIGASI_TRANSCRIBER_USER=pilot-transcriber -e JIGASI_TRANSCRIBER_PASSWORD=test-hidden-password \
    -e XMPP_HIDDEN_DOMAIN=hidden.pilot.test -e XMPP_AUTH_DOMAIN=auth.pilot.test \
    -e XMPP_INTERNAL_MUC_DOMAIN=internal-muc.pilot.test \
    -e XMPP_MUC_MODULES=meet_transcription \
    -e JIGASI_TRANSCRIBER_ENABLE_SAVING=false -e JIGASI_TRANSCRIBER_ENABLE_TRANSLATION=false \
    -e JIGASI_TRANSCRIBER_CUSTOM_SERVICE=org.jitsi.jigasi.transcription.WhisperTranscriptionService \
    -e JIGASI_TRANSCRIBER_WHISPER_URL=ws://whisper.internal:8000 \
    -e JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY=test-only \
    -e JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY_NAME=test-key \
    "ghcr.io/jitsi/$service:$VERSION" "$template"
}
render web /defaults/settings-config.js >"$WORK/web.js"
cat "$ROOT/web/custom-config.js" >>"$WORK/web.js"
docker run --rm --entrypoint node -v "$WORK:/check:ro" node:22-alpine -e 'const fs = require("fs"), vm = require("vm"); const context = { config: {} };
vm.runInNewContext(fs.readFileSync(process.argv[1], "utf8"), context);
if (context.config.transcription.translationLanguages.length) process.exit(1);' /check/web.js
render jicofo /defaults/jicofo.conf >"$WORK/jicofo.conf"
render prosody /defaults/conf.d/jitsi-meet.cfg.lua >"$WORK/prosody.lua"
render jigasi /defaults/transcriber-sip-communicator.properties >"$WORK/transcriber.properties"
cat "$ROOT/compose/transcription.properties" >>"$WORK/transcriber.properties"
grep -q 'enabled: true' "$WORK/web.js"
grep -q 'pilotbrewery@internal-muc.pilot.test' "$WORK/jicofo.conf"
grep -q 'pilot-jigasi@auth.pilot.test' "$WORK/prosody.lua"
grep -q 'pilot-transcriber@hidden.pilot.test' "$WORK/prosody.lua"
grep -q '"meet_transcription"' "$WORK/prosody.lua"
grep -q 'whisper.websocket_url=ws://whisper.internal:8000' "$WORK/transcriber.properties"
grep -q 'whisper.private_key=test-only' "$WORK/transcriber.properties"
grep -q 'customService=org.jitsi.jigasi.transcription.WhisperTranscriptionService' "$WORK/transcriber.properties"
grep -q 'SAVE_TXT=false' "$WORK/transcriber.properties"
grep -q 'SAVE_JSON=false' "$WORK/transcriber.properties"
if grep -qE 'SAVE_(TXT|JSON)=true|RECORD_AUDIO=true|ENABLE_TRANSLATION=true' "$WORK/transcriber.properties"; then
  echo 'unexpected transcript saving, audio recording or translation' >&2
  exit 1
fi
# Derive and merge the real pinned upstream compose with this feature overlay.
cp -R "$ROOT/scripts" "$ROOT/deployments" "$ROOT/compose" "$ROOT/web" "$ROOT/UPSTREAM_VERSION" "$WORK/"
sed -i 's/^MEET_FEATURES=.*/MEET_FEATURES=transcription/' "$WORK/deployments/_template/deployment.env"
printf '\nJIGASI_TRANSCRIBER_WHISPER_URL=ws://whisper.internal:8000\n' >>"$WORK/deployments/_template/deployment.env"
mv "$WORK/deployments/_template" "$WORK/deployments/pilot"
"$WORK/scripts/meet" init pilot >/dev/null
"$WORK/scripts/meet" compose pilot config --format json >"$WORK/compose.json"
python3 - "$WORK/compose.json" "$VERSION" <<'PY'
import json, sys
services = json.load(open(sys.argv[1]))['services']
t = services['transcriber']
assert t['image'] == 'ghcr.io/jitsi/jigasi:' + sys.argv[2]
assert t['depends_on']['prosody']['condition'] == 'service_healthy'
assert 'shell user list' in services['prosody']['healthcheck']['test'][1]
assert t['environment']['JIGASI_MODE'] == 'transcriber'
assert t['environment']['JIGASI_TRANSCRIBER_WHISPER_URL'] == 'ws://whisper.internal:8000'
assert not t['environment'].get('JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY')
for service in ['web', 'prosody', 'jicofo']:
    assert services[service]['environment']['ENABLE_TRANSCRIPTIONS'] == '1'
assert 'meet_transcription' in services['prosody']['environment']['XMPP_MUC_MODULES']
assert any(v['target'] == '/config/custom-sip-communicator.properties' for v in t['volumes'])
PY
# Internal gateway adds no published port and replaces the external URL only when configured.
printf '\nMEET_STT_PROVIDER_MODULE=/provider/adapter.mjs\nMEET_STT_PROVIDER_DIR=%s\n' "$WORK/provider" >>"$WORK/deployments/pilot/deployment.env"
"$WORK/scripts/meet" compose pilot config --format json >"$WORK/gateway-compose.json"
python3 - "$WORK/gateway-compose.json" <<'PYCODE'
import json, sys
services = json.load(open(sys.argv[1]))['services']
g = services['stt-gateway']
assert not g.get('ports')
assert g['read_only']
assert g['environment']['MEET_STT_PROVIDER_MODULE'] == '/provider/adapter.mjs'
assert g['volumes'][0]['target'] == '/provider' and g['volumes'][0]['read_only']
assert services['transcriber']['depends_on']['stt-gateway']['condition'] == 'service_healthy'
assert services['transcriber']['environment']['JIGASI_TRANSCRIBER_WHISPER_URL'] == 'ws://stt-gateway:8000/streaming-whisper/ws'
PYCODE
printf 'transcription generated config: ok\n'
