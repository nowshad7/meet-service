import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../web/brand/transcription-language.js', import.meta.url), 'utf8');
function setup(language, enabled = true, feature = true) {
    let tick;
    const calls = [];
    let joined = false;
    const room = { isJoined: () => joined, setLocalParticipantProperty: (...args) => calls.push(args) };
    const jwt = `x.${Buffer.from(JSON.stringify({ context: {
        features: { transcription: feature }, room: { transcription: { enabled: true, language } }
    } })).toString('base64url')}.x`;
    const window = {
        config: { transcription: { enabled } },
        APP: { store: { getState: () => ({ 'features/base/jwt': { jwt } }) }, conference: { _room: room } },
        atob: value => Buffer.from(value, 'base64').toString('utf8'),
        setInterval: fn => { tick = fn; }, clearInterval() {}, addEventListener() {}
    };
    runInNewContext(source, { window });
    return { calls, tick: () => tick(), join: () => { joined = true; }, window, room };
}
test('sets bn/en after join, once per conference, including a new conference', () => {
    for (const language of ['bn', 'en']) {
        const s = setup(language);
        s.tick(); assert.equal(s.calls.length, 0);
        s.join(); s.tick(); s.tick();
        assert.deepEqual(s.calls, [['transcription_language', language]]);
        s.window.APP.conference._room = { ...s.room };
        s.tick(); assert.equal(s.calls.length, 2);
    }
});
test('inactive, unauthorized, unsupported and malformed tokens do nothing', () => {
    for (const s of [setup('bn', false), setup('bn', true, false), setup('bn-BD')]) {
        s.join(); s.tick(); assert.equal(s.calls.length, 0);
    }
    const s = setup('bn');
    s.window.APP.store.getState = () => ({ 'features/base/jwt': { jwt: 'invalid' } });
    s.join(); s.tick(); assert.equal(s.calls.length, 0);
});
