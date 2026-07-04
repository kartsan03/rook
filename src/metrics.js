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

    return {
        basePrice,
        crMultiplier,
        penaltyReasons,
        conservative: Math.floor(coreViews * benchmark.benchmarks.conservative_conversion_rate * crMultiplier * basePrice),
        moderate: Math.floor(coreViews * benchmark.benchmarks.moderate_conversion_rate * crMultiplier * basePrice),
    };
}
