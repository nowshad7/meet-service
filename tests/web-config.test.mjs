import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/custom-config.js', import.meta.url), 'utf8');

function load(config = {}) {
    vm.runInNewContext(source, { config });
    return config;
}

test('closed rooms offer no invite or add-people dialogs', () => {
    assert.equal(load().disableInviteFunctions, true);
});

test('captions offer no translation, so the CC button toggles them directly', () => {
    const { transcription } = load({ transcription: { enabled: true } });
    assert.equal(transcription.translationEnabled, false);
    assert.equal(transcription.translationLanguages.length, 0);
    assert.equal(transcription.translationLanguagesHead.length, 0);
    assert.equal(JSON.stringify(load({ transcription: { enabled: false } }).transcription), '{"enabled":false}');
});
