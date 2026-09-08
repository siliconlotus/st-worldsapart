// entity.mjs — the entity filter: the lorebook's own vocabulary, and the weighted BM25 query terms built from
// it. Read at stage 3 only (content-lexical): it can reweight what an activated entry scores, never admit one.

import { tokenize } from './lexical.mjs';
import { normalizeOrthography } from '../plugin/automaton.mjs';
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
    const weights = {};
    // The split must stay lexical.tokenize's character class, or an accented query term shatters and matches nothing (K9).
    const query = normalizeOrthography(queryText);
    const properNouns = properNounsOf(query);

    for (const token of query.split(/[^\p{L}\p{N}\p{M}']+/u)) {
        if (token.length < 2) {
            continue;
        }

        const lower = token.toLowerCase();
        const isProperNoun = properNouns.has(lower);

        if (!isProperNoun && !gazetteer.has(lower)) {
            continue;
        }

        weights[lower] = Math.max(weights[lower] ?? 0, isProperNoun ? boost : 1);
    }

    return weights;
}
