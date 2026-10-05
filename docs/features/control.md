# Control

`MEET_PLUGINS=control` lets the app remove a participant or end a meeting.

## What it does

- `mod_meet_control` serves `POST /kick-user` and `POST /allow-user` on Prosody's HTTP port.
  `kick-user` removes every seat whose `context.user.id` matches and, unless `ban=false`, refuses that user's later joins for as long as the room lives; `allow-user` lifts the ban.
- The upstream `mod_muc_end_meeting` serves `POST /end-meeting`, which destroys the room; `control` loads it too.

Both verify the bearer against the control key server, `MEET_APP_CONTROL_KEYS_URL`, never the join key server.
That separation is what stops a user replaying their own join token against these endpoints.

## Settings

| Setting | Use |
|---|---|
| `MEET_PLUGINS` contains `control` | Adds `muc_end_meeting` and `meet_control` to `XMPP_MODULES` |
| `MEET_APP_CONTROL_KEYS_URL` | Control-token public keys (`prosody_password_public_key_repo_url`, set in `prosody/conf.d/meet.cfg.lua`) |
| `MEET_CONTROL_BIND`, `MEET_CONTROL_PORT` | Where the HTTP port is published; default `127.0.0.1:5280` |
| `MEET_TEXT_REMOVED` | Notice shown to a removed or banned user |

`MEET_APP_CONTROL_KEYS_URL` may point at the same URL as the join keys, but the control key pair must always be a different pair from the join key pair.

## Contract

[Control calls](../../contract/README.md#4-control-calls).

## Tests

`tests/plugins/mod_meet_control_spec.lua` covers status codes, token checks, removal, bans and the notice text.
`tests/stack-check.sh` checks that the module loads, `/kick-user` answers and the ban hook is installed on the MUC component.
