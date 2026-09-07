// scoring.mjs — stage 1: score a collection's chunks by mean-centered cosine, pool to entries, bound the
// result. The cosine itself lives in vector.mjs; this file is the admission concern, which after the cut
// below is almost none. Pure and isomorphic, shared by the plugin, the extension, and the harnesses.
//
// Stage 1 ranks on cosine alone and no longer admits selectively at all. Removing the old `scoreThreshold`
// was a measured no-op that recovered no relevant entry (R1), so the gate was deciding nothing; with no
// gate, BM25 had no admission left to serve, and the lexical half of stage 1 went with it.
//
// The stage-3 text signal is unaffected: content-lexical.mjs computes BM25 over every entry's content in
// the browser, a superset of the vectorized chunks this file ever indexed, and onScanDone reads that. It
// measured as the strongest stage-3 predictor of per-entry relevance under the embedder of the era (R10).
//
// What this gives up, stated because no book here can show it: above admitCeiling the overflow is chosen
// on cosine alone, and the population a lexical rank rescues there is real — chunks below the corpus
// mean in embedding space that carry the query's exact terms (R2). The ceiling sits far above the
// largest measured book (R4), so if a book ever approaches it, this is the decision to revisit first.
import { centeredCosineScores } from './vector.mjs';

/** Score one collection's chunks against a query vector by mean-centered cosine, and return them all.
 *  This is the plugin's /query-multi per-collection loop.
 *
 *  Nothing here drops a chunk. A raw-cosine floor as a wrong-book failsafe separates a wrong-genre book,
 *  which is a configuration error, and not a sibling book — same story, same author — which is the
 *  mistake anyone actually makes (R8). It also cost a shipped constant needing per-model recalibration,
 *  the only unrecoverable drop in the pipeline, and a scoring side effect: removing rows changes the
 *  within-scene standardisation, so gating can promote a surviving entry past the cut. */
export function scoreCollection(collectionId, loaded, queryVector, { centered = true } = {}) {
    const { items, mean } = loaded;
    const vectorScores = centeredCosineScores(items, queryVector, mean, centered);
    return items.map((item, docIndex) => ({ collectionId, score: vectorScores[docIndex], metadata: item.metadata }));
}

/**
 * Pools a collection's chunk scores down to one record per entry, so the top-K that follows counts
 * entries rather than chunks.
 *
 * Pooled here rather than on the client, because a client pooling over only what the top-K let through
 * conflates two unrelated depths in one number: K would have to be large enough for each entry's best
 * chunk to survive — a corpus property scaling with chunks-per-entry, not stabilising until K runs deep
 * into the book (R6) — while also standing in for a user preference about how many entries to activate.
 * Pooling before the cut makes the maxima exact by construction at any topK.
 *
 * One signal, so pooling is a max over cosine and the surviving record is the entry's best chunk — its
 * hash and text are what the client shows and what `owners` resolves.
 *
 * @param {Array<{collectionId: string, score: number, metadata: object}>} results Chunk scores
 * @returns {Array<{collectionId: string, score: number, metadata: object}>} One record per entry
 */
export function poolEntries(results) {
    const best = new Map();
    for (const r of results) {
        // metadata.index is the owning entry's uid (see syncWorld). US-separated per the composite-key
        // rule; falling back to the hash means a chunk with no owner pools as its own entry.
        const key = `${r.collectionId}${r.metadata?.index ?? `#${r.metadata?.hash}`}`;
        const previous = best.get(key);
        if (!previous || r.score > previous.score) best.set(key, { ...r });
    }
    return [...best.values()];
}

/**
 * How many records stage 1 asks the store for. A safety limit on what a pathological scene may feed
 * core's scan loop, not a verdict on relevance — stage 4 makes the only relevance decision.
 *
 * A sanity bound, not tuned: a ceiling below real books fires as an ordinary cut on routine scenes,
 * dropping graded-relevant entries no downstream stage can recover, and raising it saturated (R3). The
 * cost is stage 3's one keywordScore pass per activated entry, measured negligible at this ceiling (R7).
 *
 * Path-dependent, because K counts a different thing on each retrieval path:
 *
 *   pooled server-side   poolEntries runs before selectTopK, so K counts entries. 1000.
 *   not pooled           K counts chunks and the client pools over only what K let through. 10000,
 *                        holding the measured ~10 chunks/entry ratio (R5) so the two paths bound the
 *                        same number of entries.
 *
 * One number for both would mean "1000 entries, correctly pooled" on one path and "1000 chunks, with
 * understated per-entry maxima" on the other, and those understated scores feed stage 4.
 *
 * Unknown resolves to the chunk ceiling: over-asking costs a larger response, under-asking silently
 * mis-scores entries.
 *
 * @param {boolean} pooledServerSide Whether the store pooled to one record per entry before cutting
 * @returns {number} topK to request
 */
export const admitCeiling = pooledServerSide => (pooledServerSide === true ? 1000 : 10000);

/** The top-K by cosine across collections, grouped by collectionId — exactly what the client receives
 *  from the plugin. Fed poolEntries() output, so K counts entries.
 *
 *  Cosine alone: a union with a top-K by BM25 would be a tie-break at a bound nothing reaches, since
 *  admitCeiling sits far above any measured book (R4). See the header for what that concedes on a book
 *  that does reach it. */
export function selectTopK(results, topK) {
    const byVector = [...results].sort((a, b) => b.score - a.score).slice(0, topK);
    const grouped = {}, emitted = new Set();
    for (const r of byVector) {
        const key = `${r.collectionId}:${r.metadata.hash}`;
        if (emitted.has(key)) continue; emitted.add(key);
        grouped[r.collectionId] ??= { hashes: [], metadata: [] };
        grouped[r.collectionId].hashes.push(Number(r.metadata.hash));
        grouped[r.collectionId].metadata.push({ ...r.metadata, score: r.score });
    }
    return grouped;
}
