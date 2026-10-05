# Upgrading Jitsi

There are two versions.
`UPSTREAM_VERSION` pins the `docker-jitsi-meet` release: the images and the upstream compose files come from the same tag.
A meet-service release tag (`v1.0.0`, ...) pins one `UPSTREAM_VERSION` together with the plugins and scripts; deployments run a release tag, and rolling back means checking out the previous tag and running `scripts/meet up <name>`.

## Flow

1. `scripts/meet upgrade-check` lists upstream stable releases newer than the pinned one.
2. On a branch, `scripts/meet upgrade <tag>` fetches both releases into `.upstream/` and reports:
   - environment variables added or removed upstream (from `env.example`, the config templates and the compose files),
   - changes to the Jicofo config template and the Prosody site config template,
   - changes to the upstream Prosody modules the plugins depend on: `token_verification`, `room_metadata_component`, `muc_meeting_id`, `reservations` (read from the two Prosody images).

   It then writes `<tag>` to `UPSTREAM_VERSION`.
3. Act on the report: rename settings in every `deployment.env` (including those in `MEET_DEPLOYMENTS_DIR`), adapt plugins, and regenerate any `lang/main.json` a deployment mounts from the new upstream file, reapplying its edits.
4. Run `tests/run.sh`, then bring up a staging deployment and run `tests/stack-check.sh <name>` and the app's own checks.
5. Merge only when everything passes, tag a release, roll out to staging, then to each deployment on its own schedule.

New upstream features arrive with the images.
Exposing one to apps is a contract addition, which is a minor service release.
Release notes come from the conventional commit messages; there is no hand-edited changelog.

## What to look at in the report

| Change | Why it matters |
|---|---|
| A renamed or removed env variable that a `deployment.env` sets | The setting silently stops working |
| `token_verification` | Join and control token checks, `context.*` claims |
| `reservations` | Room gate request and response format |
| `muc_meeting_id`, `room_metadata_component` | `meeting_id` in webhooks, room data the plugins read |
| Hooks and room data used by `mod_meet_*` | `muc-occupant-pre-join`, `muc-occupant-groupchat`, `muc-private-message`, `av_can_unmute`, `jitsi_meet_context_*` on sessions |
| Prosody major version | Config syntax used by `prosody/conf.d/` (`Lua.os.getenv`), checked by `tests/prosody-config-check.sh` |
