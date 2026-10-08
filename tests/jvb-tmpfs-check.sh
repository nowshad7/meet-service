#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -R "$ROOT/deploy" "$ROOT/scripts" "$ROOT/deployments" "$ROOT/compose" "$ROOT/web" "$ROOT/UPSTREAM_VERSION" "$WORK/"
cp "$WORK/deploy/env.example" "$WORK/deploy/.env"
cp "$WORK/deploy/secrets.env.example" "$WORK/deploy/secrets.env"
docker compose --project-directory "$WORK/deploy" config --format json >"$WORK/images.json"
"$WORK/scripts/meet" init example >/dev/null
"$WORK/scripts/meet" compose example config --format json >"$WORK/checkout.json"

python3 - "$WORK/images.json" "$WORK/checkout.json" <<'PY'
import json
import sys

NATIVE_SCTP_LIBRARY_BYTES = 16_284_272
RUNTIME_HEADROOM_BYTES = 16 * 1024 * 1024

for path in sys.argv[1:]:
    with open(path) as source:
        services = json.load(source)['services']
    mounts = dict(mount.split(':', 1) for mount in services['jvb']['tmpfs'])
    options = dict(option.split('=', 1) if '=' in option else (option, True)
                   for option in mounts['/run'].split(','))
    size = options['size'].upper()
    units = {'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3}
    capacity = int(size[:-1]) * units[size[-1]] if size[-1] in units else int(size)
    assert capacity >= NATIVE_SCTP_LIBRARY_BYTES + RUNTIME_HEADROOM_BYTES, path
    assert options['mode'] == '1750' and options.get('exec') and 'noexec' not in options, path
    assert mounts['/tmp'] == 'size=16M,mode=1777,noexec', path
    for name in ['web', 'prosody', 'jicofo']:
        assert '/run:size=16M,mode=1750,exec' in services[name]['tmpfs'], (path, name)
PY

echo 'JVB native SCTP tmpfs capacity: ok'
