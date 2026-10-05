#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FINALIZE="$ROOT/services/recording-finalize/finalize.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_recording() {
  local dir="$WORK/recordings/$1"
  mkdir -p "$dir"
  echo video >"$dir/meeting.mp4"
  echo '{"meeting_url":"https://meet.example.org/acme/room1","participants":[]}' >"$dir/metadata.json"
  echo "$dir"
}

make_curl() {
  mkdir -p "$WORK/bin"
  cat >"$WORK/bin/curl" <<CURL
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$WORK/curl.log"
while ((\$#)); do [[ "\$1" == -o ]] && exec >"\$2"; shift; done
printf '{"id":9,"status":"ready"}'
exit $1
CURL
  chmod +x "$WORK/bin/curl"
  : >"$WORK/curl.log"
}

run_finalize() {
  PATH="$WORK/bin:$PATH" MEET_FINALIZE_DETACHED=1 MEET_FINALIZE_RETRY_DELAYS="0 0" \
    MEET_APP_API_URL=http://app.internal/meet/api MEET_APP_API_TOKEN=test-token \
    "$FINALIZE" "$1" >"$WORK/out.log" 2>&1
}

make_curl 0
dir="$(make_recording 1791100990_acme_room1)"
run_finalize "$dir" || fail "upload should succeed"
[[ ! -e "$dir" ]] || fail "uploaded recording should be deleted"
grep -qF -- "-T $dir/meeting.mp4" "$WORK/curl.log" || fail "should upload the mp4"
grep -qF "Authorization: Bearer test-token" "$WORK/curl.log" || fail "should send the API token"
grep -qF "http://app.internal/meet/api/recordings/finished?key=1791100990_acme_room1&meeting_url=https://meet.example.org/acme/room1" \
  "$WORK/curl.log" || fail "should PUT to recordings/finished with key and meeting_url"
grep -qxE '[0-9T:+-]+ 1791100990_acme_room1: uploaded' "$WORK/out.log" \
  || fail "should log the upload on its own line, got: $(<"$WORK/out.log")"

make_curl 22
dir="$(make_recording 1791100991_acme_room2)"
if run_finalize "$dir"; then fail "upload should fail"; fi
[[ -f "$dir/meeting.mp4" ]] || fail "failed upload should keep the files"
[[ "$(wc -l <"$WORK/curl.log")" -eq 2 ]] || fail "should try once per retry delay"
grep -qF "giving up" "$WORK/out.log" || fail "should log giving up"
[[ "$(grep -c '^[0-9]\{4\}-' "$WORK/out.log")" -eq 3 ]] \
  || fail "each attempt and the give-up should be a separate line, got:"$'\n'"$(<"$WORK/out.log")"

if MEET_FINALIZE_DETACHED=1 "$FINALIZE" "$dir" >/dev/null 2>&1; then fail "should refuse to run without MEET_APP_API_URL"; fi

echo "finalize: ok"
