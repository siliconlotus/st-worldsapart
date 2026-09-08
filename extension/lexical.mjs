// lexical.mjs — tokenization and BM25 over chunk texts. Pure; the fold is the matcher's (plugin/automaton.mjs),
// so both sides tokenize identically.
import { fold } from '../plugin/automaton.mjs';

export const DEFAULT_K1 = 1.2, DEFAULT_B = 0.75;

/** Folded tokens (len > 1): the matcher's fold, then split outside \p{L}\p{N}\p{M} and apostrophe — never an ASCII split, or "Möbius" indexes as "bius" (K9). */
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

/** Per-document BM25; `termWeights` pre-filters and weights the query terms, `stopwordDf` drops terms in more than that share of docs. */
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
