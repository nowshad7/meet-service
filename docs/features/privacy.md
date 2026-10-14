# Privacy

`MEET_PLUGINS=privacy` lets the app make a room private through the join token.

## What it does

`mod_meet_privacy` loads on the main MUC and reads `context.room` from the first token that carries it:

- `privacy: true` sets `av_can_unmute = false`, so upstream AV moderation switches on when the first moderator joins and Jicofo keeps every participant muted at the bridge until a moderator approves them.
  Participants also cannot post to the group chat and may send private messages only to or from moderators.
  With `MEET_PRIVACY_AV_MODERATION=0` the deployment keeps only these chat rules: privacy mode leaves media alone, participants turn on their own microphone and camera, and moderators can still mute them, turn their camera off or remove them.
- `publicChat: false` stops participants posting to the group chat without privacy mode; private messages stay open.

Moderators are never restricted, and healthcheck rooms and admins are ignored.
Hiding the filmstrip or participant list is client configuration (the app's URL hash), so names stay visible to a determined participant; their camera and microphone do not.

## Settings

| Setting | Use |
|---|---|
| `MEET_PLUGINS` contains `privacy` | Adds `meet_privacy` to `XMPP_MUC_MODULES` |
| `ENABLE_AV_MODERATION=1` | Required for the media part |
| `MEET_PRIVACY_AV_MODERATION=0` | Privacy mode leaves media alone (Prosody option `meet_privacy_av_moderation = false`); default `1`, media moderated |
| `MEET_TEXT_PRIVATE_CHAT_ONLY` | Notice when a message is refused in privacy mode |
| `MEET_TEXT_PUBLIC_CHAT_OFF` | Notice when group chat is refused because `publicChat` is false |

## Contract

[Join token](../../contract/README.md#1-join-token): `context.room.privacy` and `context.room.publicChat`.

## Tests

`tests/plugins/mod_meet_privacy_spec.lua` covers when the mode turns on, the media switch, the first-token rule, group chat and private message filtering and the notice texts.
