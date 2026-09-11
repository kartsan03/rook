import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildQuoteAllowList,
    formatCommentDate,
    extractQuotedSpans,
    groundQuotes,
    formatAllowListForPrompt,
} from '../src/comment_filter.js';

test('formatCommentDate: null/empty → date_unknown', () => {
    assert.equal(formatCommentDate(null), 'date_unknown');
    assert.equal(formatCommentDate(''), 'date_unknown');
    assert.equal(formatCommentDate('2026-06-14T12:00:00Z'), '2026-06-14');
});

test('buildQuoteAllowList: numbered, filtered, deduped', () => {
    const videos = [{
        top_comments: [
            { text: 'Do you have a program I can just buy? I need structure', date: '2026-06-14T00:00:00Z' },
            { text: 'thanks', date: null },
            { text: 'Do you have a program I can just buy? I need structure', date: '2026-06-15T00:00:00Z' },
            { text: 'Please cover nutrition macros in a dedicated video soon', date: null },
        ],
    }];
    const list = buildQuoteAllowList(videos);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 1);
    assert.equal(list[1].date, 'date_unknown');
    assert.match(formatAllowListForPrompt(list), /^\[1\]/);
});

test('groundQuotes: keeps grounded, strips invented', () => {
    const allow = buildQuoteAllowList([{
        top_comments: [
            { text: 'Do you have a program I can just buy? I need structure', date: '2026-06-14T00:00:00Z' },
        ],
    }]);
    const md = `## 2
*   *Quote:* "Do you have a program I can just buy? I need structure"
*   *Quote:* "This invented quote never appeared in comments at all"
`;
    const { text, stripped, ungrounded } = groundQuotes(md, allow);
    assert.equal(stripped, 1);
    assert.equal(ungrounded.length, 1);
    assert.match(text, /Do you have a program/);
    assert.doesNotMatch(text, /This invented quote never appeared/);
});

test('extractQuotedSpans finds curly quotes too', () => {
    const spans = extractQuotedSpans('Said “hello there friend” and "another long enough quote here"');
    assert.equal(spans.length, 2);
});

test('groundQuotes: padded hallucination (allow-prefix + invention) strips', () => {
    const allow = buildQuoteAllowList([{
        top_comments: [
            { text: 'Do you have a program I can just buy? I need structure', date: '2026-06-14T00:00:00Z' },
        ],
    }]);
    // Reverse/prefix hatch would wrongly accept this; one-direction must reject.
    const md = `*Quote:* "Do you have a program I can just buy? I need structure AND also your secret NFT drop"\n`;
    const { text, stripped, ungrounded } = groundQuotes(md, allow);
    assert.equal(stripped, 1);
    assert.equal(ungrounded.length, 1);
    assert.match(ungrounded[0], /secret NFT drop/);
    assert.doesNotMatch(text, /secret NFT drop/);
    // Quote:* line path strips the whole bullet (no placeholder left).
    assert.ok(!text.includes('NFT'));
});
