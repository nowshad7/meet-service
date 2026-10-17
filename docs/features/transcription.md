# Transcription

Live captions through a server-side transcriber: Jigasi joins the room as a hidden participant, streams every speaker's audio to the internal stt-gateway, and the gateway streams it to a speech-to-text provider.
Captions appear in Jitsi's own subtitles UI, word by word.
Nothing is saved: transcript files, audio recording, transcript URL advertising and translation are switched off.

Both workflows include it as an opt-in:

- **Published images:** the `transcription` profile of [`deploy/compose.yml`](../../deploy/compose.yml), see [Release deployment](#release-deployment).
- **Checkout:** `MEET_FEATURES=transcription` with `scripts/meet`, see [Source deployment](#source-deployment).

With neither, no transcriber or gateway runs and nobody can request captions.

## What it does

1. The room's first moderator joins with a token that entitles the room and asks for `autoStart`; the default brand script requests captions at once, so Jigasi joins before anyone speaks (see [Starting captions](#starting-captions)).
   Without `autoStart`, an entitled participant starts captions from Jitsi's closed captions button.
2. Jicofo invites Jigasi from its brewery through the legacy `requestingTranscription` presence path.
   There is no bridge transcription URL or `asyncTranscription` wiring.
3. Jigasi (`meet-jigasi`, the pinned upstream image with a [patched audio buffer](../../images/jigasi/README.md)) sends each speaker's 16 kHz PCM to the gateway every 100 ms instead of every 1.46 s.
4. The gateway passes every frame straight to a continuous provider and every interim result straight back; nothing is windowed, batched or throttled.
5. Jigasi turns results into JSON caption messages in the room, which Jitsi's subtitles UI shows, interim text first and the final text when the provider commits the phrase.

`mod_meet_transcription` runs after upstream token verification and fixes room entitlement from the first ordinary participant's verified token.
Both `context.features.transcription: true` and `context.room.transcription.enabled: true` are required, together with deployment opt-in.
A later token cannot enable a denied room.
The module removes transcription-request presence on joins and subsequent updates unless the room is entitled and the requesting participant has a verified token with the feature claim.
A direct hidden-transcriber invitation into a denied room is rejected too.
Focus/admin and healthcheck joins cannot establish entitlement.
Moderator status alone grants no transcription entitlement.
The published Prosody configuration always loads the module; with `ENABLE_TRANSCRIPTIONS` off it denies every request.

The default brand loads `transcription-language.js`, which is inert unless captions are enabled and the token opts in with a supported language.
After the conference joins, it announces the local speaker's `transcription_language` as `bn` or `en` using the pinned client's participant-property API, and applies it again to a new conference after reconnecting.
This bypasses the pinned web client's language allowlist, which otherwise rejects Bangla and falls back to English, without patching upstream files.
The same script starts captions for rooms with `autoStart`.
The browser reads the token for language selection and auto-start only; Prosody decides permission from verified session claims.
Deployment brands overriding `plugin.head.html` must include this script themselves.

## Release deployment

On published images, add to `.env`:

```sh
COMPOSE_PROFILES=transcription          # with any other profiles, comma-separated
ENABLE_TRANSCRIPTIONS=1
TOOLBAR_BUTTONS=...,closedcaptions,...  # so each user can turn captions on and off
# Optional, defaults shown:
# MEET_STT_PROVIDER_MODULE=/app/gemini-transcribe-live.mjs
# GEMINI_TRANSCRIBE_MODEL=gemini-3.5-transcribe-live
```

and put the provider key in `stt-secrets.env`, next to `secrets.env` (from [`deploy/stt-secrets.env.example`](../../deploy/stt-secrets.env.example), `chmod 600`, never committed):

```sh
GEMINI_API_KEY=...
```

Create `data/transcriber` with the rest of the data tree, then `docker compose up -d`.
The profile adds two services:

| Service | Image | Notes |
|---|---|---|
| `stt-gateway` | `meet-stt-gateway` | Reads `.env` and `stt-secrets.env` only; no other service sees the provider keys, and it does not see the XMPP passwords. No host port. |
| `transcriber` | `meet-jigasi` | `JIGASI_MODE=transcriber` with the bundled `WhisperTranscriptionService` pointed at `ws://stt-gateway:8000/streaming-whisper/ws`; saving, audio recording, URL advertising and translation off. |

`deploy/compose.yml` also derives what `scripts/meet` derives on a checkout:

- Prosody always loads `meet_transcription` (appended to `XMPP_MUC_MODULES`) and sets `MEET_TRANSCRIPTION_ENABLED` from `ENABLE_TRANSCRIPTIONS`.
- Prosody's healthcheck waits until upstream has registered both Jigasi accounts when captions are on, and the transcriber waits for it and for the gateway.
- The Jigasi user names, brewery and hidden domain keep their upstream defaults (`jigasi`, `transcriber`, `jigasibrewery`, `hidden.meet.jitsi`); their passwords are the `JIGASI_*_PASSWORD` entries already in `secrets.env`.
- The live-only Jigasi properties are built into `meet-jigasi`; a `custom-sip-communicator.properties` in `data/transcriber` replaces them.

A deployment that carried transcription in its own `compose.override.yml` on 1.3.0 drops the `stt-gateway` and `transcriber` services, the Prosody healthcheck, its copy of `transcription.properties`, and these `.env` lines:
`MEET_TRANSCRIPTION_ENABLED`, `meet_transcription` in `XMPP_MUC_MODULES`, `JITSI_IMAGE_VERSION`, `JIGASI_XMPP_USER`, `JIGASI_TRANSCRIBER_USER`, `JIGASI_BREWERY_MUC`, `JIGASI_TRANSCRIBER_CUSTOM_SERVICE`, `JIGASI_TRANSCRIBER_WHISPER_URL` and the four `JIGASI_TRANSCRIBER_*` saving and translation flags.
It moves the provider key from `secrets.env` to `stt-secrets.env`.

## Source deployment

`scripts/meet` includes the pinned upstream `transcriber.yml` and `compose/transcription.yml`, sets `ENABLE_TRANSCRIPTIONS=1` for web, Prosody and Jicofo, and selects Jigasi's bundled `WhisperTranscriptionService`.
`compose/transcription.yml` runs `meet-jigasi`, built locally from `images/Dockerfile` (`MEET_JIGASI_IMAGE` selects another).
It activates with either a nonempty private `JIGASI_TRANSCRIBER_WHISPER_URL` or a configured `MEET_STT_PROVIDER_MODULE` (a bundled provider or a mounted private one).

```sh
MEET_FEATURES=transcription
MEET_STT_PROVIDER_MODULE=/app/gemini-transcribe-live.mjs
```

| Setting | Use |
|---|---|
| `MEET_FEATURES` contains `transcription` | Opts in; activation also requires a backend URL or provider module |
| `AUTH_TYPE=jwt` | Required for the verified token permission gate |
| `MEET_STT_PROVIDER_MODULE` | `/app/gemini-transcribe-live.mjs`, `/app/elevenlabs.mjs`, `/app/gemini-live.mjs`, `/app/gemini.mjs`, or a private module under `/provider/` |
| `JIGASI_TRANSCRIBER_WHISPER_URL` | Private Jigasi/Skynet-compatible WebSocket endpoint instead of the gateway; empty by default |
| `JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY`, `JIGASI_TRANSCRIBER_WHISPER_PRIVATE_KEY_NAME` | Optional private backend authentication; key stays in deployment secrets and is never generated by `init` |
| `JIGASI_XMPP_USER`, `JIGASI_XMPP_PASSWORD` | Brewery account, default user `jigasi`; password generated privately by `init` |
| `JIGASI_TRANSCRIBER_USER`, `JIGASI_TRANSCRIBER_PASSWORD` | Hidden participant account, default user `transcriber`; password generated privately by `init` |
| `JIGASI_BREWERY_MUC` | Brewery shared by Jigasi and Jicofo, default `jigasibrewery` |
| `XMPP_AUTH_DOMAIN`, `XMPP_INTERNAL_MUC_DOMAIN`, `XMPP_HIDDEN_DOMAIN` | Upstream account and brewery domains; hidden domain defaults to `hidden.meet.jitsi` |

The transcriber waits for a Prosody healthcheck confirming both accounts exist, avoiding a first-start login race.
Put provider keys in the deployment's uncommitted `secrets.env`; `compose/stt-gateway.yml` passes them to the gateway only.
No provider key, model file or provider secret belongs in the repository or images.

## Internal gateway and providers

The gateway (`services/stt-gateway`, image `meet-stt-gateway`) speaks Jigasi's streaming Whisper protocol on port 8000 of the private network and loads one provider module.
`scripts/meet` adds `compose/stt-gateway.yml` only when transcription and a module are configured, and sets Jigasi's URL to `ws://stt-gateway:8000/streaming-whisper/ws`.
Private modules also require `MEET_STT_PROVIDER_DIR`, mounted read-only at `/provider` by `compose/stt-provider.yml`.
A configured module takes precedence over an external backend URL.
The gateway has no published host port; Jigasi waits for its readiness check.

| Module | Kind | Key | Notes |
|---|---|---|---|
| `/app/gemini-transcribe-live.mjs` | continuous, **default** | `GEMINI_API_KEY` | [Gemini 3.5 Transcribe Live](#gemini-35-transcribe-live-provider) |
| `/app/elevenlabs.mjs` | continuous | `ELEVENLABS_API_KEY` | [ElevenLabs Scribe v2 Realtime](#elevenlabs-scribe-v2-realtime-provider) |
| `/app/gemini-live.mjs` | continuous | `GEMINI_API_KEY` | [Gemini Live](#gemini-live-provider), a dialogue model with input transcription |
| `/app/gemini.mjs` | batch | `GEMINI_API_KEY` | [3 s windows](#gemini-batch-provider); 5–15 s behind speech |

Continuous providers receive each frame immediately through the stream interface; batch providers get 3-second PCM windows with 500 ms overlap.
Each provider handles speech/silence boundaries and interim/final text.
Queues, speaker counts and room connections are bounded; batch calls are aborted after 10 seconds.
Provider failures affect captions rather than the meeting transport.
A global limit of 32 active provider calls or streams remains effective across reconnects.
See [the provider contract](../../services/stt-gateway/README.md) for settings and [the pinned protocol citations](../../services/stt-gateway/PROTOCOL.md) for exact formats.

Jigasi connects to the gateway as soon as it joins a room, before anyone has spoken.
The gateway then asks a continuous provider that supports it to open a connection for the room's next speaker, in the language it last heard (or `MEET_STT_PREWARM_LANGUAGE`), so the first words do not wait for the provider's handshake and setup.
After a speaker takes that connection the gateway prepares the next one.

The gateway writes one timing line per event to stdout: `stt-gateway event=<name>` with numbers and short fixed tokens only, never audio, caption text, keys, tokens or participant IDs (speakers are an 8-character hash).

| Event | Fields |
|---|---|
| `ready` | `provider` (module file name), `mode`, `prewarm`, start-up `ms` |
| `room_open`, `room_close` | `room` (random), `connections`; on close `code`, `seconds`, `speakers` |
| `first_audio` | `speaker`, `language`, `ms` since the room connected |
| `stream_open`, `stream_close` | `streams`; on close `seconds`, `audio_ms`, `results` |
| `provider_ready` | setup `ms`, `warm` (pre-opened), `rotation` |
| `first_result` | `ms` from the speaker's first audio to their first caption, `type` |
| `provider_error` | `reason` (`setup_timeout`, `http_401`, `closed_1011`, a vendor error type, ...), `cooldown` |
| `provider_reconnect`, `provider_rotate`, `provider_switched` | `attempt`, `wait_ms` |
| `stream_failed`, `stream_limit`, `room_refused`, `room_rejected`, `window_dropped`, `call_failed`, `call_timeout` | failures; `reason` is a fixed code |

`MEET_STT_LOG=0` turns the lines off.
Start-up failures print one line naming a fixed code, for example `(key_required)` or `(invalid_config)`.

## Gemini 3.5 Transcribe Live provider

The default provider.
`/app/gemini-transcribe-live.mjs` opens one Gemini Live API WebSocket per speaker (`v1beta` `BidiGenerateContent`, model `gemini-3.5-transcribe-live`, response modality `TEXT`) and streams the PCM unchanged in 100 ms chunks.
Input transcription is requested in the speaker's language plus English (`bn-IN, en-US` for `bn`, `en-US` for `en`; region tags in the token pass through), so English words inside Bangla speech stay English.
`interimInputTranscription` carries the whole current utterance and goes straight out as an interim caption; `inputTranscription` ends it as a final.
Model text output is discarded.
Gateway idle sends `audioStreamEnd`; later audio continues in the same session.

The API limits these sessions to 10 minutes.
The provider rotates each speaker's session after 9 minutes without losing audio or words:

1. It opens the next session while the current one keeps streaming.
2. Once the new session is ready, audio moves to it and the old one gets `audioStreamEnd`.
3. The old session finishes the words already sent, and its caption stays up until its final arrives (at most `GEMINI_TRANSCRIBE_DRAIN_MS`); text from the new session is shown right after.

A server `goAway` starts the same rotation early.
A broken connection commits the visible caption, keeps unsent audio within the queue limit and reconnects with backoff; words in flight on that connection are lost.
Auth (401/403), quota (429) and policy closes (1007/1008) cool down for 60 seconds, as do more than five failed attempts in a row.

| Setting | Default | Meaning |
|---|---:|---|
| `GEMINI_API_KEY` | none | Required, in `stt-secrets.env` (release) or `secrets.env` (checkout) |
| `GEMINI_TRANSCRIBE_MODEL` | `gemini-3.5-transcribe-live` | Live transcription model |
| `GEMINI_TRANSCRIBE_SESSION_MS` | 540000 | Overlapping rotation; at most 590000, 0 turns it off |
| `GEMINI_TRANSCRIBE_DRAIN_MS` | 2500 | Longest wait for the old session's final at a rotation |
| `GEMINI_TRANSCRIBE_SPARE_MS` | 540000 | Lifetime of a pre-opened connection before it is renewed; 0 turns pre-opening off |
| `GEMINI_TRANSCRIBE_MAX_QUEUE_MS` | 5000 | Unsent PCM kept during setup or reconnect; oldest audio drops at the limit |
| `GEMINI_TRANSCRIBE_SETUP_TIMEOUT_MS` | 10000 | Connect and setup deadline |
| `GEMINI_TRANSCRIBE_RECONNECT_MS` | 500 | Initial reconnect backoff, doubling to 5 seconds |
| `GEMINI_TRANSCRIBE_MAX_STREAMS` | 32 | Open sessions, pre-opened ones included; a speaker takes the slot of another room's spare |

Millisecond limits other than the session and spare lifetimes are at most 60000; counts are at most 4096.
Pre-opened connections are idle sessions; Gemini bills audio tokens, so they are not expected to cost anything (unverified).
The API shape was verified against the live service on 2026-10-15 (setup, interim and final transcription, the 1007 close for the `AUDIO` modality).

## ElevenLabs Scribe v2 Realtime provider

`/app/elevenlabs.mjs` opens one `wss://api.elevenlabs.io/v1/speech-to-text/realtime` connection per speaker with `model_id=scribe_v2_realtime`, `audio_format=pcm_16000`, `commit_strategy=vad` and the speaker's ISO 639-1 language, authenticated with the `xi-api-key` header.
Audio waits for `session_started`, then goes out unchanged in 100 ms `input_audio_chunk` messages.
`partial_transcript` is the interim caption and `committed_transcript` the final; gateway idle commits an open segment instead of waiting for server VAD.

On singing, a commit sometimes drops most of the words its partials showed.
When the committed text has fewer than 70 % of the last partial's words, the final keeps the partial, so the caption does not visibly shrink; a commit that keeps most of the words, or corrects them, is used as sent.
This needs no extra wait.
Vendor error messages reconnect with backoff; `auth_error`, `quota_exceeded`, `rate_limited`, `resource_exhausted` and `unaccepted_terms` cool down for 60 seconds.

| Setting | Default | Meaning |
|---|---:|---|
| `ELEVENLABS_API_KEY` | none | Required, in `stt-secrets.env` (release) or `secrets.env` (checkout) |
| `ELEVENLABS_MODEL` | `scribe_v2_realtime` | Realtime model |
| `ELEVENLABS_SPARE_MS` | 0 | Pre-opened connection lifetime; off by default because ElevenLabs does not document whether idle session time is billed |
| `ELEVENLABS_MAX_QUEUE_MS`, `ELEVENLABS_SETUP_TIMEOUT_MS`, `ELEVENLABS_RECONNECT_MS`, `ELEVENLABS_MAX_STREAMS` | 5000, 10000, 500, 32 | As for Gemini |

Scribe v2 Realtime documents Bengali; switching to English inside a sentence is not documented for the realtime model.

## Gemini batch provider

Kept for comparison; it is 5–15 s behind speech. In the per-deployment `deployment.env`, select:

```sh
MEET_FEATURES=transcription
MEET_STT_PROVIDER_MODULE=/app/gemini.mjs
GEMINI_MODEL=gemini-3.5-flash
GEMINI_TIMEOUT_MS=8000
```

Keep `AUTH_TYPE=jwt` and the room entitlement and speaker-language claims described below.
Place `GEMINI_API_KEY` only in that deployment's uncommitted `secrets.env` or equivalent injected per-deployment secret.
There is no default key; missing/empty credentials fail gateway startup with a generic message.
Never put a key, including a test key, in this repository, deployment templates, image build arguments or images.
The compose overlay passes the runtime settings to the internal gateway without publishing its port.
No private provider directory is needed for Gemini.

| Setting | Default | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | None | Required runtime deployment secret |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Gemini model identifier; must support audio input |
| `GEMINI_TIMEOUT_MS` | `8000` | Positive integer deadline for the whole chunk request, including retry |

The effective deadline is bounded by `MEET_STT_TIMEOUT_MS` (default 10000).
The adapter uses Node's built-in HTTP fetch, sends mono 16-bit PCM wrapped in WAV to Google's `generateContent` API,
and instructs it to transcribe exactly as spoken with the speaker's language hint, keeping Bangla in Bangla script and English words in English.
Audio leaves the deployment for Google's API; the adapter does not upload saved transcripts or store audio.
It returns each completed batch as a final segment using the existing provider contract, with no fabricated interim results.
Empty chunks, exact digital silence and overlap-only finalization make no API request.
Quiet microphone noise is not classified as silence locally.
Confirmed overlap PCM is removed from consecutive successful windows; after dropped/failed windows or a language change the prefix is retained.
This avoids re-submitting already processed audio, but speech split at a window boundary may be clipped; live boundary accuracy remains unverified.
No transcript history is retained, and session scheduling metadata is released on disconnect.

Network failures, HTTP 408 and selected transient 5xx responses get at most one retry after 500–749 ms of jittered backoff within the same deadline.
Auth (401/403), quota/payment (402/429), other request failures and invalid/blocked responses raise sanitized provider errors without retry.
The gateway discards those errors while keeping the meeting transport running.
Neither adapter nor gateway logs keys, audio, transcripts or vendor error bodies.

API shape and error handling were checked against Google's current [generateContent reference](https://ai.google.dev/api/generate-content),
[audio format guide](https://ai.google.dev/gemini-api/docs/audio#supported-audio-formats),
and [retry guidance](https://ai.google.dev/gemini-api/docs/troubleshooting#retry-strategy) on 2026-10-07.
Requests use `contents[].parts[]` with text and base64 `inlineData` (`mimeType: audio/wav`), and `x-goog-api-key` header authentication;
responses read non-thought text from `candidates[0].content.parts[]` only after `finishReason: STOP`.
The model default follows the deployment requirement; model availability was not verified with a real API call.

**Real-time latency, per-minute cost, and accuracy on live class audio are unverified.**
A successful uploaded-file transcription does not establish live caption performance with short, overlapping speaker windows.
Test representative Bangla/English classes, code-switching, quiet speech, boundary words and concurrent speakers before wider deployment.

## Gemini Live provider

Kept as an option. Select it in the deployment's `deployment.env` (or `.env` on the release path):

```sh
MEET_FEATURES=transcription
MEET_STT_PROVIDER_MODULE=/app/gemini-live.mjs
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-latest
```

Keep `GEMINI_API_KEY` in the deployment's uncommitted `secrets.env`, as for the batch provider.
No provider directory is required.
The gateway image bundles every adapter and can be selected with `MEET_STT_GATEWAY_IMAGE`.
The Live model setting is separate from `GEMINI_MODEL`, which continues to select the batch model.

The provider opens one authenticated Live WebSocket per speaker and streams headerless PCM16 little-endian mono at 16 kHz in at most 100 ms chunks.
The pinned Jigasi capture device already produces this format; no resampling or WAV wrapping is needed.
`inputTranscription.text` fragments extend one accumulated interim caption, so Jigasi keeps its utterance ID and previous words remain visible.
A server `turnComplete` schedules a final after a short grace period, which late input fragments extend.
Google documents no guaranteed ordering between input transcription and turn events, so this grace is a heuristic; delayed fragments can still become a new utterance.
Gateway idle/EOF sends `audioStreamEnd`; subsequent PCM reopens input on the same session.
The provider does not infer utterance boundaries from client-side silence or clear captions with empty text.
First caption startup still includes network setup and the model's first-token delay.

Native audio requires the `AUDIO` response modality.
A system instruction asks it to listen silently and never reply, with a default maximum of 32 output tokens.
All generated audio, output transcription and tool calls are discarded; none is decoded, played, stored or forwarded.
These controls do not guarantee zero output generation or zero output charges.
Cost per minute is unmeasured.

| Setting | Default | Meaning |
|---|---:|---|
| `GEMINI_LIVE_MODEL` | `gemini-2.5-flash-native-audio-latest` | Live model name |
| `GEMINI_LIVE_MAX_STREAMS` | 32 | Provider session cap, also subject to the gateway global cap |
| `GEMINI_LIVE_MAX_QUEUE_MS` | 5000 | Unsent PCM retained during setup/reconnect; oldest audio drops at the limit |
| `GEMINI_LIVE_SETUP_TIMEOUT_MS` | 10000 | Connect/setup deadline |
| `GEMINI_LIVE_STALL_MS` | 30000 | No input transcription while nonzero PCM is pending before reconnect |
| `GEMINI_LIVE_RECONNECT_MS` | 500 | Initial exponential backoff, capped at 5 seconds |
| `GEMINI_LIVE_SESSION_MS` | 540000 | Proactive connection rotation; maximum 840000 |
| `GEMINI_LIVE_FINAL_GRACE_MS` | 350 | Delay after an API boundary for late input fragments |
| `GEMINI_LIVE_MAX_OUTPUT_TOKENS` | 32 | Generated response token cap |

All limits are positive integers; millisecond limits other than session rotation are at most 60000, and counts/token caps are at most 4096.
Setup completion is required before sending audio; startup audio is held only within the bounded queue.
Session resumption handles and sliding-window context compression are enabled; GoAway or scheduled rotation reconnects using the last resumable handle.
Without a usable handle the provider commits the current caption and starts a fresh session.
Auth/policy/quota failures and more than five consecutive unsuccessful recoveries impose a 60-second cooldown.
A successful input transcription resets the recovery count.
Sent audio is never replayed because realtime frames have no individual acknowledgement; unsent audio is retained within the queue limit.
Words in flight during a broken connection can be lost; recovery is best effort, not lossless.
All failures remain confined to captions and no native errors, URLs, credentials, audio or transcript text enter provider logs.

The [WebSocket guide](https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket) documents the v1beta endpoint, query-key authentication and PCM framing.
The [Live API reference](https://ai.google.dev/api/live) documents setup, input transcription, `audioStreamEnd`, turn completion and resumption updates.
The [session guide](https://ai.google.dev/gemini-api/docs/live-api/session-management) documents connection limits, resumption, compression and GoAway.
These sources were checked on 2026-10-08.
Fake-WebSocket tests cover framing, caption accumulation, boundaries, bounded startup queues, reconnect and private-error handling.
A single isolated 64-second Bangla Jitsi/Jigasi playback on 2026-10-08 yielded 196 input fragments, 190 containing one word, with a median 189 ms fragment interval.
The first API fragment arrived 5.471 seconds after browser playback began, including 2.849 seconds before the gateway's first outgoing PCM, and 2.622 seconds after that PCM began.
No generated reply audio was observed with the silent instruction and 32-token cap in that pass.
That first run's UI instrumentation was invalid.
A corrected second playback captured 201 visible text changes with a median 192 ms interval; 100 of 104 positive displayed word-count increases added one word.
Its first visible caption arrived 10.239 seconds after speech playback began, including 7.538 seconds before Jigasi supplied PCM; the first API fragment arrived 2.650 seconds after PCM began and rendered 51 ms later.
This observed initial caption was slower than the supplied 7–9-second batch baseline, which was not independently replayed.
The provider improves update cadence; faster initial end-to-end captions are not guaranteed.
Per-word speech-to-caption latency requires spoken-word alignment and was not measured.
Human-rated accuracy, long sessions, many concurrent speakers and cost per minute remain unverified.

## Starting captions

`context.room.transcription.autoStart: true` in the join token starts captions automatically:

- An entitled moderator's browser requests captions as soon as it joins, so Jigasi joins and connects before anyone speaks.
  It retries every 10 seconds if the transcriber leaves.
- Every other entitled participant turns captions on once the transcriber is in the room.
- Captions show on stage: the first time, the script switches on the pinned client's "Show subtitles on stage" setting (otherwise captions appear only in the chat panel's closed captions tab).
  After that the user's own setting, kept in their browser, stands.
- Each user can turn captions off and on again for themselves with the closed captions button; the script does not undo that.
  With captions on stage the button toggles them directly (translation selection is switched off, so there is no language dialog); a user who turned them back on gets them again after a transcriber restart.
  A moderator turning captions off keeps the room's transcription request, so other participants keep their captions while the moderator is in the room.

Auto-start requests captions exactly like the closed captions panel's Start, without a translation language.
Prosody still decides who may request captions, so a token that only claims `autoStart` without the feature claim starts nothing.
A room with auto-start streams every unmuted speaker for the whole class, which is billed by the provider.

## Contract

An entitled join token includes this context:

```json
{
  "features": { "transcription": true },
  "room": { "transcription": { "enabled": true, "language": "bn", "autoStart": true } }
}
```

Use `en` for English speakers and `bn` for Bangla speakers, one language per speaker or class.
Every participant permitted to request captions needs the feature claim; entitled speakers should carry their own language.
`autoStart` starts captions as described above; without it, captions start from Jitsi's closed captions button.
`save` is ignored: captions are live only.
Translation is outside this feature; do not select a translation/output language, since Jigasi's Whisper adapter can prefer it over the source language.
End-to-end encrypted audio cannot be recognized by a server transcriber.

## Latency

Measured on 2026-10-15 to 2026-10-17 on an isolated stack built from this tree (localhost, one laptop), with the method of the 1.3.0 measurement: the student's browser sings a vocals-only Bangla song from a fake microphone, the moderator's browser receives captions on stage, timing only.
Gated runs cut the song into 16 sung bursts with 6 s of silence after each, so every burst's lag can be read separately.
1.3.0 is the same measurement on the 1.3.0 stack (stock Jigasi, Gemini 3.5 Transcribe Live as a test module, captions started by hand).

| Stage | 1.3.0 | Now: Gemini 3.5 Transcribe Live | Now: ElevenLabs Scribe v2 Realtime |
|---|---:|---:|---:|
| Moderator joins → transcriber in the room | captions started by hand | 0.6–0.8 s, before anyone speaks | same |
| Speech onset → PCM at the gateway | 1.3 s | 0.0 s (within the first 100 ms; stock Jigasi in the same stack: 1.24 s) | 0.0 s |
| Provider connection set-up for the first speaker | in the first-caption time | 0 ms (pre-opened) | 0.55–0.67 s (pre-opening off by default) |
| Gateway PCM → first caption message | | 1.27–1.34 s | 2.35–2.52 s |
| Message → caption in the page | 6–20 ms | 1–3 ms | 1–2 ms |
| **Speech onset → first visible caption** | **4.0–8.7 s** | **1.15–1.23 s** (5 runs) | **2.17–2.39 s** (3 runs) |
| **Per-word lag p50 / p90** (gated) | **1.9 / 3.1 s** | **1.34 / 2.39 s** (default settings; 1.11–1.35 / 2.39–2.90 s over 4 runs) | **0.91 / 2.25 s** (0.76 / 2.17 s with the 1.5 s idle) |
| Phrase start → first words p50 / p90 | 2.9 / 4.3 s | 2.37 / 3.33 s | 1.89 / 3.28 s |
| Phrase end → last words p50 / p90 | 0.9 / 1.7 s | 0.47 / 1.32 s | −0.08 / 0.60 s |
| Phrase end → final caption p50 / p90 | 1.4 / 2.1 s | 1.32 / 1.58 s (2.15 / 2.31 s with the 1.5 s idle) | 1.40 / 1.66 s (2.17 / 2.44 s with the 1.5 s idle) |
| Caption messages | about one per 1.4 s | about one per 1.0 s | about one per 1.0 s |

With the stock Jigasi image in the same stack, Gemini's per-word lag was 1.76 / 3.07 s and the first caption 1.87 s, so the buffer patch accounts for about 0.4 s of per-word lag and 0.7 s of first caption.
The gateway forwards every result (152 sent for 134 received in one run, the rest after recording stopped), and Jigasi, Prosody and the web client add no throttle: the remaining one-per-second cadence is how often the providers send interim text.
Sung audio, one speaker, a few runs per setting; accuracy and cost per minute were not measured.

## Tests

`tests/plugins/mod_meet_transcription_spec.lua` covers deployment and token permission, first-join room policy, start requests, updates and denied hidden-transcriber joins.
`tests/meet-test.sh` covers opt-in, empty backend behavior, private secret generation, bundled provider modules and compose-file selection.
`tests/transcription-language.test.mjs` covers Bangla/English participant properties after initialization and reconnects, auto-start for moderators and other participants, per-user off, transcriber restarts and inert cases.
`tests/transcription-config-check.sh` renders pinned image templates, checks the merged `scripts/meet` compose configuration (including the `meet-jigasi` build), and checks the release compose with the `transcription` profile: key isolation, derived Prosody settings and service wiring.
`tests/jigasi-patch-check.sh` builds `meet-jigasi`, refuses a different upstream Jigasi package, and unit-tests the patched buffer inside the image.
`tests/stt-gateway.test.mjs` uses source-built binary frames and a fake provider to check real WebSocket transport, PCM windows, overlap, interim/final responses, per-speaker language, timeout/queue bounds, disconnect cleanup, pre-opening and the timing log.
`tests/stt-realtime.test.mjs` checks the shared continuous-provider core with fake connections: queueing until setup, pass-through of every interim, overlapping rotation with no audio or caption lost, drain timeout, reconnect with commit, pre-opened connections and caps.
`tests/stt-gemini-transcribe-live.test.mjs` and `tests/stt-elevenlabs.test.mjs` check the vendor wire formats against local fake WebSocket servers (setup, framing, interim/final mapping, rotation on real sockets, commit reconciliation, error cooldowns, absence of logs).
`tests/stt-gemini.test.mjs` and `tests/stt-gemini-live.test.mjs` cover the batch and Gemini Live adapters the same way.
`tests/stt-stack-check.sh` starts an isolated gateway container and sends source-format frames using the Jetty and JSON-simple libraries bundled in the pinned Jigasi image.
None of these tests calls a real provider.
