# App contract v1

This is everything an app implements to use a meet-service deployment.
An app in any language can integrate by following this page, the JSON schemas in [schemas/](schemas/) and the payloads in [examples/](examples/).
[examples/app-node](../examples/app-node/README.md) is a small, dependency-free reference implementation of every part, and `tests/run.sh` checks its payloads against these schemas.

The contract has four parts:

| Part | Direction | Required |
|---|---|---|
| [Join token](#1-join-token) | App signs, service verifies | Yes |
| [Room gate](#2-room-gate) | Service asks the app | Only when the deployment enables `room-gate` |
| [Webhooks](#3-webhooks) | Service tells the app | Only for the events and features the deployment enables |
| [Control calls](#4-control-calls) | App tells the service | Only when the deployment enables `control` |

## Settings agreed per deployment

The operator of a deployment and the app team agree on these values; they live in the deployment's `deployment.env` and `secrets.env`.

| Setting | Meaning |
|---|---|
| `PUBLIC_URL` | Where users open rooms: `{PUBLIC_URL}/{tenant}/{room}?jwt={token}` |
| `JWT_APP_ID` | The `iss` claim of every token the app signs |
| `MEET_APP_KEYS_URL` | Where the service fetches the app's join-token public keys |
| `MEET_APP_CONTROL_KEYS_URL` | Where the service fetches the app's control-token public keys |
| `MEET_APP_API_URL` | Base URL of the app's endpoints that the service calls |
| `MEET_APP_API_TOKEN` | Bearer token the service sends on every call to `MEET_APP_API_URL` (secret) |
| `MEET_PLUGINS`, `MEET_FEATURES` | Which parts of this contract are active |

## 1. Join token

The app mints one RS256 JWT per join and puts it on the room URL as `?jwt=`.
Schema: [join-token.schema.json](schemas/join-token.schema.json), example: [join-token.json](examples/join-token.json).

- The header carries `kid`.
  The service fetches the public key from `{MEET_APP_KEYS_URL}/{sha256_hex(kid)}.pem` and caches it.
- Required claims: `iss` (equal to `JWT_APP_ID`), `aud`, `sub` (the tenant), `room`, `nbf`, `exp`, `context.user.id`, `context.user.name`.
- `room` and `sub` bind the token to one room in one tenant; the service refuses it anywhere else.
- `context.user.id` is the stable user id.
  Attendance webhooks, single-session and removal all key on it, so set it on every token, guests included.
- Optional user claims: `email`, `avatar`, `moderator`, `affiliation` (`owner`, `moderator` or `teacher` make a moderator), `lobby_bypass`.
- Optional `context.group` and `context.features.*` (`recording`, `screen-sharing`, `transcription`, `livestreaming`, `outbound-call`).
  `transcription` permits live captions when the deployment enables the `transcription` feature and plugin (see [transcription](../docs/features/transcription.md) for the upstream release gate).
- Optional room block `context.room`:

| Field | Effect | Needs plugin |
|---|---|---|
| `privacy: true` | Participants stay muted until a moderator approves them; they cannot post to the group chat and may send private messages to moderators only | `privacy` |
| `publicChat: false` | Participants cannot post to the group chat; private messages stay open | `privacy` |
| `lobby_autostart: false` | The lobby does not switch on automatically for this room | upstream `token_lobby_autostart` |
| `transcription` | `{enabled, language, autoStart, save}` for live captions | `transcription` |

Room options come from the first token that carries them; later tokens do not change a room that is already set.
Anything missing falls back to the deployment default.
A room option can only turn on a feature the deployment has enabled; it can never enable a disabled one.
For transcription, both `context.features.transcription: true` and `context.room.transcription.enabled: true` are required.
`language` is passed to the transcriber; `autoStart: true` requests captions immediately, otherwise the caption UI starts them.
`save` remains reserved for Phase 2 and has no effect.
End-to-end captions require a future supporting Jitsi stable release; they were not run end to end on the pinned release.

Keep `exp` generous (for example the scheduled end plus 30 minutes): Jitsi reuses the original token when a client reconnects, so a short-lived token drops users after a network blip.

## 2. Room gate

When a room is about to open, the service asks the app whether it may.
The first person in waits for the answer, so answer fast, and well inside 20 seconds.

**`POST {MEET_APP_API_URL}/conference`**, form-encoded, with `Authorization: Bearer {MEET_APP_API_TOKEN}`.
Fields: [room-gate-request.schema.json](schemas/room-gate-request.schema.json), example: [room-gate-request.json](examples/room-gate-request.json).

Answers, all described by [room-gate-response.schema.json](schemas/room-gate-response.schema.json):

| Status | Body | Example |
|---|---|---|
| `200` or `201` | `id`, `name` (exactly as requested), `mail_owner`, `start_time`, `duration` in seconds, optional `max_occupants`, `lobby`, `password` | [room-gate-response.json](examples/room-gate-response.json) |
| `409` | `conflict_id`; the service then calls `GET {MEET_APP_API_URL}/conference/{conflict_id}` and expects the approved body | [room-gate-conflict.json](examples/room-gate-conflict.json) |
| `4xx` | `message`, shown to the user, so write it for a person | [room-gate-denied.json](examples/room-gate-denied.json) |

**`DELETE {MEET_APP_API_URL}/conference/{id}`** follows when the room is destroyed, either because everyone left or because `duration` ran out.

Breakout rooms skip the gate.
A reopened room is a new `POST`, so approving a session that is already live must return the same record.

## 3. Webhooks

The service sends every webhook to `MEET_APP_API_URL` with `Authorization: Bearer {MEET_APP_API_TOKEN}`.
It retries on network errors and 5xx responses, so the same event can arrive twice: store it under a unique key, answer `200` quickly and process it later.

| Event | Request | Schema | Example |
|---|---|---|---|
| Room created | `POST events/room/created` | [schema](schemas/webhook-room-created.schema.json) | [example](examples/webhook-room-created.json) |
| Participant joined | `POST events/occupant/joined` | [schema](schemas/webhook-occupant-joined.schema.json) | [example](examples/webhook-occupant-joined.json) |
| Participant left | `POST events/occupant/left` | [schema](schemas/webhook-occupant-left.schema.json) | [example](examples/webhook-occupant-left.json) |
| Room destroyed | `POST events/room/destroyed` | [schema](schemas/webhook-room-destroyed.schema.json) | [example](examples/webhook-room-destroyed.json) |
| Recording uploaded | `PUT recordings/finished?key=&meeting_url=` | [schema](schemas/recording-upload.schema.json) | [example](examples/recording-upload.json) |
| Transcript line | `POST transcripts` | reserved for captions | |

Room and participant events need the `events` plugin.
Every event carries `room_name`, `room_jid`, `meeting_id` and `is_breakout`; for a breakout room, `room_name` and `room_jid` name the main room and `breakout_room_id` and `breakout_meeting_id` name the breakout.
The occupant carries `id` and every other `context.user` field from the join token.
`room/destroyed` repeats every occupant with `joined_at` and `left_at`, so it can repair events the app missed.

The recording upload needs the `recording` feature.
Its body is the `video/mp4` file.
`key` is unique per recording and is the idempotency key.
Any `2xx` means the app has the file and the service deletes its copy; anything else is retried for about 15 minutes, after which the files stay on the recorder for a manual retry.

## 4. Control calls

The app calls Prosody's HTTP port (bound per deployment by `MEET_CONTROL_BIND` and `MEET_CONTROL_PORT`, loopback by default).
Every call carries `Authorization: Bearer {control token}`.

The control token is an RS256 JWT signed with a **separate control key pair**, published at `{MEET_APP_CONTROL_KEYS_URL}/{sha256_hex(kid)}.pem`.
Its claims: `iss` equal to `JWT_APP_ID`, `sub`, `room` and `exp` ([control-token.schema.json](schemas/control-token.schema.json), [example](examples/control-token.json)).
Join tokens never work here; keep the control private key on the app server only.

| Call | Query | Answers |
|---|---|---|
| `POST /kick-user` | `conference` (room JID), `user` (`context.user.id`), optional `ban=false` ([schema](schemas/control-kick-user.schema.json), [example](examples/control-kick-user.json)) | `200` done, `400` bad query, `401` bad token, `404` no such room |
| `POST /allow-user` | `conference`, `user` | Lifts a ban set by `kick-user`; same answers |
| `POST /end-meeting` | `conference`, optional `silent-reconnect=true` ([schema](schemas/control-end-meeting.schema.json), [example](examples/control-end-meeting.json)) | `200` destroyed, `400`, `401`, `404` |

`kick-user` removes every seat of that user and, unless `ban=false`, keeps the user out of the room until it ends or `allow-user` lifts the ban.
The app should also stop minting tokens for a removed user.
`/kick-user` and `/allow-user` need the `control` plugin; `/end-meeting` is the upstream `muc_end_meeting` module, which `control` also enables.

## Versioning

- Adding an optional field, event or call is a minor service release; existing apps keep working.
- Removing or changing anything is contract `v2`, with a deprecation period in which both versions work.
- Apps must ignore fields they do not know.
