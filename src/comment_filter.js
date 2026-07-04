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
