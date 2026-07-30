// scene.mjs — loading and scoring ONE graded scene from a /wa-grade sample. The machinery
// graded-scene-grid.mjs and paired-arms.mjs both need, extracted so there is exactly one copy of it.
//
// WHY IT IS A MODULE AND NOT COPY-PASTE. Every line below is a place a second copy would silently drift.
// The gazetteer alone has already cost this project one wrong answer: reading raw book keys instead of the
// suppressed ones admitted 2.3x the query terms and inflated every BM25 score by up to 74%, which is what
// made a validated sample look unreproducible. A cross-sample tool that re-derived any of this by hand would
// be comparing two subtly different rankings and reporting the difference as a parameter effect.
//
// Nothing here parses argv or prints a report — callers own their own CLI and output. Nothing here reads a
// live lorebook either: entries come from the sample's embedded copies, which is what makes a graded scene
// re-runnable after the books have been edited.
import { readFileSync, existsSync } from 'node:fs';
import { scoreCollection, poolEntries, selectTopK } from '../plugin/scoring.mjs';
import { buildLexical } from '../plugin/lexical.mjs';
import { corpusMean } from '../plugin/vector.mjs';
import * as ranking from '../extension/ranking.mjs';
import { isScaffolding, openBundle } from '../extension/grading.mjs';

/** Reads a manifest from disk as a plain sample, whether it is one or a /wa-super-grade multi-arm bundle.
 *  Every tool goes through this so `--arm` behaves identically everywhere and a bundle is never scored as
 *  though its first arm were the only one. */
export const openSample = (path, arm = null) => openBundle(JSON.parse(readFileSync(path, 'utf8')), arm);

export const CID = 'wa';

/** ST's string hash. WA stores each book's vectors under wa_${hash(bookName)}, so the collection path is
 *  derivable rather than configured. Must stay bit-identical to ST's or the index is simply not found. */
export const getStringHash = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); };

/** An entry's display title, exactly as the extension derives it (comment, else keys, else uid). */
export const wiTitle = e => (e.comment && e.comment.trim()) ? e.comment.trim() : (e.key?.length ? e.key.join(', ') : `UID ${e.uid}`);

/** Title normaliser for grade matching: lowercase alphanumeric tokens, singles dropped. */
export const nrm = s => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1);

export const dcg = (v, k) => v.slice(0, k).reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
/** Graded nDCG. The ideal is built from the RANKED vector, so a graded title that never gets ranked
 *  contributes to neither DCG nor the ideal — which is what makes excludeTitles free. */
export const ndcg = (vec, k) => { const ideal = [...vec].sort((a, b) => b - a); return dcg(ideal, k) ? dcg(vec, k) / dcg(ideal, k) : 0; };

/**
 * Where this sample's vector collection lives. Explicit --index wins, then the sample's own record, then the
 * derived path.
 *
 * THE SAMPLE'S OWN `index` IS SKIPPED WHEN IT DOESN'T EXIST HERE, which is the normal case for a graded scene
 * somebody else captured: it records an absolute-ish path on THEIR machine. Falling through to the derived
 * path lets a rebuilt collection (eval/reindex.mjs, whose cache key is book + model + chunk settings) be
 * found without editing the manifest. Callers that need a specific rebuild still pass `index` explicitly.
 */
export const indexPath = (S, { vectors = 'data/default-user/vectors/ollama', model = 'bge-m3', index = null } = {}) => {
    if (index) return index;
    const derived = `${vectors}/wa_${getStringHash(S.primaryBook)}/${model}/index.json`;
    if (S.index && (existsSync(S.index) || !existsSync(derived))) return S.index;
    return derived;
};

/** One local embed call. Deliberately not cached to disk: a stored vector would keep answering after the
 *  embedding model underneath it changed. */
export const embed = async (text, { ollama = 'http://localhost:11434', model = 'bge-m3' } = {}) => {
    const r = await fetch(`${ollama}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: text }) });
    return (await r.json()).embeddings[0];
};

/**
 * The parameter set a sample was captured under, layered over the harness defaults.
 *
 * The defaults are one tuned chat's snapshot, NOT the shipped defaults (extension/state.mjs ships K1 1.2,
 * LEXW 1) — a sample overrides them via its own captureParams, which is the point of putting them in the
 * manifest: each graded scene carries the settings it was graded under. `overrides` on top is how an arm
 * asks "what would this scene look like at these parameters instead".
 */
export const sceneParams = (S, overrides = {}) => ({
    // KEYW null mirrors LEXW, exactly as the extension does — so a sample captured before the split scores
    // identically, and an arm that sets KEYW is testing the split rather than a silent default change.
    K: 20, K1: 2, B: 0.75, LEXW: 1.5, KEYW: null, boost: 3, stopwordDf: 0.25, commonWordWeight: 1,
    caseSensitive: false, wholeWords: false, includeNames: true, threshold: 0.1,
    maxVectorEntries: 20, suppressVectorKeys: true, scoreVectorKeys: false, entityFilter: true,
    queryMode: 'messages', retrievalMode: 'hybrid',
    // How a VECTORIZED entry's chunk earns admission to the candidate set. 'either' is what the plugin ships
    // (scoreCollection: `score >= threshold || bm25 > 0`), so a chunk with a weak embedding can still enter on
    // its own lexical match. 'cosine' is the strict per-entry-type gate — the cosine floor actually gates the
    // entries it is named for. Simulated by filtering the plugin's own output rather than forking it: the OR
    // admits a superset, so the AND result is that set narrowed to the chunks clearing the floor. Non-vectorized
    // entries are unaffected either way; they are not in the collection at all and arrive via keyword scoring
    // (measured: 0 non-vectorized entries in any of three real indexes, so the plugin's bm25 clause is a
    // SECOND route for vector entries, not the non-vector branch). 'both' is the strict AND — a chunk needs a
    // clearing cosine AND some lexical overlap — which is narrower than either single test.
    admit: 'either',
    // Floor for the LEXICAL admission clause. The plugin ships `bm25 > 0`, which at these query lengths admits
    // 80-95% of every chunk in the book — so the clause is nearly free and the cosine floor can only widen the
    // set. A percentile floor makes the lexical test selective, and makes it ADAPTIVE: BM25 is not comparable
    // across queries or corpora, so a fixed number cannot transfer between scenes the way a quantile can.
    bm25Floor: 0,
    // Same floor expressed as a PERCENTILE of the nonzero BM25 scores actually in play, computed per query.
    // This is the form a real implementation would take: measured p25-of-all ranges 2.67 to 10.93 across three
    // books, a 4x spread, so no fixed number transfers between scenes and the gate has to be adaptive.
    bm25FloorPct: 0,
    ...(S.captureParams ?? {}), ...overrides,
});

/**
 * Loads a sample into everything needed to score it.
 *
 * @param {object} S The parsed sample
 * @param {object} opts
 * @param {string} opts.indexFile Vector index path
 * @param {object} opts.params sceneParams() output
 * @returns {object} entries, byUid, loaded index, gazetteer, pool sets, and the grade/exclusion matchers
 */
export function loadScene(S, { indexFile, params: P }) {
    const primary = S.primaryBook;
    const entries = Object.values(S.books[primary]);
    const byUid = new Map(entries.map(e => [Number(e.uid), e]));
    const items = JSON.parse(readFileSync(indexFile, 'utf8')).items;
    const loaded = { items, mean: corpusMean(items), lexical: buildLexical(items) };

    // Out-of-scope graded titles: entries from a second attached book, which this harness cannot rank
    // because only one collection is loaded. Token-subset match, same rule as grade matching.
    const EXCLUDED = (S.excludeTitles ?? []).map(nrm).filter(x => x.length);
    const isExcluded = title => { const t = new Set(nrm(title)); return EXCLUDED.some(x => x.every(w => t.has(w))); };

    // PRODUCTION BUILDS THE GAZETTEER DOWNSTREAM OF suppressVectorKeys, which blanks key/keysecondary on
    // every vectorized entry (worldsapart.js) so core can't keyword-match them. By the time retrieval calls
    // buildGazetteer(getSortedEntries()), those keys are gone and the "lorebook's own vocabulary" is only
    // entry TITLES plus the keys of non-vectorized entries. Reading the raw book instead admitted 2.3x the
    // terms (238 vs 105) and inflated every BM25 score by up to 74% — the gap that made a validated sample
    // look unreproducible. Suppressing reproduces the capture exactly.
    //
    // The gazetteer spans every book the live chat had attached, as production's does: those extra terms
    // change which query terms survive the filter, so they move BM25 on THIS book's entries even though
    // their own entries are out of scope here. Gazetteer-only — no index, no candidates.
    const embeddedOthers = Object.keys(S.books).filter(w => w !== primary).flatMap(w => Object.values(S.books[w]));
    const gazSource = [...entries, ...embeddedOthers];
    const gazEntries = P.suppressVectorKeys
        ? gazSource.map(e => (e.vectorized ? { ...e, key: [], keysecondary: [] } : e))
        : gazSource;
    const gaz = ranking.buildGazetteer(gazEntries);

    // THE POOL IS WHAT A HUMAN JUDGED, not what one capture logged — see graded-scene-grid.mjs. OWN is this
    // capture's own non-scaffolding rows, kept separately so coverage warnings stay about re-derivation
    // failing rather than about sibling arms legitimately disagreeing.
    const OWN = new Set((S.candidates ?? []).filter(c => !isScaffolding(c) && (!c.world || c.world === primary)).map(c => Number(c.uid)));
    const POOL = new Set([...OWN, ...(S.grades ?? [])
        .filter(g => Number.isFinite(Number(g.uid)) && (!g.world || g.world === primary) && !isExcluded(g.title))
        .map(g => Number(g.uid))]);

    return { primary, entries, byUid, items, loaded, gaz, gazSource, isExcluded, POOL, OWN };
}

/**
 * Grade lookup. By uid when every grade carries one (every /wa-grade sample does) — token-subset title
 * matching alone misattributes when one graded title's tokens are a subset of a sibling's ("Villa" also
 * matches "Villa Party", first-found wins). Titles remain the fallback for hand-written samples, and a bare
 * string argument always resolves by title. Out-of-scope titles drop; ungraded = 0.
 */
export function makeGradeOf(grades, isExcluded) {
    const list = (grades ?? [])
        .filter(x => x && x.title && Number.isFinite(Number(x.grade)))
        .map(x => ({ tk: nrm(x.title), g: Number(x.grade), title: x.title, uid: x.uid }));
    const kept = list.filter(g => !isExcluded(g.title));
    // uid is authoritative only when the grade set is uid-complete; a mixed set falls back to titles
    // wholesale rather than resolving half the rows by a different rule.
    const byUid = list.length && list.every(g => Number.isFinite(Number(g.uid)))
        ? new Map(kept.map(g => [Number(g.uid), g.g]))
        : null;
    const byTitle = title => { const mt = new Set(nrm(title)); const h = kept.find(x => x.tk.length && x.tk.every(t => mt.has(t))); return h ? h.g : 0; };
    return r => {
        const uid = Number(r?.uid ?? r?.key);
        if (byUid && Number.isFinite(uid)) return byUid.get(uid) ?? 0;
        return byTitle(typeof r === 'string' ? r : String(r?.title ?? ''));
    };
}

/** Keys the production scan would actually score. suppressVectorKeys blanks a vectorized entry's keys at
 *  scan time (worldsapart.js suppressKeys), and scoreVectorKeys is what re-admits the stashed originals —
 *  offline the originals ARE e.key, since samples embed the book raw. Scoring raw keys unconditionally gave
 *  vectorized entries a keys signal production can never produce, the keyword-side twin of the gazetteer
 *  bug documented in loadScene. */
export const scoringKeys = (e, P) => (e.vectorized && P.suppressVectorKeys && !P.scoreVectorKeys) ? [] : (e.key ?? []);

/** Keyword score via the SHARED ranking.keywordScore (which mirrors ST core's matchKeys). */
export const makeKeywordScore = P => (e, text, k1) =>
    ranking.keywordScore(e, text, scoringKeys(e, P), { k1, caseSensitiveDefault: P.caseSensitive, wholeWordsDefault: P.wholeWords }).score;

/**
 * Per-entry signals via the SHARED plugin scoring — the exact vector + BM25 + chunk-selection code the
 * server runs — then keyword on top.
 *
 * Entries are pooled independently per signal, as the client does: best vector chunk and best BM25 chunk.
 * Entries the index never returned still enter the ranking if they keyword-match, which is how non-vectorized
 * entries compete at all.
 *
 * @returns {(k1: number, b: number, tw: object|null, qvec: number[], qtext: string, scanText: string) => object[]}
 */
export function makeScorer({ loaded, byUid, entries, params: P, topK }) {
    const keywordScore = makeKeywordScore(P);
    return (k1, b, tw, qvec, qtext, scanText) => {
        let scored = scoreCollection(CID, loaded, qvec, { centered: true, threshold: P.threshold, queryText: qtext, k1, b, termWeights: tw, stopwordDf: P.stopwordDf, commonWordWeight: P.commonWordWeight });
        if (P.admit === 'cosine') scored = scored.filter(m => m.score >= P.threshold);
        else if (P.admit === 'both') scored = scored.filter(m => m.score >= P.threshold && m.bm25 > 0);
        if (P.bm25Floor > 0) scored = scored.filter(m => m.score >= P.threshold || m.bm25 >= P.bm25Floor);
        if (P.bm25FloorPct > 0) {
            const nz = scored.map(m => m.bm25).filter(x => x > 0).sort((a, b) => a - b);
            const floor = nz.length ? nz[Math.min(nz.length - 1, Math.floor(P.bm25FloorPct * nz.length))] : 0;
            if (floor > 0) scored = scored.filter(m => m.score >= P.threshold || m.bm25 >= floor);
        }
        const grouped = selectTopK(poolEntries(scored), topK);
        const per = new Map();
        for (const m of grouped[CID]?.metadata ?? []) { const uid = Number(m.index); const c = per.get(uid) ?? { score: -Infinity, bm25: 0 }; c.score = Math.max(c.score, m.score); c.bm25 = Math.max(c.bm25, m.bm25); per.set(uid, c); }
        const rows = [];
        for (const [uid, s] of per) { const e = byUid.get(uid); if (e) rows.push({ uid, title: wiTitle(e), score: s.score, textScore: s.bm25, keywordScore: keywordScore(e, scanText, k1) }); }
        for (const e of entries) { const uid = Number(e.uid); if (per.has(uid)) continue; const kw = keywordScore(e, scanText, k1); if (kw > 0) rows.push({ uid, title: wiTitle(e), score: undefined, textScore: 0, keywordScore: kw }); }
        return rows;
    };
}

/** Fusion via the SHARED ranking.fuseRanks (the layout ranking, not the retrieval one). Keys on item.key,
 *  so uid is aliased in. Mutates the rows it is handed and returns a sorted copy. */
export const makeFuse = P => (rows, lexW) => {
    rows.forEach(r => { r.key = r.uid; });
    // The sample's own retrievalMode, not a hardcoded 'hybrid' — production passes settings().retrievalMode
    // here, and a scene graded under 'lexical'/'vector' fused as hybrid is a ranking the user never ran.
    ranking.fuseRanks(rows, { rrfK: P.K, retrievalMode: P.retrievalMode, weightByOrder: false, lexicalWeight: lexW, keywordWeight: P.KEYW });
    return [...rows].sort((a, b) => b.fused - a.fused);
};

/**
 * Scores one scene end to end at one parameter set: nDCG on the pooled rows, plus judged coverage of the
 * unfiltered top-k.
 *
 * THE TWO RANKINGS ARE DELIBERATELY DIFFERENT. nDCG is measured on the pool (grades only exist there), while
 * coverage is measured on the UNFILTERED ranking — because the question coverage answers is "has a human
 * looked at the top-k this configuration would actually deploy", and restricting to the pool first would
 * answer it 100% by construction. A scene whose coverage is short is reporting a LOWER BOUND on nDCG.
 *
 * @param {object} args
 * @param {object} args.sample Parsed sample
 * @param {object} [args.overrides] Parameter overrides for this arm
 * @param {number} [args.k] Coverage/nDCG cutoff (10 — the widest rank the shipped cut can reach)
 * @returns {Promise<{n: number, nAt5: number, judged: number, of: number, unjudged: string[], terms: number|null}>}
 */
export async function scoreScene({ sample: S, overrides = {}, k = 10, vectors, model, ollama, index, topK, scene: preloaded, qv: cachedQv } = {}) {
    const P = sceneParams(S, overrides);
    // A preloaded scene is reused across arms so N arms cost ONE embed and ONE index parse per scene. Valid
    // only while no arm moves suppressVectorKeys, which is baked into the gazetteer at load time — asserted
    // rather than trusted, because the failure would be a silently wrong gazetteer and those cost 74% BM25.
    if (preloaded && overrides.suppressVectorKeys !== undefined) {
        throw new Error('suppressVectorKeys changes the gazetteer, so it cannot be swept against a preloaded scene — load per arm');
    }
    const scene = preloaded ?? loadScene(S, { indexFile: indexPath(S, { vectors, model, index }), params: P });
    const scoreAll = makeScorer({ ...scene, params: P, topK: topK ?? Math.max(100, P.maxVectorEntries * 2) });
    const fuse = makeFuse(P);
    const gradeOf = makeGradeOf(S.grades, scene.isExcluded);

    const query = S.query;
    const tw = (P.entityFilter && P.queryMode !== 'summary') ? ranking.buildTermWeights(query, scene.gaz, P.boost) : null;
    const qv = cachedQv ?? await embed(query, { ollama, model });
    const all = scoreAll(P.K1, P.B, tw, qv, query, S.scanText);

    const top = fuse(all, P.LEXW).slice(0, k);
    const unjudged = top.filter(r => !scene.POOL.has(Number(r.uid)));
    // Re-fuse the pooled subset AFTER reading the slice above: fuse mutates, and the subset shares references.
    const g = fuse(all.filter(r => scene.POOL.has(Number(r.uid))), P.LEXW).map(r => gradeOf(r));

    return {
        n: ndcg(g, k),
        nAt5: ndcg(g, 5),
        judged: top.length - unjudged.length,
        of: top.length,
        unjudged: unjudged.map(r => r.title),
        // The unjudged rows with their identity, which is what an offline pool extension needs: these are
        // exactly the entries this configuration would put in front of a user and nobody has judged.
        unjudgedRows: unjudged.map(r => ({ uid: Number(r.uid), title: r.title, rank: top.indexOf(r) + 1 })),
        terms: tw ? Object.keys(tw).length : null,
    };
}
