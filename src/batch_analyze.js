import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const listFilePath = args[0];
let defaultNiche = 'Unknown';

const nicheIndex = args.indexOf('--niche');
if (nicheIndex !== -1 && args[nicheIndex + 1]) {
    defaultNiche = args[nicheIndex + 1];
}

if (!listFilePath) {
    console.error('Error: pass a path to a targets file.');
    console.error('Example: node src/batch_analyze.js targets.txt --niche "Fitness & Health"');
    process.exit(1);
}

const absoluteListPath = path.resolve(listFilePath);
if (!fs.existsSync(absoluteListPath)) {
    console.error(`Error: file not found: ${absoluteListPath}`);
    process.exit(1);
}

console.log(`Batch analysis from: ${absoluteListPath}`);

// Normalize any YouTube input (handle, channel URL, watch URL) to a channel URL.
function cleanYoutubeInput(input) {
    let clean = input.trim();

    if (clean.startsWith('v=') || clean.startsWith('watch?v=')) {
        clean = 'https://www.youtube.com/watch?' + clean;
    }

    if (clean.endsWith('/')) {
        clean = clean.slice(0, -1);
    }

    if (clean.endsWith('/videos')) clean = clean.slice(0, -7);
    if (clean.endsWith('/featured')) clean = clean.slice(0, -9);
    if (clean.endsWith('/shorts')) clean = clean.slice(0, -7);
    if (clean.endsWith('/streams')) clean = clean.slice(0, -8);

    // A single video URL: resolve the uploading channel via yt-dlp
    if (clean.includes('watch?v=') || clean.includes('youtu.be/')) {
        try {
            console.log(`Resolving channel for video: ${clean}...`);
            const uploaderId = execSync(`yt-dlp -O uploader_id "${clean}"`, { encoding: 'utf8' }).trim();
            if (uploaderId && uploaderId !== 'NA') {
                const handle = uploaderId.startsWith('@') ? uploaderId : `@${uploaderId}`;
                console.log(`   Channel found: ${handle}`);
                return `https://www.youtube.com/${handle}`;
            }
        } catch (e) {
            console.error(`   Could not resolve the channel via yt-dlp: ${e.message}`);
        }
    }

    if (clean.includes('youtube.com') || clean.includes('youtu.be')) {
        return clean;
    }
    if (!clean.startsWith('@')) {
        clean = '@' + clean;
    }
    return `https://www.youtube.com/${clean}`;
}

// Normalize an Instagram input (username, @username, or profile URL) to a bare username.
function cleanInstagramInput(input) {
    let clean = input.trim();
    if (clean.endsWith('/')) {
        clean = clean.slice(0, -1);
    }
    if (clean.includes('instagram.com/')) {
        const parts = clean.split('instagram.com/');
        const username = parts[1].split('?')[0].split('/')[0];
        return username.replace('@', '');
    }
    return clean.replace('@', '');
}

// Read targets
let rawTargets = [];
const fileContent = fs.readFileSync(absoluteListPath, 'utf8');

if (listFilePath.endsWith('.json')) {
    try {
        const jsonTargets = JSON.parse(fileContent);
        rawTargets = jsonTargets.map(t => {
            if (t.platform === 'multi') {
                return {
                    platform: 'multi',
                    ytUrl: cleanYoutubeInput(t.ytUrl || t.url),
                    igUsername: cleanInstagramInput(t.igUsername || t.username),
                    niche: t.niche || defaultNiche
                };
            } else if (t.platform === 'instagram' || t.igUsername || (t.platform === undefined && t.username && !t.url)) {
                return {
                    platform: 'instagram',
                    username: cleanInstagramInput(t.username || t.url),
                    niche: t.niche || defaultNiche
                };
            } else {
                return {
                    platform: 'youtube',
                    url: cleanYoutubeInput(t.url || t.username),
                    niche: t.niche || defaultNiche
                };
            }
        });
    } catch (e) {
        console.error('Error parsing the JSON targets file:', e.message);
        process.exit(1);
    }
} else {
    // Text file, one target per line
    const lines = fileContent.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
    for (const line of lines) {
        if (line === 'https://www.youtube.com/watch?' || line === 'https://www.youtube.com/watch') {
            console.log(`Skipping incomplete URL: ${line}`);
            continue;
        }

        // Fusion format: yt_input | ig_input
        if (line.includes('|')) {
            const parts = line.split('|');
            rawTargets.push({
                platform: 'multi',
                ytUrl: cleanYoutubeInput(parts[0].trim()),
                igUsername: cleanInstagramInput(parts[1].trim()),
                niche: defaultNiche
            });
        } else if (line.includes('instagram.com') || line.startsWith('ig:')) {
            const cleanIg = line.startsWith('ig:') ? line.substring(3) : line;
            rawTargets.push({
                platform: 'instagram',
                username: cleanInstagramInput(cleanIg),
                niche: defaultNiche
            });
        } else {
            const cleanYt = line.startsWith('yt:') ? line.substring(3) : line;
            rawTargets.push({
                platform: 'youtube',
                url: cleanYoutubeInput(cleanYt),
                niche: defaultNiche
            });
        }
    }
}

// Deduplicate targets
const seen = new Set();
const targets = [];
for (const t of rawTargets) {
    let key = '';
    if (t.platform === 'multi') {
        key = `multi:${t.ytUrl}|${t.igUsername}`;
    } else if (t.platform === 'youtube') {
        key = `youtube:${t.url}`;
    } else {
        key = `instagram:${t.username}`;
    }

    if (!seen.has(key)) {
        seen.add(key);
        targets.push(t);
    } else {
        console.log(`Duplicate removed from the list: ${key.split(':')[1]}`);
    }
}

console.log(`Targets to analyze: ${targets.length}`);
targets.forEach((t, idx) => {
    if (t.platform === 'multi') {
        console.log(`  [${idx + 1}] FUSION: YT: ${t.ytUrl} | IG: @${t.igUsername} (${t.niche})`);
    } else if (t.platform === 'youtube') {
        console.log(`  [${idx + 1}] YOUTUBE: ${t.url} (${t.niche})`);
    } else {
        console.log(`  [${idx + 1}] INSTAGRAM: @${t.username} (${t.niche})`);
    }
});

const summary = [];

for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    console.log(`\n================================================================`);
    console.log(`[${i + 1}/${targets.length}] Processing: ${target.platform.toUpperCase()}`);
    console.log(`================================================================`);

    try {
        let handle = '';
        let rawDataPath = '';

        if (target.platform === 'youtube') {
            handle = target.url.split('/').pop().replace('@', '');
            rawDataPath = path.join(rootDir, 'data', `raw_${handle}.json`);

            console.log(`Ingesting YouTube data for ${handle}...`);
            execSync(`node src/ingest_youtube.js "${target.url}" --niche "${target.niche}"`, { stdio: 'inherit', cwd: rootDir });

        } else if (target.platform === 'instagram') {
            const username = target.username;
            handle = `@${username}`;
            rawDataPath = path.join(rootDir, 'data', `raw_ig_${username}.json`);

            console.log(`Ingesting Instagram data for @${username}...`);
            execSync(`node src/ingest_instagram_apify.js "${username}" --niche "${target.niche}"`, { stdio: 'inherit', cwd: rootDir });

        } else if (target.platform === 'multi') {
            const ytHandle = target.ytUrl.split('/').pop().replace('@', '');
            handle = ytHandle;
            rawDataPath = path.join(rootDir, 'data', `fused_${ytHandle}_${target.igUsername}.json`);

            console.log(`[Fusion 1/3] Ingesting YouTube for ${ytHandle}...`);
            execSync(`node src/ingest_youtube.js "${target.ytUrl}" --niche "${target.niche}"`, { stdio: 'inherit', cwd: rootDir });

            console.log(`[Fusion 2/3] Ingesting Instagram for @${target.igUsername}...`);
            execSync(`node src/ingest_instagram_apify.js "${target.igUsername}" --niche "${target.niche}"`, { stdio: 'inherit', cwd: rootDir });

            console.log(`[Fusion 3/3] Fusing the data...`);
            execSync(`node src/fusion_data.js "${ytHandle}" "${target.igUsername}"`, { stdio: 'inherit', cwd: rootDir });
        }

        // Analyze the specific raw file so parallel/previous runs cannot bleed into this one
        console.log(`Building The Brief for ${handle}...`);
        execSync(`node src/process_brief.js "${rawDataPath}"`, { stdio: 'inherit', cwd: rootDir });

        console.log(`Building the Master Dossier for ${handle}...`);
        execSync(`node src/process_logic.js "${rawDataPath}"`, { stdio: 'inherit', cwd: rootDir });

        console.log(`Done: ${handle}`);
        summary.push({ handle, platform: target.platform, status: 'SUCCESS' });

    } catch (err) {
        console.error(`Error while processing:`, err.message);
        summary.push({
            handle: target.platform === 'youtube' ? target.url : (target.platform === 'instagram' ? target.username : `${target.ytUrl}|${target.igUsername}`),
            platform: target.platform,
            status: 'FAILED',
            error: err.message
        });

        if (err.message.includes('Apify') || err.message.includes('credit') || err.message.includes('billing')) {
            console.log('Apify error detected. YouTube-only targets can still be processed.');
        }
    }
}

console.log(`\n================================================================`);
console.log(`Batch analysis finished`);
console.log(`================================================================`);
let successCount = 0;
summary.forEach((s, idx) => {
    if (s.status === 'SUCCESS') successCount++;
    console.log(`  [${idx + 1}] ${s.handle} (${s.platform}): ${s.status}${s.status === 'FAILED' ? ` (error: ${s.error})` : ''}`);
});
console.log(`\nSucceeded: ${successCount}/${targets.length}`);
