// entity.mjs — the entity filter: the lorebook's own vocabulary, and the weighted BM25 query terms built from
// it. Read at stage 3 only (content-lexical): it can reweight what an activated entry scores, never admit one.

import { tokenize } from './lexical.mjs';
import { normalizeOrthography } from './automaton.mjs';
import { properNounsOf } from './relevance.mjs';

/** Every term in an entry's keys or title, lowercased. Do not "fix" the missing keys: at the production call site the takeover has already blanked them, and the gazetteer source measured flat, empty included (R20). */
export function buildGazetteer(entries) {
    const terms = new Set();

    for (const entry of entries) {
        const sources = [...(entry.key ?? []), ...(entry.keysecondary ?? []), entry.comment ?? ''];
        for (const source of sources) {
            for (const token of tokenize(source)) terms.add(token);
        }
    }

    return terms;
}

/** Query terms that are capitalised or in `gazetteer`, capitalised ones weighted `boost`; not applied to summarized queries. */
export function buildTermWeights(queryText, gazetteer, boost) {
    // Null-prototype: the keys are chat tokens, and `weights['constructor'] ?? 0` would otherwise read a Function and fold to NaN.
    const weights = Object.create(null);
    const properNouns = properNounsOf(normalizeOrthography(queryText));

    // lexical.tokenize, so a query term is exactly the token the BM25 index holds (K9).
    for (const lower of tokenize(queryText)) {
        const isProperNoun = properNouns.has(lower);

        if (!isProperNoun && !gazetteer.has(lower)) {
            continue;
        }

        weights[lower] = Math.max(weights[lower] ?? 0, isProperNoun ? boost : 1);
    }

    return weights;
}
