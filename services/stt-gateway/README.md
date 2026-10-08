# Speech provider interface

The gateway contains transport, scheduling and the optional open-source Gemini batch and Live providers.
It imports the absolute `MEET_STT_PROVIDER_MODULE` path at startup and calls its exported `createProvider()` once, awaiting the result.
Startup fails with a generic message if no usable provider is selected.
Set `MEET_STT_PROVIDER_MODULE=/app/gemini.mjs` to select the bundled Gemini provider,
or mount a private module under `/provider`. The image contains no credentials.
See [Gemini setup and limitations](../../docs/features/transcription.md#gemini-provider).

A batch provider implements:

```js
async transcribe({
    sessionId, participantId, language, audio, sampleRate,
    overlapSamples, sequence, final, signal
}) {
    // Return an array of { text: string, isFinal: boolean, variance?: number }.
}
```

`audio` is a Buffer of signed little-endian 16-bit mono PCM at `sampleRate = 16000`.
`language` is preserved from that speaker's frame header, including region suffixes if supplied.
`sessionId` isolates reconnects and simultaneous meetings whose participant IDs might coincide.
Calls are serialized per speaker, but separate speakers and sessions can run concurrently.
Provider state must be keyed by session and participant, never participant alone.
`sequence` increments even when a job is dropped, so the provider can detect gaps.
`overlapSamples` identifies the prefix already present in the previous window; a provider must reconcile it to avoid duplicate captions.
The provider decides utterance boundaries and can return interim updates or final segments from any call.
It must perform silence detection itself for continuous PCM streams; the core does not interpret audio or infer speech.

`final = true` requests finalization after idle, language change or EOF.
This call may contain only an overlap prefix with no fresh audio, so finalize cached recognition rather than submitting the prefix as a new utterance.
Return final results for any outstanding interim utterance, or an empty array if no text is available.
After an idle flush the next audio starts a new window without overlap.
On EOF the adapter immediately disconnects, so delivery of last captions cannot be guaranteed; disconnect aborts recognition and drops unsent work.
No per-speaker leave message exists on the wire; speaker state is retained until the connection closes, within the speaker cap.

Honor `signal` promptly to cancel network requests and release audio buffers.
After a timeout the core discards late results and keeps that speaker's call occupied until it settles, bounding concurrent calls even if cancellation is ignored.
A global active-call cap also remains occupied across disconnects until calls settle; at that cap new jobs are dropped, preventing reconnects from accumulating uncancellable calls.
The waiting queue is bounded and drops new jobs when full; captions can be lost under overload, while other speakers continue.
Exceptions and invalid results are discarded without logging their messages, audio, transcripts, IDs or credentials.
A provider must follow the same logging policy.
Results are limited to 16,000 characters and a slow caption socket drops results once buffered output exceeds 64 KiB.

An optional `releaseSession({ sessionId })` is called on connection close to release private provider state.
It must tolerate in-flight aborted calls completing later.
Its errors are discarded too.

| Environment | Default | Meaning |
|---|---:|---|
| `MEET_STT_WINDOW_MS` | 3000 | PCM window; maximum 30000 ms |
| `MEET_STT_OVERLAP_MS` | 500 | Prefix retained between windows; less than window |
| `MEET_STT_IDLE_MS` | 1500 | No incoming audio before finalization |
| `MEET_STT_TIMEOUT_MS` | 10000 | Abort a provider call and discard its late results |
| `MEET_STT_MAX_ACTIVE_CALLS` | 32 | Global in-flight provider calls, including abandoned calls |
| `MEET_STT_MAX_QUEUE` | 4 | Waiting jobs per speaker, excluding the active call |
| `MEET_STT_MAX_SPEAKERS` | 100 | Speaker states per connection |
| `MEET_STT_MAX_CONNECTIONS` | 20 | Concurrent room connections |

All settings are integer values; overlap may be zero, other settings must be positive.
The WebSocket message limit is 30 seconds of PCM plus its header.
The service listens on port 8000 and serves `/health` for readiness.
The compose overlay publishes no host port and uses the private Jitsi network.
It does not validate backend bearer tokens; keep it reachable only by trusted internal transcribers.
Add provider credentials and any additional private mounts/env in the private deployment's compose overlay, never in this repository or image.

## Continuous providers

A provider may instead implement the synchronous `openStream` method below.
When present, it takes precedence over `transcribe`; the existing batch interface is unchanged.
The gateway passes each incoming PCM frame immediately, with no windows or overlap.

```js
openStream({ sessionId, participantId, language, sampleRate, onResult }) {
    return {
        write(audio) { /* synchronously accept a PCM Buffer into a bounded queue */ },
        endAudio() { /* signal idle/EOF; later write calls reopen audio */ },
        close() { /* cancel timers, network and queues synchronously */ }
    };
}
```

Call `onResult({ text, isFinal, variance })` as recognition arrives, with the same result contract as batch calls.
An interim is the complete current utterance, not a new fragment; a final commits that utterance in Jigasi.
The gateway never sends empty text to clear captions.
Idle and EOF call `endAudio`; language changes close the old stream and open a new one with the new hint.
Disconnect calls `close` and suppresses later callbacks.
Invalid results and synchronous provider failures are discarded without exposing error content.
`MEET_STT_MAX_ACTIVE_CALLS` also caps open continuous streams globally; batch and streaming are selected per process.
Streaming providers own startup deadlines, reconnection and bounded queues rather than the batch call timeout.
No per-speaker departure frame exists, so idle speaker streams occupy a slot until language change or room disconnect.
The same speaker/room caps and slow caption consumer limit apply.

Select `/app/gemini-live.mjs` for the bundled continuous Gemini implementation.
It uses the existing PCM bytes without resampling because the pinned Jigasi capture device already emits exactly the required format.
See [Live configuration and limitations](../../docs/features/transcription.md#gemini-live-provider).
