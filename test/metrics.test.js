import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCore, detectGeoTier, estimateRevenue } from '../src/metrics.js';

// --- calculateCore ---

test('calculateCore: empty or all-zero view lists give 0', () => {
    assert.equal(calculateCore([]), 0);
    assert.equal(calculateCore([0, 0, 0]), 0);
});

test('calculateCore: 1-2 videos use the smallest view count', () => {
    assert.equal(calculateCore([5000]), 5000);
    assert.equal(calculateCore([9000, 4000]), 4000);
});

test('calculateCore: 3-10 videos use the second-smallest', () => {
    assert.equal(calculateCore([100, 900, 500]), 500);
});

test('calculateCore: larger samples use the 10th percentile', () => {
    const views = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    assert.equal(calculateCore(views), 300);
});

test('calculateCore: zero-view videos are excluded before picking', () => {
    assert.equal(calculateCore([0, 0, 700, 300]), 300);
});

// --- detectGeoTier ---

const videosWith = comments => [{ top_comments: comments.map(text => ({ text })) }];

test('detectGeoTier: mostly-Cyrillic comments are Tier 3', () => {
    const { isTier3, reason } = detectGeoTier(videosWith(['привет как дела', 'очень круто получилось']));
    assert.equal(isTier3, true);
    assert.match(reason, /Cyrillic/);
});

test('detectGeoTier: Latin-script comments stay global', () => {
    assert.equal(detectGeoTier(videosWith(['great video', 'love this part'])).isTier3, false);
});

test('detectGeoTier: no comments defaults to global', () => {
    assert.equal(detectGeoTier([{ top_comments: [] }]).isTier3, false);
    assert.equal(detectGeoTier([{}]).isTier3, false);
});

test('detectGeoTier: mixed text below the 50% threshold stays global', () => {
    // 6 Cyrillic characters vs 14 Latin
    assert.equal(detectGeoTier(videosWith(['привет hello my friends'])).isTier3, false);
});

test('detectGeoTier: Devanagari majority is Tier 3 India', () => {
    const { isTier3, reason } = detectGeoTier(videosWith(['बहुत अच्छा वीडियो है']));
    assert.equal(isTier3, true);
    assert.match(reason, /India/);
});

// --- estimateRevenue ---

const benchmark = {
    average_ticket_price_usd: 100,
    benchmarks: { conservative_conversion_rate: 0.002, moderate_conversion_rate: 0.01 },
};

test('estimateRevenue: clean profile gets no penalties', () => {
    const r = estimateRevenue({ coreViews: 10000, benchmark, snr: 20, botProbability: 0.05, isTier3: false });
    assert.equal(r.moderate, 10000);
    assert.equal(r.conservative, 2000);
    assert.equal(r.crMultiplier, 1);
    assert.equal(r.penaltyReasons.length, 0);
});

test('estimateRevenue: low SNR cuts conversion to 20%', () => {
    const r = estimateRevenue({ coreViews: 10000, benchmark, snr: 3, botProbability: 0.05, isTier3: false });
    assert.equal(r.moderate, 2000);
    assert.deepEqual(r.penaltyReasons, ['Low SNR (<5%)']);
});

test('estimateRevenue: likely bot audience halves conversion', () => {
    const r = estimateRevenue({ coreViews: 10000, benchmark, snr: 20, botProbability: 0.8, isTier3: false });
    assert.equal(r.moderate, 5000);
    assert.equal(r.penaltyReasons.length, 1);
});

test('estimateRevenue: penalties stack', () => {
    const r = estimateRevenue({ coreViews: 10000, benchmark, snr: 3, botProbability: 0.8, isTier3: false });
    assert.equal(r.moderate, 1000);
    assert.equal(r.penaltyReasons.length, 2);
});

test('estimateRevenue: Tier 3 audiences get 30% of the ticket price', () => {
    const r = estimateRevenue({ coreViews: 10000, benchmark, snr: 20, botProbability: 0.05, isTier3: true });
    assert.equal(r.basePrice, 30);
    assert.equal(r.moderate, 3000);
});
