// scene.mjs — loads and scores ONE graded scene from a /wa-grade sample; the single copy of the gazetteer
// and the scorers that graded-scene-grid.mjs and param-screen.mjs share. A second copy must never appear.
import fs, { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
// Re-exported: every existing importer reads it from here.
export { stInstall } from './st-install.mjs';
import { stInstall } from './st-install.mjs';
import { scoreCollection, poolEntries, selectTopK, admitCeiling } from '../../plugin/scoring.mjs';
import { corpusMean, centeredCosineScores } from '../../plugin/vector.mjs';
import * as entity from '../../extension/entity.mjs';
import * as matcher from '../../extension/matcher.mjs';
import { hasPromoteDecorator } from '../../extension/matcher.mjs';
import { isDurable, openBundle } from '../../extension/grading.mjs';
import * as selection from '../../extension/selection.mjs';
import * as delivery from '../../extension/delivery.mjs';
import { buildContentIndex, scoreContent, entryKey } from '../../extension/content-lexical.mjs';
import { defaultSettings } from '../../extension/state.mjs';
// Cycle with reindex.mjs (getStringHash); safe only while neither side references the other at module scope.
import { cachePath, chunkConfig, embedTexts, pathSafe, resolveModel } from './reindex.mjs';
import { gradeCredit, fbeta, RECALL_WEIGHT, gradeValue, topComponents, projectOut, componentScales } from './metrics.mjs';
import { loadBasis } from './global-basis.mjs';

/** Whether an item is in the vector collection; membership only, it never gates the text signal. */
export const inVectorIndex = it => it.vectorEligible ?? it.entry?.vectorized ?? Number.isFinite(it.score);

/** Unit Separator — never NUL, which makes git treat the file as binary. */
const US = String.fromCharCode(31);

/** Drops graded rows AND book entries post-dating the scene's frozen turn; books too, since `makeCandidateSet` re-derives the pool from them. */
export const dropUnavailable = (S, label = "sample") => {
    const at = Number(S?.generatedFrom?.msg);
    if (!Number.isFinite(at)) return S;
    const start = new Map(), end = new Map();
    for (const [w, bk] of Object.entries(S.books ?? {})) {
        for (const e of Object.values(bk ?? {})) {
            start.set(`${w}${US}${e.uid}`, Number(e.STMB_start));
            end.set(`${w}${US}${e.uid}`, Number(e.STMB_end));
        }
    }
    // The boundary is relevance.mjs postDates, never restated here: the runtime's dropUnavailable must agree on it.
    const future = r => postDates({ STMB_end: end.get(`${r.book}${US}${r.uid}`), STMB_start: start.get(`${r.book}${US}${r.uid}`) }, at);
    let cut = 0, gone = 0;
    const keep = list => (list ?? []).filter(r => (future(r) ? (cut++, false) : true));
    S.entries = keep(S.entries);
    S.candidates = keep(S.candidates);
    // The index cache is keyed per book, not per scene (reindex.mjs cachePath), so it must be built from the pristine copy (P4).
    S.pristineBooks ??= structuredClone(S.books ?? {});
    for (const [book, bk] of Object.entries(S.books ?? {})) {
        for (const [k, e] of Object.entries(bk ?? {})) {
            if (future({ book, uid: e.uid })) { delete bk[k]; gone++; }
        }
    }
    if (cut || gone) console.error(`  ${label}: dropped ${gone} entr(ies) and ${cut} graded/candidate row(s) post-dating message ${at}`);
    // Reported, not dropped: a missing STMB_start reads as always-available, which is wrong for a MEMORY entry (P5).
    const unverified = Object.entries(S.books ?? {}).flatMap(([, bk]) => Object.values(bk ?? {}))
        .filter(e => isMemory(e) && !Number.isFinite(Number(e.STMB_start))).length;
    if (unverified) console.error(`  ${label}: ${unverified} MEMORY entr(ies) carry no STMB_start — availability unchecked, not verified as available`);
    return S;
};

/** Groups book names into LINEAGES by shared entry bodies; count these, not files (C2). The group takes the most recently used name. */
export const lineagesOf = (booksByName, recency = new Map()) => {
    const norm = t => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const sigs = new Map(Object.entries(booksByName).map(([b, bk]) =>
        [b, new Set(Object.values(bk ?? {}).filter(e => e.content).map(e => norm(e.content)))]));
    const names = [...sigs.keys()];
    const parent = new Map(names.map(n => [n, n]));
    const find = x => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
            const A = sigs.get(names[i]), B = sigs.get(names[j]);
            const smaller = Math.min(A.size, B.size);
            if (!smaller) continue;
            let shared = 0;
            for (const x of A) if (B.has(x)) shared++;
            if (shared / smaller >= 0.3) parent.set(find(names[i]), find(names[j]));
        }
    }
    const members = new Map();
    for (const b of names) {
        const r = find(b);
        if (!members.has(r)) members.set(r, []);
        members.get(r).push(b);
    }
    const out = new Map();
    for (const group of members.values()) {
        const stamp = x => String(recency.get(x) ?? '');
        const label = [...group].sort((a, b) =>
            stamp(b).localeCompare(stamp(a)) || (a.length - b.length) || a.localeCompare(b))[0];
        for (const b of group) out.set(b, label);
    }
    return out;
};

export const openSample = (path, arm = null) => openBundle(JSON.parse(readFileSync(path, 'utf8')), arm);

export const sceneLabel = S => (S?.arm ? `${S.name ?? ''}--${S.arm}` : String(S?.name ?? ''));

/** The haystack composer for a scene, per entry: `(entry) => string[]`. `over` widens the chat or depth for the depth ablation. */
export function haystackFor(S, P, over = {}) {
    const windowFor = matcher.makeWindowFor(over.chat ?? S.scanChat ?? [], {
        injects: S.injects ?? [],
        sources: S.sources ?? {},
        matchWindow: P.matchWindow,
        includeNames: P.includeNames,
    });
    return entry => windowFor(matcher.scanDepthFor(entry, over.depth ?? S.depth), entry);
}

/** Key hits for one entry against a scan window — the same call onScanDone makes. */
export function whyFor(entry, scanText, P) {
    matcher.setBoundaryMode(P.wordBoundary);
    const keys = scoringKeys(entry, P);
    if (!keys.length || !scanText) return [];
    const { hits } = matcher.keywordScore(entry, scanText, keys, { k1: P.K1, caseSensitiveDefault: P.caseSensitive, wholeWordsDefault: P.wholeWords });
    return hits.slice(0, 4).map(h => {
        const contexts = matcher.keyExcerpts(h.key, scanText, entry.caseSensitive, entry.matchWholeWords);
        return { key: h.key, count: h.count, excerpt: contexts[0] ?? null, contexts };
    });
}

/** ST's string hash, which names a book's collection (wa_${hash(bookName)}); must stay bit-identical to ST's. */
export const getStringHash = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); };

/** A book's drift fingerprint (entry count, gazetteer-field hash, body hash); callers record `null` for a book with NO WORLD FILE. */
export const bookFingerprint = (book) => {
    const list = Object.values(book ?? {}).sort((a, b) => Number(a.uid) - Number(b.uid));
    const RS = String.fromCharCode(30);
    let gaz = '', content = '';
    for (const e of list) {
        gaz += [e.uid, (e.key ?? []).join(US), (e.keysecondary ?? []).join(US), e.comment ?? ''].join(US) + RS;
        content += [e.uid, e.content ?? ''].join(US) + RS;
    }
    return { entries: list.length, gaz: getStringHash(gaz), content: getStringHash(content) };
};

/** An entry's display title, exactly as the extension derives it (comment, else keys, else uid). */
export const wiTitle = e => (e.comment && e.comment.trim()) ? e.comment.trim() : (e.key?.length ? e.key.join(', ') : `UID ${e.uid}`);

/** Title normaliser for grade matching: lowercase alphanumeric tokens, singles dropped. */
export const nrm = s => (String(s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1);

export const dcg = (v, k) => v.slice(0, k).reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
export const ndcg = (vec, k) => { const ideal = [...vec].sort((a, b) => b - a); return dcg(ideal, k) ? dcg(vec, k) / dcg(ideal, k) : 0; };


export const evalDataDir = () => {
    const local = fileURLToPath(new URL('../eval-data/', import.meta.url));
    const st = stInstall();
    return existsSync(local) || !st ? local : `${st.root}/public/scripts/extensions/third-party/WorldsApart/eval/eval-data/`;
};

const embedModelOf = S => {
    if (!S?.embedModel) throw new Error('sample records no embedModel — the harness reads the model off the bundle');
    return S.embedModel;
};
/** One book's vector collection, ending at the rebuild cache, which may not exist yet. Only the primary may take `index` or `S.index`: both name ONE file. */
export const indexPath = (S, { vectors = 'data/default-user/vectors/ollama', model = resolveModel(embedModelOf(S)).label, index = null, all = false, book = S.primaryBook } = {}) => {
    const own = book === S.primaryBook;
    if (index && own) return index;
    if (all) return cachePath(S, chunkConfig(S), model, book, true);
    // Through stInstall, not the cwd: both local candidates carry ST's data/ prefix.
    const st = stInstall();
    const local = p => (st ? st.resolve(p) : p);
    if (own && S.index && existsSync(local(S.index))) return local(S.index);
    const derived = local(`${vectors}/wa_${getStringHash(book)}/${pathSafe(model)}/index.json`);
    if (existsSync(derived)) return derived;
    return cachePath(S, chunkConfig(S), model, book);
};

const qCache = new Map();
/** The cache file for one model label. `pathSafe` only, as cachePath treats the model half of a collection path. */
export const queryCachePath = label => fileURLToPath(new URL(`../eval-data/query-cache__${pathSafe(label)}.jsonl`, import.meta.url));
const qCachePath = queryCachePath;
const qCacheLoad = (label) => {
    if (qCache.has(label)) return qCache.get(label);
    const m = new Map();
    const p = qCachePath(label);
    if (existsSync(p)) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
            if (!line) continue;
            try { const r = JSON.parse(line); if (r?.h && Array.isArray(r.v)) m.set(r.h, r.v); } catch { /* a torn last line from a killed append */ }
        }
    }
    qCache.set(label, m);
    return m;
};
export const embed = async (text, { ollama = 'http://localhost:11434', model, endpoint = 'ollama', url = ollama, label = model } = {}) => {
    if (!model) throw new Error('embed needs a model — the caller resolves one; there is no default embedder');
    const store = qCacheLoad(label);
    const h = createHash('sha256').update(text).digest('hex');
    const hit = store.get(h);
    if (hit) return hit;
    const v = (await embedTexts([text], { model, endpoint, url }))[0];
    store.set(h, v);
    fs.appendFileSync(qCachePath(label), `${JSON.stringify({ h, v })}\n`);
    return v;
};

/** The sample's own `params` over these defaults, then `overrides`. The scorer constants come off state.mjs, which owns them. */
export const sceneParams = (S, overrides = {}) => ({
    K1: defaultSettings.bm25K1, B: defaultSettings.bm25B, boost: defaultSettings.properNounBoost, stopwordDf: defaultSettings.stopwordDocFreq,
    // null = each tier's fit's own cutoff; a cutoff arm sets one number for both tiers (scoreScene admits).
    memoryCutoff: null,
    // Which fit scores the column, by name; null is production. An arm setting this must also fix memoryCutoff.
    relevanceFit: null,
    // Directory holding relevance-model-<tier>.json, from the cwd; null is the shipped extension/ pair. Same warning.
    fitDir: null,
    caseSensitive: false, wholeWords: false, includeNames: true,
    // How the haystack is segmented for countKey; a document that records it overrides this.
    matchWindow: 'scan',
    // What counts as inside a word when wholeWords is on (shipped 'strict'). Matcher module state: pushed through setBoundaryMode per call.
    wordBoundary: 'strict',
    // Occurrences -> score (matcher.mjs repeatCurveOf). 'bm25', not the shipped 'presence-log': captures predating the setting must reproduce.
    repeatCurve: 'bm25', repeatR: 1,
    meanCentered: true,
    // A stage-3 cosine for entries the collection has no row for; needs a reindex.mjs --all index. Production, so on.
    denseAllEntries: true,
    // Which entries define the corpus mean (plugin/vector.mjs): 'vectorized', 'memory' (production) or 'memoryArchived' (adds disabled memory entries; needs a --archived index).
    centroidPopulation: 'memory',
    // What a REFERENCE entry's stage-3 cosine is centred on: 'memory' (production: both sides on the centroid above),
    // 'reference' (both sides on the reference-tier mean), 'cross' (query on the centroid, items on the reference mean), 'raw' (uncentred).
    referenceCentroid: 'memory',
    // How many leading components of the centred corpus are projected out, on top of the mean; 0 is production.
    pcRemove: 0,
    // Whitening: how many of the book's own directions to rescale (whitenR, 0 is production) and by how much (whitenAlpha).
    whitenR: 0,
    whitenAlpha: 1,
    // The token ceiling stage 5 walks the layout under; 0 leaves the budget unmodelled. Passed in, never read off the bundle.
    budgetTokens: 0,
    // How many shared components come off first (global-basis.mjs, per book, leave-one-lineage-out); 0 is production.
    sharedComponents: 0,
    maxVectorEntries: 20, entityFilter: true,
    // Which fields the gazetteer reads: 'keys+titles' (shipped), 'keys', 'titles', 'bodies' (shipped plus content), 'none'.
    gazetteerSource: 'keys+titles',
    // How stage A picks its components: 'rank' (first N by variance) or 'shared' (lowest eta^2; needs a basis carrying eta).
    sharedSelect: 'rank',
    // Which scatter stage A's directions come off: 'pooled' PCA, or 'within' (reads a separate --within basis).
    sharedScatter: 'pooled',
    // Exact key strings to treat as removed from the book (see scoringKeys). Null = none.
    dropKeys: null,
    // Per-book quota for stage 5 (applyBudget capOf), as {book: cap}; null = no cap. No bundle records the live setting.
    bookCaps: null,
    // ST core's two recursion settings, by their own names. Off is what every capture predating this was made under,
    // so the default must stay false or their keys scores move. maxRecursionSteps 0 is core's "no cap", not "no passes".
    recursive: false,
    maxRecursionSteps: 0,
    ...(S.params ?? {}), ...overrides,
});

/** Loads a sample into everything needed to score it: every attached book in one ranking, row identity `entryKey` (book, uid); `indexFile` is the PRIMARY book's, the others resolve their own. */
export function loadScene(S, { indexFile, indexOpts = {}, params: P }) {
    const primary = S.primaryBook;
    if (!S.books?.[primary]) throw new Error(`sample's primaryBook "${primary}" is not among its embedded books (${Object.keys(S.books ?? {}).join(', ') || 'none'})`);
    // Fingerprint guard, once per sample: dropUnavailable mutates the books, so a re-check would compare a stripped book.
    for (const a of (S.availabilityFiltered ? [] : S.generatedFrom?.attached ?? [])) {
        if (!a?.fingerprint) continue;                       // named but no world file; nothing was embedded
        const have = S.books?.[a.book];
        if (!have) throw new Error(`document records book "${a.book}" as embedded but does not carry it — the gazetteer would be narrower than the one it was derived under`);
        const now = bookFingerprint(have);
        const moved = ['entries', 'gaz', 'content'].filter(k => now[k] !== a.fingerprint[k]);
        if (moved.length) {
            throw new Error(`embedded book "${a.book}" has changed since derivation (${moved.join(', ')} differ) — `
                + `re-derive rather than score, or the numbers describe a book the grades were not made against`);
        }
    }
    // After the fingerprint guard, before anything is built from the books.
    if (!S.availabilityFiltered) { dropUnavailable(S, S.name ?? 'sample'); S.availabilityFiltered = true; }
    // Primary first: loaded[0] and items are the primary's, and a bundle does not promise its key order.
    const books = [primary, ...Object.keys(S.books).filter(b => b !== primary)];
    // world is optional in a world file and entryKey reads it; ??= because a copy that has one is the authority (F50).
    for (const b of books) for (const e of Object.values(S.books[b])) e.world ??= b;
    const entries = books.flatMap(b => Object.values(S.books[b]));
    const byKey = new Map(entries.map(e => [entryKey(e), e]));

    /** One book's collection, split by stage and centred on its OWN mean, as the plugin does per collection. */
    const loadBook = (book, indexFile) => {
        const own = Object.values(S.books[book]);
        const uids = new Set(own.map(e => Number(e.uid)));
        // No collection is a configuration, not a failure (F50); the index is pristine, so the uid filter is what enforces availability.
        const rawAll = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')).items : [];
        const raw = rawAll.filter(it => uids.has(Number(it.metadata?.index)));
        // --all index: vectorized chunks stay stage 1's items, the rest are stage-3 extras, centroid-only (archived) chunks reach neither.
        const archived = raw.filter(it => it.metadata?.centroidOnly);
        const live = raw.filter(it => !it.metadata?.centroidOnly);
        const vectorUids = new Set(own.filter(e => e.vectorized).map(e => Number(e.uid)));
        const ofVectorized = it => vectorUids.has(Number(it.metadata?.index));
        const items = P.denseAllEntries ? live.filter(ofVectorized) : live;
        const extra = P.denseAllEntries ? live.filter(it => !ofVectorized(it)) : [];
        // Asked of the BOOK, not the file: a fully vectorized book legitimately has no extras.
        if (P.denseAllEntries && !extra.length && own.some(e => !e.vectorized && !e.disable && e.content)) throw new Error(`denseAllEntries is on but ${indexFile} holds no non-vectorized chunks for "${book}" — build that collection with: node eval/reindex.mjs <sample.json> --all --book ${JSON.stringify(book)}`);
        // The same gate reindex.mjs buildItems applies; without it a missing collection scores keyword-and-BM25-only.
        if (!items.length && own.some(e => e.vectorized && !e.disable && e.content)) {
            throw new Error(`no vector collection for "${book}" at ${indexFile} — the book has vectorized entries, so scoring without one would silently drop cosine. Build it with: node eval/reindex.mjs <sample.json> --book ${JSON.stringify(book)}`);
        }
        const memoryUids = new Set(own.filter(isMemory).map(e => Number(e.uid)));
        const ofMemory = it => memoryUids.has(Number(it.metadata?.index));
        const archivable = own.filter(e => e.disable && isMemory(e) && e.content).length;
        if (P.centroidPopulation === 'memoryArchived' && archivable && !archived.length) {
            throw new Error(`centroidPopulation 'memoryArchived': "${book}" has ${archivable} archived memory entries but ${indexFile} holds no centroid-only chunks — build that collection with: node eval/reindex.mjs <sample.json> --all --archived --book ${JSON.stringify(book)}`);
        }
        const centroidSources = {
            vectorized: () => (items.length ? items : extra),
            memory: () => live.filter(ofMemory),
            memoryArchived: () => [...live.filter(ofMemory), ...archived],
        };
        if (!centroidSources[P.centroidPopulation]) throw new Error(`unknown centroidPopulation "${P.centroidPopulation}" — one of ${Object.keys(centroidSources).join(', ')}`);
        let meanSource = centroidSources[P.centroidPopulation]();
        // An empty mean scores a whole book at cosine 0, so fall back to the whole collection as plugin/server.js centroidFor does.
        const emptySelection = !meanSource.length && live.length;
        if (emptySelection) meanSource = live;
        const loaded = { book, items, extra, mean: meanSource.length ? corpusMean(meanSource) : [] };
        if (P.referenceCentroid !== 'memory') {
            if (!['reference', 'cross', 'raw'].includes(P.referenceCentroid)) throw new Error(`unknown referenceCentroid "${P.referenceCentroid}" — one of memory, reference, cross, raw`);
            if (P.sharedComponents > 0 || P.pcRemove > 0 || P.whitenR > 0 || !P.meanCentered) throw new Error('referenceCentroid is defined on the plain centred cosine; not combinable with pcRemove/sharedComponents/whitenR or centering off');
            const refItems = live.filter(it => !ofMemory(it));
            loaded.refItems = refItems;
            loaded.refMean = refItems.length ? corpusMean(refItems) : loaded.mean;
        }

        // Projected at load and the mean becomes zero; the QUERY must take the same transform at every call site (pcQuery).
        if (P.sharedComponents > 0 || P.pcRemove > 0 || P.whitenR > 0) {
            if (!P.meanCentered) throw new Error('sharedComponents/pcRemove need meanCentered: both are defined as what comes off BEFORE the cosine, and uncentered scoring subtracts nothing');
            const stages = [];
            // Stage A comes off memory chunks only (F51); a reference chunk passes through untouched.
            const hasMemory = live.some(ofMemory);
            if (P.sharedComponents > 0 && hasMemory) {
                if (P.centroidPopulation === 'vectorized') throw new Error(`sharedComponents with centroidPopulation 'vectorized' would average stage-A-projected memory chunks with unprojected reference ones in one centroid — use 'memory' or 'memoryArchived'`);
                if (P.sharedScatter !== 'pooled' && P.sharedScatter !== 'within') throw new Error(`unknown sharedScatter "${P.sharedScatter}" — one of pooled, within`);
                const within = P.sharedScatter === 'within';
                const basis = loadBasis(book, resolveModel(P.embedModel ?? embedModelOf(S)).label, within);
                if (!basis) throw new Error(`sharedComponents needs a${within ? ' --within' : ''} basis for "${book}" — build it with: node eval/global-basis.mjs <samples...>${within ? ' --within' : ''}`);
                if (basis.comps.length < P.sharedComponents) throw new Error(`sharedComponents ${P.sharedComponents} but "${book}"'s basis holds ${basis.comps.length} components — rebuild with --m ${P.sharedComponents} --force`);
                let comps = basis.comps;
                if (P.sharedSelect === 'shared') {
                    if (!basis.eta?.length) throw new Error(`sharedSelect 'shared' ranks components by eta^2 and "${book}"'s basis carries none — rebuild with: node eval/global-basis.mjs <samples...> --force`);
                    comps = basis.comps.map((c, j) => [c, basis.eta[j]]).sort((x, y) => x[1] - y[1]).map(([c]) => c);
                } else if (P.sharedSelect !== 'rank') {
                    throw new Error(`unknown sharedSelect "${P.sharedSelect}" — one of rank, shared`);
                }
                stages.push({ mean: basis.mean, comps: comps.slice(0, P.sharedComponents) });
            }
            const applyAll = (v, upto) => stages.slice(0, upto).reduce((acc, st) => projectOut(acc, st.mean, st.comps), v);
            const shiftA = xs => xs.map(it => (ofMemory(it) ? { ...it, vector: applyAll(it.vector, stages.length) } : it));
            loaded.items = shiftA(loaded.items);
            loaded.extra = shiftA(loaded.extra);
            // meanSource holds the PRE-transform objects: re-resolve by hash, transforming archived centroid mass on the spot.
            const byHash = new Map([...loaded.items, ...loaded.extra].map(it => [it.metadata?.hash, it]));
            const srcA = meanSource.map(it => byHash.get(it.metadata?.hash) ?? { ...it, vector: applyAll(it.vector, stages.length) });
            const bookMean = srcA.length ? corpusMean(srcA) : loaded.mean;
            const nComps = Math.max(P.pcRemove, P.whitenR);
            const bookComps = nComps > 0 ? topComponents(srcA, nComps, bookMean) : [];
            let weights = null;
            if (P.whitenR > 0 && bookComps.length) {
                const sd = componentScales(srcA, bookComps, bookMean);
                const floor = sd[Math.min(P.whitenR, sd.length) - 1] || 1;
                weights = bookComps.map((_, j) => (j < P.pcRemove ? 0 : (j < P.whitenR ? Math.min(1, (sd[j] / floor) ** -P.whitenAlpha) : 1)));
            }
            stages.push({ mean: bookMean, comps: bookComps, weights });
            const shiftB = xs => xs.map(it => ({ ...it, vector: projectOut(it.vector, bookMean, bookComps, weights) }));
            loaded.items = shiftB(loaded.items);
            loaded.extra = shiftB(loaded.extra);
            loaded.pc = { stages, sharedComponents: P.sharedComponents, pcRemove: P.pcRemove, whitenR: P.whitenR, whitenAlpha: P.whitenAlpha, gotBookComps: bookComps.length };
            if (!loaded.mean.length) throw new Error(`sharedComponents/pcRemove need a centroid and "${book}" has no collection to build one from`);
            loaded.mean = new Float64Array(loaded.mean.length);
        }
        return loaded;
    };

    // One embedding space across books: callers thread the same resolved LABEL through indexOpts (embedModel is a spec).
    // ponytail: a chunk arm's rebuild reaches the primary only — cachePath keys the others off the scene's chunkConfig.
    const modelLabel = indexOpts.model ?? resolveModel(embedModelOf(S)).label;
    const loaded = books.map(b => loadBook(b, b === primary
        ? indexFile
        : indexPath(S, { ...indexOpts, model: modelLabel, book: b, all: P.denseAllEntries })));
    const items = loaded[0].items;

    const outOfScope = r => !S.books[r?.book ?? primary];

    const gazSource = entries;
    // Field selection rides on buildGazetteer, never a second tokenizer; `comment` is the title slot.
    const GAZ_FIELDS = {
        'keys+titles': e => e,
        keys: e => ({ key: e.key, keysecondary: e.keysecondary }),
        titles: e => ({ comment: e.comment }),
        bodies: e => [e, { comment: e.content }],
        none: () => [],
    };
    const pick = GAZ_FIELDS[P.gazetteerSource];
    if (!pick) throw new Error(`unknown gazetteerSource "${P.gazetteerSource}" — one of ${Object.keys(GAZ_FIELDS).join(', ')}`);
    const gaz = entity.buildGazetteer(gazSource.flatMap(e => pick(e)));

    // The pool is what was judged, keyed by (book, uid). OWN is this capture's own non-durable rows and is never unioned in (G10).
    const OWN = new Set((S.candidates ?? []).filter(c => !isDurable(c) && !outOfScope(c)).map(c => entryKey({ world: c.book ?? primary, uid: c.uid })));
    const POOL = new Set((S.entries ?? [])
        .filter(g => Number.isFinite(Number(g.uid)) && !outOfScope(g))
        .map(g => entryKey({ world: g.book ?? primary, uid: g.uid })));

    // The gate inputs ride the scene so every makeCandidateSet caller gets them from its `{...scene}` spread.
    // Read off the sample's scene entry when it has one (schemaVersion 3.1), else off the sample itself.
    const sc = (S.scenes ?? [])[0] ?? S;
    const gates = { assistantCount: sc.assistantCount, greetingIndex: sc.greetingIndex, personaName: sc.personaName, firedLatches: sc.firedLatches };
    return { primary, books, entries, byKey, items, loaded, gaz, gazSource, outOfScope, POOL, OWN, embedModel: embedModelOf(S), modelLabel, chunkCfg: chunkConfig(S), gates };
}

/** Grade lookup by (book, uid), title as the fallback; a bare string resolves by title. Null for "nobody judged this", never 0. */
export function makeGradeOf(grades, { outOfScope, primary }) {
    const list = (grades ?? [])
        .filter(x => x && x.title && Number.isFinite(gradeValue(x)))
        .map(x => ({ tk: nrm(x.title), g: gradeValue(x), title: x.title, uid: x.uid, book: x.book ?? primary, scoped: !outOfScope(x) }));
    const kept = list.filter(g => g.scoped);
    // uid is authoritative only when the grade set is uid-complete; a mixed set falls back to titles wholesale.
    const byKey = list.length && list.every(g => Number.isFinite(Number(g.uid)))
        ? new Map(kept.map(g => [entryKey({ world: g.book, uid: g.uid }), g.g]))
        : null;
    const byTitle = title => { const mt = new Set(nrm(title)); const h = kept.find(x => x.tk.length && x.tk.every(t => mt.has(t))); return h ? h.g : null; };
    return r => {
        const uid = Number(r?.uid ?? r?.key);
        if (byKey && Number.isFinite(uid)) return byKey.get(entryKey({ world: r?.book ?? r?.entry?.world ?? primary, uid })) ?? null;
        return byTitle(typeof r === 'string' ? r : String(r?.title ?? ''));
    };
}

/** The three populations as predicates over a raw entry; they cross-cut. `isMemory` is imported AND re-exported: a bare `export ... from` would not bind it here. */
import { isMemory, buildNameDf, properNames, properShared, properDensity, scoreRelevance, modelKey, postDates, UNFITTED_FALLBACK } from '../../extension/relevance.mjs';
export { isMemory };
const isReference = e => !isMemory(e);
export const isDurableEntry = e => Boolean(e?.constant);

/** Recall split by tier over one selection's kept set (identity, not uid); `population` arrives with durable already excluded. */
export function tierRecall(population, kept, gradeOf) {
    const keptSet = new Set(kept);
    const relevant = population.filter(r => (gradeOf(r) ?? 0) >= 3);
    const half = pick => {
        const rows = relevant.filter(pick);
        return { got: rows.filter(r => keptSet.has(r)).length, of: rows.length };
    };
    return { memory: half(r => isMemory(r.entry)), reference: half(r => isReference(r.entry)) };
}

/** Whole-word presence of a bare name in the entry's own content — the fill rule for addCastKeys. */
const nameRe = new Map();
const mentions = (name, content) => {
    let re = nameRe.get(name);
    if (!re) nameRe.set(name, re = new RegExp(`(?<!\\w)${name.toLowerCase()}(?!\\w)`));
    return re.test((content ?? '').toLowerCase());
};

/** The query under the transform ONE BOOK'S collection took; applied per book at every call site, or the sides are compared in different spaces. */
const pcQuery = (loaded, qvec) => (loaded?.pc
    ? loaded.pc.stages.reduce((v, st) => projectOut(v, st.mean, st.comps, st.weights ?? null), qvec)
    : qvec);

/** Keys the production scan scores — every entry's, vectorized included (worldsapart.js scoreKeysOf); `dropKeys` leaves the gazetteer alone. */
export const scoringKeys = (e, P) => {
    let base = e.key ?? [];
    // addCastKeys (bare names): appended wherever the content mentions the name whole-word and no key already carries it.
    if (P.addCastKeys?.length) {
        const have = base.map(k => k.toLowerCase());
        const fills = P.addCastKeys.filter(n => {
            const ln = n.toLowerCase();
            return !have.some(k => k === ln || k.startsWith(ln + ' ')) && mentions(n, e.content);
        });
        if (fills.length) base = [...base, ...fills];
    }
    const ks = base;
    return P.dropKeys ? ks.filter(k => !P.dropKeys.includes(k)) : ks;
};

/** Keyword score via the shared matcher.keywordScore; the boundary mode is pushed per call, since arms hold their scorers across each other's runs. */
export const makeKeywordScore = P => (e, text, k1) => {
    matcher.setBoundaryMode(P.wordBoundary);
    return matcher.keywordScore(e, text, scoringKeys(e, P), { k1, caseSensitiveDefault: P.caseSensitive, wholeWordsDefault: P.wholeWords, repeatCurve: P.repeatCurve, repeatR: P.repeatR }).score;
};

/**
 * Builds the candidate set — every entry that would be in the ranking, with its per-signal scores. `topK` is stage 1's own bound and counts ENTRIES.
 * @returns {(k1: number, b: number, tw: object|null, qvec: number[], qtext: string, haystackFor: (entry: object) => string[]) => object[]}
 */
export function makeCandidateSet({ loaded, byKey, entries, params: P, chunkCfg, topK = admitCeiling(true), gates = {} }) {
    const keywordScore = makeKeywordScore(P);
    // The stage-3 text index, one per book as bookIndexes keys it: pooling the books would pool their IDF.
    const { chunkMode, chunkSize, minChunkSize } = defaultSettings;
    const cfg = chunkCfg ?? { chunkMode, chunkSize, minChunkSize };   // the shipped values, never a second copy of them
    const byBook = new Map();
    for (const e of entries) { const b = e.world; if (!byBook.has(b)) byBook.set(b, []); byBook.get(b).push(e); }
    const contentIndexes = [...byBook].map(([, own]) => buildContentIndex(own, cfg));
    const hasContent = e => Boolean(String(e?.content ?? '').trim());
    // Dense-all: the stage-3 cosine for entries the collection has no row for, pooled by MAX against the book's own mean; admits nothing.
    const denseExtra = (qvec) => {
        const out = new Map();
        if (!qvec?.length) return out;
        for (const L of loaded) {
            if (!L.extra?.length) continue;
            const scores = centeredCosineScores(L.extra, pcQuery(L, qvec), L.mean, P.meanCentered);
            L.extra.forEach((it, i) => {
                const key = entryKey({ world: L.book, uid: it.metadata?.index });
                out.set(key, Math.max(out.get(key) ?? -Infinity, scores[i]));
            });
        }
        return out;
    };
    return (k1, b, tw, qvec, qtext, haystackFor) => {
        const dense = denseExtra(qvec);
        // --- STAGE 1: retrieval — one top-K across every book, each against its own centroid, as /query-multi does; contentText admits nothing.
        const contentText = new Map();
        for (const ix of contentIndexes) for (const [k, v] of scoreContent(ix, qtext, { k1, b, termWeights: tw, stopwordDf: P.stopwordDf })) contentText.set(k, v);
        const scored = loaded.flatMap(L => scoreCollection(L.book, L, pcQuery(L, qvec), { centered: P.meanCentered }));
        const grouped = selectTopK(poolEntries(scored), topK);
        const per = new Map();
        for (const [book, g] of Object.entries(grouped)) for (const m of g.metadata ?? []) { const key = entryKey({ world: book, uid: m.index }); per.set(key, { score: Math.max(per.get(key)?.score ?? -Infinity, m.score) }); }
        const rows = [];
        // --- STAGE 2, retrieval route. Disabled entries drop here, not from `entries`: the gazetteer and BM25 corpus must still see them (F49).
        for (const [key, s] of per) { const e = byKey.get(key); if (e && !e.disable) rows.push({ uid: Number(e.uid), book: e.world, entry: e, title: wiTitle(e), score: s.score, textScore: contentText.get(entryKey(e)) ?? 0, keywordScore: keywordScore(e, haystackFor(e), k1), vectorEligible: !!e.vectorized, textEligible: hasContent(e), keysEligible: scoringKeys(e, P).length > 0 }); }
        // --- STAGE 2: activation, keyword route, run to a fixpoint. May admit only what core could activate, so never a
        // disabled entry (F49), and on the initial pass never a delayUntilRecursion one. Its LEVEL is not modelled:
        // core walks distinct levels (world-info.js currentRecursionDelayLevel), this admits at the first pass.
        // The capture's gate inputs (eval/bundle-schema.md, 3.1). A field the bundle does not carry leaves its
        // gate OFF, and every gate left off is reported: absent is not the same as "nothing was latched".
        const gateOpts = {
            assistantCount: gates.assistantCount,
            greetingIndex: gates.greetingIndex,
            personaName: gates.personaName,
            fired: gates.firedLatches === undefined ? undefined : new Set(Object.keys(gates.firedLatches ?? {})),
        };
        const missing = matcher.unmodelledGates(entries, gateOpts);
        if (missing.length) {
            console.error(`  ${missing.join(', ')}: gate(s) this bundle carries no input for, so rows they would have gated OUT are admitted here`);
        }
        const admitted = new Set(rows.map(r => entryKey(r.entry)));
        // The retrieval winners feed recursion too: WA force-activates them, so core counts them in new.successful.
        const feeds = e => P.recursive && !e.preventRecursion && Boolean(String(e.content ?? '').trim());
        const buffer = rows.map(r => r.entry).filter(feeds).map(e => String(e.content).trim());
        const buffered = matcher.withExtraTexts((_d, e) => haystackFor(e), buffer, P.matchWindow);
        const depthOf = new Map();
        // Termination is the buffer standing still, not a pass admitting nothing: the retrieval winners seed the buffer
        // and the depth-0 pass matches chat only, so a pass that admits nothing can still leave text for the next one.
        let scanned = 0;
        for (let depth = 0; ; depth++) {
            if (depth > 0) {
                if (!P.recursive || (P.maxRecursionSteps && depth > P.maxRecursionSteps)) break;
                if (buffer.length === scanned) break;
                scanned = buffer.length;
            }
            const hay = depth === 0 ? haystackFor : (e => buffered(0, e));
            const found = [];
            for (const e of entries) {
                const key = entryKey(e);
                if (admitted.has(key) || e.disable) continue;
                // This loop may admit only what could have activated. `@@activate` outranks `@@dont_activate` (CCv3: the
                // latter "SHOULD be ignored" when the former is present), and core's ladder tests them in that order.
                // A constant is NOT skipped here — it reaches the pool through stage 1 and scoreScene's `rankable` strips it.
                if (matcher.hasDecorator(e, '@@dont_activate') && !matcher.hasDecorator(e, '@@activate')) continue;
                const verdict = matcher.gateVerdict(e, gateOpts);
                if (verdict === 'skip') continue;
                if (verdict === 'admit') { found.push(e); continue; }
                if (depth === 0 ? e.delayUntilRecursion : e.excludeRecursion) continue;
                if (keywordScore(e, hay(e), k1) > 0) found.push(e);
            }
            for (const e of found) {
                const key = entryKey(e);
                admitted.add(key);
                depthOf.set(key, depth);
                rows.push({ uid: Number(e.uid), book: e.world, entry: e, title: wiTitle(e), score: dense.get(key), textScore: contentText.get(key) ?? 0, keywordScore: 0, vectorEligible: dense.has(key) || !!e.vectorized, textEligible: hasContent(e), keysEligible: true });
            }
            for (const e of found) if (feeds(e)) buffer.push(String(e.content).trim());
        }
        // --- STAGE 3, reference cosine under another centring; the column only, stage 1 keeps the production centroid.
        if (P.referenceCentroid !== 'memory') {
            const ref = new Map();
            for (const L of loaded) {
                if (!L.refItems?.length) continue;
                // 'cross' wants (q - mean)·(item - refMean): shifting q by (refMean - mean) makes the one-mean scorer do it.
                const q = P.referenceCentroid === 'cross' ? qvec.map((x, i) => x - L.mean[i] + L.refMean[i]) : qvec;
                const scores = centeredCosineScores(L.refItems, q, L.refMean, P.referenceCentroid !== 'raw');
                L.refItems.forEach((it, i) => {
                    const key = entryKey({ world: L.book, uid: it.metadata?.index });
                    ref.set(key, Math.max(ref.get(key) ?? -Infinity, scores[i]));
                });
            }
            for (const r of rows) if (!isMemory(r.entry) && ref.has(entryKey(r.entry))) r.score = ref.get(entryKey(r.entry));
        }
        // --- STAGE 3, keys. Once, over the COMPLETE buffer, as onScanDone runs after core's last loop. An entry that fed
        // the buffer does not match its own content there: that is the entry naming itself, not the conversation naming it.
        for (const r of rows) {
            const own = String(r.entry.content ?? '').trim();
            const others = r.entry.excludeRecursion ? [] : buffer.filter(t => t !== own);
            const hay = others.length ? matcher.withExtraTexts((_d, e) => haystackFor(e), others, P.matchWindow)(0, r.entry) : haystackFor(r.entry);
            r.triggerDepth = depthOf.get(entryKey(r.entry)) ?? 0;
            r.keywordScore = keywordScore(r.entry, hay, k1) / (1 + r.triggerDepth);
        }
        return rows;
    };
}

const MODEL_CACHE = new Map();
const modelFiles = (dir = null) => {
    const key = dir ?? '';
    if (!MODEL_CACHE.has(key)) {
        const base = dir ? resolvePath(process.cwd(), dir) : dirname(fileURLToPath(new URL('../../extension/x', import.meta.url)));
        const out = {};
        for (const tier of ['memory', 'reference']) {
            try { out[tier] = JSON.parse(fs.readFileSync(resolvePath(base, `relevance-model-${tier}.json`), 'utf8')); }
            catch { out[tier] = dir ? modelFiles()[tier] : null; }
        }
        // The cosine-free fit rides on every fit in its tier, attached ONCE here as the runtime's loadRelevanceModel does.
        // Stamped at read time instead, what a caller got depended on whether modelsFor had run for that key first.
        for (const tier of ['memory', 'reference']) {
            const nc = out[tier]?.noCosine ?? null;
            for (const f of Object.values(out[tier]?.byModel ?? {})) f.noCosine = nc;
        }
        MODEL_CACHE.set(key, out);
    }
    return MODEL_CACHE.get(key);
};

/** The fits for one embedding model, by tier. THROWS when the model has none, where production would borrow UNFITTED_FALLBACK's. */
export const modelsFor = (embedModel, dir = null) => {
    const MODEL_FILES = modelFiles(dir);
    const key = modelKey(resolveModel(embedModel).model);
    const out = {};
    for (const tier of ['memory', 'reference']) {
        out[tier] = MODEL_FILES[tier]?.byModel?.[key] ?? null;
        if (!out[tier]) {
            throw new Error(`no ${tier} relevance fit for embedding model "${key}" (have: ${Object.keys(MODEL_FILES[tier]?.byModel ?? {}).join(', ') || 'none'}). `
                + `The runtime would borrow "${UNFITTED_FALLBACK}"'s coefficients here; a harness is told its embedder, so say which fit you mean `
                + 'with an explicit arm (fit=<name>) or fit this model with eval/relevance-regress.mjs --emit-model.');
        }
    }
    return out;
};
/** The fits under one NAME (a `byModel` key, or `noCosine`). THROWS on an unknown name. */
export const fitsNamed = (name, dir = null) => {
    const MODEL_FILES = modelFiles(dir);
    const out = {};
    for (const tier of ['memory', 'reference']) {
        const file = MODEL_FILES[tier];
        out[tier] = name === 'noCosine' ? (file?.noCosine ?? null) : (file?.byModel?.[name] ?? null);
        if (!out[tier]) throw new Error(`no ${tier} fit named "${name}" (have: ${Object.keys(file?.byModel ?? {}).join(', ') || 'none'}, noCosine)`);
    }
    return out;
};
export const fittedModels = () => [...new Set(Object.values(modelFiles()).flatMap(f => Object.keys(f?.byModel ?? {})))];

/** The LAYOUT ORDER: rows sorted by E[credit], each tier standardised among its own rows as its fit was built; properNouns and density come through relevance.mjs, never a copy. */
export const makeLayoutOrder = ({ scene, haystack, fit = null, fitDir = null }) => {
    if (!fit && !scene?.embedModel) throw new Error('scene records no embedModel — the fits are per embedding model');
    const MODELS = fit ? fitsNamed(fit, fitDir) : modelsFor(scene.embedModel, fitDir);
    // df per book, as bookIndexes builds it.
    const dfs = new Map();
    for (const e of scene.entries ?? []) { const b = e.world; if (!dfs.has(b)) dfs.set(b, []); dfs.get(b).push(e); }
    for (const [b, own] of dfs) dfs.set(b, buildNameDf(own));
    const windowNames = properNames(haystack({}).join('\n'));
    return (rows) => {
        for (const r of rows) {
            const df = dfs.get(r.entry?.world) ?? buildNameDf([]);
            const names = df.names.get(entryKey(r.entry)) ?? properNames(r.entry?.content);
            r.properNouns = properShared(names, windowNames, df);
            r.density = properDensity(r.entry?.content);
        }
        const col = r => ({
            cosine: Number.isFinite(r.score) ? r.score : 0,
            text: Number(r.textScore) || 0,
            keys: Number(r.keywordScore) || 0,
            properNouns: Number(r.properNouns) || 0,
            density: Number(r.density) || 0,
        });
        for (const [tier, model] of Object.entries(MODELS)) {
            if (!model) continue;
            const mine = rows.filter(r => (isMemory(r.entry) ? 'memory' : 'reference') === tier);
            if (!mine.length) continue;
            // Population rule and the noCosine fallback are read off the fit, as worldsapart.js scoreRelevanceColumn does; must not drift.
            const fit = mine.some(r => Number.isFinite(r.score)) ? model : (model.noCosine ?? model);
            const population = (fit.standardise === 'pooled' ? rows : mine).filter(r => !r.entry?.constant).map(col);
            const e = scoreRelevance(fit, mine.map(col), population);
            // tierCutoff is the fit's own optimum, provenance only; the cut and its number belong to scoreScene `admits`.
            mine.forEach((r, i) => { r.eCredit = e[i]; r.tierCutoff = fit.cutoff; });
        }
        return [...rows].sort((a, b) => (b.eCredit ?? -1) - (a.eCredit ?? -1));
    };
};

/** Scores one scene at one parameter set: nDCG on the pooled rows, judged coverage of the unpooled top-k, and the set scores at @R, @cut and @budget. `k` is the coverage/nDCG cutoff (10). */
export async function scoreScene({ sample: S, overrides = {}, k = 10, vectors, model, ollama, index, topK, scene: preloaded, qv: cachedQv } = {}) {
    const P = sceneParams(S, overrides);
    if (preloaded && (overrides.denseAllEntries !== undefined || overrides.gazetteerSource !== undefined)) {
        throw new Error('gazetteerSource/denseAllEntries are read at load time, so they cannot be swept against a preloaded scene — load per arm');
    }
    const em = resolveModel(model);
    const scene = preloaded ?? loadScene(S, { indexFile: indexPath(S, { vectors, model: em.label, index }), indexOpts: { vectors, model: em.label }, params: P });
    const scoreAll = makeCandidateSet({ ...scene, params: P, topK });
    const layoutOrder = makeLayoutOrder({ scene, haystack: haystackFor(S, P), fit: P.relevanceFit, fitDir: P.fitDir });
    const gradeOf = makeGradeOf(S.entries, scene);

    const query = S.query;
    const tw = P.entityFilter ? entity.buildTermWeights(query, scene.gaz, P.boost) : null;
    const qv = cachedQv ?? (scene.loaded.some(L => L.items.length || L.extra?.length)
        ? await embed(em.query + query, { ollama, model: em.model, label: em.label, endpoint: em.endpoint, url: em.endpoint === 'ollama' ? ollama : em.url })
        : []);
    const all = scoreAll(P.K1, P.B, tw, qv, query, haystackFor(S, P));

    // Constants are not ranked; sticky and reference ARE (F48).
    const rankable = all.filter(r => !r.entry?.constant);

    const top = layoutOrder(rankable).slice(0, k);
    const unjudged = top.filter(r => !scene.POOL.has(entryKey(r.entry)));
    // Read before the second layoutOrder call: it mutates rows the two lists share.
    const topGrades = top.map(r => gradeOf(r) ?? 0);
    // From `rankable`, not `all` (F48); `?? 0` is the partial-label rule, since gradeOf returns null for unjudged.
    const g = layoutOrder(rankable.filter(r => scene.POOL.has(entryKey(r.entry)))).map(r => gradeOf(r) ?? 0);

    // Set scores on the asymmetric bars (metrics.mjs gradeCredit, RECALL_WEIGHT) over the UNPOOLED top-k: an ungraded row still costs precision.
    const relevant = g.filter(x => x >= 3).length;
    const precision = top.length ? topGrades.reduce((sum, x) => sum + gradeCredit(x), 0) / top.length : 0;
    const recall = relevant ? topGrades.filter(x => x >= 3).length / relevant : 0;
    const f2 = fbeta(precision, recall, RECALL_WEIGHT);

    //   @R  the top `relevant` rows; budget-invariant by construction.
    const scoreWindow = (rows) => {
        const gr = rows.map(r => gradeOf(r) ?? 0);
        const p = rows.length ? gr.reduce((s, x) => s + gradeCredit(x), 0) / rows.length : 0;
        const rc = relevant ? gr.filter(x => x >= 3).length / relevant : 0;
        const un = rows.filter(r => !scene.POOL.has(entryKey(r.entry)));
        return {
            precision: p, recall: rc, f: fbeta(p, rc, RECALL_WEIGHT), n: rows.length,
            judged: rows.length - un.length,
            unjudgedRows: un.map(r => ({ uid: Number(r.uid), book: r.entry?.world, title: r.title })),
        };
    };
    const ranked = layoutOrder(rankable);
    const atR = scoreWindow(ranked.slice(0, relevant));

    //   @cut  what the relevance cut admits, the one window the system chooses; both tiers, at the arm's memoryCutoff —
    //   the field's name in every bundle, though it cuts both tiers. `relevanceCutoff` is a USER setting, so nothing here
    //   may stand in for it: with none supplied the window is reported as unavailable rather than scored at the fit's own
    //   optimum, which is a number production never reads.
    const cutGiven = Number.isFinite(P.memoryCutoff);
    const cutFor = () => P.memoryCutoff;
    // Promoted rows are exempt, as at runtime; read off the entry, since a bundle embeds the book verbatim.
    const promotedRow = r => hasPromoteDecorator(r.entry);
    // selection.relevanceCut IS the keep rule — never a second copy of it. A promoted row is exempt because the runtime's
    // layout order splits it out before the cut, and NaN as its cutoff is how relevanceCut spells "not cut".
    // No cutoff supplied: nothing is cut, so @budget still reports the whole ranked set — only @cut goes unavailable.
    const keptSet = new Set(selection.relevanceCut(ranked, {
        scoreOf: r => r.eCredit,
        cutoffOf: r => (!cutGiven || promotedRow(r) ? NaN : cutFor()),
    }).kept);
    const admits = r => keptSet.has(r);
    const atCut = cutGiven ? scoreWindow(ranked.filter(admits)) : null;

    //   @budget  what the token ceiling leaves — the delivered set. Recorded tokens where the capture has them, else this corpus's chars-per-token (G12).
    const recorded = new Map((S.candidates ?? []).map(c => [entryKey({ world: c.book ?? S.primaryBook, uid: c.uid }), c.tokens]).filter(([, t]) => typeof t === 'number'));
    const tokensOf = r => recorded.get(entryKey(r.entry)) ?? Math.round(String(r.entry?.content ?? '').length / 4.91);
    // What the admitted set costs when nothing binds; outside the budget branch on purpose.
    if (atCut) atCut.tokens = ranked.filter(admits).reduce((n, r) => n + tokensOf(r), 0);

    let atBudget = null;
    if (P.budgetTokens > 0) {
        const kept = await delivery.applyBudget({
            // Classified as the runtime walks it: isDynamic excludes promoted rows; the capacity caps take the wider population.
            walk: delivery.walkOrder({
                promoted: ranked.filter(r => admits(r) && promotedRow(r)),
                results: ranked.filter(r => admits(r) && !promotedRow(r)),
            }),
            isDynamic: r => !promotedRow(r),
            isCapped: () => true,
            maxTokens: P.budgetTokens,
            maxTotal: P.maxTotalEntries ?? 0,
            maxDynamic: 0,
            maxVectorEntries: P.maxVectorEntries ?? 0,
            isVector: r => Boolean(r.entry?.vectorized),
            capOf: r => Number(P.bookCaps?.[r.entry?.world]) || 0,
            tokensOf,
        });
        // survivors is a Set walked in layout order, which scoreWindow reads positionally.
        atBudget = scoreWindow([...kept.survivors]);
        atBudget.dropped = kept.dropped;
        atBudget.tokens = kept.budgeted;
    }

    return {
        n: ndcg(g, k),
        nAt5: ndcg(g, 5),
        precision,
        recall,
        f2,
        atR,
        atCut,
        atBudget,
        relevant,
        judged: top.length - unjudged.length,
        of: top.length,
        unjudged: unjudged.map(r => r.title),
        unjudgedRows: unjudged.map(r => ({ uid: Number(r.uid), book: r.entry?.world, title: r.title, rank: top.indexOf(r) + 1 })),
        terms: tw ? Object.keys(tw).length : null,
    };
}
