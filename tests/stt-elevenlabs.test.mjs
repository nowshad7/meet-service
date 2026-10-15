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
// Fake Scribe v2 Realtime server; shapes follow PROVIDERS.md (verified 2026-10-15).
async function fixture(t, env = {}) {
    const { createProvider } = await import('../services/stt-gateway/elevenlabs.mjs');
    const key = randomBytes(24).toString('hex');
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const peers = [], messages = [], requests = [], results = [], events = [];
    server.on('connection', (ws, request) => {
        requests.push(request); peers.push(ws);
        const received = []; messages.push(received);
        ws.on('message', data => received.push(JSON.parse(data.toString())));
        ws.on('error', () => {});
    });
    const provider = createProvider({ env: { ELEVENLABS_API_KEY: key, ELEVENLABS_RECONNECT_MS: '10', ...env },
        apiUrl: `ws://127.0.0.1:${server.address().port}/v1/speech-to-text/realtime` });
    const open = (language = 'bn') => {
        const stream = provider.openStream({ sessionId: 'room', participantId: 'speaker', language, sampleRate: 16000,
            onResult: r => results.push([r.isFinal ? 'final' : 'interim', r.text]), onEvent: (n, f) => events.push([n, f]) });
        t.after(() => stream.close());
        return stream;
    };
    t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(r => server.close(r)); });
    return { provider, open, peers, messages, requests, results, events, key };
}
const say = (ws, message) => ws.send(JSON.stringify(message));

test('query, header key, session gating and unchanged PCM chunks', async t => {
    const { open, peers, messages, requests, key } = await fixture(t);
    const stream = open('bn-BD');
    await until(() => peers[0]);
    const url = new URL(requests[0].url, 'http://localhost');
    assert.deepEqual(Object.fromEntries(url.searchParams), { model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000',
        commit_strategy: 'vad', language_code: 'bn' });
    assert.equal(requests[0].headers['xi-api-key'], key);
    assert.ok(!requests[0].url.includes(key));
    const pcm = Buffer.from([1, 2, 3, 4]);
    stream.write(pcm);
    await delay(20); assert.equal(messages[0].length, 0);
    say(peers[0], { message_type: 'session_started', session_id: 'x' });
    await until(() => messages[0].length === 1);
    assert.deepEqual(messages[0][0], { message_type: 'input_audio_chunk', audio_base_64: pcm.toString('base64'),
        commit: false, sample_rate: 16000 });
});

test('partials stream through; a commit that drops most words keeps the shown partial', async t => {
    const { open, peers, results } = await fixture(t);
    open(); await until(() => peers[0]);
    say(peers[0], { message_type: 'session_started' });
    say(peers[0], { message_type: 'partial_transcript', text: 'এক দুই' });
    say(peers[0], { message_type: 'partial_transcript', text: 'এক দুই তিন চার পাঁচ' });
    say(peers[0], { message_type: 'committed_transcript', text: 'এক' });
    say(peers[0], { message_type: 'partial_transcript', text: 'ছয় সাত' });
    say(peers[0], { message_type: 'committed_transcript', text: 'ছয় সাত আট' });
    say(peers[0], { message_type: 'partial_transcript', text: 'নয়' });
    say(peers[0], { message_type: 'committed_transcript', text: '' });
    say(peers[0], { message_type: 'committed_transcript_with_timestamps', text: 'ignored' });
    await until(() => results.length === 7);
    assert.deepEqual(results, [['interim', 'এক দুই'], ['interim', 'এক দুই তিন চার পাঁচ'], ['final', 'এক দুই তিন চার পাঁচ'],
        ['interim', 'ছয় সাত'], ['final', 'ছয় সাত আট'], ['interim', 'নয়'], ['final', 'নয়']]);
});

test('reconcile keeps corrections that retain most words', async () => {
    const { reconcile } = await import('../services/stt-gateway/elevenlabs.mjs');
    assert.equal(reconcile('a b c d', 'a b x d e'), 'a b c d');
    assert.equal(reconcile('a', 'a b c d e'), 'a b c d e');
    assert.equal(reconcile('a b', ''), 'a b');
    assert.equal(reconcile(undefined, 'a'), 'a');
});

test('gateway idle commits an open segment only', async t => {
    const { open, peers, messages } = await fixture(t);
    const stream = open(); await until(() => peers[0]);
    say(peers[0], { message_type: 'session_started' });
    stream.endAudio(); await delay(30);
    assert.equal(messages[0].length, 0);
    say(peers[0], { message_type: 'partial_transcript', text: 'open' });
    await delay(20); stream.endAudio();
    await until(() => messages[0].length === 1);
    assert.deepEqual(messages[0][0], { message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 });
});

test('vendor errors reconnect, auth cools down; nothing is logged', async t => {
    const logs = [], originals = {};
    for (const name of ['error', 'warn', 'log', 'debug', 'info']) { originals[name] = console[name]; console[name] = (...a) => logs.push(a); }
    t.after(() => Object.assign(console, originals));
    const { open, peers, results, events, key } = await fixture(t);
    open(); await until(() => peers[0]);
    say(peers[0], { message_type: 'session_started' });
    say(peers[0], { message_type: 'partial_transcript', text: 'kept' });
    say(peers[0], { message_type: 'input_error', error: `bad ${key}` });
    await until(() => peers[1]);
    say(peers[1], { message_type: 'auth_error', error: key });
    await delay(80);
    assert.equal(peers.length, 2);
    assert.deepEqual(results, [['interim', 'kept'], ['final', 'kept']]);
    assert.deepEqual(logs, []);
    assert.deepEqual(events.filter(([n]) => n === 'provider_error').map(([, f]) => f),
        [{ reason: 'input_error', cooldown: 0 }, { reason: 'auth_error', cooldown: 1 }]);
});

test('pre-opened connections are opt-in', async t => {
    const off = await fixture(t);
    off.provider.prepare({ sessionId: 'room', language: 'bn' });
    await delay(30); assert.equal(off.peers.length, 0);
    const on = await fixture(t, { ELEVENLABS_SPARE_MS: '1000' });
    on.provider.prepare({ sessionId: 'room', language: 'bn' });
    await until(() => on.peers[0]);
    say(on.peers[0], { message_type: 'session_started' });
    await delay(20);
    on.open();
    await delay(20); assert.equal(on.peers.length, 1);
    on.provider.releaseSession({ sessionId: 'room' });
});

test('configuration fails with fixed errors', async () => {
    const { createProvider } = await import('../services/stt-gateway/elevenlabs.mjs');
    assert.throws(() => createProvider({ env: {} }), /key_required/);
    for (const settings of [{ ELEVENLABS_MODEL: '../x' }, { ELEVENLABS_MAX_QUEUE_MS: '0' }, { ELEVENLABS_SPARE_MS: '-1' }]) {
        assert.throws(() => createProvider({ env: { ELEVENLABS_API_KEY: 'test-only', ...settings } }), /invalid_config/);
    }
});
