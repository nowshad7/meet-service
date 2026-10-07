import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createProvider, GeminiProviderError } from '../services/stt-gateway/gemini.mjs';

function job(options = {}) {
    return { sessionId: 'room', participantId: 'speaker', language: 'bn-BD',
        audio: Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]), sampleRate: 16000,
        overlapSamples: 0, sequence: 0, final: false, signal: new AbortController().signal, ...options };
}
function result(text = 'বাংলা English') {
    return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] };
}
async function fixture(t, respond = () => ({ status: 200, body: result() }), settings = {}) {
    // Ephemeral authentication material exists only in memory; no literal test key.
    const key = randomBytes(24).toString('hex');
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const entry = { url: req.url, method: req.method, headers: req.headers,
            body: JSON.parse(Buffer.concat(chunks).toString()) };
        requests.push(entry);
        const response = await respond(entry, requests.length);
        if (!res.destroyed) {
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(response.raw ?? JSON.stringify(response.body));
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const provider = createProvider({ env: { GEMINI_API_KEY: key, ...settings },
        apiBase: `http://127.0.0.1:${server.address().port}/v1beta` });
    return { provider, requests, key };
}
const hasCode = code => error => error instanceof GeminiProviderError && error.code === code;

test('REST request: header authentication, WAV PCM, model, hint and mixed-script final text', async t => {
    const { provider, requests, key } = await fixture(t);
    const input = job();
    assert.deepEqual(await provider.transcribe(input), [{ text: 'বাংলা English', isFinal: true }]);
    const req = requests[0];
    assert.equal(req.url, '/v1beta/models/gemini-3.5-flash:generateContent');
    assert.equal(req.method, 'POST');
    assert.ok(req.headers['x-goog-api-key'] === key, 'authentication header matches runtime material');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.ok(!JSON.stringify(req.body).includes(key));
    const parts = req.body.contents[0].parts;
    assert.equal(req.body.contents[0].role, 'user');
    assert.match(parts[0].text, /Speaker language hint: bn-BD/);
    assert.match(parts[0].text, /Bangla in Bangla script and English words in English/);
    assert.match(parts[0].text, /Output only the transcript/);
    assert.equal(parts[1].inlineData.mimeType, 'audio/wav');
    const audio = Buffer.from(parts[1].inlineData.data, 'base64');
    assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
    assert.equal(audio.toString('ascii', 8, 16), 'WAVEfmt ');
    assert.equal(audio.readUInt32LE(4), audio.length - 8);
    assert.equal(audio.readUInt32LE(16), 16);
    assert.equal(audio.readUInt16LE(20), 1);
    assert.equal(audio.readUInt16LE(22), 1);
    assert.equal(audio.readUInt32LE(24), 16000);
    assert.equal(audio.readUInt32LE(28), 32000);
    assert.equal(audio.readUInt16LE(32), 2);
    assert.equal(audio.readUInt16LE(34), 16);
    assert.equal(audio.toString('ascii', 36, 40), 'data');
    assert.equal(audio.readUInt32LE(40), input.audio.length);
    assert.deepEqual(audio.subarray(44), input.audio);
});

test('environment model override and English hint; finalization never fabricates interim captions', async t => {
    const { provider, requests } = await fixture(t, () => ({ status: 200, body: result('hello') }), { GEMINI_MODEL: 'other-model' });
    assert.deepEqual(await provider.transcribe(job({ final: true, language: 'en' })), [{ text: 'hello', isFinal: true }]);
    assert.equal(requests[0].url, '/v1beta/models/other-model:generateContent');
    assert.match(requests[0].body.contents[0].parts[0].text, /Speaker language hint: en/);
});

test('empty, digital silence and overlap-only finalization skip HTTP; confirmed overlap is stripped', async t => {
    const { provider, requests } = await fixture(t);
    assert.deepEqual(await provider.transcribe(job({ audio: Buffer.alloc(0), final: true })), []);
    assert.deepEqual(await provider.transcribe(job({ audio: Buffer.alloc(8) })), []);
    await provider.transcribe(job({ sequence: 1, overlapSamples: 2 }));
    assert.deepEqual(Buffer.from(requests[0].body.contents[0].parts[1].inlineData.data, 'base64').subarray(44), job().audio.subarray(4));
    assert.deepEqual(await provider.transcribe(job({ sequence: 2, final: true, overlapSamples: 4 })), []);
    assert.equal(requests.length, 1);
});

test('gaps, language changes, participants and reconnects retain unconfirmed overlap; session release is effective', async t => {
    const { provider, requests } = await fixture(t);
    await provider.transcribe(job());
    await provider.transcribe(job({ sequence: 2, overlapSamples: 2 }));
    await provider.transcribe(job({ sequence: 3, overlapSamples: 2, language: 'en' }));
    await provider.transcribe(job({ sequence: 4, overlapSamples: 2, participantId: 'other' }));
    await provider.transcribe(job({ sequence: 4, overlapSamples: 2, sessionId: 'other' }));
    provider.releaseSession({ sessionId: 'room' });
    await provider.transcribe(job({ sequence: 4, overlapSamples: 2, language: 'en' }));
    assert.ok(requests.every(req => Buffer.from(req.body.contents[0].parts[1].inlineData.data, 'base64').length === 52));
});

test('transient server failures retry once; exhausted retries surface sanitized provider errors', async t => {
    for (const status of [408, 500, 502, 503, 504]) {
        const { provider, requests } = await fixture(t, (_req, count) => ({ status: count === 1 ? status : 200, body: result() }));
        assert.equal((await provider.transcribe(job()))[0].text, 'বাংলা English');
        assert.equal(requests.length, 2);
    }
    const { provider, requests } = await fixture(t, () => ({ status: 503, body: {} }));
    await assert.rejects(provider.transcribe(job()), hasCode('unavailable'));
    assert.equal(requests.length, 2);
});

test('auth, quota and request errors are not retried or logged, even when bodies echo secrets', async t => {
    const logs = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const name of Object.keys(original)) console[name] = (...args) => logs.push(args);
    try {
        for (const [status, code] of [[401, 'auth'], [403, 'auth'], [402, 'quota'], [429, 'quota'], [400, 'request'], [404, 'request']]) {
            const { provider, requests, key } = await fixture(t, req => ({ status, body: { error: req.headers['x-goog-api-key'], audio: req.body } }));
            let caught;
            try { await provider.transcribe(job()); } catch (error) { caught = error; }
            assert.ok(hasCode(code)(caught));
            assert.ok(!caught.stack.includes(key));
            assert.equal(caught.cause, undefined);
            assert.equal(requests.length, 1);
            // A failed window's overlap is not treated as already recognized.
            await assert.rejects(provider.transcribe(job({ sequence: 1, overlapSamples: 2 })), hasCode(code));
            assert.equal(Buffer.from(requests[1].body.contents[0].parts[1].inlineData.data, 'base64').length, 52);
        }
        assert.deepEqual(logs, []);
    } finally { Object.assign(console, original); }
});

test('malformed, blocked, truncated and missing responses are rejected; thought text is excluded', async t => {
    for (const response of [
        { raw: 'invalid JSON' }, { body: {} }, { body: { promptFeedback: { blockReason: 'SAFETY' } } },
        { body: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] } },
        { body: result('x'.repeat(16001)) }
    ]) {
        const { provider, requests } = await fixture(t, () => ({ status: 200, ...response }));
        await assert.rejects(provider.transcribe(job()), hasCode('response'));
        assert.equal(requests.length, 1);
    }
    const { provider } = await fixture(t, () => ({ status: 200, body: { candidates: [{ finishReason: 'STOP', content: {
        parts: [{ text: 'internal', thought: true }, { text: 'বাংলা ' }, { text: 'English' }]
    } }] } }));
    assert.equal((await provider.transcribe(job()))[0].text, 'বাংলা English');
    const empty = await fixture(t, () => ({ status: 200, body: result('   ') }));
    assert.deepEqual(await empty.provider.transcribe(job()), []);
});

test('configured whole-call deadline includes retry delay and is bounded by gateway timeout', async t => {
    const { provider, requests } = await fixture(t, () => ({ status: 503, body: {} }), { GEMINI_TIMEOUT_MS: '40' });
    const start = Date.now();
    await assert.rejects(provider.transcribe(job()), hasCode('timeout'));
    assert.ok(Date.now() - start < 500);
    assert.equal(requests.length, 1);
    const slow = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { status: 200, body: result() }; },
        { GEMINI_TIMEOUT_MS: '1000', MEET_STT_TIMEOUT_MS: '30' });
    await assert.rejects(slow.provider.transcribe(job()), hasCode('timeout'));
});

test('gateway cancellation aborts HTTP promptly; pre-aborted requests do not call', async t => {
    let arrived;
    const received = new Promise(resolve => { arrived = resolve; });
    const { provider, requests } = await fixture(t, async () => {
        arrived(); await new Promise(resolve => setTimeout(resolve, 100)); return { status: 200, body: result() };
    });
    const controller = new AbortController();
    const pending = provider.transcribe(job({ signal: controller.signal }));
    await received;
    controller.abort();
    await assert.rejects(pending, hasCode('cancelled'));
    await assert.rejects(provider.transcribe(job({ signal: controller.signal })), hasCode('cancelled'));
    assert.equal(requests.length, 1);
    provider.releaseSession({ sessionId: 'room' });
});

test('missing key and invalid settings fail safely; invalid PCM never calls HTTP', async t => {
    assert.throws(() => createProvider({ env: {} }), hasCode('key_required'));
    const key = randomBytes(24).toString('hex');
    for (const setting of [{ GEMINI_TIMEOUT_MS: '0' }, { GEMINI_TIMEOUT_MS: 'NaN' },
        { GEMINI_MODEL: '../bad' }, { MEET_STT_TIMEOUT_MS: '-1' }]) {
        assert.throws(() => createProvider({ env: { GEMINI_API_KEY: key, ...setting } }), hasCode('invalid_config'));
    }
    const { provider, requests } = await fixture(t);
    for (const options of [{ audio: Buffer.alloc(1) }, { sampleRate: 8000 }, { overlapSamples: 5 }, { language: 'bn\nignore' }]) {
        await assert.rejects(provider.transcribe(job(options)), hasCode('invalid_audio'));
    }
    assert.equal(requests.length, 0);
});

test('network disconnects retry once without exposing native errors', async t => {
    let calls = 0;
    const server = http.createServer((req) => { calls++; req.socket.destroy(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const provider = createProvider({ env: { GEMINI_API_KEY: randomBytes(24).toString('hex') },
        apiBase: `http://127.0.0.1:${server.address().port}/v1beta` });
    await assert.rejects(provider.transcribe(job()), hasCode('unavailable'));
    assert.equal(calls, 2);
});

test('release during an in-flight response prevents recognition metadata from reappearing', async t => {
    let arrived, release;
    const received = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const { provider, requests } = await fixture(t, async (_req, count) => {
        if (count === 1) { arrived(); await held; }
        return { status: 200, body: result() };
    });
    const pending = provider.transcribe(job());
    await received;
    provider.releaseSession({ sessionId: 'room' });
    release();
    await pending;
    await provider.transcribe(job({ sequence: 1, overlapSamples: 2 }));
    assert.equal(Buffer.from(requests[1].body.contents[0].parts[1].inlineData.data, 'base64').length, 52);
});
