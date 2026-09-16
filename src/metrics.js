// Pure math shared by process_logic.js and fusion_data.js. No I/O here so
// every branch is unit-testable (see test/metrics.test.js).

// Core audience = roughly the 10th percentile of views, i.e. the floor the
// creator reaches without algorithmic hype. Guarded for tiny video counts.
export function calculateCore(viewsArray) {
    const validViews = viewsArray.filter(v => v > 0).sort((a, b) => a - b);
    if (validViews.length === 0) return 0;
    if (validViews.length <= 2) return validViews[0];
    if (validViews.length <= 10) return validViews[1];
    return validViews[Math.floor(validViews.length * 0.1)];
}

// Fusion penalizes only the weaker platform when both have reach and the
// average-view gap exceeds 20x. Keep the warning tied to the penalized core.
export function applyFusionPenalty(ytCore, igCore, ytAvgViews, igAvgViews) {
    let fusionWarning = '';
    if (ytAvgViews > 0 && igAvgViews > 0) {
        if (ytAvgViews > igAvgViews * 20) {
            igCore = Math.floor(igCore / 7);
            fusionWarning = 'DEAD AUDIENCE PENALTY: Instagram core cut 7x due to critical platform imbalance (>20x gap vs YouTube).';
        } else if (igAvgViews > ytAvgViews * 20) {
            ytCore = Math.floor(ytCore / 7);
            fusionWarning = 'DEAD AUDIENCE PENALTY: YouTube core cut 7x due to critical platform imbalance (>20x gap vs Instagram).';
        }
    }
    return { ytCore, igCore, fusionWarning };
}

// Audience comments are the denominator. Multiple replies and a heart on the
// same comment count as one acknowledgement; creator messages are not demand.
export function measureEngagement(comments) {
    const repliedTo = new Set(comments.filter(c => c.is_creator && c.parent_id).map(c => String(c.parent_id)));
    const seen = new Set();
    const audience = comments.filter(c => {
        if (c.is_creator || !c.text?.trim()) return false;
        if (c.id != null) {
            if (seen.has(String(c.id))) return false;
            seen.add(String(c.id));
        }
        return true;
    });
    const hearted = audience.filter(c => c.has_heart).length;
    const acknowledged = audience.filter(c => c.has_heart || c.has_creator_reply ||
        (c.id != null && repliedTo.has(String(c.id)))).length;
    return {
        audience, hearted, acknowledged,
        heart_rate: audience.length ? hearted / audience.length : null,
        ghosting_rate: audience.length ? 1 - acknowledged / audience.length : null,
    };
}

// Pool sampled audience comments rather than averaging platform percentages.
export function pooledEngagement(metrics, key) {
    let total = 0;
    let weighted = 0;
    for (const m of metrics) {
        const count = m.total_raw_comments_fetched || 0;
        if (count > 0 && m[key] == null) return null;
        if (count > 0) {
            total += count;
            weighted += count * m[key];
        }
    }
    return total ? weighted / total : null;
}

// Legacy Instagram views may be likes×10: require explicit measured provenance.
export function measuredViews(video, platform) {
    if ((video.source_platform || platform) === 'instagram' && video.metrics?.views_source !== 'videoPlayCount') return null;
    const views = video.metrics?.views;
    return Number.isFinite(views) && views >= 0 ? views : null;
}

export function measuredCore(videos, platform) {
    const views = videos.map(v => measuredViews(v, platform)).filter(v => v !== null);
    return views.length ? calculateCore(views) : null;
}

// Geo detection: if most comment text is Cyrillic or Devanagari script,
// the audience is priced as Tier 3.
export function detectGeoTier(videos) {
    let cyrillic = 0;
    let devanagari = 0;
    let total = 0;

    videos.forEach(v => {
        (v.top_comments || []).forEach(c => {
            const cleanText = c.text.replace(/[\p{Emoji}\s\d\p{Punctuation}]/gu, '');
            if (cleanText.length === 0) return;
            total += cleanText.length;
            cyrillic += (cleanText.match(/[Ѐ-ӿ]/g) || []).length;
            devanagari += (cleanText.match(/[ऀ-ॿ]/g) || []).length;
        });
    });

    if (total > 0 && cyrillic / total > 0.5) return { isTier3: true, reason: 'Tier 3 (CIS, Cyrillic > 50%)' };
    if (total > 0 && devanagari / total > 0.5) return { isTier3: true, reason: 'Tier 3 (India, Hindi > 50%)' };
    return { isTier3: false, reason: 'Tier 1/2 (Global)' };
}

// Revenue estimate. A noisy comment section (SNR < 5%) and a likely bot or
// decayed audience cut the niche conversion rate; Tier 3 cuts the price.
export function estimateRevenue({ coreViews, benchmark, snr, botProbability, isTier3 }) {
    if (coreViews == null) {
        return { basePrice: null, crMultiplier: 1, penaltyReasons: [], moderateCr: null,
            conservativeCr: null, conservative: null, moderate: null };
    }
    let basePrice = benchmark.average_ticket_price_usd;
    if (isTier3) basePrice = Math.floor(basePrice * 0.3);

    let crMultiplier = 1.0;
    const penaltyReasons = [];

    if (snr < 5) {
        crMultiplier *= 0.2;
        penaltyReasons.push('Low SNR (<5%)');
    }
    if (botProbability >= 0.4) {
        crMultiplier *= 0.5;
        penaltyReasons.push(`High probability of fake/decayed audience (${(botProbability * 100).toFixed(0)}%)`);
    }

    const moderateCr = benchmark.benchmarks.moderate_conversion_rate;
    const conservativeCr = benchmark.benchmarks.conservative_conversion_rate;

    return {
        basePrice,
        crMultiplier,
        penaltyReasons,
        moderateCr,
        conservativeCr,
        conservative: Math.floor(coreViews * conservativeCr * crMultiplier * basePrice),
        moderate: Math.floor(coreViews * moderateCr * crMultiplier * basePrice),
    };
}

/** Bot bucket label for code-owned metrics blocks (LLM must not invent this). */
export function botBucket(botProbability) {
    if (botProbability == null) return 'unknown';
    const p = botProbability;
    if (p >= 0.8) return 'high (≥80%)';
    if (p >= 0.4) return 'elevated (≥40%)';
    return 'low (<40%)';
}

/**
 * Code-owned metrics snapshot the LLM must treat as ground truth
 * (do not restate as free-prose invented numbers).
 */
export function buildComputedMetrics({
    handle,
    platform,
    niche,
    ghostingRate,
    heartRate,
    snr,
    coreAudienceViews,
    botProbability,
    geoReason,
    deadAudienceWarning = '',
}) {
    return {
        handle,
        platform,
        niche,
        ghosting_pct: ghostingRate == null ? null : Number((ghostingRate * 100).toFixed(1)),
        heart_pct: heartRate == null ? null : Number((heartRate * 100).toFixed(1)),
        snr_pct: Number(snr.toFixed(1)),
        core_audience: coreAudienceViews == null ? null : Math.floor(coreAudienceViews),
        bot_probability: botProbability,
        bot_bucket: botBucket(botProbability),
        geo_reason: geoReason,
        dead_audience_warning: deadAudienceWarning || '',
    };
}

export function formatComputedMetricsBlock(m) {
    const warn = m.dead_audience_warning ? `\n- **Fusion warning**: ${m.dead_audience_warning}` : '';
    return `## COMPUTED METRICS (code-owned — do not invent or restate as free prose)
- **Handle**: @${m.handle}
- **Platform**: ${m.platform}
- **Niche**: ${m.niche}
- **Ghosting rate**: ${m.ghosting_pct == null ? 'unknown' : `${m.ghosting_pct}%`}
- **Heart rate**: ${m.heart_pct == null ? 'unknown' : `${m.heart_pct}%`}
- **SNR (signal-to-noise)**: ${m.snr_pct}%
- **Core audience (views floor)**: ${m.core_audience ?? 'unknown (no measured views)'}
- **Bot bucket**: ${m.bot_bucket}${m.bot_probability == null ? '' : ` (p=${(m.bot_probability * 100).toFixed(0)}%)`}
- **Geo**: ${m.geo_reason}${warn}
`;
}

/**
 * §4 financial model with transparency line. Money math stays in code.
 * Benchmarks from mock_benchmarks.json are labeled illustrative.
 */
export function buildFinancialBlock({
    coreAudienceViews,
    basePrice,
    geoReason,
    revConservative,
    revModerate,
    crMultiplier,
    penaltyReasons,
    moderateCr,
    niche,
    deadAudienceWarning = '',
}) {
    if (coreAudienceViews == null) {
        return '\n## 4. FINANCIAL MODEL (Reality Check)\nRevenue estimate unavailable: no measured views. Likes are not reach.\n';
    }
    const core = Math.floor(coreAudienceViews);
    const formula = `${core} × ${moderateCr} × $${basePrice} × ${crMultiplier.toFixed(2)} = $${revModerate.toLocaleString('en-US')}`;
    return `
## 4. FINANCIAL MODEL (Reality Check)
- **Calculation base (core audience)**: ${core} ${deadAudienceWarning ? '(isolated core calculation)' : ''}
- **Price (geo-pricing)**: $${basePrice} *(${geoReason})*
- **Transparency**: \`${formula}\` *(core × niche CR × price × mult)*
- **Benchmark niche**: ${niche} *(mock_benchmarks — illustrative, not live market data)*
- **Conservative estimate**: $${revConservative.toLocaleString('en-US')}
- **Base estimate**: $${revModerate.toLocaleString('en-US')}
*(Note: the niche's base conversion rate was adjusted by a ${crMultiplier.toFixed(2)}x factor. Reasons: ${penaltyReasons.length > 0 ? penaltyReasons.join(', ') : 'no penalties'}.)*
`;
}

/**
 * Post-validate markdown: keep only $ amounts that appear in code-owned blocks
 * (COMPUTED METRICS / §4 financial). Unexpected amounts are stripped.
 * Returns { text, stripped, amounts }.
 */
export function scrubUnexpectedDollars(markdown, allowedBlocks = []) {
    const allowed = new Set();
    // Treat magnitude suffixes as part of the amount: $100 million is NOT $100.
    const amountRe = /\$\s*[\d,]+(?:\.\d+)?(?:\s*(?:thousand|million|billion|trillion|[kmbt])\b)?/gi;
    for (const block of allowedBlocks) {
        if (!block) continue;
        for (const m of String(block).matchAll(amountRe)) {
            allowed.add(m[0].replace(/\s+/g, ''));
        }
    }
    const amounts = [];
    const stripped = [];
    const text = String(markdown || '').replace(amountRe, (raw) => {
        const norm = raw.replace(/\s+/g, '');
        amounts.push(norm);
        if (allowed.has(norm)) return raw;
        stripped.push(norm);
        return '[amount removed: not code-owned]';
    });
    return { text, stripped: stripped.length, amounts: stripped };
}
