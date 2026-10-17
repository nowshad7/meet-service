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

// A minimal Redux-like store with the pinned client's subtitles state shape.
function autoSetup({ role = 'participant', autoStart = true, feature = true, settings = {}, storage = new Map() } = {}) {
    let tick;
    const dispatched = [], presence = [], listeners = [], settingsUpdates = [];
    const state = { 'features/subtitles': { _requestingSubtitles: false }, 'features/base/settings': settings,
        'features/transcribing': { isTranscribing: false },
        'features/base/participants': { local: { role } } };
    const jwt = `x.${Buffer.from(JSON.stringify({ context: { features: { transcription: feature },
        room: { transcription: { enabled: true, language: 'bn', autoStart } } } })).toString('base64url')}.x`;
    const set = patch => {
        for (const [key, value] of Object.entries(patch)) state[key] = { ...state[key], ...value };
        listeners.forEach(fn => fn());
    };
    const store = {
        getState: () => ({ ...state, 'features/base/jwt': { jwt } }),
        subscribe: fn => { listeners.push(fn); return () => {}; },
        // Mirrors the pinned middleware: the request also sets the presence property.
        dispatch: action => {
            if (action.type === 'SETTINGS_UPDATED') {
                settingsUpdates.push(action.settings);
                return set({ 'features/base/settings': action.settings });
            }
            dispatched.push(action);
            room.setLocalParticipantProperty('requestingTranscription', action.enabled);
            set({ 'features/subtitles': { _requestingSubtitles: action.enabled } });
        }
    };
    const room = { isJoined: () => true, setLocalParticipantProperty: (...args) => presence.push(args) };
    const localStorage = storage ? { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }
        : { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const window = { config: { transcription: { enabled: true } }, APP: { store, conference: { _room: room } }, localStorage,
        atob: value => Buffer.from(value, 'base64').toString('utf8'),
        setInterval: fn => { tick = fn; }, clearInterval() {}, addEventListener() {} };
    runInNewContext(source, { window, Date });
    return { tick: () => tick(), dispatched, presence, set, store, state, settings: settingsUpdates };
}

test('autoStart: an entitled moderator requests captions on join, with no translation language', () => {
    const s = autoSetup({ role: 'moderator' });
    s.tick();
    assert.equal(s.dispatched.length, 1);
    assert.deepEqual({ ...s.dispatched[0] }, { type: 'SET_REQUESTING_SUBTITLES', enabled: true, displaySubtitles: true,
        language: null, forceBackendRecordingOn: false, isRecordingRequested: false, skipMetadataUpdate: false });
    assert.deepEqual(JSON.parse(JSON.stringify(s.settings)), [{ showSubtitlesOnStage: true }]);
    s.tick(); assert.equal(s.dispatched.length, 1);
});

test('autoStart shows captions on stage once per browser, then keeps the user\'s setting', () => {
    const storage = new Map();
    const first = autoSetup({ role: 'moderator', storage });
    first.tick();
    assert.equal(storage.get('meet-captions-on-stage'), '1');
    const later = autoSetup({ role: 'moderator', storage, settings: { showSubtitlesOnStage: false } });
    later.tick();
    assert.equal(later.dispatched.length, 1);
    assert.deepEqual(later.settings, []);
    const blocked = autoSetup({ role: 'moderator', storage: null });
    blocked.tick();
    assert.equal(blocked.dispatched.length, 1, 'captions still start without browser storage');
});

test('autoStart: the moderator hiding captions keeps the room transcriber and is not undone', () => {
    const s = autoSetup({ role: 'moderator' });
    s.tick();
    s.set({ 'features/transcribing': { isTranscribing: true } });
    s.store.dispatch({ type: 'SET_REQUESTING_SUBTITLES', enabled: false });
    s.tick();
    assert.equal(s.dispatched.length, 2, 'no automatic restart after the user turned captions off');
    assert.ok(!s.presence.some(([name, value]) => name === 'requestingTranscription' && value === false),
        'the transcription request presence stays on');
});

test('autoStart: other participants show captions once the transcriber joins, and can turn them off', () => {
    const s = autoSetup();
    s.tick(); assert.equal(s.dispatched.length, 0, 'only moderators request the transcriber');
    s.set({ 'features/transcribing': { isTranscribing: true } });
    assert.equal(s.dispatched.length, 1);
    s.store.dispatch({ type: 'SET_REQUESTING_SUBTITLES', enabled: false });
    s.tick(); assert.equal(s.dispatched.length, 2);
    assert.ok(s.presence.some(([name, value]) => name === 'requestingTranscription' && value === false));
});

test('autoStart: a transcriber restart re-enables captions that the user did not turn off', () => {
    const s = autoSetup();
    s.tick();
    s.set({ 'features/transcribing': { isTranscribing: true } });
    // TRANSCRIBER_LEFT resets subtitles and transcribing state together.
    s.set({ 'features/transcribing': { isTranscribing: false }, 'features/subtitles': { _requestingSubtitles: false } });
    s.set({ 'features/transcribing': { isTranscribing: true } });
    assert.equal(s.dispatched.length, 2);
});

test('autoStart off or without the feature claim does nothing', () => {
    for (const s of [autoSetup({ role: 'moderator', autoStart: false }), autoSetup({ role: 'moderator', feature: false })]) {
        s.tick(); s.set({ 'features/transcribing': { isTranscribing: true } }); s.tick();
        assert.equal(s.dispatched.length, 0);
    }
});

// What the pinned CC button dispatches with translation disabled: setRequestingSubtitles(on, on, null).
const ccButton = on => ({ type: 'SET_REQUESTING_SUBTITLES', enabled: on, displaySubtitles: on, language: null });

test('autoStart: a participant turns captions off and on again, and a later restart keeps them on', () => {
    const s = autoSetup();
    s.tick();
    s.set({ 'features/transcribing': { isTranscribing: true } });
    s.store.dispatch(ccButton(false));
    s.tick();
    s.store.dispatch(ccButton(true));
    s.tick();
    assert.equal(s.state['features/subtitles']._requestingSubtitles, true);
    assert.deepEqual(s.dispatched.map(a => a.enabled), [true, false, true], 'no extra request from the script');
    s.set({ 'features/transcribing': { isTranscribing: false }, 'features/subtitles': { _requestingSubtitles: false } });
    s.set({ 'features/transcribing': { isTranscribing: true } });
    assert.deepEqual(s.dispatched.map(a => a.enabled), [true, false, true, true]);
});

test('autoStart: a participant who keeps captions off stays off across a transcriber restart', () => {
    const s = autoSetup();
    s.tick();
    s.set({ 'features/transcribing': { isTranscribing: true } });
    s.store.dispatch(ccButton(false));
    s.set({ 'features/transcribing': { isTranscribing: false } });
    s.set({ 'features/transcribing': { isTranscribing: true } });
    s.tick();
    assert.deepEqual(s.dispatched.map(a => a.enabled), [true, false]);
});

test('autoStart: the moderator turning captions off and on keeps the room transcriber requested', () => {
    const s = autoSetup({ role: 'moderator' });
    s.tick();
    s.set({ 'features/transcribing': { isTranscribing: true } });
    s.store.dispatch(ccButton(false));
    s.store.dispatch(ccButton(true));
    const requests = s.presence.filter(([name]) => name === 'requestingTranscription').map(([, value]) => value);
    assert.deepEqual(requests, [true, true]);
    assert.equal(s.state['features/subtitles']._requestingSubtitles, true);
});
