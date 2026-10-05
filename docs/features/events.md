# Events

`MEET_PLUGINS=events` posts room and participant lifecycle to the app, which is how attendance is taken on the server rather than in the browser.

## What it does

`mod_meet_events` runs as the Prosody component `events.<XMPP_DOMAIN>` and watches the main and breakout MUCs.
It posts `events/room/created`, `events/occupant/joined`, `events/occupant/left` and `events/room/destroyed` to `MEET_APP_API_URL`.
Healthcheck rooms and the Jicofo focus user are skipped.
Occupant payloads carry every `context.user` field of the join token and, on leave, the total dominant speaker time.
`room/destroyed` repeats every occupant with join and leave times.
Breakout events report the main room in `room_name` and `room_jid` and the breakout in `breakout_room_id` and `breakout_meeting_id`.

A request is retried up to 3 times, 1 second apart, on network errors and 5xx answers; each request times out after 10 seconds.
Presence fallback (filling names from the prejoin screen) stays off, because those values are user-controlled.

Based on `mod_event_sync_component` from jitsi-contrib/prosody-plugins.

## Settings

| Setting | Use |
|---|---|
| `MEET_PLUGINS` contains `events` | Turns it on (`scripts/meet` sets `MEET_EVENTS=1`, read by `prosody/conf.d/meet-events.cfg.lua`) |
| `MEET_APP_API_URL` | Base URL of the four endpoints |
| `MEET_APP_API_TOKEN` | Sent as `Authorization: Bearer` |

## Contract

[Webhooks](../../contract/README.md#3-webhooks): the four event schemas and examples.
The app must answer fast and treat a repeated event as a duplicate.

## Tests

`tests/plugins/mod_meet_events_spec.lua` covers payloads, user info, healthcheck and focus filtering, breakout mapping and retries.
`tests/stack-check.sh` checks that the component loads.
