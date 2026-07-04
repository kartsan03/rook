import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignal } from '../src/comment_filter.js';

test('rejects comments shorter than 10 characters', () => {
    assert.equal(isSignal('great'), false);
    assert.equal(isSignal('nice one!'), false);
});

test('accepts a normal question', () => {
    assert.equal(isSignal('How do you edit your videos so fast?'), true);
});

test('rejects emoji-only comments regardless of length', () => {
    assert.equal(isSignal('🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥🔥'), false); // unslop-ignore: emoji is the input under test
});

test('rejects short thank-yous in several languages', () => {
    assert.equal(isSignal('thanks a lot man'), false);
    assert.equal(isSignal('спасибо большое'), false);
});

test('keeps long comments even when they contain a noise word', () => {
    assert.equal(isSignal('thanks, but the part about deadlifts at 3:20 looks wrong to me'), true);
});

test('trims whitespace before measuring length', () => {
    assert.equal(isSignal('   hi        '), false);
});
