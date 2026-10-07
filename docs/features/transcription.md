# Transcription

`MEET_FEATURES=transcription` prepares live captions through Jitsi's bridge-based transcription path.
It is dormant by default.

## What it does

`scripts/meet` adds `compose/transcription.yml` and enables `MEET_TRANSCRIPTION=1` only when the feature is selected and `MEET_TRANSCRIBER_URL` is nonempty.
With the `transcription` plugin selected, Prosody reads the verified join-token context and sets `room.jitsiMetadata.asyncTranscription` only when both token permissions allow it.
The first token carrying room transcription options fixes the room decision.
Healthcheck rooms and the focus account are ignored.

The Jicofo fragment sets `jicofo.transcription.url-template` to the deployment's private transcriber WebSocket URL.
Use a URL template containing `{{MEETING_ID}}` and `sendBack=true`, for example `ws://transcriber.internal:8080/transcribe?sessionId={{MEETING_ID}}&sendBack=true`.
Quote this value in `deployment.env`, which is sourced by bash.
The JVB connects directly to that service and returns live caption results to the conference.
A web config fragment enables `transcription.enabled` and closed captions.
The fragments run after upstream config generation and append nothing when the feature is off or the URL is empty.
The legacy `ENABLE_TRANSCRIPTIONS` setting is not used.

**Release gate:** `UPSTREAM_VERSION` remains `stable-11146-2`.
The checked stable successor, `stable-11248`, still lacks bridge-based transcription in Jicofo/JVB.
End-to-end captions require a future Jitsi stable release supporting `jicofo.transcription.url-template` and bridge audio streaming.
They were not run end to end on the pinned release.
After that upgrade, verify the room metadata and caption UI against that release before enabling production deployments.
Architecture reference: [Jitsi bridge-based transcription](https://jitsi.org/blog/a-new-architecture-for-transcription-and-more/).

Each private deployment runs its own transcriber container.
Selection, models and credentials belong only in that container's private configuration; the OSS service carries no defaults for them.
Use an internal deployment network URL, or a protected TLS WebSocket connection when crossing hosts.
End-to-end encryption prevents server-side transcription.

## Settings

| Setting | Use |
|---|---|
| `MEET_FEATURES` contains `transcription` | Adds the config overlay and derives the deployment permission |
| `MEET_PLUGINS` contains `transcription` | Loads `mod_meet_transcription` on the MUC component |
| `MEET_TRANSCRIBER_URL` | Private WebSocket URL template; empty by default |
| `MEET_TRANSCRIPTION` | Derived permission; defaults to `0` |

For prebuilt images using `deploy/compose.yml`, set `MEET_TRANSCRIPTION=1`, provide `MEET_TRANSCRIBER_URL`, and append `meet_transcription` to `XMPP_MUC_MODULES`.
The images already contain the fragments and initialization hooks.
Keep `MEET_TRANSCRIPTION=0` while using the pinned upstream.

## Contract

[Join token](../../contract/README.md#1-join-token): set `context.features.transcription: true` and `context.room.transcription.enabled: true`.
The optional `language` populates `transcription.language` and the `lang` URL parameter.
`autoStart: true` sets `recording.isTranscribingEnabled`; otherwise a caption UI request enables transcription.
A room cannot enable a feature disabled by the deployment.

Phase 1 provides live captions only.
`save` is reserved and ignored; there is no saved transcript, relay or transcript webhook implementation.

## Tests

`tests/plugins/mod_meet_transcription_spec.lua` checks deployment and token permissions, first-token behavior, metadata, language/autoStart and excluded rooms.
`tests/meet-test.sh` checks feature/plugin selection and the empty URL default.
`tests/transcription-config-check.sh` renders the actual fragments with the pinned image tools and checks the off, empty and enabled cases.
`tests/prosody-config-check.sh` verifies the deployment permission in Prosody's config loader.
