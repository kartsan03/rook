import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { generate } from './llm.js';
import { briefSourceMarker, requireGeneratedText } from './artifact_guard.js';
import { isSignal, buildQuoteAllowList, formatAllowListForPrompt, formatCommentDate, groundQuotes } from './comment_filter.js';
import { measuredCore, detectGeoTier, buildComputedMetrics, formatComputedMetricsBlock, scrubUnexpectedDollars } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Defaults to the last ingested profile; pass a raw data file to analyze a specific one.
let dataPath = path.join(rootDir, 'data', 'latest_creator_data.json');
if (process.argv[2]) {
    dataPath = path.resolve(process.argv[2]);
}

if (!fs.existsSync(dataPath)) {
    console.error(`Error: data file not found: ${dataPath}`);
    process.exit(1);
}
const rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

if (!rawData.global_metrics || !Array.isArray(rawData.videos)) {
    console.error(`Error: ${dataPath} is not a creator data file (expected global_metrics and videos).`);
    process.exit(1);
}

const cleanVideos = rawData.videos.map(video => {
    const seenComments = new Set();
    const comments = video.top_comments || [];
    const cleanComments = comments.filter(comment => {
        const text = comment.text.trim();
        if (!isSignal(text)) return false;
        const dedupKey = text.substring(0, 50).toLowerCase();
        if (seenComments.has(dedupKey)) return false;
        seenComments.add(dedupKey);
        return true;
    });
    return { ...video, top_comments: cleanComments };
});

const allowList = buildQuoteAllowList(rawData.videos);
if (!allowList.length) {
    console.log(`Health check failed: @${rawData.handle} has no comments with signal. Skipping Brief.`);
    process.exit(2);
}
const coreAudienceViews = rawData.platform === 'multi'
    ? rawData.global_metrics.fused_core_audience ?? null
    : measuredCore(rawData.videos, rawData.platform);
const { reason: geoReason } = detectGeoTier(rawData.videos);
const totalClean = allowList.length;
const totalRaw = rawData.global_metrics.total_raw_comments_fetched || 1;
const snr = (totalClean / totalRaw) * 100;
const computed = buildComputedMetrics({
    handle: rawData.handle,
    platform: rawData.platform,
    niche: rawData.global_metrics.niche || 'Unknown',
    ghostingRate: rawData.global_metrics.ghosting_rate,
    heartRate: rawData.global_metrics.heart_rate,
    snr,
    coreAudienceViews,
    botProbability: rawData.platform === 'instagram' ? null : rawData.global_metrics.bot_probability ?? null,
    geoReason,
    deadAudienceWarning: rawData.global_metrics.fusion_warning || '',
});
const metricsBlock = formatComputedMetricsBlock(computed);

let contextText = metricsBlock + '\n';
contextText += `QUOTE ALLOW-LIST (numbered; any quote you write MUST be a substring of one of these):\n`;
contextText += formatAllowListForPrompt(allowList) + '\n\n';

cleanVideos.forEach((v, index) => {
    const platformTag = v.source_platform ? `[${v.source_platform.toUpperCase()}]` : '';
    contextText += `--- Video ${index + 1}: ${v.title} ${platformTag} (Published: ${(v.published_at || '').substring(0, 10) || 'date_unknown'}) ---\n`;
    contextText += `Transcript (excerpt): ${v.transcript}\n`;
    contextText += `Filtered comments:\n`;
    v.top_comments.forEach(c => {
        const heartTag = c.has_heart ? '[hearted by creator]' : '';
        contextText += `- [${formatCommentDate(c.date)}] ${c.text} ${heartTag}\n`;
    });
    contextText += `\n`;
});

const today = new Date().toISOString().substring(0, 10);
const systemPrompt = `
You are a senior audience analyst. Today's date: ${today}.
Your task: read the transcripts and comments and produce **The Brief**.

IMPORTANT: If platform = "multi", you are analyzing ONE creator across YouTube and Instagram at once.
In that case you MUST:
1. Compare the audience on both platforms (where it is more active, where the pain points are stronger).
2. Identify the synergy: e.g. Instagram as the short-form funnel, YouTube as long-form warm-up content.

METRICS: The COMPUTED METRICS block above is code-owned ground truth. Do NOT invent or restate ghosting, SNR, core audience, bot bucket, geo, or rates as free-prose numbers — refer to that block.

QUOTES: When you quote a comment, copy a substring from the QUOTE ALLOW-LIST only. Never invent quotes or dates. Missing dates are "date_unknown".

METRICS YOU MUST ASSESS:
1. Time-Decay (pain freshness): look at the comment dates (use date_unknown when listed).
2. Promo Fatigue & Ownership Check: look for mentions of the creator's own products.
3. Commercial Intent: split the audience into "free-seekers" and "wallet-ready".
4. Ghosting Analysis: use the code-owned Ghosting rate from COMPUTED METRICS.
5. Purchasing Power (geo-economics): use the code-owned Geo line; expand qualitatively only.
6. Personality Fit (vibe check): determine the creator's archetype.

Output format (strict Markdown):
# The Brief: ${rawData.handle}

## 1. Pain Freshness (Time-Decay)
## 2. Promo Fatigue & Own Products
## 3. Commercial Intent
## 4. Ghosting Analysis
## 5. Geo-Economics (Purchasing Power)
## 6. Creator Archetype (Vibe Check)
## 7. Top 3 Audience Pain Points
## 8. Cross-Platform Synergy (only if platform = "multi")
- Explain how YouTube and Instagram complement each other for this creator.
## 9. Expertise Mismatch
`;

async function run() {
    console.log(`Analysis layer: building The Brief for @${rawData.handle} (${rawData.platform})...`);
    try {
        const { text, provider, model } = await generate(systemPrompt + '\n\nData context for analysis:\n' + contextText);
        const grounded = groundQuotes(requireGeneratedText(text), allowList);
        if (grounded.stripped > 0) {
            console.warn(`   Quote gate: stripped ${grounded.stripped} ungrounded quote(s).`);
        }
        // Code-owned metrics must appear in the saved Brief (parity with dossier §4 splice).
        let briefMd = grounded.text;
        if (/^#\s+.+/m.test(briefMd)) {
            briefMd = briefMd.replace(/^(#\s+.+\n)/m, `$1\n${metricsBlock}\n`);
        } else {
            briefMd = `${metricsBlock}\n${briefMd}`;
        }
        const scrubbed = scrubUnexpectedDollars(briefMd, [metricsBlock]);
        if (scrubbed.stripped > 0) {
            console.warn(`   Dollar gate: stripped ${scrubbed.stripped} non-code-owned amount(s).`);
        }
        briefMd = scrubbed.text;
        const footer = `\n\n---\n_LLM pass: provider=${provider} model=${model} temperature=0_\n`;

        fs.mkdirSync(path.join(rootDir, 'audits'), { recursive: true });
        const briefPath = path.join(rootDir, 'audits', `the_brief_${rawData.handle}.md`);
        fs.writeFileSync(briefPath, briefMd + footer + '\n' + briefSourceMarker(rawData) + '\n');
        console.log(`Brief saved to: audits/the_brief_${rawData.handle}.md`);
    } catch (error) {
        console.error('LLM error after retries:', error.message);
        process.exit(1);
    }
}
run();
