import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from '../services/stt-gateway/node_modules/ws/wrapper.mjs';

async function until(check) {
    for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
    assert.fail('condition timed out');
}
async function fixture(t, env = {}) {
    const { createProvider } = await import('../services/stt-gateway/gemini-live.mjs');
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const peers = [], messages = [], results = [];
    server.on('connection', (ws, request) => {
        const received = []; messages.push(received); peers.push(ws);
        ws.on('message', data => received.push(JSON.parse(data.toString())));
        ws.on('error', () => {});
        assert.equal(new URL(request.url, 'http://localhost').searchParams.get('key'), key);
    });
    const key = randomBytes(24).toString('hex');
    const provider = createProvider({ env: { GEMINI_API_KEY: key, GEMINI_LIVE_RECONNECT_MS: '10',
        GEMINI_LIVE_FINAL_GRACE_MS: '20', ...env }, apiUrl: `ws://127.0.0.1:${server.address().port}` });
    const stream = provider.openStream({ sessionId: 'room', participantId: 'speaker', language: 'bn',
        sampleRate: 16000, onResult: r => results.push(r) });
    t.after(async () => { stream.close(); for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); });
    await until(() => messages[0]?.length);
    return { provider, stream, peers, messages, results, key };
}

test('Live setup gates exact PCM; word fragments accumulate, final waits for late transcription; output ignored', async t => {
    const { stream, peers, messages, results } = await fixture(t);
    const setup = messages[0][0].setup;
    assert.equal(setup.model, 'models/gemini-2.5-flash-native-audio-latest');
    assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
    assert.deepEqual(setup.inputAudioTranscription, {});
    assert.match(setup.systemInstruction.parts[0].text, /not reply/i);
    const pcm = Buffer.from([0xff, 0x7f, 0, 0x80]); stream.write(pcm);
    await delay(20); assert.equal(messages[0].length, 1);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[0].length === 2);
    assert.deepEqual(messages[0][1], { realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64') } } });
    peers[0].send(JSON.stringify({ serverContent: { inputTranscription: { text: 'সে' } } }));
    peers[0].send(JSON.stringify({ serverContent: { inputTranscription: { text: ' তো' }, modelTurn: { parts: [{ inlineData: { data: 'ignored' } }] } } }));
    await until(() => results.length === 2);
    assert.deepEqual(results.map(r => r.text), ['সে', 'সে তো']);
    peers[0].send(JSON.stringify({ serverContent: { turnComplete: true } }));
    peers[0].send(JSON.stringify({ serverContent: { inputTranscription: { text: ' এই' } } }));
    await until(() => results.some(r => r.isFinal));
    assert.deepEqual(results.at(-1), { text: 'সে তো এই', isFinal: true });
    stream.endAudio(); await until(() => messages[0].at(-1).realtimeInput?.audioStreamEnd);
});

test('GoAway resumes with handle; unsent audio survives setup; unexpected close reconnects', async t => {
    const { stream, peers, messages } = await fixture(t);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    peers[0].send(JSON.stringify({ sessionResumptionUpdate: { resumable: true, newHandle: 'opaque-handle' } }));
    peers[0].send(JSON.stringify({ goAway: { timeLeft: '10s' } }));
    await until(() => messages[1]?.length);
    assert.equal(messages[1][0].setup.sessionResumption.handle, 'opaque-handle');
    stream.write(Buffer.from([1, 2]));
    peers[1].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[1].length === 2);
    peers[1].terminate(); await until(() => messages[2]?.length);
});

test('bounded queue retains recent PCM during startup; close cancels retries', async t => {
    const { stream, peers, messages } = await fixture(t, { GEMINI_LIVE_MAX_QUEUE_MS: '100' });
    for (let i = 0; i < 10; i++) stream.write(Buffer.alloc(3200, i));
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[0].length > 1);
    await delay(30);
    const audio = messages[0].slice(1).filter(m => m.realtimeInput?.audio);
    assert.equal(audio.length, 1);
    assert.equal(Buffer.from(audio[0].realtimeInput.audio.data, 'base64')[0], 9);
    stream.close(); await delay(30); assert.equal(peers.length, 1);
});

test('malformed responses and auth close never log vendor errors or keys', async t => {
    const logs = [], originals = {};
    for (const name of ['error', 'warn', 'log', 'debug']) {
        originals[name] = console[name]; console[name] = (...args) => logs.push(args);
    }
    t.after(() => { Object.assign(console, originals); });
    const { peers, stream, messages, key } = await fixture(t);
    peers[0].send('invalid JSON secret transcript');
    await until(() => messages[1]?.length);
    peers[1].close(1008, `credential ${key} transcript must never be logged`);
    await delay(60); assert.equal(peers.length, 2); assert.deepEqual(logs, []);
    stream.write(Buffer.alloc(3200)); stream.close();
});

test('configuration fails with fixed errors and no credential echo', async () => {
    const { createProvider } = await import('../services/stt-gateway/gemini-live.mjs');
    assert.throws(() => createProvider({ env: {} }), /key_required/);
    for (const settings of [{ GEMINI_LIVE_MODEL: '../invalid' }, { GEMINI_LIVE_MAX_QUEUE_MS: 'NaN' }]) {
        assert.throws(() => createProvider({ env: { GEMINI_API_KEY: 'test-only', ...settings } }), /invalid_config/);
    }
});

test('a second utterance stays interim until its own API boundary', async t => {
    const { peers, results } = await fixture(t);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    peers[0].send(JSON.stringify({ serverContent: { inputTranscription: { text: 'first' }, turnComplete: true } }));
    await until(() => results.some(r => r.isFinal));
    peers[0].send(JSON.stringify({ serverContent: { inputTranscription: { text: 'second' } } }));
    await until(() => results.length === 3);
    await delay(40);
    assert.deepEqual(results.at(-1), { text: 'second', isFinal: false });
});

test('setup and first-token deadlines recover silently; queue survives', async t => {
    const { peers, stream, messages } = await fixture(t, { GEMINI_LIVE_SETUP_TIMEOUT_MS: '80', GEMINI_LIVE_STALL_MS: '40' });
    stream.write(Buffer.from([1, 2]));
    await until(() => messages[1]?.length);
    peers[1].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[1].length === 2);
    await until(() => messages[2]?.length);
});

test('rotation reconnects and per-provider stream cap releases on room cleanup', async t => {
    const { provider, peers, messages } = await fixture(t, { GEMINI_LIVE_SESSION_MS: '40', GEMINI_LIVE_MAX_STREAMS: '1' });
    const job = { sessionId: 'another', language: 'en', sampleRate: 16000, onResult() {} };
    assert.throws(() => provider.openStream(job), /stream_limit/);
    peers[0].send(JSON.stringify({ setupComplete: {} }));
    await until(() => messages[1]?.length);
    provider.releaseSession({ sessionId: 'room' });
    const next = provider.openStream(job); next.close();
});

test('quota cooldown prevents tight reconnects and errors do not emit captions', async t => {
    const { peers, messages, results } = await fixture(t);
    peers[0].send(JSON.stringify({ error: { code: 429, message: 'private vendor body' } }));
    await delay(60);
    assert.equal(messages.length, 1); assert.deepEqual(results, []);
});


test('HTTP authentication rejection cools down without logging the handshake URL', async t => {
    const { createProvider } = await import('../services/stt-gateway/gemini-live.mjs');
    let upgrades = 0;
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', verifyClient(_info, done) {
        upgrades++; done(false, 401, 'credential rejected');
    } });
    await once(server, 'listening');
    const provider = createProvider({ env: { GEMINI_API_KEY: randomBytes(24).toString('hex'), GEMINI_LIVE_RECONNECT_MS: '5' },
        apiUrl: `ws://127.0.0.1:${server.address().port}` });
    const stream = provider.openStream({ sessionId: 'auth', language: 'en', sampleRate: 16000, onResult() { assert.fail('auth must not emit captions'); } });
    t.after(async () => { stream.close(); await new Promise(r => server.close(r)); });
    await until(() => upgrades === 1);
    await delay(60); assert.equal(upgrades, 1);
});
