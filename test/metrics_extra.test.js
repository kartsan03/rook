import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRevenue, buildFinancialBlock, botBucket, buildComputedMetrics, formatComputedMetricsBlock, scrubUnexpectedDollars } from '../src/metrics.js';

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

test('scrubUnexpectedDollars: keeps code-owned §4 dollars, strips invented', () => {
    const fin = buildFinancialBlock({
        coreAudienceViews: 22000,
        basePrice: 150,
        geoReason: 'Global / mixed',
        revConservative: 9900,
        revModerate: 33000,
        crMultiplier: 1,
        penaltyReasons: [],
        moderateCr: 0.01,
        niche: 'Fitness & Health',
    });
    const metrics = formatComputedMetricsBlock({
        handle: 'anon',
        platform: 'youtube',
        niche: 'Fitness & Health',
        ghosting_pct: 75,
        heart_pct: 10,
        snr_pct: 12.5,
        core_audience: 22000,
        bot_probability: 0.05,
        bot_bucket: 'low (<40%)',
        geo_reason: 'Global / mixed',
        dead_audience_warning: '',
    });
    const md = '## 1\nGhosting invented money: $99,999\n' + fin + '\nPitch: miss $33,000 and also $12\n';
    const { text, stripped } = scrubUnexpectedDollars(md, [metrics, fin]);
    assert.ok(stripped >= 1);
    assert.match(text, /\$33,000/);
    assert.match(text, /\$150/);
    assert.doesNotMatch(text, /\$99,999/);
    assert.match(text, /amount removed: not code-owned/);
});
