#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:-meet-jigasi-test}"
CP="/tmp/check:/usr/share/jigasi/jigasi.jar:/usr/share/jigasi/lib/*"

# Builds the meet-jigasi target (fails if the pinned jigasi package differs from
# images/jigasi/JIGASI_VERSION) and checks the patched classes inside it.
docker build -q -f "$ROOT/images/Dockerfile" --target jigasi \
  --build-arg UPSTREAM_VERSION="$(<"$ROOT/UPSTREAM_VERSION")" -t "$IMAGE" "$ROOT" >/dev/null
docker run --rm --entrypoint sh -v "$ROOT/tests/JigasiBufferCheck.java:/src/JigasiBufferCheck.java:ro" "$IMAGE" -c "
  set -e
  mkdir -p /tmp/check
  javac -nowarn -cp '$CP' -d /tmp/check /src/JigasiBufferCheck.java
  java -cp '$CP' org.jitsi.jigasi.transcription.JigasiBufferCheck
  javap -p -cp /usr/share/jigasi/jigasi.jar org.jitsi.jigasi.transcription.Participant \
    | grep -q 'ParticipantAudioBuffer buffer;'
  # The live-only defaults reach Jigasi's config the way /config overrides do.
  MEET_RUN_CONFIG=/tmp/run bash /etc/s6-overlay/scripts/meet-defaults
  grep -qx 'org.jitsi.jigasi.transcription.AUDIO_BUFFER_MS=100' /tmp/run/custom-sip-communicator.properties
  grep -qx 'org.jitsi.jigasi.transcription.SAVE_TXT=false' /tmp/run/custom-sip-communicator.properties
  echo 'meet-jigasi image: ok'
"
