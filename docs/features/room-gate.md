# Room gate

`MEET_PLUGINS=room-gate` makes the app approve every room before it opens.

## What it does

This is the upstream `mod_reservations`, configured by `scripts/meet` and `prosody/conf.d/meet.cfg.lua`.
Before a room is created, Prosody holds the first join and calls `POST {MEET_APP_API_URL}/conference`.
The app approves with a reservation (including a `duration`, after which the room is destroyed), answers `409` for an existing one, or refuses with a message the user sees.
When the room is destroyed Prosody calls `DELETE {MEET_APP_API_URL}/conference/{id}`.
Breakout rooms skip the gate.

If the app's endpoint is down, no new room can open, so keep it fast and highly available.

## Settings

| Setting | Use |
|---|---|
| `MEET_PLUGINS` contains `room-gate` | Sets `PROSODY_RESERVATION_ENABLED=1` and `PROSODY_RESERVATION_REST_BASE_URL=$MEET_APP_API_URL` |
| `MEET_APP_API_TOKEN` | Sent as `Authorization: Bearer` (`reservations_api_headers`) |

## Contract

[Room gate](../../contract/README.md#2-room-gate).

## Tests

`tests/meet-test.sh` checks the derived settings, `tests/prosody-config-check.sh` the bearer header, and `tests/stack-check.sh` that `mod_reservations` loads.
