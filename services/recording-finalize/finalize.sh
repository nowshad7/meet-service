#!/bin/bash
set -u

: "${MEET_APP_API_URL:?MEET_APP_API_URL is not set}"
: "${MEET_APP_API_TOKEN:?MEET_APP_API_TOKEN is not set}"

DIR="$1"
LOG="${MEET_FINALIZE_LOG:-/storage/logs/recording-finalize.log}"
RETRY_DELAYS="${MEET_FINALIZE_RETRY_DELAYS:-0 30 60 120 300 420}"

if [ "${MEET_FINALIZE_DETACHED:-}" != 1 ]; then
    MEET_FINALIZE_DETACHED=1 nohup "$0" "$DIR" >>"$LOG" 2>&1 &
    exit 0
fi

FILE=$(find "$DIR" -maxdepth 1 -name '*.mp4' | sort | head -1)
MEETING_URL=$(sed -n 's/.*"meeting_url" *: *"\([^"]*\)".*/\1/p' "$DIR/metadata.json")
KEY=$(basename "$DIR")

[ -n "$FILE" ] || { echo "$(date -Is) $KEY: no mp4 in $DIR"; exit 1; }

for DELAY in $RETRY_DELAYS; do
    sleep "$DELAY"
    if curl -fsS -o /dev/null -X PUT -T "$FILE" \
        -H "Authorization: Bearer ${MEET_APP_API_TOKEN}" \
        -H "Content-Type: video/mp4" \
        "${MEET_APP_API_URL}/recordings/finished?key=${KEY}&meeting_url=${MEETING_URL}"; then
        echo "$(date -Is) $KEY: uploaded"
        rm -rf "$DIR"
        exit 0
    fi
    echo "$(date -Is) $KEY: upload failed, retrying"
done

echo "$(date -Is) $KEY: giving up, files kept in $DIR"
exit 1
