import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_TEMPERATURE, getModelIds, parseRetryDelayMs } from '../src/llm.js';

test('LLM_TEMPERATURE is locked to 0', () => {
    assert.equal(LLM_TEMPERATURE, 0);
});

test('getModelIds exposes overridable defaults', () => {
    const ids = getModelIds();
    assert.ok(ids.gemini);
    assert.ok(ids.openai);
});

test('parseRetryDelayMs still works after llm refactor', () => {
    assert.equal(parseRetryDelayMs('Please retry in 5s'), 7000);
});
