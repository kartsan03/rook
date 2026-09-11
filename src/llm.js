import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import 'dotenv/config';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ALLOW_FALLBACK = process.env.ROOK_ALLOW_LLM_FALLBACK === '1';

/** Deterministic generation; never sample inventively for dossiers. */
export const LLM_TEMPERATURE = 0;

export function getModelIds() {
    return { gemini: GEMINI_MODEL, openai: OPENAI_MODEL };
}

function fallbackBanner(reason) {
    const lines = [
        '',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        `!! LLM FALLBACK: Gemini → OpenAI (${OPENAI_MODEL})`,
        `!! Reason: ${reason}`,
        ALLOW_FALLBACK
            ? '!! ROOK_ALLOW_LLM_FALLBACK=1 — continuing with OpenAI.'
            : '!! Refusing silent mid-run fallback. Set ROOK_ALLOW_LLM_FALLBACK=1 to allow.',
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
        '',
    ];
    console.error(lines.join('\n'));
}

async function openaiGenerate(prompt) {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set, cannot fall back to OpenAI.');
    }
    console.log(`   Using OpenAI (${OPENAI_MODEL}, temperature=${LLM_TEMPERATURE})...`);
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: LLM_TEMPERATURE,
        messages: [{ role: 'user', content: prompt }],
    });
    const text = response.choices[0].message.content;
    return { text, provider: 'openai', model: OPENAI_MODEL };
}

// Google 429 responses carry a RetryInfo detail with the wait the API asks for.
// Exported for unit tests.
export function parseRetryDelayMs(errMsg) {
    try {
        const errObj = JSON.parse(errMsg);
        const details = errObj.error?.details || [];
        const retryInfo = details.find(d => d['@type']?.includes('RetryInfo'));
        const seconds = parseFloat(retryInfo?.retryDelay);
        if (!isNaN(seconds)) return Math.ceil(seconds * 1000) + 2000;
    } catch {
        const match = errMsg.match(/retry(?:ing)? in ([\d.]+)s/i) || errMsg.match(/retryDelay":"([\d.]+)s"/);
        if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 2000;
    }
    return null;
}

/**
 * Generate text. Returns { text, provider, model }.
 * Temperature is always 0. Mid-run Gemini→OpenAI fallback is fail-loud unless
 * ROOK_ALLOW_LLM_FALLBACK=1 (straight OpenAI when no Gemini key is not a mid-run fallback).
 */
export async function generate(prompt, retries = 15) {
    if (!GEMINI_API_KEY) {
        console.log(`   No GEMINI_API_KEY — primary provider is OpenAI (${OPENAI_MODEL}).`);
        return openaiGenerate(prompt);
    }
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log(`   Using Gemini (${GEMINI_MODEL}, temperature=${LLM_TEMPERATURE})...`);

    for (let i = 0; i < retries; i++) {
        try {
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: { temperature: LLM_TEMPERATURE },
            });
            return { text: response.text, provider: 'gemini', model: GEMINI_MODEL };
        } catch (e) {
            const errMsg = e.message || '';
            // Model id gone / wrong → fail loud, do not silently swap models.
            if (/404|not found|NOT_FOUND|is not found/i.test(errMsg)) {
                throw new Error(
                    `Gemini model unavailable (${GEMINI_MODEL}): ${errMsg}. ` +
                    `Set GEMINI_MODEL to a current catalog id and retry.`
                );
            }
            // "limit: 0" means the free daily quota is fully exhausted; retrying is pointless.
            const quotaDead = errMsg.includes('limit: 0');
            if (quotaDead || i === retries - 1) {
                const reason = quotaDead ? 'Gemini daily quota exhausted' : 'All Gemini retries exhausted';
                fallbackBanner(reason);
                if (!ALLOW_FALLBACK) {
                    throw new Error(
                        `${reason}. Mid-run OpenAI fallback blocked (set ROOK_ALLOW_LLM_FALLBACK=1 to allow).`
                    );
                }
                try {
                    return await openaiGenerate(prompt);
                } catch (fallbackError) {
                    console.error(`   OpenAI fallback failed: ${fallbackError.message}`);
                    throw e;
                }
            }

            let waitTime = 2000 * (i + 1);
            if (/429|Quota|limit|RESOURCE_EXHAUSTED/.test(errMsg)) {
                waitTime = parseRetryDelayMs(errMsg) ?? 32000;
                console.log(`   Rate limit hit, waiting ${waitTime / 1000}s (attempt ${i + 1}/${retries})...`);
            } else {
                console.log(`   API error (${errMsg}), retrying in ${waitTime / 1000}s...`);
            }
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
}
