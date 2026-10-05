# Single session

`MEET_PLUGINS=single-session` keeps one seat per app user in a room.

## What it does

When a user joins a room they are already in (another tab or device), `mod_meet_single_session` removes the older seat, so the room shows one tile and attendance sees one person.
Users are matched on `context.user.id` from the join token; occupants without one, admins and healthcheck rooms are ignored.

## Settings

| Setting | Use |
|---|---|
| `MEET_PLUGINS` contains `single-session` | Adds `meet_single_session` to `XMPP_MUC_MODULES` |
| `MEET_TEXT_SEAT_REPLACED` | Notice shown to the removed seat |

## Contract

[Join token](../../contract/README.md#1-join-token): `context.user.id`.

## Tests

`tests/plugins/mod_meet_single_session_spec.lua`.
