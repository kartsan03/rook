import { execSync } from 'child_process';
import { YoutubeTranscript } from 'youtube-transcript';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const channelUrl = args[0];
let targetNiche = 'Unknown';

const nicheIndex = args.indexOf('--niche');
if (nicheIndex !== -1 && args[nicheIndex + 1]) {
    targetNiche = args[nicheIndex + 1];
}

if (!channelUrl) {
    console.error('Error: pass a channel URL. Example: node src/ingest_youtube.js "https://www.youtube.com/@TechLead" --niche "Software Engineering & Backend"');
    process.exit(1);
}

console.log(`Scraping channel: ${channelUrl} (niche: ${targetNiche})`);

console.log('Fetching the latest video list...');
const getVideosCmd = `yt-dlp --flat-playlist --get-id --playlist-items 1-10 "${channelUrl}/videos"`;
let videoIds = [];
try {
    const result = execSync(getVideosCmd, { encoding: 'utf8' });
    videoIds = result.trim().split('\n').filter(id => id.length > 0);
    console.log(`Found ${videoIds.length} videos`);
} catch (e) {
    console.error('Error fetching the video list:', e.message);
    process.exit(1);
}

const creatorData = {
    creator_id: '',
    handle: channelUrl.split('/').pop().replace('@', ''),
    platform: 'youtube',
    global_metrics: {
        subscribers: 0,
        avg_views_last_10_videos: 0,
        total_raw_comments_fetched: 0,
        ghosting_rate: 0,
        heart_rate: 0,
        niche: targetNiche,
        bot_probability: 0.05
    },
    videos: []
};

let totalViews = 0;
let totalSubscribers = 0;
let validVideosCount = 0;
let commentLimit = 50;

let totalCommentsScanned = 0;
let totalHearts = 0;
let totalAuthorReplies = 0;

for (let i = 0; i < videoIds.length; i++) {
    const vid = videoIds[i];
    console.log(`\n[${i + 1}/${videoIds.length}] Video: ${vid}`);
    const videoUrl = `https://www.youtube.com/watch?v=${vid}`;

    try {
        if (i === 0) {
            console.log('Sizing the channel...');
            const fastMetaCmd = `yt-dlp -j --skip-download "${videoUrl}"`;
            const fastMeta = JSON.parse(execSync(fastMetaCmd, { encoding: 'utf8' }).trim());
            totalSubscribers = fastMeta.channel_follower_count || 0;
            creatorData.creator_id = fastMeta.channel_id;

            if (totalSubscribers > 500000) commentLimit = 200;
            else if (totalSubscribers > 50000) commentLimit = 100;

            console.log(`Smart scaling: ${totalSubscribers} subscribers -> ${commentLimit} comments per video.`);
        }

        const metaCmd = `yt-dlp -j --write-comments --extractor-args youtube:max-comments=${commentLimit} "${videoUrl}"`;
        const metaResult = execSync(metaCmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout: 60000 });
        const meta = JSON.parse(metaResult.trim().split('\n')[0]);

        const topComments = [];
        if (meta.comments) {
            for (const c of meta.comments) {
                totalCommentsScanned++;
                if (c.is_favorited) totalHearts++;
                if (c.author_is_uploader || c.author_id === creatorData.creator_id) {
                    totalAuthorReplies++;
                }

                if (c.text && c.text.trim().length > 0) {
                    topComments.push({
                        text: c.text,
                        date: new Date(c.timestamp * 1000).toISOString(),
                        has_heart: c.is_favorited || false
                    });
                }
            }
        }
        console.log(`Comments collected: ${topComments.length}. Hearts so far: ${totalHearts}, creator replies: ${totalAuthorReplies}`);
        creatorData.global_metrics.total_raw_comments_fetched += topComments.length;

        let transcriptText = '';
        try {
            const transcript = await YoutubeTranscript.fetchTranscript(vid);
            transcriptText = transcript.map(t => t.text).join(' ');
        } catch (err) {
            transcriptText = 'Transcript unavailable.';
        }

        creatorData.videos.push({
            video_id: vid,
            title: meta.title,
            published_at: meta.upload_date ? `${meta.upload_date.substring(0, 4)}-${meta.upload_date.substring(4, 6)}-${meta.upload_date.substring(6, 8)}T00:00:00Z` : new Date().toISOString(),
            metrics: { views: meta.view_count || 0, likes: meta.like_count || 0, comments_count: meta.comment_count || 0 },
            transcript: transcriptText,
            top_comments: topComments
        });

        totalViews += meta.view_count || 0;
        validVideosCount++;

    } catch (e) {
        console.error('Error:', e.message);
    }
}

creatorData.global_metrics.subscribers = totalSubscribers;
if (validVideosCount > 0) {
    creatorData.global_metrics.avg_views_last_10_videos = Math.floor(totalViews / validVideosCount);
}

// Ghosting = share of comments the creator neither hearted nor replied to.
const engagementRate = totalCommentsScanned > 0 ? ((totalHearts + totalAuthorReplies) / totalCommentsScanned) : 0;
creatorData.global_metrics.heart_rate = totalCommentsScanned > 0 ? (totalHearts / totalCommentsScanned) : 0;
creatorData.global_metrics.ghosting_rate = 1 - Math.min(1, engagementRate);

// A channel whose recent videos reach almost none of its subscribers is
// likely botted or decayed; downstream math cuts conversion for it.
if (totalSubscribers > 0) {
    const viewToSubRatio = creatorData.global_metrics.avg_views_last_10_videos / totalSubscribers;
    if (viewToSubRatio < 0.01) creatorData.global_metrics.bot_probability = 0.8;
    else if (viewToSubRatio < 0.05) creatorData.global_metrics.bot_probability = 0.4;
    else creatorData.global_metrics.bot_probability = 0.05;
}

const historyPath = path.join(rootDir, 'data', `raw_${creatorData.handle}.json`);
fs.writeFileSync(historyPath, JSON.stringify(creatorData, null, 2));

const flowPath = path.join(rootDir, 'data', 'latest_creator_data.json');
fs.writeFileSync(flowPath, JSON.stringify(creatorData, null, 2));

console.log(`\nIngestion done. Saved to data/raw_${creatorData.handle}.json`);
console.log(`Ghosting Rate: ${(creatorData.global_metrics.ghosting_rate * 100).toFixed(1)}%`);
