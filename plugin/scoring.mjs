// scoring.mjs — the HYBRID combiner: score a collection with both similarity primitives (mean-centered
// vector cosine + lexical BM25) in one pass and union the top-K by each signal. The primitives live in
// vector.mjs / lexical.mjs; this file only combines them, so it IS the "hybrid retrieval" concern rather
// than either similarity. Pure and isomorphic, shared by the plugin, the extension, and the harnesses.
import { bm25Scores, DEFAULT_K1, DEFAULT_B } from './lexical.mjs';
import { centeredCosineScores } from './vector.mjs';

/** Linear-interpolated quantile. Used by the 'auto' threshold; exported for the eval harness. */
export function quantile(xs, q) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.min(lo + 1, s.length - 1);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Score one collection's chunks against a query vector: mean-centered cosine + BM25. Returns the chunks
 *  either signal likes (cosine >= threshold OR bm25 > 0). This is the plugin's /query-multi per-collection loop.
 *
 *  uncenteredGate is a wrong-book failsafe ANDed on top of that admission, not a third ranking signal: a
 *  chunk must also reach `uncenteredGate` RAW cosine (no mean subtraction) or it is dropped. Centered scores
 *  cannot do this job — centering subtracts the book's shared direction, so they only say "more like the
 *  query than this book's average chunk", and every book, including a wrong one, has above-average chunks.
 *  Raw cosine keeps absolute similarity: measured on 4 graded scenes x 3 unrelated books (bge-m3), relevant
 *  entries sit at >= 0.538 while wrong-genre books top out at 0.47-0.54, so a 0.5 gate zeroed 7/9 null cells
 *  at zero cost to any real scene. Known blind spot: a same-genre wrong book clears any raw-cosine gate. */
export function scoreCollection(collectionId, loaded, queryVector, { centered = true, threshold = 0, queryText = '', k1 = DEFAULT_K1, b = DEFAULT_B, termWeights = null, stopwordDf = 0, commonWordWeight = 1, uncenteredGate = 0 } = {}) {
    const { items, mean, lexical } = loaded;
    const lexicalScores = bm25Scores(lexical, queryText, items.length, k1, b, termWeights, stopwordDf, commonWordWeight);
    const vectorScores = centeredCosineScores(items, queryVector, mean, centered);
    // 'auto' self-calibrates the cosine floor to this query's own score distribution. The stored 0.1
    // default was chosen as "the centered p90 measured on three books with bge-m3" (state.mjs
    // scoreThreshold) — quantiling the live scores gives the same selectivity on any embedder without
    // a per-embedder recalibration. Per collection, per query, and free: the scores already exist.
    if (threshold === 'auto') threshold = quantile(vectorScores, 0.9);
    // The gate is PER ENTRY (best chunk vouches for its siblings), not per chunk. A chunk-level AND also
    // drops an entry's best-BM25 chunk whenever that chunk's own raw cosine is low, which lowers the entry's
    // pooled bm25 and reorders real scenes — measured -0.036 nDCG@10 on one of the four graded scenes,
    // where the entry-level form is a byte-identical no-op on all of them.
    let gatedOut = null;
    if (uncenteredGate > 0) {
        const rawScores = centered ? centeredCosineScores(items, queryVector, mean, false) : vectorScores;
        const bestRaw = new Map();
        items.forEach((item, docIndex) => {
            const key = item.metadata?.index ?? `#${item.metadata?.hash}`;
            bestRaw.set(key, Math.max(bestRaw.get(key) ?? -Infinity, rawScores[docIndex]));
        });
        gatedOut = key => (bestRaw.get(key) ?? -Infinity) < uncenteredGate;
    }
    const out = [];
    items.forEach((item, docIndex) => {
        const score = vectorScores[docIndex];
        const bm25 = lexicalScores[docIndex];
        if (gatedOut && gatedOut(item.metadata?.index ?? `#${item.metadata?.hash}`)) return;
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

/**
 * How many records stage 1 asks the store for. A SAFETY LIMIT on what a pathological scene may feed
 * core's scan loop, not a verdict on relevance — stage 4 makes the only relevance decision.
 *
 * SET AS A SANITY BOUND, NOT TUNED. It was 100 entries, which is below two of the seven books in the
 * graded corpus, so the safety limit was firing as an ordinary cut on routine scenes: measured over 70
 * scenes, it dropped 23 of 672 entries graded >= 3, on 20 scenes, and no downstream stage can recover
 * one — stage 1 is the only place they could have entered. Raising it to 200 recovered all but 2 and
 * saturated there, because the admission gates admit 100% of every book's indexed entries on every
 * scene measured, so the candidate set is bounded by the BOOK, never by `score >= threshold || bm25 > 0`.
 *
 * The cost is stage 3, which scores each activated entry with one keywordScore pass over the scan
 * window: measured 13 us per entry against the corpus's widest window (22.8 KB) on its densest keys
 * (19.6 per entry), linear to 2000. 1000 entries is ~13 ms per turn, which is why the bound sits far
 * above any real book rather than near one — a limit that binds on ordinary scenes is a cut.
 *
 * PATH-DEPENDENT, because K counts a different thing on each retrieval path:
 *
 *   pooled server-side   poolEntries runs before selectTopK, so K counts ENTRIES. 1000.
 *   not pooled           K counts CHUNKS and the client pools over only what K let through. 10000,
 *                        holding the ~10 chunks/entry ratio (measured 9.1-10.3) so the two paths bound
 *                        the same number of entries.
 *
 * One number for both would mean "1000 entries, correctly pooled" on one path and "1000 chunks, with
 * understated per-entry maxima" on the other — and those understated scores feed the stage-4 cliff.
 *
 * Unknown resolves to the chunk ceiling: over-asking costs a larger response, under-asking silently
 * mis-scores entries.
 *
 * @param {boolean} pooledServerSide Whether the store pooled to one record per entry before cutting
 * @returns {number} topK to request
 */
export const admitCeiling = pooledServerSide => (pooledServerSide === true ? 1000 : 10000);

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
