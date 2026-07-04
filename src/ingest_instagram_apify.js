import { ApifyClient } from 'apify-client';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const username = args[0];
let targetNiche = 'Unknown';

const nicheIndex = args.indexOf('--niche');
if (nicheIndex !== -1 && args[nicheIndex + 1]) {
    targetNiche = args[nicheIndex + 1];
}

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!username || !APIFY_TOKEN) {
    console.error('Error: pass a username and set APIFY_TOKEN in .env. Example: node src/ingest_instagram_apify.js "vladziz" --niche "Fitness & Health"');
    process.exit(1);
}

const client = new ApifyClient({ token: APIFY_TOKEN });
// Whisper transcription of Reels is optional; without an OpenAI key videos keep "Transcript unavailable."
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function run() {
    console.log(`[1/4] Running profile scraper for @${username} (niche: ${targetNiche})`);

    try {
        const profileRun = await client.actor('apify/instagram-profile-scraper').call({
            usernames: [username],
            resultsLimit: 15,
        });

        const { items: profileItems } = await client.dataset(profileRun.defaultDatasetId).listItems();
        const profile = profileItems[0];
        if (!profile) throw new Error('Profile not found.');

        console.log(`Profile loaded. Followers: ${profile.followersCount}`);

        const creatorData = {
            creator_id: profile.id,
            handle: `@${profile.username}`,
            platform: 'instagram',
            global_metrics: {
                subscribers: profile.followersCount,
                avg_views_last_10_videos: 0,
                total_raw_comments_fetched: 0,
                ghosting_rate: 0,
                heart_rate: 0,
                niche: targetNiche,
                bot_probability: 0.05
            },
            videos: []
        };

        const postUrls = (profile.latestPosts || []).map(p => `https://www.instagram.com/p/${p.shortCode}/`);

        console.log(`[2/4] Running comment scraper for ${postUrls.length} posts...`);
        const commentRun = await client.actor('apify/instagram-comment-scraper').call({
            directUrls: postUrls,
            resultsLimit: 100,
        });
        const { items: allComments } = await client.dataset(commentRun.defaultDatasetId).listItems();
        console.log(`Collected ${allComments.length} comments.`);

        console.log('[3/4] Processing posts, transcribing videos (Whisper)...');
        const posts = profile.latestPosts || [];
        let totalViews = 0;
        let videoCount = 0;
        let totalHearts = 0;
        let totalAuthorReplies = 0;

        for (const post of posts) {
            const shortCode = post.shortCode;
            const postComments = allComments
                .filter(c => c.postUrl && c.postUrl.includes(shortCode))
                .map(c => {
                    if (c.ownerLiked) totalHearts++;
                    if (c.ownerUsername === profile.username) totalAuthorReplies++;
                    return {
                        text: c.text,
                        date: c.timestamp,
                        has_heart: c.ownerLiked || false
                    };
                });

            let transcriptText = 'Transcript unavailable.';

            if (post.type === 'Video' && post.videoUrl && openai) {
                try {
                    const tempAudioPath = path.join(rootDir, 'data', `temp_${shortCode}.mp3`);
                    console.log(`   Extracting audio for ${shortCode}...`);
                    execSync(`yt-dlp -x --audio-format mp3 -o "${tempAudioPath}" "${post.videoUrl}"`);

                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(tempAudioPath),
                        model: 'whisper-1',
                    });
                    transcriptText = transcription.text;
                    console.log(`   Whisper OK: ${transcriptText.substring(0, 30)}...`);
                    fs.unlinkSync(tempAudioPath);
                } catch (err) {
                    console.log(`   Whisper skipped: ${err.message}`);
                }
            }

            creatorData.videos.push({
                video_id: post.id,
                title: post.caption || 'No caption',
                published_at: post.timestamp,
                metrics: {
                    // Photo posts have no play count; likes x10 is a rough reach proxy.
                    views: post.videoPlayCount || (post.likesCount ? post.likesCount * 10 : 0),
                    likes: post.likesCount,
                    comments_count: post.commentsCount
                },
                transcript: transcriptText,
                top_comments: postComments
            });

            totalViews += post.videoPlayCount || (post.likesCount ? post.likesCount * 10 : 0);
            videoCount++;
            creatorData.global_metrics.total_raw_comments_fetched += postComments.length;
        }

        // Ghosting = share of comments the creator neither hearted nor replied to.
        if (creatorData.global_metrics.total_raw_comments_fetched > 0) {
            const engagementRate = (totalHearts + totalAuthorReplies) / creatorData.global_metrics.total_raw_comments_fetched;
            creatorData.global_metrics.heart_rate = totalHearts / creatorData.global_metrics.total_raw_comments_fetched;
            creatorData.global_metrics.ghosting_rate = 1 - Math.min(1, engagementRate);
        }

        if (videoCount > 0) {
            creatorData.global_metrics.avg_views_last_10_videos = Math.floor(totalViews / videoCount);
        }

        const historyPath = path.join(rootDir, 'data', `raw_ig_${username}.json`);
        fs.writeFileSync(historyPath, JSON.stringify(creatorData, null, 2));
        fs.writeFileSync(path.join(rootDir, 'data', 'latest_creator_data.json'), JSON.stringify(creatorData, null, 2));

        console.log(`\n[4/4] Ingestion done. Saved to data/raw_ig_${username}.json`);
        console.log(`Ghosting Rate: ${(creatorData.global_metrics.ghosting_rate * 100).toFixed(1)}%`);

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

run();
