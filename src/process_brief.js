import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { generate } from './llm.js';
import { isSignal } from './comment_filter.js';

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

const cleanVideos = rawData.videos.map(video => {
    const seenComments = new Set();
    const cleanComments = video.top_comments.filter(comment => {
        const text = comment.text.trim();
        if (!isSignal(text)) return false;

        // Deduplicate on the first 50 chars
        const dedupKey = text.substring(0, 50).toLowerCase();
        if (seenComments.has(dedupKey)) return false;
        seenComments.add(dedupKey);

        return true;
    });
    return { ...video, top_comments: cleanComments };
});

let contextText = `Creator: ${rawData.handle} (Niche: ${rawData.global_metrics.niche})\n`;
contextText += `Platform: ${rawData.platform}\n`;
contextText += `Engagement metrics: Ghosting Rate: ${(rawData.global_metrics.ghosting_rate * 100).toFixed(1)}%, Heart Rate: ${(rawData.global_metrics.heart_rate * 100).toFixed(1)}%\n\n`;

cleanVideos.forEach((v, index) => {
    const platformTag = v.source_platform ? `[${v.source_platform.toUpperCase()}]` : '';
    contextText += `--- Video ${index + 1}: ${v.title} ${platformTag} (Published: ${v.published_at.substring(0, 10)}) ---\n`;
    contextText += `Transcript (excerpt): ${v.transcript}\n`;
    contextText += `Filtered comments:\n`;
    v.top_comments.forEach(c => {
        const heartTag = c.has_heart ? '[hearted by creator]' : '';
        contextText += `- [${c.date.substring(0, 10)}] ${c.text} ${heartTag}\n`;
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

METRICS YOU MUST ASSESS:
1. Time-Decay (pain freshness): look at the comment dates.
2. Promo Fatigue & Ownership Check: look for mentions of the creator's own products.
3. Commercial Intent: split the audience into "free-seekers" and "wallet-ready".
4. Ghosting Analysis: look at the Ghosting Rate. Above 80%, the audience feels abandoned.
5. Purchasing Power (geo-economics): determine the audience language and geo tier (Tier 1/2/3).
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
        const textResponse = await generate(systemPrompt + '\n\nData context for analysis:\n' + contextText);

        const briefPath = path.join(rootDir, 'audits', `the_brief_${rawData.handle}.md`);
        fs.writeFileSync(briefPath, textResponse);
        console.log(`Brief saved to: audits/the_brief_${rawData.handle}.md`);
    } catch (error) {
        console.error('LLM error after retries:', error.message);
        process.exit(1);
    }
}
run();
