/** Explicit deterministic recipe. Han unigrams/bigrams plus Unicode letter/number words; no semantic claim. */
export const tokenRecipe = 'zh-character-bigram-v1';
export function tokens(text) {
    const result = new Set();
    for (const run of text.normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|[\p{Letter}\p{Number}]+/gu) ?? []) {
        if (/^\p{Script=Han}+$/u.test(run)) {
            const chars = [...run];
            for (let i = 0; i < chars.length; i++) {
                result.add(chars[i]);
                if (i + 1 < chars.length)
                    result.add(chars[i] + chars[i + 1]);
            }
        }
        else
            result.add(run);
    }
    return [...result].sort();
}
//# sourceMappingURL=tokenize.js.map