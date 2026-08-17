// lexical.mjs — lexical similarity: tokenization and BM25 over chunk text. Pure and isomorphic
// (no DOM/fs), shared by the server plugin, the extension, and the offline harnesses.
//
// This is what dense retrieval can't do on a single-story corpus: IDF automatically discounts terms
// that appear everywhere (a cast name in most chunks earns almost no weight), which is exactly the
// discrimination that's lost when every embedding shares a common direction.
import { fold } from './automaton.mjs';

export const DEFAULT_K1 = 1.2, DEFAULT_B = 0.75;

/**
 * Folded tokens (len > 1): the matcher's fold (automaton.mjs — NFC, orthography, case), then split on
 * anything outside the matcher's word-character core (\p{L}\p{N}\p{M}, plus apostrophe as before).
 *
 * THE FOLD IS THE MATCHER'S, NOT A LOOKALIKE. Tokenizing with a private notion of sameness made BM25
 * disagree with every match verdict in the system: the old [^a-z0-9'] split treated an accented letter
 * as a separator, so "Möbius" indexed as "bius" and could match nothing — measured, 87 word types /
 * 319 occurrences across four books, character names included (André x51). What the fold deliberately
 * does NOT do is strip diacritics: é vs e is a distinction an author can write, so "mobius" still does
 * not match "möbius" — same verdict countKey gives, which is the point.
 */
export function tokenize(text) {
    return fold(text).split(/[^\p{L}\p{N}\p{M}']+/u).filter(t => t.length > 1);
}

/** BM25 index over chunk texts: postings, IDF, doc lengths, average length. */
export function buildLexical(items) {
    const postings = new Map();
    const docLen = new Array(items.length).fill(0);
    let total = 0;
    items.forEach((item, docIndex) => {
        const tokens = tokenize(item.metadata?.text);
        docLen[docIndex] = tokens.length; total += tokens.length;
        const tf = new Map();
        for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
        for (const [term, count] of tf) { if (!postings.has(term)) postings.set(term, []); postings.get(term).push([docIndex, count]); }
    });
    const N = items.length;
    const idf = new Map();
    for (const [term, list] of postings) idf.set(term, Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5)));
    return { postings, idf, docLen, avgdl: total / Math.max(1, N) };
}

/** Per-document BM25. termWeights (entity mode) pre-filters + weights query terms; stopwordDf drops
 *  corpus-common terms. */
export function bm25Scores(lexical, queryText, docCount, k1 = DEFAULT_K1, b = DEFAULT_B, termWeights = null, stopwordDf = 0) {
    const scores = new Float64Array(docCount);
    const maxDocs = stopwordDf > 0 ? stopwordDf * docCount : Infinity;
    const terms = termWeights ? Object.entries(termWeights) : [...new Set(tokenize(queryText))].map(term => [term, 1]);
    for (const [term, weight] of terms) {
        const list = lexical.postings.get(term);
        if (!list || !(weight > 0)) continue;
        if (list.length > maxDocs) continue;
        const idf = lexical.idf.get(term) * weight;
        for (const [docIndex, tf] of list) {
            const lenNorm = 1 - b + b * (lexical.docLen[docIndex] / (lexical.avgdl || 1));
            scores[docIndex] += idf * ((tf * (k1 + 1)) / (tf + k1 * lenNorm));
        }
    }
    return scores;
}
