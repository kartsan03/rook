const emojiOnly = /^[\p{Emoji}\s]+$/u;
const noiseWords = ['спасибо', 'thanks', 'thank you', 'धन्यवाद', 'obrigado', 'класс', 'круто', 'cool', 'awesome'];

// A comment carries signal if it is long enough, not emoji-only,
// and not a short thank-you/praise in any of the covered languages.
export function isSignal(text) {
    const t = text.trim();
    if (t.length < 10) return false;
    if (emojiOnly.test(t)) return false;
    if (t.length < 20 && noiseWords.some(w => t.toLowerCase().includes(w))) return false;
    return true;
}

/** Normalize a comment date for prompts: missing → date_unknown. */
export function formatCommentDate(date) {
    if (date == null || date === '') return 'date_unknown';
    const s = String(date);
    if (s === 'date_unknown' || s.startsWith('Invalid')) return 'date_unknown';
    return s.substring(0, 10);
}

/**
 * Build a numbered allow-list of filtered, deduped comments across videos.
 * Quotes in LLM output must be substrings of these texts.
 */
export function buildQuoteAllowList(videos) {
    const allowList = [];
    const seen = new Set();
    (videos || []).forEach((video, videoIndex) => {
        for (const comment of video.top_comments || []) {
            const text = (comment.text || '').trim();
            if (!isSignal(text)) continue;
            const dedupKey = text.substring(0, 50).toLowerCase();
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            allowList.push({
                id: allowList.length + 1,
                text,
                date: formatCommentDate(comment.date),
                videoIndex,
                has_heart: !!comment.has_heart,
            });
        }
    });
    return allowList;
}

export function formatAllowListForPrompt(allowList) {
    if (!allowList.length) return '(no signal comments)';
    return allowList.map(c => {
        const heart = c.has_heart ? ' [hearted by creator]' : '';
        return `[${c.id}] (${c.date}) ${c.text}${heart}`;
    }).join('\n');
}

/** Pull quoted strings from markdown (straight or curly double quotes). */
export function extractQuotedSpans(markdown) {
    if (!markdown) return [];
    const spans = [];
    const re = /"([^"\n]{8,})"|“([^”\n]{8,})”/g;
    let m;
    while ((m = re.exec(markdown)) !== null) {
        spans.push((m[1] || m[2]).trim());
    }
    return spans;
}

function isGrounded(quote, allowList) {
    // One-direction only: allow-list text must contain the quote (optional whitespace normalize).
    // Bidirectional / prefix-40 reverse hatch rejected padded hallucinations.
    const q = quote.toLowerCase().replace(/\s+/g, ' ').trim();
    return allowList.some(c => {
        const allow = c.text.toLowerCase().replace(/\s+/g, ' ').trim();
        return allow.includes(q);
    });
}

/**
 * Post-validate: every substantial quote must appear in the allow-list.
 * Ungrounded quotes are stripped (line or *Quote:* bullets removed).
 * Returns { text, stripped, ungrounded }.
 */
export function groundQuotes(markdown, allowList) {
    const ungrounded = [];
    let text = markdown || '';
    const spans = extractQuotedSpans(text);
    for (const quote of spans) {
        if (!isGrounded(quote, allowList)) {
            ungrounded.push(quote);
            // Strip *Quote:* / Quote: lines that contain this span
            const esc = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text.replace(new RegExp(`^.*[*_]*Quote[*_]*:.*${esc}.*$`, 'gmi'), '');
            // Also drop bare "..." occurrences of the ungrounded span
            text = text.replace(new RegExp(`["“]${esc}["”]`, 'g'), '[quote removed: ungrounded]');
        }
    }
    // Collapse excessive blank lines left by stripping
    text = text.replace(/\n{3,}/g, '\n\n').trim() + (markdown ? '\n' : '');
    return { text, stripped: ungrounded.length, ungrounded };
}
