# Pinned streaming protocol

This gateway implements the bundled Jigasi adapter's wire protocol, with no upstream image patch.
The reference commit is `e9a3acc139c14d4b512718fef08333416a8ec625`.

| Wire behavior | Source |
|---|---|
| One connection shared by room speakers; participant ID is the second debug-name component | [WhisperTranscriptionService.java:141–185](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperTranscriptionService.java#L141) |
| Configured base URL gains `/connectionId`; optional HTTP `Authorization: Bearer …` | [WhisperWebsocket.java:171–215](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperWebsocket.java#L171) |
| Binary message: exactly 60 header bytes, `participantId\|language`, zero-padded, then unchanged audio bytes | [WhisperWebsocket.java:440–448](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperWebsocket.java#L440) |
| Language is the translation language if present, otherwise source language; it is carried in each audio frame | [WhisperWebsocket.java:422–437](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperWebsocket.java#L422) |
| Raw signed 16-bit little-endian, 16,000 Hz, mono LINEAR PCM, byte array; no WAV header | [PCMAudioSilenceCaptureDevice.java:57–70](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/PCMAudioSilenceCaptureDevice.java#L57), selected by [WhisperTranscriptionService.java:54–60](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperTranscriptionService.java#L54) |
| One-byte binary zero EOF, followed immediately by disconnect when all participants leave; no per-speaker leave frame | [WhisperWebsocket.java:94–96](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperWebsocket.java#L94), [461–487](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperWebsocket.java#L461) |
| Text JSON with `type`, `participant_id`, `text`, `variance`; exactly `final` means final, all other types mean interim; final clears Jigasi's utterance ID | [WhisperWebsocket.java:345–407](https://github.com/jitsi/jigasi/blob/e9a3acc139c14d4b512718fef08333416a8ec625/src/main/java/org/jitsi/jigasi/transcription/WhisperWebsocket.java#L345) |

The companion [Skynet streaming document:40–61](https://github.com/jitsi/skynet/blob/7099ed2acc596d74a5fcae231e7e23bf36459446/docs/streaming_whisper_module.md#L40) specifies `/streaming-whisper/ws/{meeting-id}` and the same binary header and headerless mono 16 kHz audio.
Its Java example at [100–110](https://github.com/jitsi/skynet/blob/7099ed2acc596d74a5fcae231e7e23bf36459446/docs/streaming_whisper_module.md#L100) agrees with Jigasi's zero padding; its JavaScript example space-pads instead, which the parser also accepts.
The gateway buffers even smaller audio frames; the document recommends at least one second but the Java adapter imposes no wire minimum.
The pinned Java source uses the JVM default charset for the header; the pinned container's UTF-8 environment is assumed.
The supported participant IDs/language tags are UTF-8 strings fitting the 60-byte header.

Example gateway response:

```json
{"type":"interim","participant_id":"speaker-id","text":"example","variance":0.500000}
```

`variance` is deliberately encoded with a decimal point even for zero, because JSON-simple parses integer tokens as `Long` and the adapter casts this field to `double` via `Double`.
No extra message ID is invented: Jigasi assigns and retains that ID until a final response.
