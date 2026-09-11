import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { generate } from './llm.js';
import { buildQuoteAllowList, formatAllowListForPrompt, groundQuotes } from './comment_filter.js';
import {
    calculateCore,
    detectGeoTier,
    estimateRevenue,
    buildComputedMetrics,
    formatComputedMetricsBlock,
    scrubUnexpectedDollars,
    buildFinancialBlock,
} from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Defaults to the last ingested profile; pass a raw data file to analyze a specific one.
let latestDataPath = path.join(rootDir, 'data', 'latest_creator_data.json');
if (process.argv[2]) {
    latestDataPath = path.resolve(process.argv[2]);
}

if (!fs.existsSync(latestDataPath)) {
    console.error(`Error: data file not found: ${latestDataPath}`);
    process.exit(1);
}
const creatorData = JSON.parse(fs.readFileSync(latestDataPath, 'utf8'));

if (!creatorData.global_metrics || !Array.isArray(creatorData.videos)) {
    console.error(`Error: ${latestDataPath} is not a creator data file (expected global_metrics and videos).`);
    process.exit(1);
}

const briefPath = path.join(rootDir, 'audits', `the_brief_${creatorData.handle}.md`);
if (!fs.existsSync(briefPath)) {
    console.error(`Error: brief for @${creatorData.handle} not found. Run process_brief.js first.`);
    process.exit(1);
}
const theBrief = fs.readFileSync(briefPath, 'utf8');

const benchmarksPath = path.join(rootDir, 'config', 'mock_benchmarks.json');
const benchmarksData = JSON.parse(fs.readFileSync(benchmarksPath, 'utf8'));

const niche = creatorData.global_metrics.niche || 'Unknown';
const nicheBenchmark = benchmarksData.find(b => b.niche === niche) || benchmarksData.find(b => b.niche === 'Unknown');

// ---------------------------------------------------------
// HEALTH CHECK & METRICS
// ---------------------------------------------------------
const allowList = buildQuoteAllowList(creatorData.videos);
const totalCleanComments = allowList.length;

if (totalCleanComments === 0) {
    console.log(`Health check failed: @${creatorData.handle} has no comments with signal. Skipping dossier.`);
    process.exit(0);
}

const videoViews = creatorData.videos.filter(v => v.metrics.views > 0).map(v => v.metrics.views);

// Fusion mode pre-computes the core across platforms; single platform computes it here.
const coreAudienceViews = creatorData.global_metrics.fused_core_audience || calculateCore(videoViews);
const deadAudienceWarning = creatorData.global_metrics.fusion_warning || '';

const totalRawComments = creatorData.global_metrics.total_raw_comments_fetched || 1;
const snr = (totalCleanComments / totalRawComments) * 100;

// ---------------------------------------------------------
// DETERMINISTIC REVENUE MATH (the LLM never touches these numbers)
// ---------------------------------------------------------
// No ghosting/bot double penalties: the core-audience floor already excludes
// dead reach, and ghosting is a selling angle, not a conversion cut.
const { isTier3, reason: geoReason } = detectGeoTier(creatorData.videos);
const botProb = creatorData.global_metrics.bot_probability || 0.05;

const {
    basePrice,
    crMultiplier,
    penaltyReasons,
    moderateCr,
    conservative: revConservative,
    moderate: revModerate,
} = estimateRevenue({
    coreViews: coreAudienceViews,
    benchmark: nicheBenchmark,
    snr,
    botProbability: botProb,
    isTier3,
});

const computed = buildComputedMetrics({
    handle: creatorData.handle,
    platform: creatorData.platform,
    niche,
    ghostingRate: creatorData.global_metrics.ghosting_rate,
    heartRate: creatorData.global_metrics.heart_rate,
    snr,
    coreAudienceViews,
    botProbability: botProb,
    geoReason,
    deadAudienceWarning,
});
const metricsBlock = formatComputedMetricsBlock(computed);

const financialBlock = buildFinancialBlock({
    coreAudienceViews,
    basePrice,
    geoReason,
    revConservative,
    revModerate,
    crMultiplier,
    penaltyReasons,
    moderateCr,
    niche,
    deadAudienceWarning,
});

const contextText = `
${metricsBlock}

QUOTE ALLOW-LIST (numbered; any audience quote MUST be a substring of one of these):
${formatAllowListForPrompt(allowList)}

### CALCULATED REVENUE (USE IN THE PITCH — do not invent other dollar figures):
Expected base revenue: $${revModerate.toLocaleString('en-US')}
(Use this figure in the outreach pitch text.)

### INTERNAL BRIEF (pain points and archetype):
${theBrief}
`;

const synthPrompt = `
You are the senior strategist. Produce the FIRST DRAFT of the offer and pitch.
RULES:
1. There is always exactly ONE offer (Unified Offer).
2. Use the figure $${revModerate.toLocaleString('en-US')} in the pitch text as "missed revenue".
3. The pitch must be bold but expert. Use direct audience quotes ONLY from the QUOTE ALLOW-LIST (copy substrings).
4. Do NOT invent ghosting/SNR/core/bot/geo numbers — use COMPUTED METRICS only.

Output format:
VERDICT: ...
PRODUCT_NAME: ...
PITCH_DRAFT: ...
`;

const criticPrompt = `
You are a harsh business critic. Find the 3 FATAL FLAWS in the proposed offer draft.
Your goal is to force the strategist to change the tone or the product if it does not fit the creator's archetype.
Flag any invented quotes or metric numbers that are not in COMPUTED METRICS / QUOTE ALLOW-LIST.
`;

const refinerPrompt = `
You are the sales director. Take the context, the draft, and the critique, and produce the FINAL MASTER SALES DOSSIER in Markdown.
IMPORTANT: DO NOT write section "4. FINANCIAL MODEL". It is inserted automatically. Write ONLY sections 1, 2, 3 and 5.
Quotes in §2 MUST be substrings of the QUOTE ALLOW-LIST. Use dates from the allow-list (or date_unknown). Never invent comments.
Ghosting / SNR / core / bot / geo: copy from COMPUTED METRICS; do not invent.

Output format:

# MASTER SALES DOSSIER: @${creatorData.handle}

## 1. STRATEGIC DIAGNOSIS (Overview)
- **Verdict**: [GO / NO-GO].
- **Creator archetype**: [Teacher/Showman/Engineer/Motivator].
- **Ghosting level**: [from COMPUTED METRICS].
- **Platform imbalance**: assess whether there is a gap (see penalties in the context).

## 2. DEMAND ANALYSIS (What the audience wants)
List the 2-3 main audience pain points, ALWAYS with direct quotes from the allow-list and their dates.
*   **Pain 1:** ...
    *   *Quote:* "..."

## 3. PRODUCT BATTLE CARD (The Offer)
- **Product Name**: ...
- **Target Audience**: ...
- **The Hook**: ...
- **Delivery Model**: [format]
- **Ownership Strategy**: [Level Up or Launch]

## 5. [COPY-PASTE COLD OUTREACH]
The DM text. Hit the pain point, use a quote from the allow-list, and name the missed-revenue figure ($${revModerate.toLocaleString('en-US')}).
`;

function formatPassFooter(passes) {
    const lines = passes.map(p => `- ${p.name}: provider=${p.provider} model=${p.model} temperature=0`);
    return `\n\n---\n### LLM debug\n${lines.join('\n')}\n`;
}

async function run() {
    const runId = `${creatorData.handle}_${Date.now()}`;
    const passes = [];

    console.log(`Strategy loop (draft -> critique -> final) for @${creatorData.handle}...`);
    try {
        fs.mkdirSync(path.join(rootDir, 'audits'), { recursive: true });
        console.log('   [1/3] Strategist: drafting the offer...');
        const draftRes = await generate(`${synthPrompt}\n\nDATA:\n${contextText}`);
        passes.push({ name: 'strategist', provider: draftRes.provider, model: draftRes.model });
        fs.writeFileSync(path.join(rootDir, 'audits', `debug_${runId}_draft.md`), draftRes.text);

        console.log('   [2/3] Critic: finding weak spots...');
        const critiqueRes = await generate(`${criticPrompt}\n\nDATA:\nCONTEXT:\n${contextText}\n\nSTRATEGIST DRAFT:\n${draftRes.text}`);
        passes.push({ name: 'critic', provider: critiqueRes.provider, model: critiqueRes.model });
        fs.writeFileSync(path.join(rootDir, 'audits', `debug_${runId}_critique.md`), critiqueRes.text);

        console.log('   [3/3] Refiner: assembling the final dossier...');
        const finalRes = await generate(`${refinerPrompt}\n\nDATA:\nCONTEXT:\n${contextText}\n\nDRAFT:\n${draftRes.text}\n\nCRITIQUE:\n${critiqueRes.text}`);
        passes.push({ name: 'refiner', provider: finalRes.provider, model: finalRes.model });

        let finalBrief = finalRes.text;
        const grounded = groundQuotes(finalBrief, allowList);
        if (grounded.stripped > 0) {
            console.warn(`   Quote gate: stripped ${grounded.stripped} ungrounded quote(s).`);
        }
        finalBrief = grounded.text;

        // Splice code-owned COMPUTED METRICS into saved dossier (parity with §4).
        if (finalBrief.includes('## 1.')) {
            finalBrief = finalBrief.replace('## 1.', `${metricsBlock}\n\n## 1.`);
        } else if (/^#\s+.+/m.test(finalBrief)) {
            finalBrief = finalBrief.replace(/^(#\s+.+\n)/m, `$1\n${metricsBlock}\n`);
        } else {
            finalBrief = `${metricsBlock}\n\n${finalBrief}`;
        }

        if (finalBrief.includes('## 5.')) {
            finalBrief = finalBrief.replace('## 5.', `${financialBlock}\n\n## 5.`);
        } else {
            finalBrief += `\n\n${financialBlock}`;
        }

        const scrubbed = scrubUnexpectedDollars(finalBrief, [metricsBlock, financialBlock]);
        if (scrubbed.stripped > 0) {
            console.warn(`   Dollar gate: stripped ${scrubbed.stripped} non-code-owned amount(s).`);
        }
        finalBrief = scrubbed.text;
        finalBrief += formatPassFooter(passes);

        const finalPath = path.join(rootDir, 'audits', `investment_brief_${runId}.md`);
        fs.writeFileSync(finalPath, finalBrief);

        console.log(`\nDone. Final dossier: audits/investment_brief_${runId}.md`);

    } catch (error) {
        console.error('Strategy loop error:', error.message);
        process.exit(1);
    }
}

run();
