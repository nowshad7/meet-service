import { WebSocket } from 'ws';
import { createStreamingProvider, readConfig } from './realtime.mjs';

// Gemini 3.5 Transcribe Live continuous provider. Unlike gemini-live.mjs this
// model rejects the AUDIO response modality (close 1007): it takes TEXT and
// reports the current utterance cumulatively in interimInputTranscription and
// the finished one in inputTranscription.
// No keys, URLs, audio, transcripts or vendor errors enter logs.
const endpoint = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export class TranscribeProviderError extends Error {
    constructor(code) { super(code); this.name = 'TranscribeProviderError'; this.code = code; }
}
const failure = code => new TranscribeProviderError(code);
// Speaker hint plus English for in-sentence switching; BCP-47 as the Live transcription docs ask.
const regions = { bn: 'bn-IN', en: 'en-US' };

export function languageCodes(language) {
    const base = language.split('-')[0].toLowerCase();
    return [...new Set([language.includes('-') ? language : regions[base] ?? language, 'en-US'])];
}

// apiUrl is injectable for fake-server tests only; never configurable in deployments.
export function createProvider({ env = process.env, apiUrl = endpoint } = {}) {
    const key = env.GEMINI_API_KEY;
    const model = env.GEMINI_TRANSCRIBE_MODEL ?? 'gemini-3.5-transcribe-live';
    if (typeof key !== 'string' || !key.trim()) throw failure('key_required');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) throw failure('invalid_config');
    // Live transcription sessions are limited to 10 minutes; rotate before that.
    const config = readConfig(env, 'GEMINI_TRANSCRIBE_', { MAX_QUEUE_MS: 5000, SETUP_TIMEOUT_MS: 10000,
        RECONNECT_MS: 500, SESSION_MS: 540000, DRAIN_MS: 2500, SPARE_MS: 540000, MAX_STREAMS: 32 },
    { SESSION_MS: 590000, SPARE_MS: 590000 }, failure);

    function connect(language, handlers) {
        const conn = { ready: false, closed: false, openedAt: Date.now(), readyAt: 0, handlers };
        const url = new URL(apiUrl); url.searchParams.set('key', key);
        const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 1024 * 1024,
            handshakeTimeout: config.SETUP_TIMEOUT_MS });
        const setupTimer = setTimeout(() => fail('setup_timeout'), config.SETUP_TIMEOUT_MS);
        function stop() {
            if (conn.closed) return false;
            conn.closed = true; conn.ready = false; clearTimeout(setupTimer); ws.terminate();
            return true;
        }
        function fail(reason, cooldown = false) {
            if (stop()) conn.handlers.onFail?.(reason, cooldown);
        }
        function send(message) {
            if (conn.closed) return;
            try { ws.send(JSON.stringify(message), error => { if (error) fail('send_error'); }); }
            catch { fail('send_error'); }
        }
        ws.on('open', () => {
            send({ setup: { model: `models/${model}`, generationConfig: { responseModalities: ['TEXT'] },
                inputAudioTranscription: { languageCodes: languageCodes(language) } } });
        });
        ws.on('message', data => {
            if (conn.closed) return;
            let message;
            try { message = JSON.parse(data.toString()); } catch { fail('invalid_message'); return; }
            if (message.error) { fail('api_error', [401, 403, 429].includes(message.error.code)); return; }
            if (message.setupComplete && !conn.ready) {
                conn.ready = true; conn.readyAt = Date.now(); clearTimeout(setupTimer);
                conn.handlers.onReady?.();
            }
            const content = message.serverContent;
            const partial = content?.interimInputTranscription?.text;
            if (typeof partial === 'string') conn.handlers.onInterim?.(partial);
            const final = content?.inputTranscription?.text;
            if (typeof final === 'string') conn.handlers.onFinal?.(final);
            // Model text output (modelTurn) is discarded, never stored or forwarded.
            if (message.goAway) conn.handlers.onRotate?.();
        });
        ws.on('unexpected-response', (_request, response) => {
            response.destroy();
            fail(`http_${response.statusCode}`, [401, 403, 429].includes(response.statusCode));
        });
        ws.on('error', () => fail('socket_error'));
        ws.on('close', code => fail(`closed_${code}`, [1007, 1008].includes(code)));
        Object.assign(conn, {
            bufferedAmount: () => ws.bufferedAmount,
            sendAudio(audio) {
                send({ realtimeInput: { audio: { data: audio.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
            },
            endAudio() { send({ realtimeInput: { audioStreamEnd: true } }); },
            close: stop
        });
        return conn;
    }

    return createStreamingProvider({ connect, failure, maxStreams: config.MAX_STREAMS,
        maxQueueMs: config.MAX_QUEUE_MS, reconnectMs: config.RECONNECT_MS, sessionMs: config.SESSION_MS,
        drainMs: config.DRAIN_MS, spareMs: config.SPARE_MS, renewSpares: true });
}
