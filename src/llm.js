import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import 'dotenv/config';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function openaiGenerate(prompt) {
    if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY is not set, cannot fall back to OpenAI.');
    }
    console.log('   Falling back to OpenAI (gpt-4o-mini)...');
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
    });
    return response.choices[0].message.content;
}

// Google 429 responses carry a RetryInfo detail with the wait the API asks for.
function parseRetryDelayMs(errMsg) {
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

export async function generate(prompt, retries = 15) {
    if (!GEMINI_API_KEY) return openaiGenerate(prompt);
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    for (let i = 0; i < retries; i++) {
        try {
            const response = await ai.models.generateContent({
                model: GEMINI_MODEL,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
            });
            return response.text;
        } catch (e) {
            const errMsg = e.message || '';
            // "limit: 0" means the free daily quota is fully exhausted; retrying is pointless.
            const quotaDead = errMsg.includes('limit: 0');
            if (quotaDead || i === retries - 1) {
                console.log(quotaDead
                    ? '   Gemini daily quota exhausted.'
                    : '   All Gemini retries exhausted.');
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
