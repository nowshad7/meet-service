#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(<"$ROOT/UPSTREAM_VERSION")"

for service in jicofo web; do
  extension=conf
  output=/run/jicofo/config/jicofo.conf
  [[ "$service" != web ]] || { extension=js; output=/run/web/config/config.js; }
  for case_name in off empty enabled; do
    enabled=0
    url='ws://transcriber.internal/transcribe?sessionId={{MEETING_ID}}&sendBack=true'
    [[ "$case_name" != enabled ]] || enabled=1
    [[ "$case_name" != empty ]] || { enabled=1; url=; }
    docker run --rm --user root --entrypoint bash \
      -e MEET_TRANSCRIPTION="$enabled" -e MEET_TRANSCRIBER_URL="$url" \
      -e CHECK_CASE="$case_name" -e CHECK_OUTPUT="$output" -e CHECK_SERVICE="$service" \
      -v "$ROOT/$service/meet-transcription.$extension:/defaults/meet-transcription.$extension:ro" \
      -v "$ROOT/$service/s6/scripts/meet-transcription:/check.sh:ro" \
      "ghcr.io/jitsi/$service:$VERSION" -euc '
        mkdir -p "$(dirname "$CHECK_OUTPUT")"
        echo sentinel >"$CHECK_OUTPUT"
        bash /check.sh
        if [[ "$CHECK_CASE" == enabled ]]; then
          if [[ "$CHECK_SERVICE" == jicofo ]]; then
            grep -qxF "jicofo.transcription.url-template = \"$MEET_TRANSCRIBER_URL\"" "$CHECK_OUTPUT"
          else
            grep -qxF "config.transcription.enabled = true;" "$CHECK_OUTPUT"
            grep -qxF "config.transcription.disableClosedCaptions = false;" "$CHECK_OUTPUT"
          fi
        else
          [[ "$(cat "$CHECK_OUTPUT")" == sentinel ]]
        fi
      '
  done
done
echo 'transcription config: ok'
