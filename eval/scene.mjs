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
import { dirname, resolve as resolvePath } from 'node:path';
import { scoreCollection, poolEntries, selectTopK, quantile } from '../plugin/scoring.mjs';
import { buildLexical } from '../plugin/lexical.mjs';
import { corpusMean, centeredCosineScores } from '../plugin/vector.mjs';
import * as ranking from '../extension/ranking.mjs';
import * as matcher from '../extension/matcher.mjs';
import { isDurable, openBundle } from '../extension/grading.mjs';
import { cutDynamic } from '../extension/selection.mjs';
// Cycle: reindex.mjs imports getStringHash from here. Safe because neither side calls across at module
// scope — both references live inside function bodies, so whichever module loads first finishes evaluating
// before the other needs a binding.
import { cachePath, chunkConfig } from './reindex.mjs';
import { gradeCredit, fbeta, RECALL_WEIGHT, gradeValue } from './metrics.mjs';
export { vectorable } from '../extension/ranking.mjs';

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
 * Locates the live SillyTavern install for tools that must find it from any checkout. WA_ST_ROOT wins;
 * otherwise walk ancestors to the directory holding config.yaml — ST doesn't export its root, but every
 * install has exactly one config.yaml at it, and the walk works from git worktrees because those nest
 * inside the ST tree. dataRoot is read from that config.yaml rather than assumed: ST's data directory is
 * relocatable, while sample `index` paths are recorded with the default `data/` prefix.
 *
 * Returns null when no install is reachable (a standalone clone on another machine) — callers skip, they
 * don't guess.
 *
 * @returns {{root: string, dataRoot: string, resolve: (p: string) => string} | null}
 */
export function stInstall() {
    let root = process.env.WA_ST_ROOT;
    if (!root) {
        for (let d = dirname(new URL(import.meta.url).pathname); ; d = dirname(d)) {
            if (existsSync(`${d}/config.yaml`)) { root = d; break; }
            if (dirname(d) === d) return null;
        }
    }
    const m = existsSync(`${root}/config.yaml`) && readFileSync(`${root}/config.yaml`, 'utf8').match(/^dataRoot:\s*['"]?(.+?)['"]?\s*$/m);
    const dataRoot = resolvePath(root, m ? m[1] : './data');
    const resolve = p => p.startsWith('/') ? p : p.startsWith('data/') ? dataRoot + p.slice('data'.length) : `${root}/${p}`;
    return { root, dataRoot, resolve };
}

/**
 * Where this sample's vector collection lives. Explicit --index wins, then the sample's own record, then the
 * path derived from the local ST vectors dir, then the rebuild cache.
 *
 * THE SAMPLE'S OWN `index` IS SKIPPED WHEN IT DOESN'T EXIST HERE, which is the normal case for a graded scene
 * somebody else captured: it records an absolute-ish path on THEIR machine. So does the derived path — it
 * hashes the book name into THIS machine's vectors dir, which a stranger's book will not occupy. Both are
 * author-machine concepts, and a bundle that carries `bookMode: 'full'`, `paramSnapshot.vectors` and
 * `embedModel` needs neither: cachePath keys on (book, model, chunk settings), so it names the same file on
 * every machine and ensureIndex can fill it. That cache is the last resort rather than the first so no run
 * that resolves today resolves anywhere else — it is reached only when the two local paths are both absent.
 *
 * The returned path may not exist. Naming the rebuildable one in that case is what lets loadScene say which
 * file to build instead of scoring on an empty collection.
 */
export const indexPath = (S, { vectors = 'data/default-user/vectors/ollama', model = 'bge-m3', index = null } = {}) => {
    if (index) return index;
    // THROUGH stInstall, NOT THE CWD. Both local candidates are recorded with ST's `data/` prefix, so testing
    // them raw asks whether the collection exists *relative to wherever the tool was launched from* — and the
    // answer changes with the directory while the scene does not. That is not hypothetical: the same sample
    // scored 10/10 judged from the ST root and 0/0 one directory down, and the second run reported it as a
    // result. stInstall returns null only on a machine with no ST install, where neither candidate can exist
    // anyway and the rebuild cache is the answer.
    const st = stInstall();
    const local = p => (st ? st.resolve(p) : p);
    if (S.index && existsSync(local(S.index))) return local(S.index);
    const derived = local(`${vectors}/wa_${getStringHash(S.primaryBook)}/${model}/index.json`);
    if (existsSync(derived)) return derived;
    return cachePath(S, chunkConfig(S), model);
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
    // What counts as INSIDE a word when wholeWords is on (state.mjs wordBoundary, shipped 'strict').
    // Unlike the knobs above this one is module state in the matcher, so makeKeywordScore pushes it
    // through setBoundaryMode per call — otherwise every arm scores at whatever the last one set.
    // A sample captured before the setting existed ran under a class that is NEITHER mode (no hyphen
    // or apostrophe, but `_` a word character), so it cannot reproduce byte-identically; it is read
    // at the shipped default, which is what its numbers mean today.
    wordBoundary: 'strict',
    // Wrong-book failsafe (see state.mjs uncenteredGate). 0 here, NOT the shipped 0.5: every sample captured
    // before the gate existed must reproduce byte-identically, and a gate arm overrides this explicitly.
    uncenteredGate: 0,
    // Whether the cosine subtracts the corpus mean (state.mjs meanCentered, shipped on). An arm here contrasts
    // the CENTERED and RAW rankings on graded scenes; centering-grid.mjs measures the same switch on the
    // leave-one-out chunk-to-sibling task, which is a different question and can disagree without either
    // being wrong. Samples captured before captureParams recorded it fall back to this default, which is the
    // value they in fact ran under.
    meanCentered: true,
    maxVectorEntries: 20, suppressVectorKeys: true, scoreVectorKeys: false, entityFilter: true,
    // suppressVectorKeys moves TWO stages at once. It blanks vectorized keys so core cannot keyword-ACTIVATE
    // them (stage 2), and because the gazetteer is built downstream of that blanking it also changes the BM25
    // term set (stage 1 — 2.3x terms, up to 74% score movement, see loadScene). So an arm that flips it is not
    // a clean activation contrast, and the keys-live capture is NOT a superset of shipped: measured, it adds
    // 767 keyword-only rows but LOSES 174 vector rows across 65 scenes to the reranking, all of them below
    // shipped rank 16. Null follows suppressVectorKeys, which is what production does. Set it explicitly to
    // hold the gazetteer fixed while activation moves, or the reverse, and the two effects separate.
    suppressGazetteerKeys: null,
    // Exact key strings to treat as removed from the book (see scoringKeys). Null = none.
    dropKeys: null,
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
    // `primaryBook` names a key of `books`, and a bundle whose book was renamed after capture no longer
    // satisfies that. Says so, rather than dying inside Object.values with nothing naming the book.
    if (!S.books?.[primary]) throw new Error(`sample's primaryBook "${primary}" is not among its embedded books (${Object.keys(S.books ?? {}).join(', ') || 'none'})`);
    const entries = Object.values(S.books[primary]);
    const byUid = new Map(entries.map(e => [Number(e.uid), e]));
    // A KEYWORD-ONLY BOOK HAS NO COLLECTION, and that is a configuration rather than a failure: indexing
    // gates on `vectorized` (reindex.mjs buildItems), so a book with no vectorized entry yields no items
    // and ensureIndex refuses to build one. Foxbridge is exactly that — 38 hand-keyed reference entries,
    // 0 vectorized — and until this branch existed its two clean captures could not be scored at all,
    // while the 8 that could embedded a reverted, partly-vectorized copy of the same book. Retrieval then
    // contributes nothing, every entry arrives by the keyword route, and the scene is deterministic: no
    // index, no embedding call, no ollama. corpusMean is the only thing that cannot take an empty list,
    // and it is guarded here rather than in plugin/ so this needs no redeploy.
    const items = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')).items : [];
    // AN EMPTY COLLECTION IS ONLY LEGITIMATE WHEN THE BOOK HAS NOTHING TO INDEX. Same gate reindex.mjs
    // buildItems applies, so the two agree on what "nothing to index" means. Without this the two cases are
    // indistinguishable at runtime: a missing collection scores keyword-and-BM25-only and returns a
    // plausible number rather than an error, which is what a bundle opened on a machine that never held the
    // author's vectors does. Measured on this corpus: the same scene read 10/10 judged with the index and
    // 0/0 without, and only the second one looked like a result.
    if (!items.length && entries.some(e => e.vectorized && !e.disable && e.content)) {
        throw new Error(`no vector collection for "${primary}" at ${indexFile} — the book has vectorized entries, so scoring without one would silently drop cosine. Build it with: node eval/reindex.mjs <sample.json>`);
    }
    const loaded = { items, mean: items.length ? corpusMean(items) : [], lexical: buildLexical(items) };

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
    // suppressGazetteerKeys splits this from the activation half of suppressVectorKeys (see sceneParams);
    // null is production, where one flag drives both.
    const gazEntries = (P.suppressGazetteerKeys ?? P.suppressVectorKeys)
        ? gazSource.map(e => (e.vectorized ? { ...e, key: [], keysecondary: [] } : e))
        : gazSource;
    const gaz = ranking.buildGazetteer(gazEntries);

    // THE POOL IS WHAT WAS JUDGED, and ONLY that — see graded-scene-grid.mjs. OWN is this capture's own
    // non-durable rows, kept separately so coverage warnings stay about re-derivation failing rather than
    // about sibling arms legitimately disagreeing.
    //
    // OWN USED TO BE UNIONED INTO THE POOL, which was a shorthand for "a capture logs exactly the rows the
    // grader was shown" — true while every logged row got a verdict, and false the moment a sample records a
    // population wider than the graded set. A re-derived bundle logging 144 rows against 47 grades then
    // reported judged@10 of 100% on a scene that was 18% judged, so the stopping rule said "pool is
    // adequate" precisely where it was not. An ungraded row is unjudged no matter who logged it.
    const OWN = new Set((S.candidates ?? []).filter(c => !isDurable(c) && (!c.world || c.world === primary)).map(c => Number(c.uid)));
    const POOL = new Set((S.grades ?? [])
        .filter(g => Number.isFinite(Number(g.uid)) && (!g.world || g.world === primary) && !isExcluded(g.title))
        .map(g => Number(g.uid)));

    return { primary, entries, byUid, items, loaded, gaz, gazSource, isExcluded, POOL, OWN };
}

/**
 * Grade lookup. By uid when every grade carries one (every /wa-grade sample does) — token-subset title
 * matching alone misattributes when one graded title's tokens are a subset of a sibling's ("Villa" also
 * matches "Villa Party", first-found wins). Titles remain the fallback for hand-written samples, and a bare
 * string argument always resolves by title.
 *
 * RETURNS null FOR "NOBODY JUDGED THIS", NOT 0. A judged 0 is a verdict — someone looked and said not
 * relevant — while an absent grade is the pool not reaching that row, and the two want opposite
 * treatment: the first is evidence, the second is a hole. Collapsing them to 0 hid both. It made the
 * reference tier's grade distribution unreadable (its g0 bucket was mostly unjudged rows), and under
 * "activation supplies delivery" it would silently score a correctly-fired, never-judged reference
 * entry as a miss. Out-of-scope titles also return null: the harness has no usable verdict for them.
 *
 * Callers that need a number say so. For nDCG that is `?? 0`, which is the standard partial-label
 * rule and is now written where it applies rather than assumed everywhere.
 */
export function makeGradeOf(grades, isExcluded) {
    const list = (grades ?? [])
        .filter(x => x && x.title && Number.isFinite(gradeValue(x)))
        .map(x => ({ tk: nrm(x.title), g: gradeValue(x), title: x.title, uid: x.uid }));
    const kept = list.filter(g => !isExcluded(g.title));
    // uid is authoritative only when the grade set is uid-complete; a mixed set falls back to titles
    // wholesale rather than resolving half the rows by a different rule.
    const byUid = list.length && list.every(g => Number.isFinite(Number(g.uid)))
        ? new Map(kept.map(g => [Number(g.uid), g.g]))
        : null;
    const byTitle = title => { const mt = new Set(nrm(title)); const h = kept.find(x => x.tk.length && x.tk.every(t => mt.has(t))); return h ? h.g : null; };
    return r => {
        const uid = Number(r?.uid ?? r?.key);
        if (byUid && Number.isFinite(uid)) return byUid.get(uid) ?? null;
        return byTitle(typeof r === 'string' ? r : String(r?.title ?? ''));
    };
}

/**
 * The three populations, as predicates over a raw ENTRY. They cross-cut, which is why there are three
 * names and not two: a keyword-activated reference entry is not durable, and a durable entry may be
 * either tier.
 *
 *   memory     STMB-marked — a scene summary ranking chose
 *   reference  everything else — world rules, settings, standing sheets
 *   durable    constant or configured-sticky — in the prompt by intent, not by relevance
 *
 * Provenance, never routing: the marker cannot drift with the configuration under evaluation, where
 * `vectorized`/`sticky`/`constant` all can. Presence of the marker is the whole signal — never its range
 * (see eval/repair-markers.mjs).
 *
 * `isDurableEntry` asks of an entry what `isDurable` (extension/grading.mjs) asks of a capture row; the
 * two shapes carry the constant flag differently and cannot share an implementation.
 */
export const isMemory = e => Boolean(e) && ('stmemorybooks' in e || 'STMB_start' in e);
export const isReference = e => !isMemory(e);
export const isDurableEntry = e => Boolean(e?.constant) || Number(e?.sticky) > 0;

/** Keys the production scan would actually score. suppressVectorKeys blanks a vectorized entry's keys at
 *  scan time (worldsapart.js suppressKeys), and scoreVectorKeys is what re-admits the stashed originals —
 *  offline the originals ARE e.key, since samples embed the book raw. Scoring raw keys unconditionally gave
 *  vectorized entries a keys signal production can never produce, the keyword-side twin of the gazetteer
 *  bug documented in loadScene.
 *
 *  P.dropKeys (array of exact key strings) simulates removing those keys from the book: they stop scoring
 *  AND stop keyword-activating, since stage-2 activation tests `keywordScore > 0` through this same
 *  function. NOT removed from the gazetteer — a real book edit would also drop them there, so a dropKeys
 *  arm understates removal by whatever those terms contribute to term weighting. */
/** Whole-word presence of a bare name in the entry's own content — the mechanical fill rule for
 *  addCastKeys. Per-name regex cached at module level; case-insensitive to match the default key flags. */
const nameRe = new Map();
const mentions = (name, content) => {
    let re = nameRe.get(name);
    if (!re) nameRe.set(name, re = new RegExp(`(?<!\\w)${name.toLowerCase()}(?!\\w)`));
    return re.test((content ?? '').toLowerCase());
};

export const scoringKeys = (e, P) => {
    let base = e.key ?? [];
    // P.addCastKeys (array of bare names) simulates uniform placement: each name is appended wherever the
    // entry's CONTENT mentions it whole-word and no key already carries it (exact or "Name Surname" form).
    // Applied before the suppress gate so a filled key behaves exactly like a book key would.
    if (P.addCastKeys?.length) {
        const have = base.map(k => k.toLowerCase());
        const fills = P.addCastKeys.filter(n => {
            const ln = n.toLowerCase();
            return !have.some(k => k === ln || k.startsWith(ln + ' ')) && mentions(n, e.content);
        });
        if (fills.length) base = [...base, ...fills];
    }
    const ks = (e.vectorized && P.suppressVectorKeys && !P.scoreVectorKeys) ? [] : base;
    return P.dropKeys ? ks.filter(k => !P.dropKeys.includes(k)) : ks;
};

/** Keyword score via the SHARED matcher.keywordScore (which mirrors ST core's matchKeys).
 *  Pushed per call, not once at construction: arms hold their scorers across each other's runs, so
 *  a mode set at build time would be whichever arm was constructed last. */
export const makeKeywordScore = P => (e, text, k1) => {
    matcher.setBoundaryMode(P.wordBoundary);
    return matcher.keywordScore(e, text, scoringKeys(e, P), { k1, caseSensitiveDefault: P.caseSensitive, wholeWordsDefault: P.wholeWords }).score;
};

/**
 * Builds the candidate set — every entry that would be in the ranking, with its per-signal scores.
 *
 * SPANS THREE STAGES, and they are marked below because collapsing them is how this harness has produced
 * wrong numbers twice. Production keeps them apart by construction: retrieval runs in selectAndActivate on
 * one event and scoring in rankActivated on another. Offline there is no event loop, so they collapse into
 * one pass — which is a reason to label the boundaries, not to forget they exist.
 *
 * Stage 2 genuinely depends on a stage-3 computation: `keywordScore > 0` is what decides keyword
 * activation. Core has the same dependency — matching serves both — so this is faithful, not a shortcut.
 *
 * @returns {(k1: number, b: number, tw: object|null, qvec: number[], qtext: string, scanText: string) => object[]}
 */
export function makeCandidateSet({ loaded, byUid, entries, params: P, topK }) {
    const keywordScore = makeKeywordScore(P);
    return (k1, b, tw, qvec, qtext, scanText) => {
        // Resolve 'auto' here, once, so the admit/floor filters below compare against the same number
        // scoreCollection gated with — the same p90-of-live-scores the plugin computes.
        // --- STAGE 1: RETRIEVAL. Score every chunk, apply the admission gates, pool per entry, take top-K.
        const thr = P.threshold === 'auto' ? quantile(centeredCosineScores(loaded.items, qvec, loaded.mean, P.meanCentered), 0.9) : P.threshold;
        let scored = scoreCollection(CID, loaded, qvec, { centered: P.meanCentered, threshold: thr, queryText: qtext, k1, b, termWeights: tw, stopwordDf: P.stopwordDf, commonWordWeight: P.commonWordWeight, uncenteredGate: P.uncenteredGate });
        if (P.admit === 'cosine') scored = scored.filter(m => m.score >= thr);
        else if (P.admit === 'both') scored = scored.filter(m => m.score >= thr && m.bm25 > 0);
        if (P.bm25Floor > 0) scored = scored.filter(m => m.score >= thr || m.bm25 >= P.bm25Floor);
        if (P.bm25FloorPct > 0) {
            const nz = scored.map(m => m.bm25).filter(x => x > 0).sort((a, b) => a - b);
            const floor = nz.length ? nz[Math.min(nz.length - 1, Math.floor(P.bm25FloorPct * nz.length))] : 0;
            if (floor > 0) scored = scored.filter(m => m.score >= thr || m.bm25 >= floor);
        }
        const grouped = selectTopK(poolEntries(scored), topK);
        const per = new Map();
        for (const m of grouped[CID]?.metadata ?? []) { const uid = Number(m.index); const c = per.get(uid) ?? { score: -Infinity, bm25: 0 }; c.score = Math.max(c.score, m.score); c.bm25 = Math.max(c.bm25, m.bm25); per.set(uid, c); }
        const rows = [];
        // --- STAGE 2: ACTIVATION (retrieval route). Whatever survived the cut above is in the ranking.
        // `entry` is carried so fuseRanks can read eligibility (and authored order) the way production does.
        //
        // DISABLED ENTRIES ARE EXCLUDED HERE TOO, and this route is why the exclusion matters. Disabling an
        // entry does NOT purge its chunks from the collection, so the index keeps answering for it long after
        // core stopped activating it — measured: every one of the 41 ungraded rows in the top-40 of three
        // sommers scenes was a disabled entry, all of them still in the index, 34% of the delivered slots.
        // They read as "unjudged" for the honest reason that no live capture could ever have listed them, so
        // the pool is complete and the RANKING was wrong. The keyword route below has always guarded this;
        // its comment used to justify being the only guard by claiming a disabled entry "is never indexed
        // either", which the index disproves.
        //
        // Dropped at admission rather than filtered from `entries`: the gazetteer and the BM25 corpus must
        // still see every entry, or the term weights move and the comparison measures the wrong thing.
        for (const [uid, s] of per) { const e = byUid.get(uid); if (e && !e.disable) rows.push({ uid, entry: e, title: wiTitle(e), score: s.score, textScore: s.bm25, keywordScore: keywordScore(e, scanText, k1), vectorEligible: !!e.vectorized, keysEligible: scoringKeys(e, P).length > 0 }); }
        // --- STAGE 2: ACTIVATION (keyword route). Stands in for ST core's keyword match, so it may only
        // admit an entry core could actually have activated. Two exclusions, both stage-2 facts:
        //
        //   disable            core never activates a disabled entry — 279 of 611 keyword-only rows on the
        //                      curated sommers scenes arrived this way before the guard. The retrieval route
        //                      needs the same exclusion for a different reason (see above): a disabled entry
        //                      stays in the collection, so that door does not close on its own.
        //   suppressVectorKeys blanks a vectorized entry's keys so core CANNOT keyword-activate it. Its only
        //                      door is retrieval, i.e. `per`. scoreVectorKeys does not reopen this one — that
        //                      setting is stage 3, and re-admits the stashed keys for SCORING alone. Without
        //                      this guard a capture with both settings on (every sommers arm) admitted 209
        //                      more rows by key, and keys appeared to rescue vector entries production would
        //                      never have ranked.
        for (const e of entries) { const uid = Number(e.uid); if (per.has(uid) || e.disable || (e.vectorized && P.suppressVectorKeys)) continue; const kw = keywordScore(e, scanText, k1); if (kw > 0) rows.push({ uid, entry: e, title: wiTitle(e), score: undefined, textScore: 0, keywordScore: kw, vectorEligible: !!e.vectorized, keysEligible: true }); }
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
 * The stage-4 cliff as the runtime applies it: over the fused LAYOUT ranking's dynamic block, not over
 * the retrieval ranking. One helper so graded-scene-grid and paired-arms cannot drift — the same rule
 * that keeps the gazetteer and the scorers in one place.
 *
 * Reference-tier rows are the harness's sticky/constant analogue: they reach the prompt because a key
 * fired, not because ranking chose them, so they are outside the cliff's population exactly as constants
 * are at runtime.
 *
 * DURABLE IS OUT OF THE POPULATION, matching the runtime — the budget may cut a constant for capacity,
 * the cliff may not cut it for relevance. REFERENCE IS IN IT, also matching the runtime, because a
 * keyword-activated entry is neither sticky nor constant and so lands in `results` there.
 *
 * `scoreScene` still strips reference rows before its RANKING metrics (triggered == relevant); whether
 * the cliff is entitled to cut them is a different question and the answer is yes.
 *
 * `refKept`/`refAll` report composition over the CUT population, so a cliff eating the reference tier is
 * visible. Read it as a calibration symptom, not as a case for a quota: the fused score is meant to make
 * a grade-3 memory entry beat a grade-2 reference entry, and if reference rows vanish at equal grade
 * that is fuseRanks failing to compare across provenance, which no cliff placement can rescue.
 *
 * @param {Array<object>} layout Fused layout ranking, best first, durable rows already excluded by the caller
 * @param {object} P Scene params (vectorCutoff, minVectorEntries, elbowSensitivity, …)
 * @returns {{kept: Array<object>, dropped: Array<object>, refKept: number, refAll: number}}
 */
export function cliffCut(layout, P) {
    // `layout` is ALREADY durable-filtered by the caller — graded-scene-grid's `layoutOf` does exactly
    // that split, and re-deriving it here is the second copy the gazetteer rule exists to prevent.
    const { ranked, dropped } = cutDynamic({ sticky: [], constant: [], results: layout }, {
        mode: P.vectorCutoff ?? 'off',
        minVectorEntries: P.minVectorEntries ?? 3,
        elbowSensitivity: P.elbowSensitivity ?? 1.5,
        dropoffThreshold: P.dropoffThreshold ?? 0.06,
    });
    return {
        kept: ranked,
        dropped,
        refKept: ranked.filter(r => isReference(r.entry)).length,
        refAll: layout.filter(r => isReference(r.entry)).length,
    };
}

/**
 * Scores one scene end to end at one parameter set: nDCG on the pooled rows, plus judged coverage of the
 * unfiltered top-k.
 *
 * THE TWO RANKINGS ARE DELIBERATELY DIFFERENT. Both drop the reference tier first; after that, nDCG is
 * measured on the pool (grades only exist there), while coverage is measured on the unpooled ranking —
 * because the question coverage answers is whether the top-k this configuration produces carries grades
 * at all, from any rater, and restricting to the pool first would answer it 100% by construction. It is
 * not about what ships — that is what survives selection — nor about human raters specifically. A scene
 * whose coverage is short is reporting a LOWER BOUND on nDCG.
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
    if (preloaded && (overrides.suppressVectorKeys !== undefined || overrides.suppressGazetteerKeys !== undefined)) {
        throw new Error('suppressVectorKeys/suppressGazetteerKeys change the gazetteer, so they cannot be swept against a preloaded scene — load per arm');
    }
    const scene = preloaded ?? loadScene(S, { indexFile: indexPath(S, { vectors, model, index }), params: P });
    const scoreAll = makeCandidateSet({ ...scene, params: P, topK: topK ?? Math.max(100, P.maxVectorEntries * 2) });
    const fuse = makeFuse(P);
    const gradeOf = makeGradeOf(S.grades, scene.isExcluded);

    const query = S.query;
    const tw = (P.entityFilter && P.queryMode !== 'summary') ? ranking.buildTermWeights(query, scene.gaz, P.boost) : null;
    // No collection means no cosine to compute, so the embed call is skipped rather than made and ignored.
    const qv = cachedQv ?? (scene.items.length ? await embed(query, { ollama, model }) : []);
    const all = scoreAll(P.K1, P.B, tw, qv, query, S.scanText);

    // REFERENCE-TIER EXCLUSION — the condensed-list convention from FULLBOOK-AUDIT-2026-08-10 (shared
    // metrics): ranking metrics remove reference/card entries from the ranked list before computing;
    // REMOVED, not zero-graded, or they punish the ranker for routing's job. A keyword entry is reference
    // tier with "triggered == relevant" — its key firing IS the inclusion decision — so assessing it
    // against a graded ranking is a category error; whether the trigger fires correctly is the
    // matcher/audit's question. The class label is the audit's mechanical one, provenance not routing:
    // kind = STMB-marked ? memory : reference — chosen because it derives from what the entry IS and
    // cannot drift with the configuration being evaluated (vectorized/sticky/constant all can). The
    // durable clause keeps isDurable (extension/grading.mjs) semantics for marked entries too.
    //
    // TWO REASONS, SPELLED SEPARATELY. A reference entry is excluded because triggered == relevant makes
    // ranking it a category error; a durable entry is excluded because relevance never chose it. One
    // predicate covering both would name neither.
    const rankable = all.filter(r => !isReference(r.entry) && !isDurableEntry(r.entry));

    const top = fuse(rankable, P.LEXW).slice(0, k);
    const unjudged = top.filter(r => !scene.POOL.has(Number(r.uid)));
    // Read the DEPLOYED slice's grades before the pooled re-fuse below mutates shared rows.
    const topGrades = top.map(r => gradeOf(r) ?? 0);
    // Re-fuse the pooled subset AFTER reading the slice above: fuse mutates, and the subset shares references.
    // FROM `rankable`, NOT `all` — the exclusion above is the whole point, and reading `all` here applied it
    // to coverage alone. That is what it did until 2026-08-12: every nDCG this harness had ever printed still
    // ranked the reference tier, and a reference-only book reported `judged 0/0` beside a healthy nDCG.
    // `?? 0` is the standard partial-label rule: an unjudged row occupies its rank and contributes
    // nothing. Explicit here because gradeOf now returns null for it — see makeGradeOf.
    const g = fuse(rankable.filter(r => scene.POOL.has(Number(r.uid))), P.LEXW).map(r => gradeOf(r) ?? 0);

    // SET METRICS, on the ASYMMETRIC bars: recall counts only grade >= 3 (did the must-deliver material
    // arrive), while precision credits a 3 or 4 in full and a 2 at half (metrics.mjs gradeCredit). Both read
    // the UNPOOLED top-k — what this configuration would actually put in front of a user — so an ungraded row
    // still occupies a slot and still costs precision, the same `?? 0` convention nDCG uses. Scoring them off
    // the pooled subset instead would flatter every arm by deleting its own misses.
    //
    // WHY THESE EXIST BESIDE nDCG. A ranking metric can only credit an entry that lands inside k, so it is
    // structurally blind to an arm whose action is ADMITTING entries; F-beta at RECALL_WEIGHT weights the
    // recall half, which is the half such an arm moves. Recall is also the pool-robust half — an ungraded row
    // is not in the relevant set, so it cannot depress recall the way it depresses precision and nDCG.
    //
    // NOT the layout score the doc rules for: that one is at the token BUDGET over the dynamic block, and
    // this is a fixed k. A fixed k also cannot express "as many as are relevant and no more" — two
    // configurations delivering 6 and 20 entries to catch the same 6 score identically here. Read it as
    // directional until the window is what the configuration actually delivered.
    const relevant = g.filter(x => x >= 3).length;
    const precision = top.length ? topGrades.reduce((sum, x) => sum + gradeCredit(x), 0) / top.length : 0;
    const recall = relevant ? topGrades.filter(x => x >= 3).length / relevant : 0;
    const f2 = fbeta(precision, recall, RECALL_WEIGHT);

    return {
        n: ndcg(g, k),
        nAt5: ndcg(g, 5),
        precision,
        recall,
        f2,
        relevant,
        judged: top.length - unjudged.length,
        of: top.length,
        unjudged: unjudged.map(r => r.title),
        // The unjudged rows with their identity, which is what an offline pool extension needs: these are
        // exactly the entries this configuration would put in front of a user and nobody has judged.
        unjudgedRows: unjudged.map(r => ({ uid: Number(r.uid), title: r.title, rank: top.indexOf(r) + 1 })),
        terms: tw ? Object.keys(tw).length : null,
    };
}
