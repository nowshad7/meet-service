import http from 'node:http';
import { randomUUID } from 'node:crypto';
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

export function createGateway(provider, options = {}) {
    const config = { windowMs: 3000, overlapMs: 500, idleMs: 1500, timeoutMs: 10000,
        maxQueue: 4, maxActiveCalls: 32, maxSpeakers: 100, maxConnections: 20, ...options };
    for (const [key, value] of Object.entries(config)) {
        if (!Number.isSafeInteger(value) || value < (key === 'overlapMs' ? 0 : 1)) throw new Error('invalid_config');
    }
    if (config.overlapMs >= config.windowMs || config.windowMs > 30000) throw new Error('invalid_window');
    let activeCalls = 0;
    let activeStreams = 0;
    const windowBytes = config.windowMs * 32;
    const overlapBytes = config.overlapMs * 32;
    const server = http.createServer((req, res) => {
        res.writeHead(req.url === '/health' ? 200 : 404).end();
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 60 + 32000 * 30, perMessageDeflate: false });
    server.on('upgrade', (req, socket, head) => {
        if (!/^\/streaming-whisper\/ws\/[^/?]+$/.test(req.url) || wss.clients.size >= config.maxConnections) {
            socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', ws => {
        const speakers = new Map();
        const sessionId = randomUUID();
        let closed = false;
        let ending = false;
        function send(participantId, result) {
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            if (typeof result.text !== 'string' || result.text.length > 16000 || typeof result.isFinal !== 'boolean' ||
                !Number.isFinite(result.variance ?? 0)) throw new Error('invalid_result');
            if (ws.bufferedAmount > 65536) return; // bounded slow caption consumer
            // A decimal is mandatory: Jigasi casts JSON-simple's variance to Double.
            const payload = JSON.stringify({ type: result.isFinal ? 'final' : 'interim',
                participant_id: participantId, text: result.text });
            ws.send(payload.slice(0, -1) + ',"variance":' + Number(result.variance ?? 0).toFixed(6) + '}');
        }
        function closeStream(s) {
            const stream = s.stream;
            if (!stream) return;
            s.stream = null; activeStreams--;
            try { stream.close(); } catch { /* discard provider errors */ }
        }
        function writeStream(s, audio) {
            if (!s.stream) {
                if (activeStreams >= config.maxActiveCalls) return;
                // openStream is synchronous; providers buffer bounded startup audio.
                let stream;
                try {
                    stream = provider.openStream({ sessionId, participantId: s.id,
                        language: s.language, sampleRate: 16000,
                        onResult(result) {
                            if (!closed && s.stream === stream) {
                                try { send(s.id, result); } catch { /* invalid provider result */ }
                            }
                        } });
                    if (!stream || !['write', 'endAudio', 'close'].every(k => typeof stream[k] === 'function')) {
                        stream?.close?.(); return;
                    }
                } catch { return; }
                s.stream = stream; activeStreams++;
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
            Promise.resolve().then(() => provider.transcribe({ ...job, sessionId, participantId: s.id,
                sampleRate: 16000, signal: controller.signal }))
                .then(results => {
                    if (!timedOut && !closed) for (const result of results) send(s.id, result);
                }).catch(() => { /* provider exceptions may contain transcripts/secrets; discard */ })
                .finally(() => { activeCalls--; clearTimeout(timeout); s.busy = false; s.controller = null; pump(s); });
        }
        function enqueue(s, audio, final, overlapSamples) {
            if (s.queue.length < config.maxQueue) s.queue.push({ audio, final, overlapSamples, language: s.language, sequence: s.sequence });
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
                    s = { id: frame.participantId, language: frame.language, buffer: Buffer.alloc(0),
                        prefix: 0, sequence: 0, queue: [], busy: false };
                    speakers.set(s.id, s);
                }
                if (s.language !== frame.language) { flush(s); closeStream(s); s.language = frame.language; }
                clearTimeout(s.idle);
                if (typeof provider.openStream === 'function') {
                    writeStream(s, frame.audio);
                    s.idle = setTimeout(() => flush(s), config.idleMs);
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
            } catch { ws.close(1003, 'invalid audio frame'); }
        });
        ws.on('error', () => {});
        ws.on('close', () => {
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
