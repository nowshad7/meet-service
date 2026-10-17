import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from '../services/stt-gateway/node_modules/ws/wrapper.mjs';

async function until(check) {
    for (let i = 0; i < 400; i++) { if (check()) return; await delay(5); }
    assert.fail('condition timed out');
}
// Fake BidiGenerateContent server; shapes follow PROVIDERS.md (v1beta, verified 2026-10-15).
async function fixture(t, env = {}) {
    const { createProvider } = await import('../services/stt-gateway/gemini-transcribe-live.mjs');
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const key = randomBytes(24).toString('hex');
    const peers = [], messages = [], results = [], events = [];
    server.on('connection', (ws, request) => {
        assert.equal(new URL(request.url, 'http://localhost').searchParams.get('key'), key);
        const received = []; messages.push(received); peers.push(ws);
        ws.on('message', data => received.push(JSON.parse(data.toString())));
        ws.on('error', () => {});
    });
    const provider = createProvider({ env: { GEMINI_API_KEY: key, GEMINI_TRANSCRIBE_RECONNECT_MS: '10',
        GEMINI_TRANSCRIBE_DRAIN_MS: '200', ...env }, apiUrl: `ws://127.0.0.1:${server.address().port}` });
    const open = (sessionId = 'room', language = 'bn') => {
        const stream = provider.openStream({ sessionId, participantId: 'speaker', language, sampleRate: 16000,
            onResult: r => results.push([r.isFinal ? 'final' : 'interim', r.text]), onEvent: (n, f) => events.push([n, f]) });
        t.after(() => stream.close());
        return stream;
    };
    t.after(async () => { provider.releaseSession({ sessionId: 'room' }); for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); });
    return { provider, open, peers, messages, results, events, key };
}
const audioOf = m => m.realtimeInput?.audio && Buffer.from(m.realtimeInput.audio.data, 'base64');

test('setup asks for TEXT with Bangla+English codes; PCM waits for setupComplete and is sent unchanged', async t => {
    const { open, peers, messages } = await fixture(t);
    const stream = open();
    await until(() => messages[0]?.length);
    assert.deepEqual(messages[0][0], { setup: { model: 'models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] }, inputAudioTranscription: { languageCodes: ['bn-IN', 'en-US'] } } });
    const pcm = Buffer.from([0xff, 0x7f, 0, 0x80]);
    stream.write(pcm);
    await delay(20); assert.equal(messages[0].length, 1);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[0].length === 2);
    assert.equal(messages[0][1].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
    assert.deepEqual(audioOf(messages[0][1]), pcm);
    stream.endAudio();
    await until(() => messages[0].at(-1).realtimeInput?.audioStreamEnd === true);
});

test('cumulative interims go straight through; inputTranscription finalizes; model text is ignored', async t => {
    const { open, peers, results } = await fixture(t);
    open(); await until(() => peers[0]);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    peers[0].send(JSON.stringify({ serverContent: { interimInputTranscription: { text: 'আমার' } } }));
    peers[0].send(JSON.stringify({ serverContent: { interimInputTranscription: { text: 'আমার সোনার' },
        modelTurn: { parts: [{ text: 'never forwarded' }] } } }));
    peers[0].send(JSON.stringify({ serverContent: { inputTranscription: { text: 'আমার সোনার বাংলা' } } }));
    await until(() => results.length === 3);
    assert.deepEqual(results, [['interim', 'আমার'], ['interim', 'আমার সোনার'], ['final', 'আমার সোনার বাংলা']]);
});

test('English speakers get en-US only; region tags pass through', async t => {
    const { open, messages } = await fixture(t);
    open('room', 'en'); open('room2', 'bn-BD');
    await until(() => messages.length === 2 && messages.every(m => m.length));
    const codes = messages.map(m => m[0].setup.inputAudioTranscription.languageCodes).sort();
    assert.deepEqual(codes, [['bn-BD', 'en-US'], ['en-US']]);
});

test('GoAway rotation overlaps on real sockets: no audio dropped, old utterance finishes first', async t => {
    const { open, peers, messages, results } = await fixture(t);
    const stream = open(); await until(() => peers[0]);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    peers[0].send(JSON.stringify({ serverContent: { interimInputTranscription: { text: 'old' } } }));
    await until(() => results.length === 1);
    peers[0].send(JSON.stringify({ goAway: { timeLeft: '10s' } }));
    await until(() => messages[1]?.length);
    stream.write(Buffer.alloc(3200, 1));
    await until(() => messages[0].some(m => audioOf(m)?.[0] === 1));
    peers[1].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[0].at(-1).realtimeInput?.audioStreamEnd);
    stream.write(Buffer.alloc(3200, 2));
    await until(() => messages[1].some(m => audioOf(m)?.[0] === 2));
    assert.ok(!messages[0].some(m => audioOf(m)?.[0] === 2), 'new audio goes only to the new session');
    peers[1].send(JSON.stringify({ serverContent: { interimInputTranscription: { text: 'new' } } }));
    await delay(20);
    peers[0].send(JSON.stringify({ serverContent: { inputTranscription: { text: 'old done' } } }));
    await until(() => results.length === 3);
    assert.deepEqual(results, [['interim', 'old'], ['final', 'old done'], ['interim', 'new']]);
});

test('scheduled rotation fires before the session limit', async t => {
    const { open, peers, messages } = await fixture(t, { GEMINI_TRANSCRIBE_SESSION_MS: '50' });
    open(); await until(() => peers[0]);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[1]?.length);
});

test('prepare opens the connection before audio; the first speaker adopts it without a new handshake', async t => {
    const { provider, open, peers, messages, events } = await fixture(t);
    provider.prepare({ sessionId: 'room', language: 'bn' });
    await until(() => messages[0]?.length);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    await delay(20);
    const stream = open();
    stream.write(Buffer.alloc(3200, 3));
    await until(() => messages[0].some(m => audioOf(m)?.[0] === 3));
    assert.equal(peers.length, 1);
    assert.deepEqual(events.find(([n]) => n === 'provider_ready')[1], { ms: 0, warm: 1, rotation: 0 });
});

test('auth rejection cools down; errors, URLs and keys never reach logs or captions', async t => {
    const logs = [], originals = {};
    for (const name of ['error', 'warn', 'log', 'debug', 'info']) { originals[name] = console[name]; console[name] = (...a) => logs.push(a); }
    t.after(() => Object.assign(console, originals));
    const { open, peers, messages, results, events, key } = await fixture(t);
    open(); await until(() => peers[0]);
    peers[0].send('not json ' + key);
    await until(() => messages[1]?.length);
    peers[1].send(JSON.stringify({ error: { code: 401, message: `bad key ${key}` } }));
    await delay(80);
    assert.equal(peers.length, 2);
    assert.deepEqual(results, []); assert.deepEqual(logs, []);
    assert.ok(!JSON.stringify(events).includes(key));
    assert.deepEqual(events.filter(([n]) => n === 'provider_error').map(([, f]) => f),
        [{ reason: 'invalid_message', cooldown: 0 }, { reason: 'api_error', cooldown: 1 }]);
});

test('configuration fails with fixed errors', async () => {
    const { createProvider } = await import('../services/stt-gateway/gemini-transcribe-live.mjs');
    assert.throws(() => createProvider({ env: {} }), /key_required/);
    for (const settings of [{ GEMINI_TRANSCRIBE_MODEL: '../x' }, { GEMINI_TRANSCRIBE_SESSION_MS: '600000' },
        { GEMINI_TRANSCRIBE_DRAIN_MS: '0' }, { GEMINI_TRANSCRIBE_MAX_STREAMS: 'NaN' }]) {
        assert.throws(() => createProvider({ env: { GEMINI_API_KEY: 'test-only', ...settings } }), /invalid_config/);
    }
});
