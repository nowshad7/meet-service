# Upgrading Jitsi

There are two versions.
`UPSTREAM_VERSION` pins the `docker-jitsi-meet` release: the images and the upstream compose files come from the same tag.
A meet-service release tag (`v1.0.0`, ...) pins one `UPSTREAM_VERSION` together with the plugins and scripts, and publishes them as images tagged `1.0.0`.
Deployments run a release: on published images by setting `MEET_VERSION`, from a checkout by checking out the tag.

## Flow

1. `scripts/meet upgrade-check` lists upstream stable releases newer than the pinned one.
2. On a branch, `scripts/meet upgrade <tag>` fetches both releases into `.upstream/` and reports:
   - environment variables added or removed upstream (from `env.example`, the config templates and the compose files),
   - changes to the Jicofo config template and the Prosody site config template,
   - changes to the upstream Prosody modules the plugins depend on: `token_verification`, `room_metadata_component`, `muc_meeting_id`, `reservations` (read from the two Prosody images).

   It then writes `<tag>` to `UPSTREAM_VERSION`.
3. Act on the report: rename settings in every `deployment.env` (including those in `MEET_DEPLOYMENTS_DIR`), in `deploy/env.example` and in the `.env` of every deployment on published images, adapt plugins, and regenerate any `lang/main.json` a deployment mounts from the new upstream file, reapplying its edits.
4. Run `tests/run.sh`, then bring up a staging deployment and run `tests/stack-check.sh <name>` and the app's own checks.
5. Merge only when everything passes, [cut a release](#cutting-a-release), roll out to staging, then to each deployment on its own schedule.

New upstream features arrive with the images.
Exposing one to apps is a contract addition, which is a minor service release.
Release notes come from the conventional commit messages; there is no hand-edited changelog.

## Cutting a release

1. Make sure `main` is green, including the `Images` workflow, and that a staging deployment passed the stack check on it.
2. Pick the version from the conventional commits since the last tag: a breaking change bumps the major, a `feat` the minor, anything else the patch.
3. Tag `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v1.2.0 -m "v1.2.0"
   git push origin v1.2.0
   ```

The `Images` workflow then builds every image for `linux/amd64` and `linux/arm64` and pushes `ghcr.io/<owner>/meet-<service>:1.2.0` and `:latest` with the repository's `GITHUB_TOKEN`.
On pull requests the same workflow only builds, so a broken image never reaches a tag.
The first time, make each `meet-*` package public in the repository owner's GitHub package settings, or give the servers a registry login.

To build the images locally, for example to test a change before it is released:

```bash
UPSTREAM_VERSION=$(cat UPSTREAM_VERSION) REGISTRY=meet.local TAGS=dev docker buildx bake --load
```

Then set `MEET_IMAGE_REPO=meet.local` and `MEET_VERSION=dev` in a test deployment's `.env`.

## Deployments on published images

- **Pin.**
  `MEET_VERSION` in `.env` selects the release for every service at once; never run `latest` in production.
- **Upgrade.**
  Read the release notes, set `MEET_VERSION` to the new version, replace `compose.yml` and compare `env.example` with the files from the same tag, then run `docker compose pull && docker compose up -d` and `tests/stack-check.sh --dir <folder>`.
- **Roll back.**
  Set `MEET_VERSION` and `compose.yml` back to the previous release and run `docker compose up -d`.
  Data stays in `CONFIG`, so a rollback is as quick as an upgrade, as long as the newer release did not change stored data; its release notes say so when it does.

## Deployments on a checkout

Check out the new release tag and run `scripts/meet up <name>`.
Rolling back is checking out the previous tag and running `scripts/meet up <name>` again.

## What to look at in the report

| Change | Why it matters |
|---|---|
| A renamed or removed env variable that a `deployment.env` sets | The setting silently stops working |
| `token_verification` | Join and control token checks, `context.*` claims |
| `reservations` | Room gate request and response format |
| `muc_meeting_id`, `room_metadata_component` | `meeting_id` in webhooks, room data the plugins read |
| Hooks and room data used by `mod_meet_*` | `muc-occupant-pre-join`, `muc-occupant-groupchat`, `muc-private-message`, `av_can_unmute`, `jitsi_meet_context_*` on sessions |
| Prosody major version | Config syntax used by `prosody/conf.d/` (`Lua.os.getenv`), checked by `tests/prosody-config-check.sh` |
