// scoring.mjs — stage 1: score a collection's chunks by mean-centered cosine, pool to entries, bound the
// result. The cosine itself lives in vector.mjs; this file is the ADMISSION concern, which after the cut
// below is almost none. Pure and isomorphic, shared by the plugin, the extension, and the harnesses.
//
// STAGE 1 NO LONGER RANKS ON ANYTHING BUT COSINE, and no longer admits selectively at all. It used to
// emit "the chunks either signal likes" — `cosine >= threshold || bm25 > 0` — which measured, across 70
// graded scenes, as an OR whose second clause admitted 99.9% of every book's indexed entries and whose
// first clause (`scoreThreshold: 'auto'`, a p90 quantile) was a top-decile selector whose every exclusion
// the second clause undid. Removing the threshold outright changed admission by 6 entries in 10,103 and
// recovered no relevant entry, so the gate was deciding nothing; with no gate, BM25 had no admission left
// to serve, and the lexical half of stage 1 went with it.
//
// The stage-3 text signal is UNAFFECTED and was already elsewhere: content-lexical.mjs computes BM25 over
// every entry's content in the browser, a superset of the vectorized chunks this file ever indexed, and
// rankActivated has read it rather than these scores since it landed. It measures as the strongest of the
// three stage-3 predictors of per-entry relevance (standardised logistic beta +0.756 against cosine's
// +0.570, n=7536 judged rows) — so lexical evidence did not leave the system, it left the stage that had
// stopped using it.
//
// WHAT THIS GIVES UP, stated because no book here can show it: above admitCeiling the overflow is now
// chosen on cosine alone, and the population a lexical rank rescues there is the one measured at 110 of
// 672 relevant entries — chunks below the corpus mean in embedding space that carry the query's exact
// terms, which mean-centering is what puts there. The ceiling is 1000 entries and the largest book
// measured holds 208 vectorized ones, so this is a future-book risk, not a present one. If a book ever
// approaches the ceiling, this is the decision to revisit first.
import { centeredCosineScores } from './vector.mjs';

/** Linear-interpolated quantile. No longer used by admission; kept for the eval harnesses' own cuts. */
export function quantile(xs, q) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.min(lo + 1, s.length - 1);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Score one collection's chunks against a query vector by mean-centered cosine, and return them ALL.
 *  This is the plugin's /query-multi per-collection loop.
 *
 *  uncenteredGate is a wrong-book failsafe and the only thing here that drops a chunk — not a ranking
 *  signal: a chunk must reach `uncenteredGate` RAW cosine (no mean subtraction) or it goes. Centered scores
 *  cannot do this job — centering subtracts the book's shared direction, so they only say "more like the
 *  query than this book's average chunk", and every book, including a wrong one, has above-average chunks.
 *  Raw cosine keeps absolute similarity: measured on 4 graded scenes x 3 unrelated books (bge-m3), relevant
 *  entries sit at >= 0.538 while wrong-genre books top out at 0.47-0.54, so a 0.5 gate zeroed 7/9 null cells
 *  at zero cost to any real scene. Known blind spot: a same-genre wrong book clears any raw-cosine gate. */
export function scoreCollection(collectionId, loaded, queryVector, { centered = true, uncenteredGate = 0 } = {}) {
    const { items, mean } = loaded;
    const vectorScores = centeredCosineScores(items, queryVector, mean, centered);
    // The gate is PER ENTRY (best chunk vouches for its siblings), not per chunk. Kept entry-level from
    // when a chunk-level AND could drop an entry's best-lexical chunk and lower its pooled score; with
    // one signal left the two forms coincide, and the entry-level reading is still the right one — the
    // question "is this the wrong book?" is about the entry, not about one of its paragraphs.
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
        if (gatedOut && gatedOut(item.metadata?.index ?? `#${item.metadata?.hash}`)) return;
        out.push({ collectionId, score: vectorScores[docIndex], metadata: item.metadata });
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
 * ONE SIGNAL, so pooling is a max over cosine and the surviving record is the entry's best chunk — its hash
 * and text are what the client shows and what `owners` resolves. It used to pool vector and lexical
 * independently and carry both maxima, because an entry's best semantic chunk and its best lexical chunk
 * need not be the same one; with the lexical half gone from stage 1 there is one maximum to keep.
 *
 * @param {Array<{collectionId: string, score: number, metadata: object}>} results Chunk scores
 * @returns {Array<{collectionId: string, score: number, metadata: object}>} One record per entry
 */
export function poolEntries(results) {
    const best = new Map();
    for (const r of results) {
        // metadata.index is the owning entry's uid (see syncWorld). US-separated per the composite-key rule;
        // falling back to the hash means a chunk with no owner pools as its own entry rather than colliding.
        const key = `${r.collectionId}${r.metadata?.index ?? `#${r.metadata?.hash}`}`;
        const previous = best.get(key);
        if (!previous || r.score > previous.score) best.set(key, { ...r });
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
 * scene measured, so the candidate set is bounded by the BOOK — and now, with admission unconditional,
 * by nothing else at all.
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

/** The top-K by cosine across collections, grouped by collectionId — exactly what the client receives
 *  from the plugin. Fed poolEntries() output, so K counts ENTRIES.
 *
 *  It used to union this list with the top-K by BM25, which is what let a lexically-strong entry survive
 *  a cut its cosine would have lost. With admitCeiling at 1000 against a largest measured book of 208
 *  vectorized entries, neither list cuts anything — the union was a tie-break at a bound nothing reaches.
 *  See the header for what that concedes on a book that does reach it. */
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
