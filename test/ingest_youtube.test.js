import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { measureEngagement } from '../src/metrics.js';

// Run the CLI body with offline I/O doubles. No yt-dlp, API keys or real writes.
const source = fs.readFileSync(new URL('../src/ingest_youtube.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('import.meta.url', 'scriptUrl');

async function ingest(execSync) {
    const root = path.resolve('offline-rook');
    const rawPath = path.join(root, 'data', 'raw_fixture.json');
    const latestPath = path.join(root, 'data', 'latest_creator_data.json');
    const files = new Map([[rawPath, 'previous raw'], [latestPath, 'previous latest']]);
    const writes = [];
    const errors = [];
    const exit = new Error('CLI exit');
    let status = 0;
    const context = vm.createContext({
        execSync,
        measureEngagement,
        YoutubeTranscript: { fetchTranscript: async () => [] },
        fs: {
            mkdirSync() {},
            writeFileSync(file, value) { writes.push(file); files.set(file, value); },
        },
        path,
        scriptUrl: 'offline-script',
        fileURLToPath: () => path.join(root, 'src', 'ingest_youtube.js'),
        process: {
            argv: ['node', 'ingest_youtube.js', 'https://www.youtube.com/@fixture'],
            exit(code) { status = code; throw exit; },
        },
        console: { log() {}, error(...args) { errors.push(args.join(' ')); } },
    });
    try {
        await new vm.Script(`(async () => {\n${source}\n})()`).runInContext(context);
    } catch (error) {
        if (error !== exit) throw error;
    }
    return { status, writes, files, errors, rawPath, latestPath };
}

const metadata = JSON.stringify({
    channel_id: 'channel-fixture', channel_follower_count: 1000000,
    title: 'Fixture', view_count: 1000, comments: [],
});

test('YouTube ingest: all detail fetches fail without overwriting existing files', async () => {
    const r = await ingest(command => {
        if (command.includes('--get-id')) return 'first\nsecond';
        if (!command.includes('--write-comments')) return metadata;
        throw new Error('detail unavailable');
    });
    assert.equal(r.status, 1);
    assert.deepEqual(r.writes, []);
    assert.equal(r.files.get(r.rawPath), 'previous raw');
    assert.equal(r.files.get(r.latestPath), 'previous latest');
    assert.match(r.errors.join('\n'), /no videos fetched successfully/);
});

test('YouTube ingest: empty listing fails without overwriting existing files', async () => {
    const r = await ingest(() => '');
    assert.equal(r.status, 1);
    assert.deepEqual(r.writes, []);
});

test('YouTube ingest: sizing retries after first failure and restores channel metrics', async () => {
    let sizingAttempts = 0;
    const r = await ingest(command => {
        if (command.includes('--get-id')) return 'first\nsecond';
        if (!command.includes('--write-comments')) {
            sizingAttempts++;
            if (sizingAttempts === 1) throw new Error('sizing unavailable');
        } else {
            assert.match(command, /max-comments=200/);
        }
        return metadata;
    });
    assert.equal(r.status, 0);
    assert.equal(sizingAttempts, 2);
    assert.equal(r.writes.length, 2);
    const raw = JSON.parse(r.files.get(r.rawPath));
    assert.equal(raw.creator_id, 'channel-fixture');
    assert.equal(raw.global_metrics.subscribers, 1000000);
    assert.equal(raw.global_metrics.bot_probability, 0.8);
    assert.equal(raw.videos.length, 1);
    assert.equal(raw.videos[0].video_id, 'second');
    assert.equal(r.files.get(r.rawPath), r.files.get(r.latestPath));
});

test('YouTube ingest: ghosting counts audience comments once, excluding creator replies', async () => {
    const r = await ingest(command => {
        if (command.includes('--get-id')) return 'first';
        return JSON.stringify({
            ...JSON.parse(metadata),
            comments: [
                { id: 'a', text: 'Please explain this topic', is_favorited: true },
                { id: 'b', text: 'Another unanswered question' },
                { id: 'r1', parent: 'a', text: 'Creator response here', author_is_uploader: true },
                { id: 'r2', parent: 'a', text: 'Another creator response', author_id: 'channel-fixture' },
            ],
        });
    });
    const raw = JSON.parse(r.files.get(r.rawPath));
    assert.equal(raw.global_metrics.ghosting_rate, 0.5);
    assert.equal(raw.global_metrics.heart_rate, 0.5);
    assert.equal(raw.global_metrics.total_raw_comments_fetched, 2);
    assert.equal(raw.videos[0].top_comments.length, 2);
});

test('YouTube ingest: successful sizing is reused when a later detail fetch fails', async () => {
    let sizingAttempts = 0;
    const r = await ingest(command => {
        if (command.includes('--get-id')) return 'first\nsecond';
        if (!command.includes('--write-comments')) sizingAttempts++;
        else if (command.includes('v=second')) throw new Error('detail unavailable');
        return metadata;
    });
    assert.equal(r.status, 0);
    assert.equal(sizingAttempts, 1);
    assert.equal(JSON.parse(r.files.get(r.rawPath)).videos.length, 1);
    assert.equal(r.writes.length, 2);
});
