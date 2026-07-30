// scoring.mjs — the HYBRID combiner: score a collection with both similarity primitives (mean-centered
// vector cosine + lexical BM25) in one pass and union the top-K by each signal. The primitives live in
// vector.mjs / lexical.mjs; this file only combines them, so it IS the "hybrid retrieval" concern rather
// than either similarity. Pure and isomorphic, shared by the plugin, the extension, and the harnesses.
import { bm25Scores, DEFAULT_K1, DEFAULT_B } from './lexical.mjs';
import { centeredCosineScores } from './vector.mjs';

/** Score one collection's chunks against a query vector: mean-centered cosine + BM25. Returns the chunks
 *  either signal likes (cosine >= threshold OR bm25 > 0). This is the plugin's /query-multi per-collection loop. */
export function scoreCollection(collectionId, loaded, queryVector, { centered = true, threshold = 0, queryText = '', k1 = DEFAULT_K1, b = DEFAULT_B, termWeights = null, stopwordDf = 0, commonWordWeight = 1 } = {}) {
    const { items, mean, lexical } = loaded;
    const lexicalScores = bm25Scores(lexical, queryText, items.length, k1, b, termWeights, stopwordDf, commonWordWeight);
    const vectorScores = centeredCosineScores(items, queryVector, mean, centered);
    const out = [];
    items.forEach((item, docIndex) => {
        const score = vectorScores[docIndex];
        const bm25 = lexicalScores[docIndex];
        if (score >= threshold || bm25 > 0) out.push({ collectionId, score, bm25, metadata: item.metadata });
    });
    return out;
}

/**
 * Pools a collection's chunk scores down to ONE RECORD PER ENTRY, so the top-K that follows counts entries
 * rather than chunks.
 *
 * WHY THIS RUNS HERE AND NOT ON THE CLIENT. Scoring an entry by its best chunk is the whole point of
 * chunking, and the client has always done that pooling — but only over the chunks the top-K already let
 * through, which conflated two unrelated depths in one number. `topK` had to be large enough for each
 * entry's best chunk to survive (a corpus property: it scales with chunks-per-entry, and measured on three
 * graded corpora the per-entry maxima don't stabilise until K ~= 150-300) AND it was derived from
 * maxVectorEntries, which is a user preference about how many entries to activate. Hence the unexplained
 * `maxVectorEntries * 20` in the client: 20 entries asked for 400 chunks, which returned essentially the
 * whole book, while 3 entries asked for 60 and read BM25 low for reasons that had nothing to do with the
 * query. Pooling before the cut makes the maxima exact by construction, at any topK, so the two depths stop
 * being the same knob.
 *
 * Vector and lexical pool INDEPENDENTLY: an entry's best semantic chunk and its best lexical chunk need not
 * be the same one. The surviving record is the best-VECTOR chunk (its hash and text are what the client
 * shows and what `owners` resolves), carrying the entry's max bm25 alongside.
 *
 * @param {Array<{collectionId: string, score: number, bm25: number, metadata: object}>} results Chunk scores
 * @returns {Array<{collectionId: string, score: number, bm25: number, metadata: object}>} One record per entry
 */
export function poolEntries(results) {
    const best = new Map();
    for (const r of results) {
        // metadata.index is the owning entry's uid (see syncWorld). US-separated per the composite-key rule;
        // falling back to the hash means a chunk with no owner pools as its own entry rather than colliding.
        const key = `${r.collectionId}${r.metadata?.index ?? `#${r.metadata?.hash}`}`;
        const previous = best.get(key);
        if (!previous) {
            best.set(key, { ...r });
        } else if (r.score > previous.score) {
            best.set(key, { ...r, bm25: Math.max(r.bm25, previous.bm25) });
        } else if (r.bm25 > previous.bm25) {
            previous.bm25 = r.bm25;
        }
    }
    return [...best.values()];
}

/** Union the top-K by each signal across collections, dedup, group by collectionId — exactly what the
 *  client receives from the plugin. Fed poolEntries() output, so K counts ENTRIES. */
export function selectTopK(results, topK) {
    const byVector = [...results].sort((a, b) => b.score - a.score).slice(0, topK);
    const byLexical = [...results].sort((a, b) => b.bm25 - a.bm25).filter(x => x.bm25 > 0).slice(0, topK);
    const grouped = {}, emitted = new Set();
    for (const r of [...byVector, ...byLexical]) {
        const key = `${r.collectionId}:${r.metadata.hash}`;
        if (emitted.has(key)) continue; emitted.add(key);
        grouped[r.collectionId] ??= { hashes: [], metadata: [] };
        grouped[r.collectionId].hashes.push(Number(r.metadata.hash));
        grouped[r.collectionId].metadata.push({ ...r.metadata, score: r.score, bm25: r.bm25 });
    }
    return grouped;
}
