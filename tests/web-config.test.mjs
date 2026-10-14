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
