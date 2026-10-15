import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createStreamingProvider } from '../services/stt-gateway/realtime.mjs';

// Fake vendor connections: tests drive readiness and results by hand.
function harness(t, options = {}) {
    const conns = [];
    function connect(language, handlers) {
        const conn = { language, handlers, ready: false, closed: false, openedAt: Date.now(), readyAt: 0,
            audio: [], ends: 0, buffered: 0 };
        Object.assign(conn, {
            bufferedAmount: () => conn.buffered,
            sendAudio(audio) { conn.audio.push(audio[0]); },
            endAudio() { conn.ends++; },
            close() { conn.closed = true; conn.ready = false; },
            up() { conn.ready = true; conn.readyAt = Date.now(); conn.handlers.onReady?.(); },
            interim(text) { conn.handlers.onInterim?.(text); },
            final(text) { conn.handlers.onFinal?.(text); },
            fail(reason = 'closed_1006', cooldown = false) { conn.closed = true; conn.handlers.onFail?.(reason, cooldown); }
        });
        conns.push(conn);
        return conn;
    }
    const provider = createStreamingProvider({ connect, failure: code => new Error(code), maxStreams: 4,
        maxQueueMs: 1000, reconnectMs: 5, drainMs: 60, ...options });
    const results = [], events = [];
    const open = (sessionId = 'room', language = 'bn') => {
        const stream = provider.openStream({ sessionId, language, sampleRate: 16000,
            onResult: r => results.push([r.isFinal ? 'final' : 'interim', r.text]),
            onEvent: (name, fields) => events.push([name, fields]) });
        t.after(() => stream.close());
        return stream;
    };
    return { provider, conns, results, events, open };
}
const chunk = n => Buffer.alloc(3200, n);

test('audio queues until setup, then flows unchanged in 100 ms chunks; idle end waits for the queue', async t => {
    const { conns, open } = harness(t);
    const stream = open();
    stream.write(Buffer.concat([chunk(1), chunk(2), chunk(3).subarray(0, 1600)]));
    stream.endAudio();
    assert.equal(conns.length, 1); assert.deepEqual(conns[0].audio, []);
    conns[0].up();
    assert.deepEqual(conns[0].audio, [1, 2, 3]);
    assert.equal(conns[0].ends, 1);
});

test('every interim is forwarded at once; final commits; empty final commits the shown words', t => {
    const { conns, results, open } = harness(t);
    open(); conns[0].up();
    conns[0].interim('এক'); conns[0].interim('এক দুই'); conns[0].interim('এক দুই');
    conns[0].final('এক দুই তিন');
    conns[0].interim('চার'); conns[0].final('');
    assert.deepEqual(results, [['interim', 'এক'], ['interim', 'এক দুই'], ['final', 'এক দুই তিন'],
        ['interim', 'চার'], ['final', 'চার']]);
});

test('rotation overlaps: old session keeps audio until the new one is ready, then finishes its utterance first', async t => {
    const { conns, results, events, open } = harness(t, { sessionMs: 30, drainMs: 1000 });
    const stream = open();
    conns[0].up();
    conns[0].interim('old words');
    await delay(50);
    assert.equal(conns.length, 2, 'next session opened before the limit');
    stream.write(chunk(7));
    assert.deepEqual(conns[0].audio, [7], 'audio stays on the old session while the new one sets up');
    conns[1].up();
    assert.equal(conns[0].ends, 1, 'old session told the audio ended');
    stream.write(chunk(8));
    assert.deepEqual(conns[1].audio, [8]);
    conns[1].interim('new');                      // waits behind the old utterance
    conns[0].interim('old words more');           // late words from audio already sent
    conns[0].final('old words more done');
    assert.ok(conns[0].closed);
    assert.deepEqual(results, [['interim', 'old words'], ['interim', 'old words more'],
        ['final', 'old words more done'], ['interim', 'new']]);
    assert.ok(events.some(([name]) => name === 'provider_rotate'));
    assert.ok(events.some(([name]) => name === 'provider_switched'));
});

test('vendor GoAway rotates; drain timeout commits the old caption; a silent old session hands over at once', async t => {
    const { conns, results, open } = harness(t, { drainMs: 30 });
    open(); conns[0].up(); conns[0].interim('left over');
    conns[0].handlers.onRotate();
    assert.equal(conns.length, 2);
    conns[1].up();
    conns[1].interim('next');
    assert.deepEqual(results, [['interim', 'left over']]);
    await delay(60);
    assert.deepEqual(results, [['interim', 'left over'], ['final', 'left over'], ['interim', 'next']]);
    assert.ok(conns[0].closed);
    conns[1].final('next');
    conns[1].handlers.onRotate(); conns[2].up();
    conns[2].interim('fresh');
    assert.deepEqual(results.at(-1), ['interim', 'fresh']);
    assert.ok(conns[1].closed);
});

test('a failed session commits its caption, keeps unsent audio and reconnects with backoff', async t => {
    const { conns, results, events, open } = harness(t);
    const stream = open(); conns[0].up();
    conns[0].interim('half');
    conns[0].fail();
    stream.write(chunk(4));
    assert.deepEqual(results, [['interim', 'half'], ['final', 'half']]);
    await delay(30);
    assert.equal(conns.length, 2);
    conns[1].up();
    assert.deepEqual(conns[1].audio, [4]);
    assert.deepEqual(events.find(([name]) => name === 'provider_error')[1], { reason: 'closed_1006', cooldown: 0 });
    conns[1].fail('http_401', true);
    await delay(30);
    assert.equal(conns.length, 2, 'auth failure cools down instead of retrying at once');
});

test('prepared spare is adopted by the first speaker: no new connection, no setup wait', async t => {
    const { provider, conns, events, open } = harness(t, { spareMs: 1000 });
    provider.prepare({ sessionId: 'room', language: 'bn' });
    assert.equal(conns.length, 1);
    conns[0].up();
    const stream = open('room', 'bn');
    stream.write(chunk(5));
    assert.equal(conns.length, 1);
    await delay(1);
    assert.deepEqual(conns[0].audio, [5]);
    assert.deepEqual(events[0], ['provider_ready', { ms: 0, warm: 1, rotation: 0 }]);
    provider.prepare({ sessionId: 'other', language: 'en' });
    open('other', 'bn'); // language mismatch: spare not used
    assert.equal(conns.length, 3);
    provider.releaseSession({ sessionId: 'other' });
    assert.ok(conns[1].closed && conns[2].closed);
});

test('spares expire before the session limit, renew when asked, and are off by default', async t => {
    const renewing = harness(t, { spareMs: 20, renewSpares: true });
    renewing.provider.prepare({ sessionId: 'room', language: 'bn' });
    await delay(50);
    assert.ok(renewing.conns.length >= 2 && renewing.conns[0].closed);
    renewing.provider.releaseSession({ sessionId: 'room' });
    assert.ok(renewing.conns.every(c => c.closed));
    const off = harness(t);
    off.provider.prepare({ sessionId: 'room', language: 'bn' });
    assert.equal(off.conns.length, 0);
});

test('stream cap counts spares; invalid input is refused with fixed errors', t => {
    const { provider, conns, open } = harness(t, { spareMs: 1000 });
    provider.prepare({ sessionId: 'spare', language: 'bn' });
    const streams = [];
    for (let i = 0; i < 3; i++) streams.push(open(`s${i}`));
    assert.equal(conns.length, 4);
    streams.push(open('s3'));
    assert.ok(conns[0].closed, 'at the cap a speaker evicts another room\'s spare');
    assert.throws(() => open('s5'), /stream_limit/);
    assert.throws(() => provider.openStream({ sessionId: 'x', language: '../x', sampleRate: 16000, onResult() {} }), /invalid_audio/);
    const stream = streams[0];
    assert.throws(() => stream.write(Buffer.alloc(3)), /invalid_audio/);
});
