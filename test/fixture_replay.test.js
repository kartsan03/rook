import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isSignal, buildQuoteAllowList, groundQuotes } from '../src/comment_filter.js';
import {
    calculateCore,
    detectGeoTier,
    estimateRevenue,
    buildComputedMetrics,
    formatComputedMetricsBlock,
    buildFinancialBlock,
} from '../src/metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'raw_fixture_anon.json');
const benchmarksPath = path.join(__dirname, '..', 'config', 'mock_benchmarks.json');

test('fixture replay: §4 dollars + core/geo/SNR without live APIs', () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const benchmarks = JSON.parse(fs.readFileSync(benchmarksPath, 'utf8'));
    const niche = raw.global_metrics.niche;
    const benchmark = benchmarks.find(b => b.niche === niche);

    const allowList = buildQuoteAllowList(raw.videos);
    assert.ok(allowList.length >= 4, 'fixture should retain signal comments');

    const views = raw.videos.map(v => v.metrics.views);
    const core = calculateCore(views);
    // 3 videos sorted [18400,22000,31000] → second-smallest = 22000
    assert.equal(core, 22000);

    const { isTier3, reason: geoReason } = detectGeoTier(raw.videos);
    assert.equal(isTier3, false);
    assert.match(geoReason, /Global/);

    const snr = (allowList.length / raw.global_metrics.total_raw_comments_fetched) * 100;
    assert.ok(snr > 5, `expected healthy SNR, got ${snr}`);

    const rev = estimateRevenue({
        coreViews: core,
        benchmark,
        snr,
        botProbability: raw.global_metrics.bot_probability,
        isTier3,
    });
    // 22000 × 0.01 × 150 × 1.0 = 33000
    assert.equal(rev.moderate, 33000);
    assert.equal(rev.conservative, Math.floor(22000 * 0.003 * 150));

    const computed = buildComputedMetrics({
        handle: raw.handle,
        platform: raw.platform,
        niche,
        ghostingRate: raw.global_metrics.ghosting_rate,
        heartRate: raw.global_metrics.heart_rate,
        snr,
        coreAudienceViews: core,
        botProbability: raw.global_metrics.bot_probability,
        geoReason,
    });
    assert.equal(computed.core_audience, 22000);
    assert.equal(computed.ghosting_pct, 75);
    assert.equal(computed.bot_bucket, 'low (<40%)');

    const metricsMd = formatComputedMetricsBlock(computed);
    assert.match(metricsMd, /COMPUTED METRICS/);
    assert.match(metricsMd, /22000/);

    const fin = buildFinancialBlock({
        coreAudienceViews: core,
        basePrice: rev.basePrice,
        geoReason,
        revConservative: rev.conservative,
        revModerate: rev.moderate,
        crMultiplier: rev.crMultiplier,
        penaltyReasons: rev.penaltyReasons,
        moderateCr: rev.moderateCr,
        niche,
    });
    assert.match(fin, /22000 × 0\.01 × \$150 × 1\.00 = \$33,000/);
    assert.match(fin, /illustrative/);
    assert.match(fin, /Fitness & Health/);
});

test('fixture replay: quote gate rejects invented spans', () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const allowList = buildQuoteAllowList(raw.videos);
    const fake = '*Quote:* "Totally fabricated audience demand about crypto trading tips"\n';
    const { stripped, ungrounded } = groundQuotes(fake, allowList);
    assert.equal(stripped, 1);
    assert.ok(ungrounded[0].includes('crypto'));
});

test('fixture: noise comments are not in allow-list', () => {
    const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const allowList = buildQuoteAllowList(raw.videos);
    assert.ok(!allowList.some(c => !isSignal(c.text)));
    assert.ok(!allowList.some(c => c.text === 'thanks' || c.text.includes('🔥')));
});
