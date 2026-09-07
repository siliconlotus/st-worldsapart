// entity.mjs — the entity filter: the lorebook's own vocabulary, and the weighted BM25 query terms
// built from it. Reduces a raw query to entity-ish terms and boosts the names among them; the weights
// reach content-lexical at stage 3, which is the only thing that reads them.
//
// Query construction is query.mjs and name detection is relevance.mjs; this file decides what a query
// term is worth, which is a different question from either.
//
// Isomorphic — no DOM, no ST imports; the proper-noun boost is injected by the caller. It lives with the
// extension, never the plugin: a change here is a browser refresh, and it stays out of the plugin
// fingerprint.

// The index's tokenizer, imported rather than restated, because the tokens built here are BM25 query
// terms: buildTermWeights' keys feed bm25Scores directly, so they must be tokenized exactly as the index
// is or an accented query term shatters on this side and matches nothing.
import { tokenize } from './lexical.mjs';
import { normalizeOrthography } from '../plugin/automaton.mjs';
// The project's definition of a name, imported rather than restated: relevance.mjs owns every name rule.
import { properNounsOf } from './relevance.mjs';

/**
 * Collects the lorebook's own vocabulary — every term appearing in an entry's keys or title. Anything
 * named there is something this corpus treats as worth naming, which is a better salience signal than
 * rarity.
 *
 * Read at stage 3 only: the term weights are BM25 query terms and stage 1 has no BM25
 * (plugin/scoring.mjs), so this can reweight what an activated entry scores, never what is admitted.
 *
 * Do not "fix" the missing keys. At the one production call site the takeover has already blanked
 * key/keysecondary on every keyword-activating entry, so the vocabulary is entry titles plus the keys of
 * constants and `@@activate` entries. The gazetteer source measured flat on every arm, an empty
 * gazetteer included (R20) — the proper-noun boost is carrying the entity filter on its own.
 *
 * The offline harnesses must reproduce whatever production hands this, or they measure a gazetteer
 * nothing builds.
 *
 * @param {object[]} entries All World Info entries
 * @returns {Set<string>} Lowercased gazetteer terms
 */
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

/**
 * Reduces a raw query to entity-ish terms, weighted: a term survives if it is capitalised or in the
 * lorebook's vocabulary, and capitalised terms get `boost`.
 *
 * Reaches only content-lexical at stage 3 now. Every arm that admitted more terms ranked worse (R20,
 * R21): IDF and part-of-speech filters admit prose variation at high weight, and identity is what
 * discriminates here. The gazetteer source measured flat, empty included (R20), so treat its assembly
 * as having nothing to tune. Judge any change on mean target rank over the uncut ranking with unjudged
 * rows as 0: nDCG@5 saturates on this sparse relevance and the activated pool hides a wrong promotion (R21).
 *
 * Deliberately not applied to summarized queries, which are already salience-selected.
 *
 * @param {string} queryText Raw query
 * @param {Set<string>} gazetteer Lorebook vocabulary
 * @param {number} boost settings().properNounBoost
 * @returns {Record<string, number>} Term weights
 */
export function buildTermWeights(queryText, gazetteer, boost) {
    const weights = {};
    // Orthography before anything reads the text, case preserved: the proper-noun test below needs
    // capitals, so this is the fold minus its case half, applied once so both loops see one form.
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
