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
    const day = s.substring(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'date_unknown';
    const parsed = new Date(`${day}T00:00:00Z`);
    return !isNaN(parsed) && parsed.toISOString().substring(0, 10) === day ? day : 'date_unknown';
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

function matchingComments(quote, allowList) {
    // One-direction only: allow-list text must contain the quote (optional whitespace normalize).
    // Bidirectional / prefix-40 reverse hatch rejected padded hallucinations.
    const q = quote.toLowerCase().replace(/\s+/g, ' ').trim();
    return allowList.filter(c => {
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
        if (!matchingComments(quote, allowList).length) {
            ungrounded.push(quote);
            // Strip *Quote:* / Quote: lines that contain this span
            const esc = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            text = text.replace(new RegExp(`^.*[*_]*Quote[*_]*:.*${esc}.*$`, 'gmi'), '');
            // Also drop bare "..." occurrences of the ungrounded span
            text = text.replace(new RegExp(`["“]${esc}["”]`, 'g'), '[quote removed: ungrounded]');
        }
    }
    // Dates next to quotes are evidence, not LLM prose. Replace them with
    // source dates on the same line; ambiguous substrings remain date_unknown.
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const quotes = extractQuotedSpans(line).filter(q => matchingComments(q, allowList).length);
        if (!quotes.length) continue;
        const dates = quotes.map(q => {
            const candidates = new Set(matchingComments(q, allowList).map(c => formatCommentDate(c.date)));
            return candidates.size === 1 ? [...candidates][0] : 'date_unknown';
        });
        // Drop standalone adjacent ISO-date labels as well as inline dates.
        for (const neighbor of [i - 1, i + 1]) {
            if (/^\s*[*_\-\s]*(?:date\s*:\s*)?\(?\d{4}-\d{2}-\d{2}\)?[*_\s]*$/i.test(lines[neighbor] || '')) {
                lines[neighbor] = '';
            }
        }
        // Preserve the surrounding pitch. Only date labels outside the quote
        // are removed; a date inside a grounded source quote stays verbatim.
        const dateRe = /\b\d{4}-\d{2}-\d{2}\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\bdate_unknown\b/gi;
        let quoteIndex = 0;
        lines[i] = line.split(/("[^"\n]{8,}"|“[^”\n]{8,}”)/g).map(part => {
            if (/^["“]/.test(part)) {
                return `${part} [source date: ${dates[quoteIndex++]}]`;
            }
            return part.replace(dateRe, '').replace(/\(\s*\)/g, '');
        }).join('');
    }
    text = lines.join('\n');
    // Collapse excessive blank lines left by stripping
    text = text.replace(/\n{3,}/g, '\n\n').trim() + (markdown ? '\n' : '');
    return { text, stripped: ungrounded.length, ungrounded };
}
