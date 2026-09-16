import { createHash } from 'node:crypto';

// Bind a Brief to the exact parsed input, not just the creator's handle.
export function briefSourceMarker(data) {
    const hash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return `<!-- rook-source-sha256: ${hash} -->`;
}

export function assertCurrentBrief(brief, data) {
    if (!brief.trimEnd().endsWith(briefSourceMarker(data))) {
        throw new Error('Brief is stale or has no source fingerprint. Run process_brief.js for this data file first.');
    }
}

export function requireGeneratedText(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('LLM returned empty text; refusing to save an empty analysis.');
    }
    return text;
}
