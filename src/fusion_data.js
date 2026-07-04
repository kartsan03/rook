import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const ytHandle = (process.argv[2] || '').replace('@', '');
const igHandle = (process.argv[3] || '').replace('@', '');

if (!ytHandle || !igHandle) {
    console.error('Error: pass both handles. Example: node src/fusion_data.js "TechLead" "techlead"');
    process.exit(1);
}

const ytPath = path.join(rootDir, 'data', `raw_${ytHandle}.json`);
const igPath = path.join(rootDir, 'data', `raw_ig_${igHandle}.json`);

if (!fs.existsSync(ytPath) || !fs.existsSync(igPath)) {
    console.error('Error: one or both raw files are missing in /data. Run the ingest scripts first.');
    process.exit(1);
}

const ytData = JSON.parse(fs.readFileSync(ytPath, 'utf8'));
const igData = JSON.parse(fs.readFileSync(igPath, 'utf8'));

console.log(`Fusing data for ${ytHandle} (YT) and @${igHandle} (IG)...`);

// Core audience = roughly the 10th percentile of views (see process_logic.js).
function calculateCore(viewsArray) {
    const validViews = viewsArray.filter(v => v > 0).sort((a, b) => a - b);
    if (validViews.length === 0) return 0;
    if (validViews.length <= 2) return validViews[0];
    if (validViews.length <= 10) return validViews[1];
    return validViews[Math.floor(validViews.length * 0.1)];
}

const ytViewsArray = ytData.videos.map(v => v.metrics.views);
const igViewsArray = igData.videos.map(v => v.metrics.views);

let ytCore = calculateCore(ytViewsArray);
let igCore = calculateCore(igViewsArray);

const avg = arr => {
    const positive = arr.filter(v => v > 0);
    return positive.length > 0 ? Math.floor(positive.reduce((a, b) => a + b, 0) / positive.length) : 0;
};
const ytAvgViews = avg(ytViewsArray);
const igAvgViews = avg(igViewsArray);

// Dead audience trap: if one platform out-reaches the other by >20x, the weaker
// one is likely dead weight, so its core is cut before the cores are added.
let fusionWarning = '';
if ((ytAvgViews > 0 && igAvgViews > 0) && (ytAvgViews > igAvgViews * 20)) {
    ytCore = Math.floor(ytCore / 7);
    fusionWarning = 'DEAD AUDIENCE PENALTY: YouTube core cut 7x due to critical platform imbalance (>20x gap vs Instagram).';
} else if ((ytAvgViews > 0 && igAvgViews > 0) && (igAvgViews > ytAvgViews * 20)) {
    igCore = Math.floor(igCore / 7);
    fusionWarning = 'DEAD AUDIENCE PENALTY: Instagram core cut 7x due to critical platform imbalance (>20x gap vs YouTube).';
}

// Cores are computed per platform and then added, so one platform's hype
// cannot inflate the other's floor.
const fusedCore = ytCore + igCore;

const combinedAvgViews = avg([...ytViewsArray, ...igViewsArray]);

const fusedData = {
    creator_id: `${ytData.creator_id}_${igData.creator_id}`,
    handle: ytData.handle,
    platform: 'multi',
    global_metrics: {
        subscribers: (ytData.global_metrics.subscribers || 0) + (igData.global_metrics.subscribers || 0),
        avg_views_last_10_videos: combinedAvgViews,
        total_raw_comments_fetched: (ytData.global_metrics.total_raw_comments_fetched || 0) + (igData.global_metrics.total_raw_comments_fetched || 0),
        ghosting_rate: (ytData.global_metrics.ghosting_rate + igData.global_metrics.ghosting_rate) / 2,
        heart_rate: (ytData.global_metrics.heart_rate + igData.global_metrics.heart_rate) / 2,
        bot_probability: Math.max(ytData.global_metrics.bot_probability || 0.05, igData.global_metrics.bot_probability || 0.05),
        niche: ytData.global_metrics.niche !== 'Unknown' ? ytData.global_metrics.niche : igData.global_metrics.niche,
        fused_core_audience: fusedCore,
        fusion_warning: fusionWarning
    },
    videos: [
        ...ytData.videos.map(v => ({ ...v, source_platform: 'youtube' })),
        ...igData.videos.map(v => ({ ...v, source_platform: 'instagram' }))
    ]
};

const outputPath = path.join(rootDir, 'data', 'latest_creator_data.json');
fs.writeFileSync(outputPath, JSON.stringify(fusedData, null, 2));

const historyPath = path.join(rootDir, 'data', `fused_${ytHandle}_${igHandle}.json`);
fs.writeFileSync(historyPath, JSON.stringify(fusedData, null, 2));

console.log(`\nFusion done. Saved to data/fused_${ytHandle}_${igHandle}.json`);
console.log(`Combined core audience: ${fusedCore}${fusionWarning ? `\n${fusionWarning}` : ''}`);
