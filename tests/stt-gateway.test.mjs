import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from '../services/stt-gateway/node_modules/ws/wrapper.mjs';
import { createGateway, parseFrame } from '../services/stt-gateway/gateway.mjs';
import { createProvider } from './stt-fake-provider.mjs';

// Java ByteBuffer.allocate(60) zero fills; put(header.getBytes()), then put(audio).
// WhisperWebsocket.java:440-448 at e9a3acc139c14d4b512718fef08333416a8ec625.
function frame(id, lang, audio = Buffer.alloc(32000)) {
    const header = Buffer.alloc(60);
    header.write(`${id}|${lang}`);
    return Buffer.concat([header, audio]);
}
async function fixture(t, provider = createProvider(), options = {}) {
    const gateway = createGateway(provider, { windowMs: 1000, overlapMs: 250, idleMs: 100, ...options });
    gateway.server.listen(0, '127.0.0.1');
    await once(gateway.server, 'listening');
    t.after(() => gateway.close());
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/streaming-whisper/ws/jigasi-connection`);
    const messages = [];
    ws.on('message', data => messages.push(data.toString()));
    await once(ws, 'open');
    return { gateway, ws, messages };
}
async function until(check) {
    for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
    assert.fail('condition timed out');
}

test('source-built frame, EOF, and invalid framing', () => {
    const audio = Buffer.from([0xff, 0x7f, 0, 0x80]);
    assert.deepEqual(parseFrame(frame('speaker', 'bn', audio)), { participantId: 'speaker', language: 'bn', audio });
    assert.equal(parseFrame(Buffer.from([0])), null);
    for (const data of [Buffer.from([1]), Buffer.alloc(60), frame('x', 'en', Buffer.alloc(1)), frame('x', '')]) {
        assert.throws(() => parseFrame(data));
    }
});

test('real WebSocket multiplexes languages and uses Jigasi interim/final decimal variance', async t => {
    const { ws, messages } = await fixture(t);
    ws.send(frame('bangla', 'bn')); ws.send(frame('english', 'en'));
    ws.send(frame('bangla', 'bn', Buffer.alloc(16000)));
    ws.send(Buffer.from([0]));
    await until(() => messages.length === 4);
    const results = messages.map(x => JSON.parse(x));
    assert.deepEqual(results.map(x => [x.participant_id, x.type, x.text]), [
        ['bangla', 'interim', 'bangla:bn'], ['english', 'interim', 'english:en'], ['bangla', 'final', 'bangla:bn'], ['english', 'final', 'english:en']
    ]);
    assert.ok(messages.every(x => /"variance":0\.500000/.test(x)));
});

test('window stride, exact PCM and overlap metadata; idle finalizes overlap-only tail', async t => {
    const calls = [];
    const provider = { async transcribe(job) { calls.push(job); return []; } };
    const { ws } = await fixture(t, provider);
    const audio = Buffer.alloc(56000);
    for (let i = 0; i < audio.length; i++) audio[i] = i % 251;
    ws.send(frame('a', 'bn', audio));
    await until(() => calls.length === 2);
    await delay(140);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].audio, audio.subarray(0, 32000));
    assert.deepEqual(calls[1].audio, audio.subarray(24000, 56000));
    assert.deepEqual(calls.slice(0, 2).map(c => [c.overlapSamples, c.final, c.sampleRate]), [[0, false, 16000], [4000, false, 16000]]);
    assert.equal(calls[2].overlapSamples, calls[2].audio.length / 2);
    assert.equal(calls[2].final, true);
    ws.send(frame('a', 'bn', Buffer.alloc(1000)));
    await until(() => calls.length === 4);
    assert.equal(calls[3].final, true);
    assert.equal(calls[3].audio.length, 1000); // idle reset already cleared prior overlap
});

test('language changes snapshot queued jobs and flush the previous language', async t => {
    const calls = [];
    const { ws } = await fixture(t, { async transcribe(job) { calls.push(job); await delay(20); return []; } });
    ws.send(frame('a', 'bn', Buffer.alloc(1000))); ws.send(frame('a', 'en', Buffer.alloc(1000)));
    ws.send(Buffer.from([0]));
    await until(() => calls.length === 2);
    assert.deepEqual(calls.map(c => [c.language, c.final]), [['bn', true], ['en', true]]);
});

test('provider errors do not close socket or leak contents; another speaker continues', async t => {
    const { ws, messages } = await fixture(t, { async transcribe(job) {
        if (job.participantId === 'bad') throw new Error('secret transcript');
        return [{ text: 'ok', isFinal: true }];
    } });
    ws.send(frame('bad', 'bn')); ws.send(frame('good', 'en'));
    await until(() => messages.length === 1);
    assert.equal(JSON.parse(messages[0]).participant_id, 'good');
    assert.equal(ws.readyState, WebSocket.OPEN);
});

test('slow provider aborts, queue is bounded, late results discarded, other speaker progresses', async t => {
    const calls = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { ws, messages } = await fixture(t, { async transcribe(job) {
        calls.push(job);
        if (job.participantId === 'slow') await held;
        return [{ text: 'ok', isFinal: true }];
    } }, { timeoutMs: 20, maxQueue: 1, idleMs: 5000 });
    for (let i = 0; i < 8; i++) ws.send(frame('slow', 'bn'));
    ws.send(frame('fast', 'en'));
    await until(() => calls.length === 2 && calls[0].signal.aborted);
    assert.equal(messages.length, 1);
    release();
    await until(() => calls.length === 3);
    await delay(20);
    assert.equal(calls.filter(c => c.participantId === 'slow').length, 2);
    assert.equal(messages.length, 2); // timed-out call did not emit
});

test('disconnect aborts provider and discards queued audio', async t => {
    let signal;
    const { ws } = await fixture(t, { transcribe(job) { signal = job.signal; return new Promise(() => {}); } }, { timeoutMs: 50 });
    ws.send(frame('a', 'en')); await until(() => signal);
    ws.terminate(); await until(() => signal.aborted);
});

test('bad binary/text frames close only the offending connection and config is validated', async t => {
    const { ws } = await fixture(t);
    const close = once(ws, 'close'); ws.send('text');
    assert.equal((await close)[0], 1003);
    assert.throws(() => createGateway(createProvider(), { overlapMs: 3000 }));
    assert.throws(() => createGateway(createProvider(), { timeoutMs: NaN }));
});

test('uncancellable calls retain a global slot across disconnects; session state releases separately', async t => {
    const calls = [];
    const released = [];
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { ws, gateway } = await fixture(t, {
        async transcribe(job) { calls.push(job); await held; return []; },
        releaseSession(job) { released.push(job.sessionId); }
    }, { maxActiveCalls: 1, timeoutMs: 20 });
    ws.send(frame('same', 'bn')); await until(() => calls.length === 1);
    ws.terminate(); await until(() => released.length === 1);
    assert.equal(released[0], calls[0].sessionId);
    const next = new WebSocket(`ws://127.0.0.1:${gateway.server.address().port}/streaming-whisper/ws/reconnect`);
    await once(next, 'open'); next.send(frame('same', 'en'));
    await delay(30); assert.equal(calls.length, 1);
    release(); await delay(10);
    next.send(frame('same', 'en')); await until(() => calls.length === 2);
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);
});

test('continuous provider receives small PCM frames immediately and callbacks keep Jigasi utterances', async t => {
    const writes = [], ended = [], closed = [];
    let emit;
    const { ws, messages } = await fixture(t, { openStream(job) {
        emit = job.onResult;
        return { write(audio) { writes.push(audio); }, endAudio() { ended.push(true); }, close() { closed.push(true); } };
    } });
    const pcm = Buffer.from([1, 2, 3, 4]);
    ws.send(frame('a', 'bn', pcm));
    await until(() => writes.length === 1);
    assert.deepEqual(writes[0], pcm);
    emit({ text: 'সে', isFinal: false }); emit({ text: 'সে তো', isFinal: false });
    emit({ text: 'সে তো', isFinal: true });
    await until(() => messages.length === 3);
    assert.deepEqual(messages.map(x => JSON.parse(x).type), ['interim', 'interim', 'final']);
    await until(() => ended.length === 1);
    ws.terminate(); await until(() => closed.length === 1);
    emit({ text: 'late', isFinal: true }); assert.equal(messages.length, 3);
});
