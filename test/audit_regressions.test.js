import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { briefSourceMarker, assertCurrentBrief, requireGeneratedText } from '../src/artifact_guard.js';
import { measureEngagement, measuredCore, measuredViews, pooledEngagement, botBucket,
    buildComputedMetrics, formatComputedMetricsBlock, estimateRevenue, buildFinancialBlock,
    scrubUnexpectedDollars } from '../src/metrics.js';
import { groundQuotes, formatCommentDate } from '../src/comment_filter.js';
import vm from 'node:vm';
import * as metrics from '../src/metrics.js';
import * as quotes from '../src/comment_filter.js';
import * as guards from '../src/artifact_guard.js';

const root = path.resolve('offline-rook');

// Execute the real CLI body with in-memory files and injected API doubles.
async function runCli(script, { args = [], files = new Map(), doubles = {}, env = {} } = {}) {
    const source = fs.readFileSync(new URL(`../src/${script}`, import.meta.url), 'utf8')
        .replace(/^import\s[\s\S]*?;\r?\n/gm, '')
        .replaceAll('import.meta.url', 'scriptUrl')
        .replace(/^run\(\);$/m, 'await run();');
    const writes = [];
    const logs = [];
    const exit = new Error('CLI exit');
    const process = { argv: ['node', script, ...args], env, exitCode: 0,
        exit(code) { this.exitCode = code; throw exit; } };
    const context = vm.createContext({
        ...metrics, ...quotes, ...guards,
        path, scriptUrl: 'offline-script',
        fileURLToPath: () => path.join(root, 'src', script),
        process,
        fs: {
            existsSync: file => files.has(file),
            readFileSync(file) {
                if (!files.has(file)) throw new Error(`Missing fixture: ${file}`);
                return files.get(file);
            },
            mkdirSync() {},
            writeFileSync(file, text) { writes.push(file); files.set(file, text); },
        },
        console: Object.fromEntries(['log', 'error', 'warn'].map(key => [key, (...args) => logs.push(args.join(' '))])),
        ...doubles,
    });
    try {
        await new vm.Script(`(async () => {\n${source}\n})()`).runInContext(context);
    } catch (error) {
        if (error !== exit) throw error;
    }
    return { status: process.exitCode, writes, files, logs };
}

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/raw_fixture_anon.json', import.meta.url), 'utf8'));
const rawPath = path.join(root, 'data', 'raw_fixture.json');
const briefPath = path.join(root, 'audits', `the_brief_${raw.handle}.md`);
function inputFiles(data = raw) {
    return new Map([
        [rawPath, JSON.stringify(data)],
        [briefPath, `# Previous Brief\n${briefSourceMarker(data)}\n`],
        [path.join(root, 'config', 'mock_benchmarks.json'), fs.readFileSync(new URL('../config/mock_benchmarks.json', import.meta.url), 'utf8')],
    ]);
}
const generated = text => ({ text, model: 'offline', provider: 'offline' });

test('F4: source fingerprint rejects changed input and legacy Briefs', () => {
    const brief = `Brief\n${briefSourceMarker(raw)}`;
    assert.doesNotThrow(() => assertCurrentBrief(brief, raw));
    assert.throws(() => assertCurrentBrief(brief, { ...raw, platform: 'multi' }), /stale/);
    assert.throws(() => assertCurrentBrief('Legacy Brief', raw), /fingerprint/);
    for (const text of ['', ' \n ', null, undefined]) assert.throws(() => requireGeneratedText(text), /empty/);
});

test('F4: empty Brief response fails without overwriting previous artifact', async () => {
    const files = inputFiles();
    const previous = files.get(briefPath);
    const r = await runCli('process_brief.js', { files, args: [rawPath], doubles: { generate: async () => generated('  ') } });
    assert.equal(r.status, 1);
    assert.deepEqual(r.writes, []);
    assert.equal(files.get(briefPath), previous);
});

test('F4: saved Brief is source-bound and accepted by dossier CLI', async () => {
    const files = inputFiles();
    const r = await runCli('process_brief.js', { files, args: [rawPath], doubles: { generate: async () => generated('# The Brief\nAnalysis') } });
    assert.equal(r.status, 0);
    assertCurrentBrief(files.get(briefPath), raw);
    const dossier = await runCli('process_logic.js', { files, args: [rawPath], doubles: { generate: async () => generated('# Dossier\n## 1. Diagnosis\n## 5. Pitch') } });
    assert.equal(dossier.status, 0);
    assert.ok(dossier.writes.some(p => p.includes('investment_brief_')));
});

test('F4: stale Brief stops dossier before any LLM call', async () => {
    const files = inputFiles();
    files.set(rawPath, JSON.stringify({ ...raw, platform: 'multi' }));
    const r = await runCli('process_logic.js', { files, args: [rawPath], doubles: { generate() { throw new Error('Must not call'); } } });
    assert.equal(r.status, 1);
    assert.deepEqual(r.writes, []);
    assert.match(r.logs.join('\n'), /stale/);
});

for (const emptyPass of [1, 2, 3]) {
    test(`F4: empty dossier pass ${emptyPass} fails without a final dossier`, async () => {
        let calls = 0;
        const r = await runCli('process_logic.js', { files: inputFiles(), args: [rawPath], doubles: {
            generate: async () => generated(++calls === emptyPass ? '' : 'Valid draft'),
        } });
        assert.equal(r.status, 1);
        assert.equal(calls, emptyPass);
        assert.ok(r.writes.every(p => !p.includes('investment_brief_')));
    });
}

test('F5: union of hearts/replies, repeated IDs and empty sample', () => {
    const r = measureEngagement([
        { id: 'a', text: 'Question A', has_heart: true },
        { id: 'a', text: 'Question A', has_heart: true },
        { id: 'b', text: 'Question B' },
        { id: 'c', text: 'Question C' },
        { id: 'r1', text: 'Answer A', is_creator: true, parent_id: 'a' },
        { id: 'r2', text: 'Answer B', is_creator: true, parent_id: 'b' },
        { id: 'r3', text: 'More B', is_creator: true, parent_id: 'b' },
    ]);
    assert.equal(r.audience.length, 3);
    assert.equal(r.hearted, 1);
    assert.equal(r.acknowledged, 2);
    assert.equal(r.ghosting_rate, 1 - 2 / 3);
    assert.equal(measureEngagement([]).ghosting_rate, null);
    assert.equal(pooledEngagement([
        { total_raw_comments_fetched: 1, ghosting_rate: 0 },
        { total_raw_comments_fetched: 9, ghosting_rate: 1 },
    ], 'ghosting_rate'), 0.9);
});

test('F6: quote dates come from matching source, surrounding pitch survives', () => {
    const allow = [{ text: 'Please explain this topic in detail', date: '2020-01-02' }];
    const r = groundQuotes('Your audience asked "Please explain this topic" (2026-06-14). We can help.', allow);
    assert.match(r.text, /Your audience asked/);
    assert.match(r.text, /We can help/);
    assert.match(r.text, /source date: 2020-01-02/);
    assert.doesNotMatch(r.text, /2026-06-14/);
    const unknown = groundQuotes('"Please explain this topic" June 14, 2026', [{ ...allow[0], date: null }]);
    assert.match(unknown.text, /source date: date_unknown/);
    assert.doesNotMatch(unknown.text, /June 14/);
    const ambiguous = groundQuotes('"Please explain this topic"', [...allow, { ...allow[0], date: '2021-01-02' }]);
    assert.match(ambiguous.text, /date_unknown/);
    assert.equal(formatCommentDate('2026-02-30'), 'date_unknown');
});

test('F6: removes adjacent date labels without removing real dates inside quotes', () => {
    const allow = [{ text: 'The course on 2020-01-01 helped a lot', date: '2020-01-02' }];
    const r = groundQuotes('Date: 2026-01-01\n"The course on 2020-01-01 helped a lot"\n(2026-02-02)', allow);
    assert.doesNotMatch(r.text, /2026/);
    assert.match(r.text, /2020-01-01/);
    assert.match(r.text, /source date: 2020-01-02/);
});

test('F7: magnitude suffixes cannot borrow an allowed numeric prefix', () => {
    const r = scrubUnexpectedDollars('Keep $100. Reject $100 million, $100M, $100 billion, $100k, $100.50.', ['$100']);
    assert.equal(r.stripped, 5);
    assert.match(r.text, /Keep \$100/);
    assert.doesNotMatch(r.text, /million|billion|\$100[Mk]/);
});

test('F8: no-signal Brief and dossier return skip, not success', async () => {
    const data = { ...raw, videos: [] };
    for (const script of ['process_brief.js', 'process_logic.js']) {
        const r = await runCli(script, { files: inputFiles(data), args: [rawPath], doubles: { generate() { throw new Error('Must not call'); } } });
        assert.equal(r.status, 2);
        assert.deepEqual(r.writes, []);
    }
});

for (const [failure, expectedStatus, label] of [[null, 0, 'SUCCESS'], [1, 1, 'FAILED'], [2, 2, 'SKIPPED']]) {
    test(`F8: batch ${label} has matching process exit status`, async () => {
        const list = path.join(root, 'targets.txt');
        const r = await runCli('batch_analyze.js', { args: [list], files: new Map([[list, 'fixture']]), doubles: {
            execSync(command) {
                if (failure && command.includes('process_brief')) throw Object.assign(new Error('Child exit'), { status: failure });
            },
        } });
        assert.equal(r.status, expectedStatus);
        assert.match(r.logs.join('\n'), new RegExp(`: ${label}`));
        if (failure) assert.doesNotMatch(r.logs.join('\n'), /: SUCCESS/);
    });
}

test('F8: ingestion exit 2 is a failure, not a no-signal skip', async () => {
    const list = path.join(root, 'targets.txt');
    const r = await runCli('batch_analyze.js', { args: [list], files: new Map([[list, 'fixture']]), doubles: {
        execSync() { throw Object.assign(new Error('Ingest usage error'), { status: 2 }); },
    } });
    assert.equal(r.status, 1);
    assert.match(r.logs.join('\n'), /: FAILED/);
});

test('F9: fusion excludes legacy proxy reach and weights sampled engagement', async () => {
    const yt = { ...raw, global_metrics: { ...raw.global_metrics, total_raw_comments_fetched: 1, ghosting_rate: 0 } };
    const ig = { ...raw, platform: 'instagram', global_metrics: { ...raw.global_metrics, total_raw_comments_fetched: 9, ghosting_rate: 1 },
        videos: [{ metrics: { views: 10000000, likes: 1000000 } }] };
    const files = new Map([
        [path.join(root, 'data', 'raw_fixture.json'), JSON.stringify(yt)],
        [path.join(root, 'data', 'raw_ig_fixture.json'), JSON.stringify(ig)],
    ]);
    const r = await runCli('fusion_data.js', { args: ['fixture', 'fixture'], files });
    assert.equal(r.status, 0);
    const data = JSON.parse(files.get(path.join(root, 'data', 'fused_fixture_fixture.json')));
    assert.equal(data.global_metrics.fused_core_audience, 22000);
    assert.equal(data.global_metrics.ghosting_rate, 0.9);
    assert.equal(data.global_metrics.bot_probability, null);
    assert.match(data.global_metrics.fusion_warning, /coverage incomplete/);
    assert.doesNotMatch(data.global_metrics.fusion_warning, /DEAD AUDIENCE PENALTY/);
});

test('F9: no proxy or unknown-to-zero coercion in metrics and revenue', () => {
    const legacy = { metrics: { views: 90000, likes: 9000 } };
    assert.equal(measuredViews(legacy, 'instagram'), null);
    assert.equal(measuredCore([legacy], 'instagram'), null);
    assert.equal(measuredCore([{ metrics: { views: 0, views_source: 'videoPlayCount' } }], 'instagram'), 0);
    assert.equal(botBucket(null), 'unknown');
    const metrics = buildComputedMetrics({ snr: 10, coreAudienceViews: null, botProbability: null });
    assert.match(formatComputedMetricsBlock(metrics), /unknown \(no measured views\)/);
    assert.doesNotMatch(formatComputedMetricsBlock(metrics), /p=0%/);
    assert.equal(estimateRevenue({ coreViews: null }).moderate, null);
    assert.match(buildFinancialBlock({ coreAudienceViews: null }), /unavailable/);
});

test('F9: photo-only dossier reports unavailable revenue, not $0', async () => {
    const data = { ...raw, platform: 'instagram', videos: raw.videos.map(v => ({ ...v, metrics: { views: null } })) };
    const r = await runCli('process_logic.js', { files: inputFiles(data), args: [rawPath], doubles: {
        generate: async prompt => {
            assert.match(prompt, /unavailable/);
            return generated('# Dossier\n## 5. Pitch');
        },
    } });
    assert.equal(r.status, 0);
    const output = r.files.get(r.writes.find(p => p.includes('investment_brief_')));
    assert.match(output, /Revenue estimate unavailable/);
    assert.match(output, /Bot bucket\*\*: unknown/);
    assert.doesNotMatch(output, /\$0/);
});

test('F5/F9: Instagram ingest uses measured plays and matched audience acknowledgement', async () => {
    const profile = { id: 'ig', username: 'fixture', followersCount: 1000, latestPosts: [
        { id: 'p', shortCode: 'photo', type: 'Image', likesCount: 500 },
        { id: 'v', shortCode: 'video', type: 'Video', videoPlayCount: 0, likesCount: 200 },
    ] };
    const comments = [
        { id: 'a', postUrl: '/p/photo/', text: 'A real audience question', ownerLiked: true, replies: [{ ownerUsername: 'fixture' }] },
        { id: 'b', postUrl: '/p/photo/', text: 'Unanswered audience question' },
        { id: 'r', postUrl: '/p/photo/', text: 'Creator reply', ownerUsername: 'fixture', parentCommentId: 'a' },
    ];
    class ApifyClient {
        actor(name) { return { call: async () => ({ defaultDatasetId: name }) }; }
        dataset(name) { return { listItems: async () => ({ items: name.includes('profile') ? [profile] : comments }) }; }
    }
    const r = await runCli('ingest_instagram_apify.js', { args: ['fixture'], doubles: { ApifyClient }, env: { APIFY_TOKEN: 'offline' } });
    assert.equal(r.status, 0);
    const data = JSON.parse(r.files.get(path.join(root, 'data', 'raw_ig_fixture.json')));
    assert.equal(data.videos[0].metrics.views, null);
    assert.equal(data.videos[1].metrics.views, 0);
    assert.equal(data.global_metrics.bot_probability, null);
    assert.equal(data.global_metrics.ghosting_rate, 0.5);
    assert.equal(data.global_metrics.total_raw_comments_fetched, 2);
});
