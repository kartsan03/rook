import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { generate } from './llm.js';
import { isSignal } from './comment_filter.js';

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
const totalCleanComments = creatorData.videos.reduce((acc, v) => {
    if (!v.top_comments) return acc;
    return acc + v.top_comments.filter(c => isSignal(c.text)).length;
}, 0);

if (totalCleanComments === 0) {
    console.log(`Health check failed: @${creatorData.handle} has no comments with signal. Skipping dossier.`);
    process.exit(0);
}

const videoViews = creatorData.videos.filter(v => v.metrics.views > 0).map(v => v.metrics.views);

// Core audience = roughly the 10th percentile of views, i.e. the floor the
// creator reaches without algorithmic hype. Guarded for tiny video counts.
function calculateCore(viewsArray) {
    const validViews = viewsArray.filter(v => v > 0).sort((a, b) => a - b);
    if (validViews.length === 0) return 0;
    if (validViews.length <= 2) return validViews[0];
    if (validViews.length <= 10) return validViews[1];
    return validViews[Math.floor(validViews.length * 0.1)];
}

// Fusion mode pre-computes the core across platforms; single platform computes it here.
const coreAudienceViews = creatorData.global_metrics.fused_core_audience || calculateCore(videoViews);
const deadAudienceWarning = creatorData.global_metrics.fusion_warning || '';

const totalRawComments = creatorData.global_metrics.total_raw_comments_fetched || 1;
const snr = (totalCleanComments / totalRawComments) * 100;

// ---------------------------------------------------------
// DETERMINISTIC REVENUE MATH (the LLM never touches these numbers)
// ---------------------------------------------------------
let basePrice = nicheBenchmark.average_ticket_price_usd;

// Geo-pricing: if most comment text is Cyrillic or Devanagari, price for Tier 3.
let cyrillicCharCount = 0;
let hindiCharCount = 0;
let geoCharCount = 0;

creatorData.videos.forEach(v => {
    (v.top_comments || []).forEach(c => {
        const cleanText = c.text.replace(/[\p{Emoji}\s\d\p{Punctuation}]/gu, '');
        if (cleanText.length === 0) return;
        geoCharCount += cleanText.length;
        cyrillicCharCount += (cleanText.match(/[Ѐ-ӿ]/g) || []).length;
        hindiCharCount += (cleanText.match(/[ऀ-ॿ]/g) || []).length;
    });
});

const cyrillicRatio = geoCharCount > 0 ? cyrillicCharCount / geoCharCount : 0;
const hindiRatio = geoCharCount > 0 ? hindiCharCount / geoCharCount : 0;

let geoReason = 'Tier 1/2 (Global)';
if (cyrillicRatio > 0.5) geoReason = 'Tier 3 (CIS, Cyrillic > 50%)';
if (hindiRatio > 0.5) geoReason = 'Tier 3 (India, Hindi > 50%)';

if (cyrillicRatio > 0.5 || hindiRatio > 0.5) {
    basePrice = Math.floor(basePrice * 0.3);
}

// No ghosting/bot double penalties here: the core-audience floor already
// excludes dead reach, and ghosting is a selling angle, not a conversion cut.
let crMultiplier = 1.0;
const penaltyReasons = [];

if (snr < 5) {
    crMultiplier *= 0.2;
    penaltyReasons.push('Low SNR (<5%)');
}

const botProb = creatorData.global_metrics.bot_probability || 0.05;
if (botProb >= 0.4) {
    crMultiplier *= 0.5;
    penaltyReasons.push(`High probability of fake/decayed audience (${(botProb * 100).toFixed(0)}%)`);
}

const crConservative = nicheBenchmark.benchmarks.conservative_conversion_rate * crMultiplier;
const crModerate = nicheBenchmark.benchmarks.moderate_conversion_rate * crMultiplier;

const revConservative = Math.floor(coreAudienceViews * crConservative * basePrice);
const revModerate = Math.floor(coreAudienceViews * crModerate * basePrice);

const financialBlock = `
## 4. FINANCIAL MODEL (Reality Check)
- **Calculation base (core audience)**: ${Math.floor(coreAudienceViews)} ${deadAudienceWarning ? '(isolated core calculation)' : ''}
- **Price (geo-pricing)**: $${basePrice} *(${geoReason})*
- **Conservative estimate**: $${revConservative.toLocaleString('en-US')}
- **Base estimate**: $${revModerate.toLocaleString('en-US')}
*(Note: the niche's base conversion rate was adjusted by a ${crMultiplier.toFixed(2)}x factor. Reasons: ${penaltyReasons.length > 0 ? penaltyReasons.join(', ') : 'no penalties'}.)*
`;

const contextText = `
### CREATOR METRICS:
Handle: @${creatorData.handle}
Platform: ${creatorData.platform}
Niche: ${niche}
Subscribers: ${creatorData.global_metrics.subscribers}
Ghosting Rate: ${(creatorData.global_metrics.ghosting_rate * 100).toFixed(1)}%
SNR (signal-to-noise): ${snr.toFixed(1)}%
${deadAudienceWarning}

### CALCULATED REVENUE (USE IN THE PITCH):
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
3. The pitch must be bold but expert. Use direct audience quotes.

Output format:
VERDICT: ...
PRODUCT_NAME: ...
PITCH_DRAFT: ...
`;

const criticPrompt = `
You are a harsh business critic. Find the 3 FATAL FLAWS in the proposed offer draft.
Your goal is to force the strategist to change the tone or the product if it does not fit the creator's archetype.
`;

const refinerPrompt = `
You are the sales director. Take the context, the draft, and the critique, and produce the FINAL MASTER SALES DOSSIER in Markdown.
IMPORTANT: DO NOT write section "4. FINANCIAL MODEL". It is inserted automatically. Write ONLY sections 1, 2, 3 and 5.

Output format:

# MASTER SALES DOSSIER: @${creatorData.handle}

## 1. STRATEGIC DIAGNOSIS (Overview)
- **Verdict**: [GO / NO-GO].
- **Creator archetype**: [Teacher/Showman/Engineer/Motivator].
- **Ghosting level**: [insert %].
- **Platform imbalance**: assess whether there is a gap (see penalties in the context).

## 2. DEMAND ANALYSIS (What the audience wants)
List the 2-3 main audience pain points, ALWAYS with direct quotes and their dates.
*   **Pain 1:** ...
    *   *Quote:* "..."

## 3. PRODUCT BATTLE CARD (The Offer)
- **Product Name**: ...
- **Target Audience**: ...
- **The Hook**: ...
- **Delivery Model**: [format]
- **Ownership Strategy**: [Level Up or Launch]

## 5. [COPY-PASTE COLD OUTREACH]
The DM text. Hit the pain point, use a quote, and name the missed-revenue figure ($${revModerate.toLocaleString('en-US')}).
`;

async function run() {
    const runId = `${creatorData.handle}_${Date.now()}`;

    console.log(`Strategy loop (draft -> critique -> final) for @${creatorData.handle}...`);
    try {
        console.log('   [1/3] Strategist: drafting the offer...');
        const draft = await generate(`${synthPrompt}\n\nDATA:\n${contextText}`);
        fs.writeFileSync(path.join(rootDir, 'audits', `debug_${runId}_draft.md`), draft);

        console.log('   [2/3] Critic: finding weak spots...');
        const critique = await generate(`${criticPrompt}\n\nDATA:\nCONTEXT:\n${contextText}\n\nSTRATEGIST DRAFT:\n${draft}`);
        fs.writeFileSync(path.join(rootDir, 'audits', `debug_${runId}_critique.md`), critique);

        console.log('   [3/3] Refiner: assembling the final dossier...');
        let finalBrief = await generate(`${refinerPrompt}\n\nDATA:\nCONTEXT:\n${contextText}\n\nDRAFT:\n${draft}\n\nCRITIQUE:\n${critique}`);

        if (finalBrief.includes('## 5.')) {
            finalBrief = finalBrief.replace('## 5.', `${financialBlock}\n\n## 5.`);
        } else {
            finalBrief += `\n\n${financialBlock}`;
        }

        const finalPath = path.join(rootDir, 'audits', `investment_brief_${runId}.md`);
        fs.writeFileSync(finalPath, finalBrief);

        console.log(`\nDone. Final dossier: audits/investment_brief_${runId}.md`);

    } catch (error) {
        console.error('Strategy loop error:', error.message);
        process.exit(1);
    }
}

run();
