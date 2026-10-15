# meet-jigasi

`meet-jigasi` is the pinned `ghcr.io/jitsi/jigasi` image with one class changed: the per-speaker audio buffer in `org.jitsi.jigasi.transcription.Participant`.
It is the only meet-service image that changes upstream code, and it exists only to make live captions faster.
Everything else in the image is upstream.

## Why

Stock Jigasi holds each speaker's audio in a fixed 48,000-byte buffer before sending it on ([`Participant.java` at `e9a3acc1`](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/Participant.java#L51-L71)).
The comment says 500 ms, but the size assumes 48 kHz audio.
The Whisper path that the stt-gateway uses delivers 16 kHz mono, so the buffer holds about 1.5 s and is sent every 1.46 s.
Every word waits up to 1.46 s before the gateway sees it, and caption updates can only arrive about once every 1.4 s.

Two upstream bugs ride along:

- A full buffer is sent as the whole backing array, including bytes that were never written, about 40 ms of zeros after every chunk.
  The array is also handed to a later executor task while the next packets are already being written into it.
- `flushBuffer()`, called when a speaker mutes, sends the whole array, so up to 1.4 s of older audio can be sent again.

## What the patch does

- [`ParticipantAudioBuffer`](src/org/jitsi/jigasi/transcription/ParticipantAudioBuffer.java), a new class, holds a configurable number of milliseconds, sized from the actual audio format of the first packet (16 kHz mono 16-bit: 32 bytes per millisecond).
  When the format leaves the rate unspecified, it assumes 20 ms packets.
- It sends a copy of only the bytes written, once the configured time is collected, and flushes only what was written since the last send.
- [`Participant`](src/org/jitsi/jigasi/transcription/Participant.java) uses it and copies each incoming packet before handing it to the executor.
  Everything else in the file is the upstream source at the pinned commit.

| Property | Default | Meaning |
|---|---:|---|
| `org.jitsi.jigasi.transcription.AUDIO_BUFFER_MS` | 100 | Milliseconds of each speaker's audio collected before sending; 0 sends every packet; at most 2000 |

The image ships it in `compose/transcription.properties`, which becomes `custom-sip-communicator.properties`.
A file of that name in the transcriber's data folder replaces it, as with the other images.

## Build and upgrade

The `jigasi` target in `images/Dockerfile` compiles the two classes against the jars of the pinned upstream image and replaces them in `jigasi.jar`.
The build fails unless the base image's `jigasi` package is exactly the version in [`JIGASI_VERSION`](JIGASI_VERSION), so an `UPSTREAM_VERSION` bump cannot silently swap in a different `Participant`.
On an upgrade:

1. Find the new package version with `docker run --rm --entrypoint dpkg-query ghcr.io/jitsi/jigasi:<tag> -W jigasi`; its suffix (`g<hash>`) is the Jigasi commit.
2. Diff upstream `Participant.java` between the old and the new commit, and carry its changes into `src/`.
   If upstream has fixed the buffer itself, delete this image and go back to the stock one.
3. Update `JIGASI_VERSION` and run `tests/jigasi-patch-check.sh`.

`tests/jigasi-patch-check.sh` builds the target, unit-tests the buffer inside the image (sizes, copies, flush, pass-through) and checks that the live-only defaults reach Jigasi's config.
Offering the fix to the upstream Jigasi project is planned separately.
