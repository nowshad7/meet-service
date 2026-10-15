import { WebSocket } from 'ws';
import { createStreamingProvider, readConfig } from './realtime.mjs';

// ElevenLabs Scribe v2 Realtime continuous provider. partial_transcript carries
// the current segment (interim); committed_transcript ends it (final).
// No keys, URLs, audio, transcripts or vendor errors enter logs.
const endpoint = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

export class ElevenLabsProviderError extends Error {
    constructor(code) { super(code); this.name = 'ElevenLabsProviderError'; this.code = code; }
}
const failure = code => new ElevenLabsProviderError(code);
const cooldownTypes = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'rate_limited', 'resource_exhausted']);
const words = text => text.trim().split(/\s+/).filter(Boolean).length;

// On sung or fast speech the commit can drop most of the words its partials
// showed. Keep the last partial then, so the caption does not shrink; a
// commit that keeps most of the words, or corrects them, is used as sent.
export function reconcile(committed, partial) {
    const text = typeof committed === 'string' ? committed.trim() : '';
    if (!partial) return text;
    if (!text) return partial;
    return words(text) < Math.ceil(words(partial) * 0.7) ? partial : text;
}

// apiUrl is injectable for fake-server tests only; never configurable in deployments.
export function createProvider({ env = process.env, apiUrl = endpoint } = {}) {
    const key = env.ELEVENLABS_API_KEY;
    const model = env.ELEVENLABS_MODEL ?? 'scribe_v2_realtime';
    if (typeof key !== 'string' || !key.trim()) throw failure('key_required');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) throw failure('invalid_config');
    // Pre-opened connections stay off by default: idle session billing is undocumented.
    const config = readConfig(env, 'ELEVENLABS_', { MAX_QUEUE_MS: 5000, SETUP_TIMEOUT_MS: 10000,
        RECONNECT_MS: 500, SPARE_MS: 0, MAX_STREAMS: 32 }, { SPARE_MS: 600000 }, failure);

    function connect(language, handlers) {
        const conn = { ready: false, closed: false, openedAt: Date.now(), readyAt: 0, handlers };
        // ISO 639-1 speaker language; VAD commits a segment after a pause.
        const query = new URLSearchParams({ model_id: model, audio_format: 'pcm_16000',
            commit_strategy: 'vad', language_code: language.split('-')[0].toLowerCase() });
        const ws = new WebSocket(`${apiUrl}?${query}`, { headers: { 'xi-api-key': key },
            perMessageDeflate: false, maxPayload: 1024 * 1024, handshakeTimeout: config.SETUP_TIMEOUT_MS });
        const setupTimer = setTimeout(() => fail('setup_timeout'), config.SETUP_TIMEOUT_MS);
        let partial = '';
        function stop() {
            if (conn.closed) return false;
            conn.closed = true; conn.ready = false; clearTimeout(setupTimer); ws.terminate();
            return true;
        }
        function fail(reason, cooldown = false) {
            if (stop()) conn.handlers.onFail?.(reason, cooldown);
        }
        function send(audio, commit) {
            if (conn.closed) return;
            const message = { message_type: 'input_audio_chunk', audio_base_64: audio.toString('base64'),
                commit, sample_rate: 16000 };
            try { ws.send(JSON.stringify(message), error => { if (error) fail('send_error'); }); }
            catch { fail('send_error'); }
        }
        ws.on('message', data => {
            if (conn.closed) return;
            let message;
            try { message = JSON.parse(data.toString()); } catch { fail('invalid_message'); return; }
            const type = message.message_type;
            if (type === 'session_started') {
                if (conn.ready) return;
                conn.ready = true; conn.readyAt = Date.now(); clearTimeout(setupTimer);
                conn.handlers.onReady?.();
            } else if (type === 'partial_transcript') {
                if (typeof message.text === 'string' && message.text.trim()) {
                    partial = message.text.trim(); conn.handlers.onInterim?.(partial);
                }
            } else if (type === 'committed_transcript') {
                // An empty commit still ends the segment; keep the shown words.
                const text = reconcile(message.text, partial);
                partial = '';
                conn.handlers.onFinal?.(text);
            } else if (type && type !== 'warning' && type !== 'commit_throttled' &&
                type !== 'insufficient_audio_activity' && !/^committed_transcript_|^edited_transcript$/.test(type)) {
                fail(/^[a-z_]{1,40}$/.test(type) ? type : 'api_error', cooldownTypes.has(type));
            }
        });
        ws.on('unexpected-response', (_request, response) => {
            response.destroy();
            fail(`http_${response.statusCode}`, [401, 402, 403, 429].includes(response.statusCode));
        });
        ws.on('error', () => fail('socket_error'));
        ws.on('close', code => fail(`closed_${code}`));
        Object.assign(conn, {
            bufferedAmount: () => ws.bufferedAmount,
            sendAudio(audio) { send(audio, false); },
            // Gateway idle: commit the open segment instead of waiting for server VAD.
            endAudio() { if (partial) send(Buffer.alloc(0), true); },
            close: stop
        });
        return conn;
    }

    return createStreamingProvider({ connect, failure, maxStreams: config.MAX_STREAMS,
        maxQueueMs: config.MAX_QUEUE_MS, reconnectMs: config.RECONNECT_MS, spareMs: config.SPARE_MS });
}
