# Private provider interface

The core contains transport and scheduling only.
It imports the absolute `MEET_STT_PROVIDER_MODULE` path at startup and calls its exported `createProvider()` once, awaiting the result.
Startup fails with a generic message if no usable provider is mounted.
Only tests contain a fake provider; the image contains no recognition implementation or credentials.

The returned object must implement:

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
