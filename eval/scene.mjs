// scene.mjs — loading and scoring ONE graded scene from a /wa-grade sample. The machinery
// graded-scene-grid.mjs and param-screen.mjs both need, so there is exactly one copy of it.
//
// A second copy of the gazetteer or the scorers must never appear: two tools would compare subtly
// different rankings and report the difference as a parameter effect (R22).
//
// Nothing here parses argv or prints a report — callers own their own CLI and output. Nothing here reads a
// live lorebook either: entries come from the sample's embedded copies, which is what makes a graded scene
// re-runnable after the books have been edited.
import fs, { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCollection, poolEntries, selectTopK, admitCeiling } from '../plugin/scoring.mjs';
import { corpusMean, centeredCosineScores } from '../plugin/vector.mjs';
import * as entity from '../extension/entity.mjs';
import * as matcher from '../extension/matcher.mjs';
import { hasPromoteDecorator } from '../extension/matcher.mjs';
import { isDurable, openBundle } from '../extension/grading.mjs';
import * as selection from '../extension/selection.mjs';
import * as delivery from '../extension/delivery.mjs';
import { buildContentIndex, scoreContent, entryKey } from '../extension/content-lexical.mjs';
// Cycle: reindex.mjs imports getStringHash from here. Safe because neither side calls across at module
// scope — both references live inside function bodies, so whichever module loads first finishes evaluating
// before the other needs a binding.
import { cachePath, chunkConfig, embedTexts, pathSafe, resolveModel } from './reindex.mjs';
import { gradeCredit, fbeta, RECALL_WEIGHT, gradeValue, topComponents, projectOut, componentScales } from './metrics.mjs';
import { loadBasis } from './global-basis.mjs';

/**
 * Whether an item is in the vector collection — not whether it could be embedded, and not whether it
 * earned a cosine: a vectorized entry that failed to rank is still in. Callers may declare it explicitly,
 * since only they know how the scan resolved; absent flags fall back to presence.
 *
 * Membership only. It never gates the text signal — content-lexical.mjs indexes every entry's content.
 */
export const inVectorIndex = it => it.vectorEligible ?? it.entry?.vectorized ?? Number.isFinite(it.score);

/** Unit Separator — see CLAUDE.md. Never NUL: that makes git treat the file as binary. */
const US = String.fromCharCode(31);

/**
 * Drops rows whose entry post-dates the scene — an STMB summary covering messages after the frozen turn
 * could not be in the book when that turn was live, so production can never retrieve it. Only offline
 * derivation produces these, so it keys on `generatedFrom.msg` and no-ops when that is absent. A large
 * share of graded rows goes, grade >= 3 rows included (F28).
 *
 * Books, not only grades: `makeCandidateSet` re-derives the pool from the books, so filtering the grades
 * alone leaves every future entry in the pool as an unjudged row still holding a rank. Dropping them from
 * the books also takes them out of the gazetteer, the BM25 IDF and the keyword scan.
 *
 * Relevance itself is not chronological — this is about what the book HOLDS, not what a grade means.
 */
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
    // The boundary is the END, not the start: an entry spanning the frozen turn (`start <= at < end`) could
    // not be in the book either, and such rows are the scene's own haystack paraphrased — they outrank
    // clean positives (F28). The rule itself is relevance.mjs's, so the runtime's `dropUnavailable` setting
    // and this cannot drift on what "not yet written" means.
    const future = r => postDates({ STMB_end: end.get(`${r.book}${US}${r.uid}`), STMB_start: start.get(`${r.book}${US}${r.uid}`) }, at);
    let cut = 0, gone = 0;
    const keep = list => (list ?? []).filter(r => (future(r) ? (cut++, false) : true));
    S.entries = keep(S.entries);
    S.candidates = keep(S.candidates);
    // The pristine books survive the filter: a collection is not scene-scoped and the index cache is keyed
    // as though it were not (reindex.mjs cachePath: book + model + chunk settings). Building from the
    // stripped book bakes one scene's message cutoff into a file every other scene of that book then reads,
    // silently, since a smaller collection scores fine (P4).
    S.pristineBooks ??= structuredClone(S.books ?? {});
    for (const [book, bk] of Object.entries(S.books ?? {})) {
        for (const [k, e] of Object.entries(bk ?? {})) {
            if (future({ book, uid: e.uid })) { delete bk[k]; gone++; }
        }
    }
    if (cut || gone) console.error(`  ${label}: dropped ${gone} entr(ies) and ${cut} graded/candidate row(s) post-dating message ${at}`);
    // A missing `STMB_start` reads here as an entry STMB never wrote, which is always available — true of a
    // reference sheet and false of a MEMORY entry that lost the field, so the guard is silently inert on
    // exactly those (P5). Reported, not dropped: dropping them is a corpus decision rather than one this
    // function should take on its own.
    const unverified = Object.entries(S.books ?? {}).flatMap(([, bk]) => Object.values(bk ?? {}))
        .filter(e => isMemory(e) && !Number.isFinite(Number(e.STMB_start))).length;
    if (unverified) console.error(`  ${label}: ${unverified} MEMORY entr(ies) carry no STMB_start — availability unchecked, not verified as available`);
    return S;
};

/**
 * Groups book names into LINEAGES by shared entry bodies — the unit CLAUDE.md says to count, because a
 * book is versioned in place and two versions of one book are not two books.
 *
 * Names cannot do this: an LTM file is named after the CHARACTER CARD and a card carries many stories, so
 * the name says nothing about which corpus a book is, in either direction (C11). It matters wherever
 * independence does — a sign test over scenes treats each as a draw, and a leave-one-book-out basis that
 * leaves out only the FILE keeps near-identical copies in its own "everyone else" (R17).
 *
 * 30% of the smaller book's bodies, the threshold CLAUDE.md records for the file-to-lineage collapse.
 * Transitive, so a chain of partial revisions lands in one group.
 *
 * The group takes the most recently used name — `recency` maps a book name to any comparable stamp, bundle
 * createdAt being what the callers have. Ties break to the SHORTEST name, since version and card
 * decoration only ever make a name longer; then by name, so the answer never depends on iteration order.
 *
 * @param {Record<string, object>} booksByName name -> uid-keyed entries
 * @param {Map<string, string|number>} [recency] name -> last-used stamp; absent names sort oldest
 * @returns {Map<string, string>} book name -> lineage name
 */
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

/** Reads a graded-scene document from disk as one arm's view. Every tool goes through this, so `--arm`
 *  behaves identically everywhere and a document is never scored as though its first arm were the only
 *  one. The view's field names are the schema's — `entries`, `params`, `scanChat`, `book` — see
 *  grading.mjs `openBundle`. */
export const openSample = (path, arm = null) => openBundle(JSON.parse(readFileSync(path, 'utf8')), arm);

/** How a scene-and-arm is named in output. Composed at display time from the document's `name` and the
 *  arm's, never baked into either field. */
export const sceneLabel = S => (S?.arm ? `${S.name ?? ''}--${S.arm}` : String(S?.name ?? ''));

/**
 * The haystack composer for a scene: `(entry) => string[]`.
 *
 * The document stores the scan messages, the injects and the opted-in sources separately, and composing
 * them here is why: a joined blob is fixed at one depth, one matchWindow and one includeNames, and cannot
 * be taken back apart. Per entry, because all three vary per entry — its own `scanDepth`, which injects
 * that depth reaches, and which card or persona fields its `matchXxx` flags pull in.
 *
 * @param {object} S An opened sample
 * @param {object} P Resolved scene params
 * @param {{chat?: object[], depth?: number}} [over] For the depth ablation, which re-derives from a wider
 *        chat than the capture froze. Everything else still comes from the document.
 * @returns {(entry: object) => string[]}
 */
export function haystackFor(S, P, over = {}) {
    const windowFor = matcher.makeWindowFor(over.chat ?? S.scanChat ?? [], {
        injects: S.injects ?? [],
        sources: S.sources ?? {},
        matchWindow: P.matchWindow,
        includeNames: P.includeNames,
    });
    return entry => windowFor(matcher.scanDepthFor(entry, over.depth ?? S.depth), entry);
}

/** Key hits for one entry against a scan window — the same call `onScanDone` makes, so the excerpt
 *  localises the match that was actually scored rather than a re-derivation of the match rules. */
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

/** ST's string hash. WA stores each book's vectors under wa_${hash(bookName)}, so the collection path is
 *  derivable rather than configured. Must stay bit-identical to ST's or the index is simply not found. */
export const getStringHash = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); };

/**
 * A book's drift fingerprint: entry count plus two hashes over the fields the two layers rest on.
 *
 * Two hashes, not one, because a lumped number cannot say which layer moved. `gaz` covers
 * key/keysecondary/comment — what buildGazetteer reads, and so which query terms survive the entity filter;
 * `content` covers the bodies, what BM25 and the embeddings see.
 *
 * A weak hash on purpose: this detects drift, it does not authenticate, the same tradeoff
 * content-lexical.mjs indexFingerprint takes. Callers record `null` for a book with NO WORLD FILE —
 * distinct from this function's answer for a book that exists and is empty.
 *
 * Entries are walked in uid order so the value is stable across however the object was built; fields are
 * joined with US and records with RS, which cannot collide with content the way a printable would.
 *
 * @param {Record<string, object>} book uid-keyed entries
 * @returns {{entries: number, gaz: number, content: number}}
 */
export const bookFingerprint = (book) => {
    const list = Object.values(book ?? {}).sort((a, b) => Number(a.uid) - Number(b.uid));
    // RS separates records; US (module scope) separates the fields within one.
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

/** Title normaliser for grade matching: lowercase alphanumeric tokens, singles dropped.
 *  Missing is empty, not a throw: a grade row is identified by (world, uid) and `title` is optional. An
 *  untitled grade is simply never excluded by title, which is correct — the exclusion names entries from a
 *  second attached book, and a row with no title matches no name. */
export const nrm = s => (String(s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1);

export const dcg = (v, k) => v.slice(0, k).reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
/** Graded nDCG. The ideal is built from the RANKED vector, so a graded title that never gets ranked
 *  contributes to neither DCG nor the ideal — which is what makes an out-of-scope grade free. */
export const ndcg = (vec, k) => { const ideal = [...vec].sort((a, b) => b - a); return dcg(ideal, k) ? dcg(vec, k) / dcg(ideal, k) : 0; };

/**
 * Locates the live SillyTavern install for tools that must find it from any checkout. WA_ST_ROOT wins;
 * otherwise walk ancestors to the directory holding config.yaml — every install has exactly one at its
 * root, and the walk works from git worktrees because those nest inside the ST tree. dataRoot is read from
 * that config.yaml rather than assumed: ST's data directory is relocatable, while sample `index` paths are
 * recorded with the default `data/` prefix.
 *
 * Returns null when no install is reachable; callers skip rather than guess.
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
 * The graded corpus directory, with a trailing slash. `eval-data/` is gitignored (private captures), so a
 * checkout that has none falls back to the canonical checkout's through stInstall() — without it a check
 * run from wherever the suite loop sits silently skips its oracle forever.
 *
 * The returned path may not exist; callers test it.
 */
export const evalDataDir = () => {
    const local = new URL('./eval-data/', import.meta.url).pathname;
    const st = stInstall();
    return existsSync(local) || !st ? local : `${st.root}/public/scripts/extensions/third-party/WorldsApart/eval/eval-data/`;
};

/** The embedding model a sample was captured under. Read off the bundle; a bundle without one is
 * refused — the harness has no model of its own. */
export const embedModelOf = S => {
    if (!S?.embedModel) throw new Error('sample records no embedModel — the harness reads the model off the bundle');
    return S.embedModel;
};
/**
 * Where this sample's vector collection lives. Explicit --index wins, then the sample's own record, then
 * the path derived from the local ST vectors dir, then the rebuild cache.
 *
 * The sample's own `index` is skipped when it doesn't exist here, as is the derived path: both are
 * author-machine concepts, and a bundle carrying its books, `paramSnapshot.settings` and `embedModel` needs
 * neither — cachePath keys on (book, model, chunk settings), so it names the same file on every machine and
 * ensureIndex can fill it. That cache is the last resort so no run that resolves today resolves elsewhere.
 *
 * The returned path may not exist; naming the rebuildable one is what lets loadScene say which file to
 * build instead of scoring on an empty collection.
 *
 * Per book, because a scene ranks every attached book and each has its own collection. Only the primary's
 * may come from `index` or the bundle's recorded `S.index` — both name ONE file, and handing a second book
 * the primary's collection would score it against another book's chunks.
 */
export const indexPath = (S, { vectors = 'data/default-user/vectors/ollama', model = resolveModel(embedModelOf(S)).label, index = null, all = false, book = S.primaryBook } = {}) => {
    const own = book === S.primaryBook;
    if (index && own) return index;
    // The all-entries collection is a different file. The live collection and S.index below hold vectorized
    // entries only, so neither can answer for a scene scored with denseAllEntries on; go straight to the
    // cache reindex.mjs --all writes.
    if (all) return cachePath(S, chunkConfig(S), model, book, true);
    // Through stInstall, not the cwd: both local candidates are recorded with ST's `data/` prefix, so testing
    // them raw asks whether the collection exists relative to wherever the tool was launched from, and the
    // answer changes with the directory while the scene does not (H2). stInstall returns null only on a
    // machine with no ST install, where neither candidate can exist and the rebuild cache is the answer.
    const st = stInstall();
    const local = p => (st ? st.resolve(p) : p);
    if (own && S.index && existsSync(local(S.index))) return local(S.index);
    const derived = local(`${vectors}/wa_${getStringHash(book)}/${pathSafe(model)}/index.json`);
    if (existsSync(derived)) return derived;
    return cachePath(S, chunkConfig(S), model, book);
};

/**
 * One embed call, memoised on disk by (model LABEL, exact input text).
 *
 * The label in the key is what makes caching safe: `resolveModel`'s label names a collection too, so a
 * different quantization, a different server serving the same weights, or a doc prefix appearing are all a
 * different cache rather than a stale hit. Keyed on the text AS SENT, prefix included, under SHA-256 — a
 * weak hash risks handing back another query's vector, which nothing downstream could catch.
 *
 * Appended one JSONL line per call, per the harness rule, so a killed run keeps every embed it already
 * paid for. Lives in gitignored eval-data: it is a cache and rebuilds from the bundles.
 */
const qCache = new Map();
/** The cache file for one model label. RAW, as cachePath writes the model half of a collection path: only
 *  a BOOK is slugged there, because book names are arbitrary user text while a label is not, and slugging a
 *  label is what would make two of them collide. `pathSafe` folds the slash of a HuggingFace repo id and
 *  nothing else. Exported so a test cannot re-derive the name and drift from it. */
export const queryCachePath = label => new URL(`./eval-data/query-cache__${pathSafe(label)}.jsonl`, import.meta.url).pathname;
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

/**
 * The parameter set a sample was captured under, layered over the harness defaults.
 *
 * The defaults are one tuned chat's snapshot, not the shipped defaults (extension/state.mjs ships K1 1.2):
 * each graded scene carries the settings it was graded under in its own `params`, which are spread over
 * these. `overrides` on top is how an arm asks what this scene would look like at other parameters.
 */
export const sceneParams = (S, overrides = {}) => ({
    // No fusion params: K, LEXW and KEYW described an RRF over the layout that no longer exists. A stored
    // bundle still carrying one is spread over these and ignored, like `threshold` below.
    K1: 2, B: 0.75, boost: 3, stopwordDf: 0.25,
    // null = whatever the shipped memory fit carries. Set only by a cutoff arm; see scoreScene `admits`.
    memoryCutoff: null,
    // Which fit scores the column, by name, overriding the scene's own embedding model. null is production.
    // A run that sets this must also fix `memoryCutoff`, or each arm cuts at its own fit's provenance cutoff
    // and the contrast reads coefficients and cut sizes at once.
    relevanceFit: null,
    // Which artefact the fits are read from — a directory holding `relevance-model-<tier>.json`, resolved
    // from the working directory; null is the shipped `extension/` pair. Orthogonal to `relevanceFit`, which
    // picks a fit WITHIN a file by embedding model; this picks the file. Same warning as above.
    fitDir: null,
    caseSensitive: false, wholeWords: false, includeNames: true,
    // How the haystack is segmented, which decides what `scan` means to countKey. Captured in `params`
    // (worldsapart.js captureParams), so a document that records it overrides this.
    matchWindow: 'scan',
    // What counts as inside a word when wholeWords is on (state.mjs wordBoundary, shipped 'strict'). Unlike
    // the knobs above this one is module state in the matcher, so makeKeywordScore pushes it through
    // setBoundaryMode per call — otherwise every arm scores at whatever the last one set. A sample captured
    // before the setting existed ran under neither mode and is read at the shipped default.
    wordBoundary: 'strict',
    // Occurrences -> score (matcher.mjs repeatCurveOf). 'bm25' here, not the shipped 'presence-log', so that
    // captures predating the setting reproduce byte-identically; new ones record their own curve in
    // `params`, which is spread over these defaults.
    repeatCurve: 'bm25', repeatR: 1,
    // Whether the cosine subtracts the corpus mean (state.mjs meanCentered, shipped on). An arm here
    // contrasts the centered and raw rankings on graded scenes; the leave-one-out chunk-to-sibling screen
    // asks a different question and can disagree without either being wrong. Captures predating `params`
    // recording it fall back to this default, which is the value they ran under.
    meanCentered: true,
    // Dense for every entry — a cosine for the entries the vector collection has no row for, which is the
    // signal keyword-only entries lack. Needs an index built with reindex.mjs --all (every entry with
    // content, the same population content-lexical.mjs indexes) and reads its two halves at different
    // stages: the vectorized chunks stay stage 1's collection and corpus mean, so retrieval, admission and
    // every baseline cosine are unchanged, and the rest are scored at stage 3 against that same mean so the
    // two classes share a scale. Nothing here activates — an entry no key fired for gets no row.
    //
    // Production, not an arm, so it defaults on: `scoreEntriesUnsafe` embeds and scores every entry with
    // content while force-activating only the vectorized ones, and the plugin centroids on the vectorized
    // uids the client names. Off, a harness run scores the pipeline as it was before that. loadScene throws
    // rather than quietly scoring the ordinary collection when the `--all` index is missing.
    denseAllEntries: true,
    // Which entries define the corpus mean the vector centering subtracts (plugin/vector.mjs).
    //
    //   'vectorized'      enabled + vectorized. Neither "the book" nor "what gets compared" — a frozen
    //                     snapshot of the comparison set from before every entry became scorable.
    //   'memory'          enabled memory-tier entries. Register-homogeneous, which is what makes a centroid
    //                     mean anything: a blend of narrative summaries and encyclopedic reference removes
    //                     neither cluster's shared direction and leaves each tilted toward the other.
    //   'memoryArchived'  the above plus DISABLED memory entries, which requires an index built with
    //                     reindex.mjs --archived. Treats the centroid as a property of the BOOK rather than
    //                     of the current playthrough, so archiving an arc stops moving every other cosine.
    //
    // The two are one step apart and worth running separately: dropping `vectorized` moves only books whose
    // memory entries are not all flagged, while adding archived mass moves whatever the author retired.
    // 'memory' is production (worldsapart.js centroidUids), so it defaults on for the same reason
    // denseAllEntries does. No stored capture records this field, and the two centroids measured
    // essentially coincident (F44), so no recorded number is invalidated by the switch.
    centroidPopulation: 'memory',
    // How many leading components of the centred corpus are projected out, on top of the mean. 0 is
    // production: mean-centering only.
    //
    // The mean is one direction, and most of its mass is shared with every other book rather than the
    // book's own (R15; metrics.mjs topComponents), so it spends most of its effect on something no book is
    // distinguished by. What is unremarkable in a book is plausibly several directions, which one vector
    // cannot carry; this removes k of them.
    //
    // Screened on the LOO chunk-to-sibling task and not promising there: it helps in proportion to a book's
    // own-direction share (R15). That task cannot answer the question — it has no selection stage, so every
    // metric it emits is read at a window nobody chooses. This param asks it of the delivered set instead.
    pcRemove: 0,
    // Whitening: how many of the book's own directions to RESCALE, and by how much. Centering moves the
    // cloud and leaves its geometry intact — book identity survives per-book centring essentially whole
    // (R18) — so a direction the book SPREADS OUT along is not discriminating within that book and should
    // count less rather than be shifted. whitenAlpha 0 is production (nothing rescaled); 1 flattens the top
    // `whitenR` directions to the scale of the smallest retained one; pcRemove is this at weight 0.
    //
    // Scaled relative to the r-th retained direction, so the transform is continuous at the boundary; an
    // absolute sigma would put a step between component r and component r+1.
    whitenR: 0,
    whitenAlpha: 1,
    // The token ceiling stage 5 walks the layout under. 0 leaves the budget unmodelled.
    //
    // What this cannot model, the gap being in the captures rather than the code: constants and armed
    // stickies are hoisted ahead of the dynamic block and spend the budget first (selection.mjs walkOrder),
    // and no capture records them — every candidate row in this corpus is `block: dynamic`. So the dynamic
    // block gets more room here than production would give it. maxTotalEntries and the per-book cap are not
    // recorded either and come from the caller.
    //
    // The ceiling is a user's cost decision rather than a property of the scene, so it is passed in rather
    // than read off the bundle; the bundles that record one write it only as a display string (G13).
    budgetTokens: 0,
    // How many shared components come off first (global-basis.mjs). 0 is production: no first stage.
    //
    // Without it pcRemove does not test what it claims: a book's leading component sits largely inside a
    // subspace built from other lineages' memory chunks (R15), so single-stage pcRemove takes mostly common
    // structure, which is what its negative F2 says. Strip the shared mean and its top m directions first,
    // and whatever leads the residual is the book's own by construction.
    //
    // The basis is per book, leave-one-LINEAGE-out, memory tier only; build it with
    // `node eval/global-basis.mjs <samples...>`.
    sharedComponents: 0,
    maxVectorEntries: 20, entityFilter: true,
    // Which fields the gazetteer reads. Production is 'keys+titles' (buildGazetteer's own sources), chosen
    // on a gold set that no longer exists; 'bodies' was re-measured on a handful of scenes and lost (F33).
    // This param exists so the choice can be re-run paired at the current scene count instead of re-argued.
    //   'keys+titles'  shipped
    //   'keys'         key/keysecondary only — the header claims this scores identically to shipped
    //   'titles'       comment only, which is what a mostly-vectorized book already reduces to
    //   'bodies'       shipped plus every entry's content
    //   'none'         empty gazetteer: the proper-noun boost alone
    gazetteerSource: 'keys+titles',
    // How stage A picks its components, a separate question from how they were estimated.
    //   'rank'    the first N by explained variance — what a PCA hands back, and the default so every
    //             stored measurement reproduces.
    //   'shared'  the N with the LOWEST eta^2, the between-lineage share of their projection's variance
    //             (global-basis.mjs). Stage A's job is to remove what the books SHARE, and variance rank is
    //             not sharedness rank: the two disagree at the very top on this corpus (R16), so 'rank'
    //             removes the most book-specific direction available first. Needs a basis carrying `eta`.
    sharedSelect: 'rank',
    // Which scatter stage A's directions come off. 'pooled' is PCA on the raw corpus; 'within' takes them
    // off the pooled WITHIN-book scatter, so a direction that only separates books cannot lead — see
    // global-basis.mjs for the measurement and for why this is not LDA. Reads a separate --within basis.
    sharedScatter: 'pooled',
    // Exact key strings to treat as removed from the book (see scoringKeys). Null = none.
    dropKeys: null,
    // NO queryMode. Nothing summarizes a query any more (matcher-design.md, *Stage 1*). Stored bundles
    // still carry the field; it is read and ignored, like `threshold`.
    // Per-book quota for stage 5 (applyBudget capOf), as {book: cap}. Null = no cap: the live setting lives
    // on the world priority list and no bundle records it, so this is an arm's knob, not a replayed value.
    bookCaps: null,
    // No admission params: `admit`, `bm25Floor`, `bm25FloorPct` and `threshold` are gone with the gates they
    // simulated — stage 1 now scores by cosine and returns everything (plugin/scoring.mjs). `threshold` in a
    // stored bundle's `params` is read and ignored rather than refused, since every stored sample has one.
    ...(S.params ?? {}), ...overrides,
});

/**
 * Loads a sample into everything needed to score it.
 *
 * Every attached book, one ranking, as production pools them: `scoreEntriesUnsafe` syncs a collection per
 * world and the plugin's /query-multi scores them all, each against its OWN centroid, before one top-K
 * across the lot. Loading only `primaryBook` made cross-book competition and `applyBudget`'s per-book cap
 * unmeasurable, and discarded every graded row from a second book (F50).
 *
 * Per-book centroids with pooled cosines, deliberately: it is what production does, and the harness models
 * the pipeline rather than an argument about it. Nothing here is evidence either way.
 *
 * A row's identity is (book, uid), never uid: uids are per book and number from 0, so two books collide on
 * almost every one. The key is content-lexical's `entryKey` — the same `${world}.${uid}` ST core uses for
 * an activated entry, and the same string the content index, the name df, the pool and the grade join all
 * read, so there is one of it.
 *
 * @param {object} S The parsed sample
 * @param {object} opts
 * @param {string} opts.indexFile Vector index path for the PRIMARY book; other books resolve their own
 * @param {object} [opts.indexOpts] Extra indexPath options (vectors, model) for the other books
 * @param {object} opts.params sceneParams() output
 * @returns {object} entries, byKey, loaded indexes, gazetteer, pool sets, and the grade/scope matchers
 */
export function loadScene(S, { indexFile, indexOpts = {}, params: P }) {
    const primary = S.primaryBook;
    // `primaryBook` names a key of `books`, and a bundle whose book was renamed after capture no longer
    // satisfies that. Says so, rather than dying inside Object.values with nothing naming the book.
    if (!S.books?.[primary]) throw new Error(`sample's primaryBook "${primary}" is not among its embedded books (${Object.keys(S.books ?? {}).join(', ') || 'none'})`);
    // The books must be the ones this bundle was derived from. `generatedFrom.attached` records a
    // fingerprint per book at derivation time (synth-scenes, bookFingerprint), so a later edit to an
    // embedded copy is detectable — the gazetteer is built from these books and a silently narrower
    // vocabulary is what this record exists to catch. Self-contained on purpose: it compares the bundle
    // against itself, so it holds on a machine with no ST install and no matching worlds.
    //
    // Legacy bundles carry no `attached` and are skipped rather than rejected: absence says nothing about
    // whether they drifted.
    //
    // Once per sample: dropUnavailable mutates the books in place and a sweep calls loadScene repeatedly on
    // the same object, so re-checking would compare a stripped book against the pristine fingerprint.
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
    // After the fingerprint guard, which asks about the pristine bundle, and before `entries`, `byKey`, the
    // gazetteer and POOL are built from the books.
    if (!S.availabilityFiltered) { dropUnavailable(S, S.name ?? 'sample'); S.availabilityFiltered = true; }
    // Every embedded book, primary first: `Object.keys` is insertion order and a bundle does not promise its
    // primary is first, so it is hoisted — `loaded[0]` and `items` are the primary's, which is what the
    // callers' diagnostics read.
    const books = [primary, ...Object.keys(S.books).filter(b => b !== primary)];
    // Stamped, because `world` identifies an entry across books and many embedded entries carry none — the
    // field is optional in a world file. entryKey, the content index, the name df and applyBudget's per-book
    // cap all read it. Idempotent, and `??=` rather than `=` because a copy that HAS a world is the
    // authority: no bundle disagrees with the key it sits under (F50).
    for (const b of books) for (const e of Object.values(S.books[b])) e.world ??= b;
    const entries = books.flatMap(b => Object.values(S.books[b]));
    const byKey = new Map(entries.map(e => [entryKey(e), e]));

    /**
     * One book's collection, split into the two stages and centered on its OWN corpus mean — which is what
     * the plugin does per collection, and why this is a loop rather than one concatenated index.
     */
    const loadBook = (book, indexFile) => {
        const own = Object.values(S.books[book]);
        const uids = new Set(own.map(e => Number(e.uid)));
        // A keyword-only book has no collection, and that is a configuration rather than a failure: indexing
        // gates on `vectorized` (reindex.mjs buildItems), so a book with no vectorized entry yields no items
        // and ensureIndex refuses to build one (F50). Retrieval then contributes nothing, every entry arrives
        // by the keyword route, and the scene is deterministic: no index, no embedding call, no ollama.
        // corpusMean is the only thing that cannot take an empty list, and it is guarded here rather than in
        // plugin/ so this needs no redeploy.
        // Availability is enforced here, not in the collection: the index is built from the pristine book
        // (reindex.mjs ensureIndex), so it may carry chunks this scene post-dates, and the filtered book is
        // what drops them. That is what lets one cached collection serve every scene of a book without any of
        // them seeing another's cutoff.
        const rawAll = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')).items : [];
        const raw = rawAll.filter(it => uids.has(Number(it.metadata?.index)));
        // Dense-all splits the collection by stage. An --all index (reindex.mjs) holds every entry's chunks;
        // the vectorized ones are item-for-item what the ordinary build produces, so keeping them as `items`
        // leaves stage 1 byte-identical to a run against the ordinary index. The rest go to `extra`, scored
        // at stage 3 only. Centroid-only chunks are not a collection: an --archived index carries disabled
        // memory entries so they can weigh in the mean, and they must reach neither `items` nor `extra` —
        // core would never activate them and no ST install stores a vector for them.
        const archived = raw.filter(it => it.metadata?.centroidOnly);
        const live = raw.filter(it => !it.metadata?.centroidOnly);
        const vectorUids = new Set(own.filter(e => e.vectorized).map(e => Number(e.uid)));
        const ofVectorized = it => vectorUids.has(Number(it.metadata?.index));
        const items = P.denseAllEntries ? live.filter(ofVectorized) : live;
        const extra = P.denseAllEntries ? live.filter(it => !ofVectorized(it)) : [];
        // An ordinary index under this param would score every entry at its production value and report the
        // arm as flat. A book whose every entry is vectorized legitimately has no extras, so the demand is on
        // the BOOK rather than on the file.
        if (P.denseAllEntries && !extra.length && own.some(e => !e.vectorized && !e.disable && e.content)) throw new Error(`denseAllEntries is on but ${indexFile} holds no non-vectorized chunks for "${book}" — build that collection with: node eval/reindex.mjs <sample.json> --all --book ${JSON.stringify(book)}`);
        // An empty collection is only legitimate when the book has nothing to index — the same gate
        // reindex.mjs buildItems applies, so the two agree on what that means. Without this a missing
        // collection scores keyword-and-BM25-only and returns a plausible number rather than an error (H2).
        if (!items.length && own.some(e => e.vectorized && !e.disable && e.content)) {
            throw new Error(`no vector collection for "${book}" at ${indexFile} — the book has vectorized entries, so scoring without one would silently drop cosine. Build it with: node eval/reindex.mjs <sample.json> --book ${JSON.stringify(book)}`);
        }
        // The mean is production's by default — the vectorized corpus's centroid — so a dense-all entry is
        // centered by the same vector its competitors are; centroidPopulation is the arm that changes it. A
        // book with nothing vectorized has no production centroid and no baseline cosine to preserve.
        const memoryUids = new Set(own.filter(isMemory).map(e => Number(e.uid)));
        const ofMemory = it => memoryUids.has(Number(it.metadata?.index));
        // An ordinary or --all index under 'memoryArchived' has no archived mass to add, so it would score the
        // 'memory' population and report it as this arm. Asked of the BOOK, not the index alone: a book with
        // nothing retired legitimately has no archived chunks and is the arm's control — its delta must come
        // back exactly 0, which is the only check that the arm is wired to what it claims.
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
        // A zero-length mean is not a centroid: centeredCosineScores dimensions its work off mean.length, so
        // an empty one returns all-zero scores rather than throwing — a whole book at cosine 0.
        //
        // Falling back to the whole collection is what production does, not a harness convenience: the client
        // names uids and `centroidFor` (plugin/server.js) returns the full corpus mean for an absent or empty
        // list. So a reference-only book is centered on everything it has, in the runtime and here alike.
        const emptySelection = !meanSource.length && live.length;
        if (emptySelection) meanSource = live;
        // No `lexical`: scoreCollection is cosine-only, and stage 3's text index is content-lexical's.
        const loaded = { book, items, extra, mean: meanSource.length ? corpusMean(meanSource) : [] };

        // Projecting the components out at load, not at scoring: they are a property of the corpus, so
        // recomputing them per query is the same answer at N times the cost. The vectors are transformed and
        // the mean becomes zero, so the shipped centeredCosineScores still does the arithmetic. The QUERY has
        // to take the same transform at each call site or the two sides are compared in different spaces.
        //
        // Components of the centroid population, the same rows that define the mean; a wider set would remove
        // directions the mean was never built from. Two stages, shared then own, and every centring moves
        // into them once either is on — loaded.mean becomes zero — so exactly one place decides what comes
        // off. Stage B's mean is the book's centroid OF THE RESIDUAL; with sharedComponents off it is the
        // ordinary centroid and the arm reduces to single-stage.
        if (P.sharedComponents > 0 || P.pcRemove > 0 || P.whitenR > 0) {
            if (!P.meanCentered) throw new Error('sharedComponents/pcRemove need meanCentered: both are defined as what comes off BEFORE the cosine, and uncentered scoring subtracts nothing');
            const stages = [];
            // Stage A is the memory register, so it comes off memory chunks and nothing else. Reference and
            // memory are parallel processes: the register is one direction across all memories on disk
            // (global-basis.mjs memoryChunks), and a reference sheet is not in the population it was
            // estimated over, so subtracting it from every chunk applies a correction fitted on one process
            // to the other (F51). The build side is memory-only; this is the apply side agreeing with it.
            //
            // A book with no memories has nothing for stage A to act on, so it needs no basis at all — that
            // falls out of the tier gate rather than being a special case.
            const hasMemory = live.some(ofMemory);
            if (P.sharedComponents > 0 && hasMemory) {
                // Stage B's mean has to be taken over chunks in the SAME transform state, or it averages
                // projected memory vectors with unprojected reference ones. 'memory' and 'memoryArchived'
                // are exactly the gated set; 'vectorized' is not.
                if (P.centroidPopulation === 'vectorized') throw new Error(`sharedComponents with centroidPopulation 'vectorized' would average stage-A-projected memory chunks with unprojected reference ones in one centroid — use 'memory' or 'memoryArchived'`);
                if (P.sharedScatter !== 'pooled' && P.sharedScatter !== 'within') throw new Error(`unknown sharedScatter "${P.sharedScatter}" — one of pooled, within`);
                const within = P.sharedScatter === 'within';
                const basis = loadBasis(book, resolveModel(P.embedModel ?? embedModelOf(S)).label, within);
                if (!basis) throw new Error(`sharedComponents needs a${within ? ' --within' : ''} basis for "${book}" — build it with: node eval/global-basis.mjs <samples...>${within ? ' --within' : ''}`);
                if (basis.comps.length < P.sharedComponents) throw new Error(`sharedComponents ${P.sharedComponents} but "${book}"'s basis holds ${basis.comps.length} components — rebuild with --m ${P.sharedComponents} --force`);
                // Selection is not estimation: the components arrive in variance order, sharedness is a
                // different order, and taking a prefix of the first conflates them.
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
            // Stage A first, so stage B sees the residual and nothing else — over the memory chunks it is
            // defined on; a reference chunk passes through untouched.
            const shiftA = xs => xs.map(it => (ofMemory(it) ? { ...it, vector: applyAll(it.vector, stages.length) } : it));
            loaded.items = shiftA(loaded.items);
            loaded.extra = shiftA(loaded.extra);
            // meanSource holds the PRE-transform objects, so re-resolve each through the transformed arrays by
            // hash; anything it names that is not in the live collection (archived centroid mass) is transformed
            // on the spot.
            const byHash = new Map([...loaded.items, ...loaded.extra].map(it => [it.metadata?.hash, it]));
            const srcA = meanSource.map(it => byHash.get(it.metadata?.hash) ?? { ...it, vector: applyAll(it.vector, stages.length) });
            const bookMean = srcA.length ? corpusMean(srcA) : loaded.mean;
            // Removal and whitening share one component list: asking for both takes the union, with the removed
            // ones at weight 0 and the rest at their whitened weight, so they compose instead of fighting.
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

    // One embedding model across every book, or the pooled top-K orders cosines taken in two different
    // spaces. Not asserted here: the primary's path arrives already resolved and `label` may differ from
    // `model` for a prefixed family (reindex.mjs modelSpec), so nothing readable off that path distinguishes
    // a mismatch from a naming convention. What prevents it is that every caller threads the same `MODEL` it
    // resolved the primary with into indexOpts; a caller passing neither gets the bundle's own `embedModel`
    // for every book. The primary's path is the caller's; every other book resolves its own.
    // ponytail: a chunk arm's rebuild reaches the primary only (cachePath keys the others off the SCENE's
    // chunkConfig), so a chunkSize sweep re-chunks one book of two. Thread the arm's overrides through
    // indexOpts if a chunk finding ever turns on a second book.
    // `embedModel` is a SPEC (it may carry a server stem); what names a collection is the LABEL, so it is
    // resolved rather than used raw. indexOpts.model is already a label — the caller resolved it.
    const modelLabel = indexOpts.model ?? resolveModel(embedModelOf(S)).label;
    const loaded = books.map(b => loadBook(b, b === primary
        ? indexFile
        : indexPath(S, { ...indexOpts, model: modelLabel, book: b, all: P.denseAllEntries })));
    const items = loaded[0].items;

    // Out of scope is a book that is not here, and nothing else: a graded row can only be ranked if its book
    // was embedded, and every embedded one now is. This replaces `excludeTitles`, whose predicate was "not
    // the primary book" — a reader honouring it would discard valid verdicts about a second book that is
    // right here. The field is gone from the writer (grading.mjs) and from every stored bundle; a copy from
    // elsewhere that still carries one is simply not read. A row with no `book` is the primary's.
    const outOfScope = r => !S.books[r?.book ?? primary];

    // The authored vocabulary, which is what production builds from: queryTermWeights restores the
    // takeover's stash into a local view before calling buildGazetteer, so the gazetteer does not depend on
    // when in the scan it is asked. Offline the authored keys ARE e.key, since samples embed the book raw.
    // The gazetteer spans every book the live chat had attached, as production's does.
    const gazSource = entries;
    // Field selection rides on buildGazetteer rather than re-deriving its tokenization — a second tokenizer
    // is the seam the single-gazetteer rule exists to prevent. `comment` is the title slot, so 'bodies'
    // passes content through it.
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

    // The pool is what was judged, and only that — see graded-scene-grid.mjs. OWN is this capture's own
    // non-durable rows, kept separately so coverage warnings stay about re-derivation failing rather than
    // about sibling arms legitimately disagreeing. OWN is never unioned into the pool: an ungraded row is
    // unjudged no matter who logged it, and unioning reported judged@10 of 100% on a mostly-unjudged
    // scene (G10).
    //
    // Keyed by (book, uid), the only identity that survives a second book: uids are per book and number from
    // 0, so a bare-uid pool declares one book's row judged on the strength of the other's grade.
    const OWN = new Set((S.candidates ?? []).filter(c => !isDurable(c) && !outOfScope(c)).map(c => entryKey({ world: c.book ?? primary, uid: c.uid })));
    const POOL = new Set((S.entries ?? [])
        .filter(g => Number.isFinite(Number(g.uid)) && !outOfScope(g))
        .map(g => entryKey({ world: g.book ?? primary, uid: g.uid })));

    return { primary, books, entries, byKey, items, loaded, gaz, gazSource, outOfScope, POOL, OWN, embedModel: embedModelOf(S), modelLabel, chunkCfg: chunkConfig(S) };
}

/**
 * Grade lookup, by (book, uid) — the scene ranks every attached book and uids number from 0 in each, so a
 * bare-uid map hands one book's row the other's grade. Rows carry their book on `book` (grades, candidates)
 * or on `entry.world` (scored rows); both resolve through content-lexical's `entryKey`. Titles remain the
 * fallback for hand-written samples, and a bare string argument always resolves by title; token-subset
 * title matching alone misattributes when one graded title's tokens are a subset of a sibling's.
 *
 * Returns null for "nobody judged this", not 0. A judged 0 is a verdict, an absent grade is a hole, and
 * collapsing them made the reference tier's grade distribution unreadable and would score a correctly
 * fired, never-judged reference entry as a miss. Out-of-scope rows also return null.
 *
 * Callers that need a number say so. For nDCG that is `?? 0`, the standard partial-label rule.
 *
 * @param {object[]} grades The scene's graded rows
 * @param {{outOfScope: (row: object) => boolean, primary: string}} scene A loadScene result
 */
export function makeGradeOf(grades, { outOfScope, primary }) {
    const list = (grades ?? [])
        .filter(x => x && x.title && Number.isFinite(gradeValue(x)))
        .map(x => ({ tk: nrm(x.title), g: gradeValue(x), title: x.title, uid: x.uid, book: x.book ?? primary, scoped: !outOfScope(x) }));
    const kept = list.filter(g => g.scoped);
    // uid is authoritative only when the grade set is uid-complete; a mixed set falls back to titles
    // wholesale rather than resolving half the rows by a different rule.
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
// The tier predicate lives in relevance.mjs, where the per-tier fit reads it, and is re-exported here so
// the harness's callers keep one import — two definitions of "is this a memory entry" is how the runtime
// and the fit would score different populations. Imported AND re-exported: a bare `export ... from`
// forwards the name without binding it in this module, and scene.mjs calls isMemory itself.
import { isMemory, buildNameDf, properNames, properShared, properDensity, scoreRelevance, modelKey, postDates, UNFITTED_FALLBACK } from '../extension/relevance.mjs';
export { isMemory };
export const isReference = e => !isMemory(e);
export const isDurableEntry = e => Boolean(e?.constant);

/**
 * Recall split by TIER, over one selection's kept set.
 *
 * Standing rather than ad hoc: `memory` and `reference` have very different base rates on this corpus, so
 * a rule that favours the denser class raises every pooled metric while delivering less of what the system
 * exists to retrieve (F39). F2, precision, recall, nDCG and calibration are all blind to it, because a
 * class prior that tracks base rates genuinely predicts. Only the split shows it.
 *
 * Identity comparison, not uid: `kept` holds the same row objects the population does, so a uid join would
 * be a second way to say the same thing and a place to drift.
 *
 * Exercised only by paired-check.mjs; nothing in this module splits a kept set.
 *
 * @param {Array<object>} population Rows the selection chose from, durable already excluded by the caller
 * @param {Array<object>} kept The rows it chose
 * @param {(row: object) => number|null} gradeOf Grade lookup; ungraded counts as not relevant
 * @returns {{memory: {got: number, of: number}, reference: {got: number, of: number}}}
 */
export function tierRecall(population, kept, gradeOf) {
    const keptSet = new Set(kept);
    const relevant = population.filter(r => (gradeOf(r) ?? 0) >= 3);
    const half = pick => {
        const rows = relevant.filter(pick);
        return { got: rows.filter(r => keptSet.has(r)).length, of: rows.length };
    };
    return { memory: half(r => isMemory(r.entry)), reference: half(r => isReference(r.entry)) };
}

/** Whole-word presence of a bare name in the entry's own content — the mechanical fill rule for
 *  addCastKeys. Per-name regex cached at module level; case-insensitive to match the default key flags. */
const nameRe = new Map();
const mentions = (name, content) => {
    let re = nameRe.get(name);
    if (!re) nameRe.set(name, re = new RegExp(`(?<!\\w)${name.toLowerCase()}(?!\\w)`));
    return re.test((content ?? '').toLowerCase());
};

/** The query under the same transform ONE BOOK'S collection took (loadScene pcRemove), or unchanged when
 *  none. Per book: each takes its own basis and centroid, so a query transformed by another book's stages
 *  is compared in the wrong space. Applied at every call site rather than once by the caller, or the
 *  dense-all extras would be compared in a different space from the collection. */
export const pcQuery = (loaded, qvec) => (loaded?.pc
    ? loaded.pc.stages.reduce((v, st) => projectOut(v, st.mean, st.comps, st.weights ?? null), qvec)
    : qvec);

/** Keys the production scan would actually score — every entry's, a vectorized one included, as
 *  worldsapart.js `scoreKeysOf` does.
 *
 *  P.dropKeys (array of exact key strings) simulates removing those keys from the book: they stop scoring
 *  AND stop keyword-activating, since stage-2 activation tests `keywordScore > 0` through this same
 *  function. Not removed from the gazetteer, so a dropKeys arm understates removal by whatever those terms
 *  contribute to term weighting. */
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
    const ks = base;
    return P.dropKeys ? ks.filter(k => !P.dropKeys.includes(k)) : ks;
};

/** Keyword score via the SHARED matcher.keywordScore (which mirrors ST core's matchKeys).
 *  Pushed per call, not once at construction: arms hold their scorers across each other's runs, so
 *  a mode set at build time would be whichever arm was constructed last. */
export const makeKeywordScore = P => (e, text, k1) => {
    matcher.setBoundaryMode(P.wordBoundary);
    return matcher.keywordScore(e, text, scoringKeys(e, P), { k1, caseSensitiveDefault: P.caseSensitive, wholeWordsDefault: P.wholeWords, repeatCurve: P.repeatCurve, repeatR: P.repeatR }).score;
};

/**
 * Builds the candidate set — every entry that would be in the ranking, with its per-signal scores.
 *
 * Spans three stages, marked below: production keeps them apart by construction (retrieval in
 * selectAndActivate on one event, scoring in onScanDone on another) and offline they collapse into one
 * pass. Stage 2 genuinely depends on a stage-3 computation — `keywordScore > 0` is what decides keyword
 * activation — and core has the same dependency, so this is faithful rather than a shortcut.
 *
 * `topK` defaults to stage 1's own bound, and pooling happens before the cut here as it does in the plugin,
 * so K counts ENTRIES. It is not a function of any stage-5 cap: admission depth and how many entries may
 * reach the prompt are separate questions. Pass it only to probe window sensitivity.
 *
 * @returns {(k1: number, b: number, tw: object|null, qvec: number[], qtext: string, haystackFor: (entry: object) => string[]) => object[]}
 */
export function makeCandidateSet({ loaded, byKey, entries, params: P, chunkCfg, topK = admitCeiling(true) }) {
    const keywordScore = makeKeywordScore(P);
    // Content-lexical, the stage-3 text signal for every entry — built once here because it depends only on
    // the book and the chunk settings, not on the query. The runtime builds it per book at the same point
    // (worldsapart.js contentTextScores); both go through content-lexical.mjs, so no second copy of the
    // pooling or chunking rule can drift.
    //
    // One index per book, because that is what `bookIndexes` keys and caches. Pooling the books into one
    // index would pool their IDF, so a term common in one book would read as rare in the other's entries.
    const cfg = chunkCfg ?? { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };
    const byBook = new Map();
    for (const e of entries) { const b = e.world; if (!byBook.has(b)) byBook.set(b, []); byBook.get(b).push(e); }
    const contentIndexes = [...byBook].map(([, own]) => buildContentIndex(own, cfg));
    const hasContent = e => Boolean(String(e?.content ?? '').trim());
    // Dense-all, the stage-3 cosine for entries the collection has no row for (loadScene splits them out).
    // Pooled by MAX per entry, the same rule poolEntries applies to the vectorized half, and against the
    // BOOK'S OWN mean so both classes are centered by the same vector. Filled onto the keyword route below,
    // so it re-ranks entries a key already activated and admits nothing.
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
    // A haystack is per entry, so the caller hands over the composer rather than one built window: it
    // resolves the entry's own scanDepth, admits the injects that depth reaches, and appends the sources the
    // entry opted into, which is what the runtime does.
    return (k1, b, tw, qvec, qtext, haystackFor) => {
        const dense = denseExtra(qvec);
        // --- STAGE 1: RETRIEVAL. Cosine over every chunk, no admission test — plugin/scoring.mjs carries
        // why the threshold and the lexical clause left this stage. `contentText` is stage 3's text signal
        // and is computed here only because this pass collapses the stages; it admits nothing.
        //
        // One top-K across every book, each scored against its own centroid — the plugin's /query-multi loop
        // exactly, which is why `scoreCollection` takes a collection id at all. The books compete:
        // `poolEntries` keys on (collection, uid) so their uids cannot collide, and `selectTopK` sorts the
        // pooled records across collections before grouping them back.
        const contentText = new Map();
        for (const ix of contentIndexes) for (const [k, v] of scoreContent(ix, qtext, { k1, b, termWeights: tw, stopwordDf: P.stopwordDf })) contentText.set(k, v);
        const scored = loaded.flatMap(L => scoreCollection(L.book, L, pcQuery(L, qvec), { centered: P.meanCentered }));
        const grouped = selectTopK(poolEntries(scored), topK);
        const per = new Map();
        for (const [book, g] of Object.entries(grouped)) for (const m of g.metadata ?? []) { const key = entryKey({ world: book, uid: m.index }); per.set(key, { score: Math.max(per.get(key)?.score ?? -Infinity, m.score) }); }
        const rows = [];
        // --- STAGE 2: ACTIVATION (retrieval route). Whatever the pooled top-K returned is in the ranking.
        // `entry` is carried so fuseRanks can read eligibility (and authored order) the way production does.
        //
        // Disabled entries are excluded here too: disabling an entry does not purge its chunks from the
        // collection, so the index goes on answering for it long after core stopped activating it, and such
        // rows have filled a large share of delivered slots as ungraded ones (F49).
        //
        // Dropped at admission rather than filtered from `entries`: the gazetteer and the BM25 corpus must
        // still see every entry, or the term weights move and the comparison measures the wrong thing.
        for (const [key, s] of per) { const e = byKey.get(key); if (e && !e.disable) rows.push({ uid: Number(e.uid), book: e.world, entry: e, title: wiTitle(e), score: s.score, textScore: contentText.get(entryKey(e)) ?? 0, keywordScore: keywordScore(e, haystackFor(e), k1), vectorEligible: !!e.vectorized, textEligible: hasContent(e), keysEligible: scoringKeys(e, P).length > 0 }); }
        // --- STAGE 2: ACTIVATION (keyword route). Stands in for ST core's keyword match, so it may only
        // admit an entry core could actually have activated. One exclusion, a stage-2 fact: `disable`, since
        // core never activates a disabled entry (F49). A vectorized entry is not excluded — WA judges it like
        // any other candidate, and stage 1 has usually admitted it already through `per`.
        for (const e of entries) { const key = entryKey(e); if (per.has(key) || e.disable) continue; const kw = keywordScore(e, haystackFor(e), k1); if (kw > 0) rows.push({ uid: Number(e.uid), book: e.world, entry: e, title: wiTitle(e), score: dense.get(key), textScore: contentText.get(key) ?? 0, keywordScore: kw, vectorEligible: dense.has(key) || !!e.vectorized, textEligible: hasContent(e), keysEligible: true }); }
        return rows;
    };
}

/** The fitted models by tier, read once per directory. `extension/` is the shipped location, and the
 *  harness reads the same files the runtime fetches so a refit reaches both without a second copy.
 *
 *  A directory, not a file, because a fit is per tier and the pair is what scores a scene. An arm naming
 *  one (`fitDir=`) compares an alternative artefact against the shipped one, which no `byModel` key can
 *  express — those being embedding models rather than fits. A tier the directory does not carry falls back
 *  to the shipped file: an arm varying the memory fit is not also claiming something about reference. */
const MODEL_CACHE = new Map();
const modelFiles = (dir = null) => {
    const key = dir ?? '';
    if (!MODEL_CACHE.has(key)) {
        const base = dir ? resolvePath(process.cwd(), dir) : dirname(fileURLToPath(new URL('../extension/x', import.meta.url)));
        const out = {};
        for (const tier of ['memory', 'reference']) {
            try { out[tier] = JSON.parse(fs.readFileSync(resolvePath(base, `relevance-model-${tier}.json`), 'utf8')); }
            catch { out[tier] = dir ? modelFiles()[tier] : null; }
        }
        MODEL_CACHE.set(key, out);
    }
    return MODEL_CACHE.get(key);
};

/** The fits for one embedding model, by tier. THROWS when the model has none, where production borrows
 *  `UNFITTED_FALLBACK`'s — production has nobody to ask, a harness is told its embedder. Modelling the
 *  borrow has its own door: name the fit (`--arms fit=mxbai`), which the run then records. */
export const modelsFor = (embedModel, dir = null) => {
    const MODEL_FILES = modelFiles(dir);
    // Through resolveModel, because a bundle records a SPEC: `omlx:Qwen3-...` keys as the served id
    // `qwen3-...`, which is what the runtime can compute for itself. A bare name resolves to itself.
    const key = modelKey(resolveModel(embedModel).model);
    const out = {};
    for (const tier of ['memory', 'reference']) {
        out[tier] = MODEL_FILES[tier]?.byModel?.[key] ?? null;
        if (!out[tier]) {
            throw new Error(`no ${tier} relevance fit for embedding model "${key}" (have: ${Object.keys(MODEL_FILES[tier]?.byModel ?? {}).join(', ') || 'none'}). `
                + `The runtime would borrow "${UNFITTED_FALLBACK}"'s coefficients here; a harness is told its embedder, so say which fit you mean `
                + 'with an explicit arm (fit=<name>) or fit this model with eval/relevance-regress.mjs --emit-model.');
        }
        // The cosine-free fit rides on the model's own, as the runtime attaches it (loadRelevanceModel).
        out[tier].noCosine = MODEL_FILES[tier]?.noCosine ?? null;
    }
    return out;
};
/** The fits under one NAME — a `byModel` key, or `noCosine` — so a scene can be scored through another
 *  model's coefficients. THROWS on an unknown name: silently scoring an arm as unfitted would report the
 *  fallback as that arm's result. Production resolves by embedding model, never by name. */
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
/** Which models the shipped artifact carries a fit for, for a caller that wants to say so. */
export const fittedModels = () => [...new Set(Object.values(modelFiles()).flatMap(f => Object.keys(f?.byModel ?? {})))];

/**
 * The LAYOUT ORDER: rows sorted by predicted relevance, the quantity stage 4 selects on.
 *
 * Not a fusion. RRF is gone from the product — E[credit] reads the signals directly and orders the dynamic
 * block by the same number the cut thresholds, which is what makes every cap below it a prefix.
 *
 * The two extra signals are computed here through relevance.mjs, the same functions the runtime calls and
 * never a copy. df is per book with the ENTRY as the document and disabled entries included; the window
 * names come from a plain entry's haystack, because proper-noun overlap is a property of the SCENE.
 *
 * Per tier, each standardised among its own rows, as each fit was built.
 */
export const makeLayoutOrder = ({ scene, haystack, fit = null, fitDir = null }) => {
    // The fits are per embedding model, resolved from the scene's own record — a bundle names the model
    // its collections are keyed under, so the fit follows the vectors rather than whatever shipped last.
    // `fit` overrides that by NAME — a screening arm, never production.
    if (!fit && !scene?.embedModel) throw new Error('scene records no embedModel — the fits are per embedding model');
    const MODELS = fit ? fitsNamed(fit, fitDir) : modelsFor(scene.embedModel, fitDir);
    // Per book, as `bookIndexes` builds it: df asks how distinctive a name is IN ITS BOOK'S vocabulary, and
    // a name common in one book and unique in another has two answers, not one.
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
            // The same population rule the runtime uses (`worldsapart.js` scoreRelevanceColumn), read off the
            // fit: a `pooled` fit took its statistics from every candidate of the scene and must be served
            // that way, since standardising it over the tier's rows alone rescales every z and reads as the
            // artefact being worse. This file and the runtime must not drift on it.
            // Also the runtime's choice: a tier with no cosine at all — a keyword-only book, a no-plugin
            // capture — scores through `noCosine` rather than standardising a column of zeros.
            const fit = mine.some(r => Number.isFinite(r.score)) ? model : (model.noCosine ?? model);
            const population = fit.standardise === 'pooled' ? rows.map(col) : undefined;
            const e = scoreRelevance(fit, mine.map(col), population);
            // `tierCutoff` is the fit's own F2 optimum, carried as provenance and nothing else — the runtime
            // does not read it and cuts at the `relevanceCutoff` setting, one value for every model. Stage 4
            // does not happen here: this produces the layout order, and whoever cuts on it owns which number
            // it cuts at (scoreScene `admits`).
            mine.forEach((r, i) => { r.eCredit = e[i]; r.tierCutoff = fit.cutoff; });
        }
        return [...rows].sort((a, b) => (b.eCredit ?? -1) - (a.eCredit ?? -1));
    };
};

/**
 * Scores one scene end to end at one parameter set: nDCG on the pooled rows, plus judged coverage of the
 * unfiltered top-k.
 *
 * The two rankings are deliberately different: nDCG is measured on the pool, where the grades are, while
 * coverage is measured on the unpooled ranking — coverage asks whether the top-k this configuration
 * produces carries grades at all, and restricting to the pool first would answer it 100% by construction.
 * A scene whose coverage is short is reporting a LOWER BOUND on nDCG.
 *
 * @param {object} args
 * @param {object} args.sample Parsed sample
 * @param {object} [args.overrides] Parameter overrides for this arm
 * @param {number} [args.k] Coverage/nDCG cutoff (10)
 * @returns {Promise<{n: number, nAt5: number, judged: number, of: number, unjudged: string[], terms: number|null,
 *   atR: {precision: number, recall: number, f: number, n: number}}>}
 */
export async function scoreScene({ sample: S, overrides = {}, k = 10, vectors, model, ollama, index, topK, scene: preloaded, qv: cachedQv } = {}) {
    const P = sceneParams(S, overrides);
    // A preloaded scene is reused across arms so N arms cost one embed and one index parse per scene. Valid
    // only while no arm moves the gazetteer or denseAllEntries, both baked in at load time — asserted rather
    // than trusted, since either failure is silent: a wrong gazetteer, or the ordinary collection scored and
    // reported flat.
    if (preloaded && (overrides.denseAllEntries !== undefined || overrides.gazetteerSource !== undefined)) {
        throw new Error('gazetteerSource/denseAllEntries are read at load time, so they cannot be swept against a preloaded scene — load per arm');
    }
    // `model` is a SPEC, resolved here so every caller can pass one: a bare ollama name, or a server stem
    // (`omlx:`, `lms:`) for a model served over an OpenAI-compatible /v1/embeddings. The LABEL names the
    // collection, the rest says how to call it, and `query` is the task prefix a prefix-trained family
    // needs — absent it does not fail, it scores the model worse than it is.
    const em = resolveModel(model);
    const scene = preloaded ?? loadScene(S, { indexFile: indexPath(S, { vectors, model: em.label, index }), indexOpts: { vectors, model: em.label }, params: P });
    const scoreAll = makeCandidateSet({ ...scene, params: P, topK });
    const layoutOrder = makeLayoutOrder({ scene, haystack: haystackFor(S, P), fit: P.relevanceFit, fitDir: P.fitDir });
    const gradeOf = makeGradeOf(S.entries, scene);

    const query = S.query;
    const tw = P.entityFilter ? entity.buildTermWeights(query, scene.gaz, P.boost) : null;
    // No collection means no cosine to compute, so the embed call is skipped rather than made and ignored.
    // Under denseAllEntries a keyword-only book has an empty stage-1 collection and still has vectors to
    // score against, which is the whole point of the arm there.
    const qv = cachedQv ?? (scene.loaded.some(L => L.items.length || L.extra?.length)
        ? await embed(em.query + query, { ollama, model: em.model, label: em.label, endpoint: em.endpoint, url: em.endpoint === 'ollama' ? ollama : em.url })
        : []);
    // Rebuilt, not read: the document stores the scan messages, the injects and the opted-in sources
    // separately, so the haystack is composed here at this arm's depth, matchWindow and includeNames.
    const all = scoreAll(P.K1, P.B, tw, qv, query, haystackFor(S, P));

    // What is ranked: the haystack, minus constants. Relevance is not a concept that applies to a constant —
    // it carries world rules and generation instructions, is not about the scene, and was never competing to
    // be; scoring one asks a grader to rate a category it does not belong to.
    //
    // Sticky is IN: a sticky entry is ordinary content that persists once activated, and how it should be
    // ordered is exactly the question here. Lumping it with constants deleted a whole book's reference tier
    // from every ranking measurement (F48). Reference is in too — a keyword-activated entry is neither
    // sticky nor constant, so at runtime it lands in the dynamic block beside the retrieved ones.
    const rankable = all.filter(r => !r.entry?.constant);

    const top = layoutOrder(rankable).slice(0, k);
    const unjudged = top.filter(r => !scene.POOL.has(entryKey(r.entry)));
    // Read the DEPLOYED slice's grades before the pooled re-fuse below mutates shared rows.
    const topGrades = top.map(r => gradeOf(r) ?? 0);
    // Re-fuse the pooled subset AFTER reading the slice above: fuse mutates, and the subset shares references.
    // From `rankable`, not `all` — reading `all` here would apply the exclusion to coverage alone (F48).
    // `?? 0` is the standard partial-label rule: an unjudged row occupies its rank and contributes nothing.
    // Explicit here because gradeOf returns null for it — see makeGradeOf.
    const g = layoutOrder(rankable.filter(r => scene.POOL.has(entryKey(r.entry)))).map(r => gradeOf(r) ?? 0);

    // Set metrics on the asymmetric bars: recall counts only grade >= 3, while precision credits a 3 or 4 in
    // full and a 2 at half (metrics.mjs gradeCredit). Both read the UNPOOLED top-k — what this configuration
    // would put in front of a user — so an ungraded row still occupies a slot and still costs precision,
    // the same `?? 0` convention nDCG uses; scoring off the pooled subset would delete every arm's misses.
    //
    // They exist beside nDCG because a ranking metric can only credit an entry that lands inside k, so it is
    // structurally blind to an arm whose action is ADMITTING entries; F-beta at RECALL_WEIGHT weights the
    // recall half, which is the half such an arm moves. Recall is also the pool-robust half — an ungraded row
    // is not in the relevant set, so it cannot depress recall the way it depresses precision and nDCG.
    //
    // Not the layout score the doc rules for: that one is at the token BUDGET over the dynamic block, and a
    // fixed k cannot express "as many as are relevant and no more". Read it as directional until the window
    // is what the configuration actually delivered.
    const relevant = g.filter(x => x >= 3).length;
    const precision = top.length ? topGrades.reduce((sum, x) => sum + gradeCredit(x), 0) / top.length : 0;
    const recall = relevant ? topGrades.filter(x => x >= 3).length / relevant : 0;
    const f2 = fbeta(precision, recall, RECALL_WEIGHT);

    // Two more windows on the same bars, since a fixed k cannot answer either question this system selects
    // for. The bars, gradeCredit and RECALL_WEIGHT are shared with the block above; only the window changes.
    //
    //   @R          the top `relevant` rows. Budget-invariant by construction — a user's token ceiling is
    //               set by cost and is not a property of the ranking, so it cannot be in the window.
    //
    // Every window carries its own pool honesty. No k bounds the admitted set: the cut is a prefix in
    // eCredit for scored memory rows, but reference rows and rows the model could not score are admitted
    // wherever they sit, so a window read at k=10 can miss an ungraded row the configuration delivers — it
    // scores 0 and reads as a precision loss with nothing saying why.
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

    //   @cut        everything the relevance cut admits. The only window the system chooses for itself —
    //               @R is handed the answer and k is handed a number, so neither can be wrong about HOW
    //               MANY, which is half of what stage 4 decides. Move the cutoff and this set moves.
    //
    // Memory only, mirroring the runtime: a reference entry that fires answers only to the budget
    // (worldsapart.js `onScanDone`), so it is never cut here either, and a row the model could not score is
    // kept because an absent verdict is not a negative one. The cut is applied here and the number it cuts
    // at is chosen here too — an arm's `memoryCutoff` when it set one, otherwise the fit's own. That
    // fallback is not what production reads (the runtime cuts at the `relevanceCutoff` setting, one value
    // for every model), so a run passing no cutoff measures a cut production does not make; changing it
    // would move every number ever measured at the default, so `param-screen.mjs` and any tool that cares
    // passes one instead.
    const cutFor = r => (isMemory(r.entry) && Number.isFinite(P.memoryCutoff)) ? P.memoryCutoff : r.tierCutoff;
    // Promoted rows are exempt, as at runtime, or this would score a delivered set the runtime never
    // produces. Read off the entry rather than a stash: a bundle embeds the book verbatim, so the `@@` lines
    // the browser only sees at ENTRIES_LOADED are still in the content here.
    const promotedRow = r => hasPromoteDecorator(r.entry);
    const admits = r => promotedRow(r) || !isMemory(r.entry) || !Number.isFinite(cutFor(r)) || !Number.isFinite(r.eCredit) || r.eCredit >= cutFor(r);
    const atCut = scoreWindow(ranked.filter(admits));

    //   @budget     what the token ceiling actually leaves — stages 4 and 5 end to end, so the only window
    //               here that is the DELIVERED set rather than a stage of it. Off by default; see
    //               budgetTokens for what the captures cannot supply.
    // Recorded token counts where the capture has them, since they came from the real tokenizer; the
    // fallback constant is this corpus's measured chars-per-token for entry bodies (G12).
    const recorded = new Map((S.candidates ?? []).map(c => [entryKey({ world: c.book ?? S.primaryBook, uid: c.uid }), c.tokens]).filter(([, t]) => typeof t === 'number'));
    const tokensOf = r => recorded.get(entryKey(r.entry)) ?? Math.round(String(r.entry?.content ?? '').length / 4.91);
    // What the delivered set costs, unconditionally — the price of the answer beside its quality. Outside
    // the budget branch because the two ask different questions: `@budget` asks what survives a ceiling,
    // this asks what the selection SPENDS when nothing binds. No set-based score can see that, so an arm
    // delivering half the tokens registers only as whatever recall it lost.
    atCut.tokens = ranked.filter(admits).reduce((n, r) => n + tokensOf(r), 0);

    let atBudget = null;
    if (P.budgetTokens > 0) {
        const kept = await delivery.applyBudget({
            // Classified, so the walk is the runtime's: `isDynamic` excludes promoted rows, and the capacity
            // caps take the wider population explicitly, the default `isCapped` being `isDynamic`.
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
            // The per-book quota. No capture records it — the live setting is `priorityList[].cap`
            // (worldsapart.js) and paramSnapshot does not carry it — so it is an arm's to set.
            capOf: r => Number(P.bookCaps?.[r.entry?.world]) || 0,
            tokensOf,
        });
        // `survivors` is a Set built by walking `ranked` in order, so spreading it keeps the layout order
        // the caps took a prefix of — which scoreWindow needs, since it reads rows positionally.
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
        // The unjudged rows with their identity, which is what an offline pool extension needs.
        unjudgedRows: unjudged.map(r => ({ uid: Number(r.uid), book: r.entry?.world, title: r.title, rank: top.indexOf(r) + 1 })),
        terms: tw ? Object.keys(tw).length : null,
    };
}
