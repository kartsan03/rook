import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRevenue, buildFinancialBlock, botBucket, buildComputedMetrics } from '../src/metrics.js';

const benchmark = {
    average_ticket_price_usd: 100,
    benchmarks: { conservative_conversion_rate: 0.002, moderate_conversion_rate: 0.01 },
};

test('buildFinancialBlock includes transparency formula and illustrative label', () => {
    const r = estimateRevenue({ coreViews: 10000, benchmark, snr: 20, botProbability: 0.05, isTier3: false });
    const md = buildFinancialBlock({
        coreAudienceViews: 10000,
        basePrice: r.basePrice,
        geoReason: 'Tier 1/2 (Global)',
        revConservative: r.conservative,
        revModerate: r.moderate,
        crMultiplier: r.crMultiplier,
        penaltyReasons: r.penaltyReasons,
        moderateCr: r.moderateCr,
        niche: 'Unknown',
    });
    assert.match(md, /10000 × 0\.01 × \$100 × 1\.00 = \$10,000/);
    assert.match(md, /illustrative/);
});

test('botBucket thresholds', () => {
    assert.equal(botBucket(0.05), 'low (<40%)');
    assert.equal(botBucket(0.4), 'elevated (≥40%)');
    assert.equal(botBucket(0.8), 'high (≥80%)');
});

test('buildComputedMetrics exposes ghosting and SNR', () => {
    const m = buildComputedMetrics({
        handle: 'x', platform: 'youtube', niche: 'Unknown',
        ghostingRate: 0.75, heartRate: 0.1, snr: 12.5,
        coreAudienceViews: 18400, botProbability: 0.05, geoReason: 'Tier 1/2 (Global)',
    });
    assert.equal(m.ghosting_pct, 75);
    assert.equal(m.snr_pct, 12.5);
    assert.equal(m.core_audience, 18400);
});
