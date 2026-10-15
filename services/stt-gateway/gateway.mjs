import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// Wire sources and line citations: see PROTOCOL.md. No audio/text enters logs.
export function parseFrame(data) {
    if (data.length === 1 && data[0] === 0) return null;
    if (data.length <= 60 || (data.length - 60) % 2) throw new Error('invalid_frame');
    const header = data.subarray(0, 60).toString('utf8').replace(/\0+$/, '').trimEnd();
    const parts = header.split('|');
    if (parts.length !== 2 || !parts[0] || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*$/.test(parts[1])) {
        throw new Error('invalid_header');
    }
    return { participantId: parts[0], language: parts[1], audio: data.subarray(60) };
}

// Timing log line: fixed event names, numbers and short tokens only, never
// audio, caption text, keys or tokens. Participant IDs are hashed.
const token = /^[a-zA-Z0-9_.:-]{1,64}$/;
export function formatEvent(name, fields = {}) {
    let line = `stt-gateway event=${token.test(name) ? name : 'invalid'}`;
    for (const [key, value] of Object.entries(fields)) {
        if (!/^[a-z_]{1,32}$/.test(key)) continue;
        if (typeof value === 'number' && Number.isFinite(value)) line += ` ${key}=${Math.round(value)}`;
        else if (typeof value === 'string' && token.test(value)) line += ` ${key}=${value}`;
    }
    return line;
}
const shortId = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

export function createGateway(provider, options = {}) {
    const { log = () => {}, prewarmLanguage = '', ...settings } = options;
    // Streaming providers end an utterance sooner after a pause than a batch window needs.
    const config = { windowMs: 3000, overlapMs: 500, idleMs: 1500, streamIdleMs: 700, timeoutMs: 10000,
        maxQueue: 4, maxActiveCalls: 32, maxSpeakers: 100, maxConnections: 20, ...settings };
    for (const [key, value] of Object.entries(config)) {
        if (!Number.isSafeInteger(value) || value < (key === 'overlapMs' ? 0 : 1)) throw new Error('invalid_config');
    }
    if (config.overlapMs >= config.windowMs || config.windowMs > 30000) throw new Error('invalid_window');
    if (typeof prewarmLanguage !== 'string' || (prewarmLanguage && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*$/.test(prewarmLanguage))) {
        throw new Error('invalid_config');
    }
    function event(name, fields) {
        try { log(formatEvent(name, fields)); } catch { /* logging must not affect captions */ }
    }
    let activeCalls = 0;
    let activeStreams = 0;
    // A room's first speaker usually talks in the language the last room used.
    let lastLanguage = prewarmLanguage;
    function prepare(sessionId, language) {
        if (!language || typeof provider.prepare !== 'function') return;
        try { provider.prepare({ sessionId, language }); } catch { /* optional warm-up */ }
    }
    const windowBytes = config.windowMs * 32;
    const overlapBytes = config.overlapMs * 32;
    const server = http.createServer((req, res) => {
        res.writeHead(req.url === '/health' ? 200 : 404).end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 60 + 32000 * 30, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
        if (!/^\/streaming-whisper\/ws\/[^/?]+$/.test(req.url) || wss.clients.size >= config.maxConnections) {
            event('room_refused', { connections: wss.clients.size });
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', ws => {
        const speakers = new Map();
        const sessionId = randomUUID();
        const room = sessionId.slice(0, 8);
        const openedAt = Date.now();
        let closed = false;
        let ending = false;
        event('room_open', { room, connections: wss.clients.size });
        // Jigasi connects when the transcriber joins, before anyone speaks.
        prepare(sessionId, lastLanguage);
        function send(participantId, result) {
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            if (typeof result.text !== 'string' || result.text.length > 16000 || typeof result.isFinal !== 'boolean' ||
                !Number.isFinite(result.variance ?? 0)) throw new Error('invalid_result');
            if (ws.bufferedAmount > 65536) return; // bounded slow caption consumer
            const s = speakers.get(participantId);
            if (s) {
                s.results++;
                if (!s.firstResultAt) {
                    s.firstResultAt = Date.now();
                    event('first_result', { room, speaker: s.tag, ms: s.firstResultAt - s.firstAudioAt,
                        type: result.isFinal ? 'final' : 'interim' });
                }
            }
            // A decimal is mandatory: Jigasi casts JSON-simple's variance to Double.
            const payload = JSON.stringify({ type: result.isFinal ? 'final' : 'interim',
                participant_id: participantId, text: result.text });
            ws.send(payload.slice(0, -1) + ',"variance":' + Number(result.variance ?? 0).toFixed(6) + '}');
        }
        function closeStream(s) {
            const stream = s.stream;
            if (!stream) return;
            s.stream = null; activeStreams--;
            event('stream_close', { room, speaker: s.tag, seconds: (Date.now() - s.streamAt) / 1000,
                audio_ms: s.audioBytes / 32, results: s.results });
            try { stream.close(); } catch { /* discard provider errors */ }
        }
        function writeStream(s, audio) {
            if (!s.stream) {
                if (activeStreams >= config.maxActiveCalls) {
                    if (!s.limitLogged) { s.limitLogged = true; event('stream_limit', { room, speaker: s.tag }); }
                    return;
                }
                // openStream is synchronous; providers buffer bounded startup audio.
                let stream;
                try {
                    stream = provider.openStream({ sessionId, participantId: s.id,
                        language: s.language, sampleRate: 16000,
                        onResult(result) {
                            if (!closed && s.stream === stream) {
                                try { send(s.id, result); } catch { /* invalid provider result */ }
                            }
                        },
                        onEvent(name, fields) {
                            if (!closed) event(name, { ...fields, room, speaker: s.tag });
                        } });
                    if (!stream || !['write', 'endAudio', 'close'].every(k => typeof stream[k] === 'function')) {
                        stream?.close?.(); event('stream_failed', { room, speaker: s.tag }); return;
                    }
                } catch (error) {
                    event('stream_failed', { room, speaker: s.tag, reason: typeof error?.code === 'string' ? error.code : 'error' });
                    return;
                }
                s.stream = stream; activeStreams++; s.streamAt = Date.now();
                event('stream_open', { room, speaker: s.tag, language: s.language, streams: activeStreams });
                // Keep one connection ready for the room's next new speaker.
                prepare(sessionId, s.language);
            }
            try { s.stream.write(audio); } catch { closeStream(s); }
        }
        function pump(s) {
            if (closed || s.busy || !s.queue.length) return;
            if (activeCalls >= config.maxActiveCalls) { s.queue = []; return; }
            activeCalls++;
            s.busy = true;
            const job = s.queue.shift();
            const controller = new AbortController();
            s.controller = controller;
            let timedOut = false;
            const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
            // Keep this speaker occupied until the provider settles, even if it ignores abort.
            const started = Date.now();
            Promise.resolve().then(() => provider.transcribe({ ...job, sessionId, participantId: s.id,
                sampleRate: 16000, signal: controller.signal }))
                .then(results => {
                    if (!timedOut && !closed) for (const result of results) send(s.id, result);
                    else if (timedOut) event('call_timeout', { room, speaker: s.tag, ms: Date.now() - started });
                }).catch(() => {
                    // Provider exceptions may contain transcripts/secrets; log only that one failed.
                    event(timedOut ? 'call_timeout' : 'call_failed', { room, speaker: s.tag, ms: Date.now() - started });
                })
                .finally(() => { activeCalls--; clearTimeout(timeout); s.busy = false; s.controller = null; pump(s); });
        }
        function enqueue(s, audio, final, overlapSamples) {
            if (s.queue.length < config.maxQueue) s.queue.push({ audio, final, overlapSamples, language: s.language, sequence: s.sequence });
            else event('window_dropped', { room, speaker: s.tag, sequence: s.sequence });
            s.sequence++;
            pump(s);
        }
        function flush(s) {
            clearTimeout(s.idle);
            if (s.stream) {
                try { s.stream.endAudio(); } catch { closeStream(s); }
            } else if (s.pending) enqueue(s, s.buffer, true, s.prefix / 2);
            s.buffer = Buffer.alloc(0); s.prefix = 0; s.pending = false;
        }
        ws.on('message', (data, binary) => {
            if (ending) return;
            try {
                if (!binary) throw new Error('binary_required');
                const frame = parseFrame(data);
                if (!frame) { ending = true; for (const s of speakers.values()) flush(s); return; }
                let s = speakers.get(frame.participantId);
                if (!s) {
                    if (speakers.size >= config.maxSpeakers) throw new Error('speaker_limit');
                    s = { id: frame.participantId, tag: shortId(frame.participantId), language: frame.language,
                        buffer: Buffer.alloc(0), prefix: 0, sequence: 0, queue: [], busy: false,
                        firstAudioAt: Date.now(), firstResultAt: 0, results: 0, audioBytes: 0 };
                    speakers.set(s.id, s);
                    lastLanguage = frame.language;
                    event('first_audio', { room, speaker: s.tag, language: s.language, ms: s.firstAudioAt - openedAt });
                }
                s.audioBytes += frame.audio.length;
                if (s.language !== frame.language) {
                    flush(s); closeStream(s); s.language = frame.language; lastLanguage = frame.language;
                    s.firstAudioAt = Date.now(); s.firstResultAt = 0;
                }
                clearTimeout(s.idle);
                if (typeof provider.openStream === 'function') {
                    writeStream(s, frame.audio);
                    s.idle = setTimeout(() => flush(s), config.streamIdleMs);
                    return;
                }
                s.buffer = Buffer.concat([s.buffer, frame.audio]);
                s.pending = true;
                while (s.buffer.length >= windowBytes) {
                    enqueue(s, Buffer.from(s.buffer.subarray(0, windowBytes)), false, s.prefix / 2);
                    s.buffer = Buffer.from(s.buffer.subarray(windowBytes - overlapBytes));
                    s.prefix = overlapBytes;
                }
                s.idle = setTimeout(() => flush(s), config.idleMs);
            } catch (error) {
                event('room_rejected', { room, reason: /^[a-z_]{1,32}$/.test(error?.message) ? error.message : 'error' });
                ws.close(1003, 'invalid audio frame');
            }
        });
        ws.on('error', () => {});
        ws.on('close', code => {
            event('room_close', { room, code, seconds: (Date.now() - openedAt) / 1000, speakers: speakers.size });
            for (const s of speakers.values()) if (s.stream) closeStream(s);
            closed = true;
            for (const s of speakers.values()) {
                clearTimeout(s.idle); closeStream(s); s.controller?.abort(); s.queue = []; s.buffer = Buffer.alloc(0);
            }
            speakers.clear();
            Promise.resolve().then(() => provider.releaseSession?.({ sessionId })).catch(() => {});
        });
    });
    return { server, wss, async close() {
        for (const ws of wss.clients) ws.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    } };
}
