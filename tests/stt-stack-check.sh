#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(<"$ROOT/UPSTREAM_VERSION")"
NETWORK="meet-stt-check-$$"
GATEWAY="$NETWORK-gateway"
cleanup() {
  docker rm -f "$GATEWAY" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# A temporary isolated transport stack; no deployed meeting services are touched.
docker network create "$NETWORK" >/dev/null
docker run -d --name "$GATEWAY" --network "$NETWORK" --network-alias stt-gateway \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -v "$ROOT/tests/stt-fake-provider.mjs:/provider/fake.mjs:ro" \
  -e MEET_STT_PROVIDER_MODULE=/provider/fake.mjs meet-stt-gateway-test >/dev/null
for _attempt in {1..30}; do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$GATEWAY")" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$GATEWAY")" == healthy ]]
docker run --rm --network "$NETWORK" --entrypoint sh \
  -v "$ROOT/tests/SttTransportCheck.java:/check/SttTransportCheck.java:ro" \
  "ghcr.io/jitsi/jigasi:$VERSION" -c \
  'javac -cp "/usr/share/jigasi/jigasi.jar:/usr/share/jigasi/lib/*" -d /tmp /check/SttTransportCheck.java && java -cp "/tmp:/usr/share/jigasi/jigasi.jar:/usr/share/jigasi/lib/*" SttTransportCheck ws://stt-gateway:8000/streaming-whisper/ws/transport-check'
