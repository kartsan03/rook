import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryDelayMs } from '../src/llm.js';

test('parses the wait from a structured Google 429 RetryInfo detail', () => {
    const errMsg = JSON.stringify({
        error: {
            code: 429,
            message: 'Resource has been exhausted.',
            details: [
                { '@type': 'type.googleapis.com/google.rpc.QuotaFailure' },
                { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '47s' }
            ]
        }
    });
    // Parsed delay plus the fixed 2s buffer.
    assert.equal(parseRetryDelayMs(errMsg), 49_000);
});

test('parses a fractional retry delay', () => {
    const errMsg = JSON.stringify({
        error: { details: [{ '@type': 'google.rpc.RetryInfo', retryDelay: '3.5s' }] }
    });
    // Ceil is applied to milliseconds: 3500ms + the fixed 2s buffer.
    assert.equal(parseRetryDelayMs(errMsg), 5_500);
});

test('falls back to regex matching on non-JSON error text', () => {
    assert.equal(parseRetryDelayMs('Rate limited. Please retry in 12.7s.'), 14_700);
    assert.equal(parseRetryDelayMs('"retryDelay":"8s"'), 10_000);
});

test('returns null when no retry hint is present', () => {
    assert.equal(parseRetryDelayMs('Invalid API key.'), null);
    assert.equal(parseRetryDelayMs(''), null);
});
