import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFusionPenalty } from '../src/metrics.js';

// --- applyFusionPenalty ---

test('fusion penalty: balanced platforms keep both cores untouched', () => {
    const r = applyFusionPenalty(50000, 30000, 20000, 15000);
    assert.equal(r.ytCore, 50000);
    assert.equal(r.igCore, 30000);
    assert.equal(r.fusionWarning, '');
});

test('fusion penalty: YouTube out-reaching Instagram by >20x cuts the WEAKER (Instagram) core', () => {
    const r = applyFusionPenalty(100000, 1000, 100000, 1000);
    assert.equal(r.igCore, Math.floor(1000 / 7));
    assert.equal(r.ytCore, 100000);
    assert.match(r.fusionWarning, /Instagram core cut/);
});

test('fusion penalty: Instagram out-reaching YouTube by >20x cuts the WEAKER (YouTube) core', () => {
    const r = applyFusionPenalty(100000, 3000, 1000, 100000);
    assert.equal(r.ytCore, Math.floor(100000 / 7));
    assert.equal(r.igCore, 3000);
    assert.match(r.fusionWarning, /YouTube core cut/);
});

test('fusion penalty: gap of exactly 20x is not penalized', () => {
    const r = applyFusionPenalty(70000, 30000, 20000, 1000);
    assert.equal(r.ytCore, 70000);
    assert.equal(r.igCore, 30000);
    assert.equal(r.fusionWarning, '');
});

test('fusion penalty: a dead platform (zero avg views) triggers no cut', () => {
    const r = applyFusionPenalty(50000, 0, 20000, 0);
    assert.equal(r.ytCore, 50000);
    assert.equal(r.igCore, 0);
    assert.equal(r.fusionWarning, '');
});
