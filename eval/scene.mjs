// scene.mjs — loading and scoring ONE graded scene from a /wa-grade sample. The machinery
// graded-scene-grid.mjs and param-screen.mjs both need, extracted so there is exactly one copy of it.
//
// WHY IT IS A MODULE AND NOT COPY-PASTE. Every line below is a place a second copy would silently drift.
// The gazetteer alone has already cost this project one wrong answer (at stage 1, when it still fed
// admission): reading raw book keys instead of the
// suppressed ones admitted 2.3x the query terms and inflated every BM25 score by up to 74%, which is what
// made a validated sample look unreproducible. A cross-sample tool that re-derived any of this by hand would
// be comparing two subtly different rankings and reporting the difference as a parameter effect.
//
// Nothing here parses argv or prints a report — callers own their own CLI and output. Nothing here reads a
// live lorebook either: entries come from the sample's embedded copies, which is what makes a graded scene
// re-runnable after the books have been edited.
import fs, { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve as resolvePath } from 'node:path';
import { scoreCollection, poolEntries, selectTopK, admitCeiling } from '../plugin/scoring.mjs';
import { corpusMean, centeredCosineScores } from '../plugin/vector.mjs';
import * as ranking from '../extension/ranking.mjs';
import * as matcher from '../extension/matcher.mjs';
import { isDurable, openBundle } from '../extension/grading.mjs';
import * as selection from '../extension/selection.mjs';
import { buildContentIndex, scoreContent, entryKey } from '../extension/content-lexical.mjs';
// Cycle: reindex.mjs imports getStringHash from here. Safe because neither side calls across at module
// scope — both references live inside function bodies, so whichever module loads first finishes evaluating
// before the other needs a binding.
import { cachePath, chunkConfig, embedTexts, pathSafe, resolveModel } from './reindex.mjs';
import { gradeCredit, fbeta, RECALL_WEIGHT, gradeValue, topComponents, projectOut, componentScales } from './metrics.mjs';
import { loadBasis } from './global-basis.mjs';
export { inVectorIndex } from '../extension/ranking.mjs';

/** Unit Separator — see CLAUDE.md. Never NUL: that makes git treat the file as binary. */
const US = String.fromCharCode(31);

/**
 * Drops rows whose entry POST-DATES the scene — an STMB summary covering messages after the frozen turn
 * could not be in the book when that turn was live, so production can never retrieve it.
 *
 * Only offline derivation produces these: `synth-scenes.mjs` cuts a scene out of a finished chat against
 * a finished book. A live /wa-grade capture cannot contain one, which is why it keys on
 * `generatedFrom.msg` and no-ops when that is absent.
 *
 * **Measured** over the 96 syn scenes: 43% of graded rows go and 20% of the grade >= 3 rows.
 *
 * BOOKS, NOT ONLY GRADES. `makeCandidateSet` re-derives the pool from the books, so filtering the grades
 * alone leaves every future entry in the pool as an UNJUDGED row still holding a rank — worse than
 * leaving it graded. Dropping them from the books also takes them out of the gazetteer, the BM25 IDF and
 * the keyword scan, none of which existed over an entry the book did not yet hold.
 *
 * Relevance itself is NOT chronological — an entry about a later event can be squarely on topic, and the
 * rubric is right to say so. This is about what the book HOLDS, not what a grade means.
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
    // THE BOUNDARY IS THE END, NOT THE START. A summary exists once the messages it covers have happened,
    // so an entry spanning the frozen turn — `start <= at < end` — could not be in the book either, and a
    // start-only test kept every one of them. They are not merely unavailable, they are the scene's own
    // haystack paraphrased: **measured**, 66 of the corpus's 446 memory positives straddled their scene,
    // scoring within-scene z 2.795 against clean positives' 0.800 and ranking FIRST in 53% of their scenes
    // against 7%. A grade of 4 on such a row is correct and the retrieval is correct; the SCENE is
    // impossible, and both the score and the fitted coefficients were reading it.
    // The rule itself is relevance.mjs's, so the runtime's `dropUnavailable` setting and this cannot
    // drift on what "not yet written" means.
    const future = r => postDates({ STMB_end: end.get(`${r.book}${US}${r.uid}`), STMB_start: start.get(`${r.book}${US}${r.uid}`) }, at);
    let cut = 0, gone = 0;
    const keep = list => (list ?? []).filter(r => (future(r) ? (cut++, false) : true));
    S.entries = keep(S.entries);
    S.candidates = keep(S.candidates);
    // THE PRISTINE BOOKS SURVIVE THE FILTER, because a COLLECTION is not scene-scoped and the index cache
    // is keyed as though it were not (reindex.mjs cachePath: book + model + chunk settings). Building from
    // the stripped book bakes ONE scene's message cutoff into a file every other scene of that book then
    // reads — silently, since a smaller collection scores fine. Measured on Time Whore: an index built
    // inside a param-screen run held 207 of the book's 243 entries, and the 36 missing ones were whatever
    // post-dated the scene that happened to build it first.
    S.pristineBooks ??= structuredClone(S.books ?? {});
    for (const [book, bk] of Object.entries(S.books ?? {})) {
        for (const [k, e] of Object.entries(bk ?? {})) {
            if (future({ book, uid: e.uid })) { delete bk[k]; gone++; }
        }
    }
    if (cut || gone) console.error(`  ${label}: dropped ${gone} entr(ies) and ${cut} graded/candidate row(s) post-dating message ${at}`);
    // WHAT IT COULD NOT CHECK, and why that is not the same as "reference". A missing `STMB_start` reads
    // here as an entry STMB never wrote, which is always available — true of a reference sheet and false
    // of a MEMORY entry that lost the field. Richard's summaries were rewritten offline against an LLM and
    // no longer map to their original ranges, so 11 of its 37 memory entries are unverifiable and the
    // guard is silently inert on exactly them. **Measured** corpus-wide: 41 memory entries, carrying 456
    // of 6075 judged rows and 63 of 446 graded >= 3.
    //
    // REPORTED, NOT DROPPED. Dropping them is defensible and costs Richard 30 of its 37 positives, so it
    // is a corpus decision rather than one this function should take on its own.
    const unverified = Object.entries(S.books ?? {}).flatMap(([, bk]) => Object.values(bk ?? {}))
        .filter(e => isMemory(e) && !Number.isFinite(Number(e.STMB_start))).length;
    if (unverified) console.error(`  ${label}: ${unverified} MEMORY entr(ies) carry no STMB_start — availability unchecked, not verified as available`);
    return S;
};

/**
 * Groups book names into LINEAGES by shared entry bodies — the unit CLAUDE.md says to count, because a
 * book is versioned in place and two versions of one book are not two books.
 *
 * NAMES CANNOT DO THIS. An LTM file is named after the CHARACTER CARD, and a card carries many stories:
 * measured on the graded corpus, `LTM - Isekai Adventure - ...@14h45` is byte-identical to `LTM - Ascensus`
 * in all 145 entries and shares under 5% with Time Whore, which is the other story on that same card. So
 * the name says nothing about which corpus a book is, in either direction.
 *
 * IT MATTERS WHEREVER INDEPENDENCE DOES. A sign test over scenes treats each as a draw, and three files of
 * one book are one draw wearing three hats; a leave-one-book-out basis that leaves out only the FILE puts
 * two near-identical copies of a book into its own "everyone else", which is how an alignment of 0.83 came
 * back as 0.77 once the siblings left.
 *
 * 30% of the smaller book's bodies, the threshold CLAUDE.md records for 43 files collapsing to 34 lineages.
 * Transitive, so a chain of partial revisions lands in one group.
 *
 * THE GROUP TAKES THE MOST RECENTLY USED NAME, since that is the one the author is currently calling it and
 * the one that will match what they say. `recency` maps a book name to any comparable stamp — bundle
 * createdAt is what the callers have.
 *
 * TIES BREAK TO THE SHORTEST NAME, which matters because those stamps are day-granular and tie constantly:
 * `LTM - Ascensus` and `LTM - Isekai Adventure - Isekai Adventure - 2026-03-04@14h45` are the same 145
 * entries and were last written the same day. Version and card decoration only ever makes a name longer, so
 * shortest recovers the base name. Then by name, so the answer never depends on iteration order.
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

/**
 * How a scene-and-arm is named in output. Composed at the point of display from the document's `name` and
 * the arm's, rather than baked into either: the view returns both fields as the schema spells them, and a
 * label that looks like a field is how `name` came to mean two different things.
 */
export const sceneLabel = S => (S?.arm ? `${S.name ?? ''}--${S.arm}` : String(S?.name ?? ''));

/**
 * Key hits for one entry against a scan window — the same call `rankActivated` makes, so the excerpt
 * localises the match that was actually scored rather than a re-derivation of the match rules.
 *
 * Lives here beside `scoringKeys`, which decides what it is allowed to score. It used to live in the v1
 * migration tool, which was the only thing that needed it at the time and is now deleted.
 */
/**
 * The haystack composer for a scene: `(entry) => string[]`.
 *
 * THE DOCUMENT STORES INPUTS, NOT A WINDOW — the scan messages, the injects and the sources some entry
 * opted into, each on its own. Composing them here is the whole reason they are stored apart: a joined
 * blob is fixed at one depth, one matchWindow and one includeNames, and cannot be taken back apart.
 *
 * Per entry, because all three of the things that vary do so per entry: its own `scanDepth`, which
 * injects that depth reaches, and which card or persona fields its `matchXxx` flags pull in. Reading one
 * window for every entry — which this did until now — silently dropped all three.
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
 * A book's drift fingerprint: how many entries, and two hashes over the fields that feed the two things a
 * bundle's numbers rest on.
 *
 * TWO HASHES, NOT ONE, because the failure modes are different and a single number cannot say which layer
 * moved. `gaz` covers key/keysecondary/comment — what buildGazetteer reads, and therefore which query terms
 * survive the entity filter. `content` covers the bodies — what BM25 and the embeddings see. A key-only
 * edit moves the first and not the second; a prose edit does the reverse. The sommers defect was purely a
 * gazetteer-layer problem, and a lumped hash would have said only "something changed".
 *
 * A WEAK HASH ON PURPOSE. This detects drift, it does not authenticate: an edit that preserves every
 * hashed byte slips through, the same tradeoff content-lexical.mjs indexFingerprint already takes for the
 * same reason. Callers record `null` for a book with NO WORLD FILE — distinct from this function's answer
 * for a book that exists and is empty, which is a real hash of nothing.
 *
 * Entries are walked in uid order so the value is stable across however the object was built; fields are
 * joined with US and records with RS, which cannot collide with content the way a printable would.
 *
 * @param {Record<string, object>} book uid-keyed entries
 * @returns {{entries: number, gaz: number, content: number}}
 */
export const bookFingerprint = (book) => {
    const list = Object.values(book ?? {}).sort((a, b) => Number(a.uid) - Number(b.uid));
    const US = '', RS = '';
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
 *  MISSING IS EMPTY, not a throw: a grade row is identified by (world, uid) and `title` is a convenience
 *  the capture path happens to write — grade-pending's merge does not, so a judge-graded bundle threw
 *  here on the first row. An untitled grade is simply never excluded by title, which is correct: the
 *  exclusion names entries from a second attached book, and a row with no title matches no name. */
export const nrm = s => (String(s ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1);

export const dcg = (v, k) => v.slice(0, k).reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
/** Graded nDCG. The ideal is built from the RANKED vector, so a graded title that never gets ranked
 *  contributes to neither DCG nor the ideal — which is what makes an out-of-scope grade free. */
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
 * author-machine concepts, and a bundle that carries its books, `paramSnapshot.settings` and
 * `embedModel` needs neither: cachePath keys on (book, model, chunk settings), so it names the same file on
 * every machine and ensureIndex can fill it. That cache is the last resort rather than the first so no run
 * that resolves today resolves anywhere else — it is reached only when the two local paths are both absent.
 *
 * The returned path may not exist. Naming the rebuildable one in that case is what lets loadScene say which
 * file to build instead of scoring on an empty collection.
 *
 * PER BOOK, because a scene ranks every book the chat had attached and each has its own collection. Only
 * the primary's may come from `index` or the bundle's recorded `S.index` — both name ONE file, and handing
 * a second book the primary's collection would score it against another book's chunks.
 */
export const indexPath = (S, { vectors = 'data/default-user/vectors/ollama', model = 'bge-m3', index = null, all = false, book = S.primaryBook } = {}) => {
    const own = book === S.primaryBook;
    if (index && own) return index;
    // THE ALL-ENTRIES COLLECTION IS A DIFFERENT FILE, and stage 1 embeds everything now, so this is the
    // ordinary case rather than an arm's. The live collection and S.index below hold vectorized entries
    // only, so neither can answer for a scene scored with denseAllEntries on; go straight to the cache
    // reindex.mjs --all writes.
    if (all) return cachePath(S, chunkConfig(S), model, book, true);
    // THROUGH stInstall, NOT THE CWD. Both local candidates are recorded with ST's `data/` prefix, so testing
    // them raw asks whether the collection exists *relative to wherever the tool was launched from* — and the
    // answer changes with the directory while the scene does not. That is not hypothetical: the same sample
    // scored 10/10 judged from the ST root and 0/0 one directory down, and the second run reported it as a
    // result. stInstall returns null only on a machine with no ST install, where neither candidate can exist
    // anyway and the rebuild cache is the answer.
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
 * IT USED TO REFUSE TO CACHE, and the reason was right at the time: a stored vector goes on answering
 * after the embedding model underneath it changes. What makes it safe is the LABEL being in the key.
 * `resolveModel`'s label is what names a collection too, so a different quantization, a different server
 * serving the same weights, or a doc prefix appearing are all a different cache rather than a stale hit —
 * the same identity rule the index cache already relies on.
 *
 * KEYED ON THE TEXT AS SENT, prefix included, under SHA-256. The query prefix is part of what was
 * embedded, so it has to be part of what is keyed; and a weak hash risks handing back another query's
 * vector, which is the kind of wrong number nothing downstream could catch.
 *
 * APPENDED, one JSONL line per call, per the harness rule: retraining re-embeds the same 105 scene
 * queries every run, and a killed run keeps every embed it already paid for. Lives in eval-data, which is
 * gitignored — it is a cache, and it rebuilds from the bundles.
 */
const qCache = new Map();
/** The cache file for one model label. RAW, as cachePath writes the model half of a collection path:
 *  only a BOOK is slugged there, because book names are arbitrary user text while a label is not — and
 *  slugging a label is what would make two of them collide, which is the ambiguity a hash would then have
 *  to undo. `pathSafe` is not that slug: it folds the slash of a HuggingFace repo id and nothing else, so
 *  no label that already names a file on disk changes. Exported so a test cannot re-derive the name and
 *  drift from it. */
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
export const embed = async (text, { ollama = 'http://localhost:11434', model = 'bge-m3', endpoint = 'ollama', url = ollama, label = model, cache = true } = {}) => {
    if (!cache) return (await embedTexts([text], { model, endpoint, url }))[0];
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
 * The defaults are one tuned chat's snapshot, NOT the shipped defaults (extension/state.mjs ships K1 1.2,
 * LEXW 1) — an arm overrides them via its own `params`, which is the point of putting them in the
 * manifest: each graded scene carries the settings it was graded under. `overrides` on top is how an arm
 * asks "what would this scene look like at these parameters instead".
 */
export const sceneParams = (S, overrides = {}) => ({
    // KEYW null mirrors LEXW, exactly as the extension does — so a sample captured before the split scores
    // identically, and an arm that sets KEYW is testing the split rather than a silent default change.
    K: 20, K1: 2, B: 0.75, LEXW: 1.5, KEYW: null, boost: 3, stopwordDf: 0.25,
    // null = whatever the shipped memory fit carries. Set only by a cutoff arm; see scoreScene `admits`.
    memoryCutoff: null,
    caseSensitive: false, wholeWords: false, includeNames: true,
    // How the haystack is SEGMENTED, which decides what `scan` means to countKey. Captured in `params`
    // (worldsapart.js captureParams), so a document that records it overrides this; 'scan' is what
    // `matcher.scanWindow` hardcoded when the window here was chat-only and one segment.
    matchWindow: 'scan',
    // What counts as INSIDE a word when wholeWords is on (state.mjs wordBoundary, shipped 'strict').
    // Unlike the knobs above this one is module state in the matcher, so makeKeywordScore pushes it
    // through setBoundaryMode per call — otherwise every arm scores at whatever the last one set.
    // A sample captured before the setting existed ran under a class that is NEITHER mode (no hyphen
    // or apostrophe, but `_` a word character), so it cannot reproduce byte-identically; it is read
    // at the shipped default, which is what its numbers mean today.
    wordBoundary: 'strict',
    // Occurrences -> score (matcher.mjs repeatCurveOf). 'bm25' here, NOT the shipped 'presence-log',
    // for the same reason: every sample captured before the setting existed must
    // reproduce byte-identically, and those all ran under bm25. New captures record their own curve in
    // `params`, which is spread over these defaults, so this fallback only ever reaches old ones.
    repeatCurve: 'bm25', repeatR: 1,
    // Whether the cosine subtracts the corpus mean (state.mjs meanCentered, shipped on). An arm here contrasts
    // the CENTERED and RAW rankings on graded scenes; centering-grid.mjs measures the same switch on the
    // leave-one-out chunk-to-sibling task, which is a different question and can disagree without either
    // being wrong. Captures taken before `params` recorded it fall back to this default, which is the
    // value they in fact ran under.
    meanCentered: true,
    // DENSE FOR EVERY ENTRY — a cosine for the entries the vector collection has no row for, which is the
    // signal keyword-only entries lack. Needs an index built with reindex.mjs --all (every entry with
    // content, the same population content-lexical.mjs indexes) and reads its two halves at different
    // stages: the vectorized chunks stay stage 1's collection and the corpus mean, so retrieval, admission
    // and every baseline cosine are unchanged, and the rest are scored at stage 3 against that same mean so
    // the two classes share a scale. Nothing here activates — an entry no key fired for gets no row.
    //
    // IT IS PRODUCTION NOW, not an arm, which is why it defaults ON. `scoreEntriesUnsafe` embeds and
    // scores every entry with content while force-activating only the vectorized ones, and the plugin
    // centroids on the vectorized uids the client names — the same split this models. Off, a harness run
    // scores the pipeline as it was before that, which is the one setting here that reports the old
    // architecture as a result.
    //
    // It still needs an `--all` index (`node eval/reindex.mjs <sample.json> --all`), and loadScene
    // throws rather than quietly scoring the ordinary collection if one is missing.
    denseAllEntries: true,
    // WHERE THAT COSINE IS FUSED, and it decides which question is being asked.
    //
    // null puts it in the entry's own `score`: the entry becomes vector-eligible, is normalised by the
    // vector weight, and loses the keyword-only tilt. That is what "vectorize this entry" would do in
    // production, and it is a change to three things at once.
    //
    // A population name instead puts it in fuseRanks's FOURTH COLUMN at denseWeight — the column the
    // learned-sparse scores were measured through. Same weight, same eligibility rule, `score` and the tilt
    // untouched, so dense and sparse measured this way differ in the NUMBER THE COLUMN HOLDS and nothing
    // else. That is the only form in which the two are comparable; the null form and the sparse arms differ
    // in enough places that their gap is unattributable.
    //
    //   'nocos'  entries with no cosine of their own — the arm the sparse head won on
    //   'all'    every ranked entry, a vectorized one's own cosine duplicated into the column
    //   'cos'    only entries that already have one, which for dense IS that duplication
    //
    // 'all' and 'cos' are degenerate for dense in a way they were not for sparse: sparse was a second
    // opinion from a different head, while duplicating the vector column is the same number twice and can
    // only reweight the vector signal. They are run as controls, not as candidates.
    // WHICH ENTRIES DEFINE THE CORPUS MEAN — the vector centering subtracts (plugin/vector.mjs). Production
    // names the vectorized uids (worldsapart.js centroidUids) and the plugin means over those, so
    // 'vectorized' is what every stored capture ran under and stays the default.
    //
    //   'vectorized'      production: enabled + vectorized. Neither "the book" nor "what gets compared" —
    //                     a frozen snapshot of the comparison set from before every entry became scorable.
    //   'memory'          enabled memory-tier entries. Register-homogeneous, which is what makes a centroid
    //                     mean anything: a blend of narrative summaries and encyclopedic reference removes
    //                     neither cluster's shared direction and leaves each tilted toward the other.
    //   'memoryArchived'  the above plus DISABLED memory entries, which requires an index built with
    //                     reindex.mjs --archived. Treats the centroid as a property of the BOOK rather than
    //                     of the current playthrough, so archiving an arc stops moving every other cosine.
    //
    // The two are one step apart and worth running separately: dropping `vectorized` moves only books whose
    // memory entries are not all flagged, while adding archived mass moves whatever the author retired.
    // 'memory' IS PRODUCTION (worldsapart.js centroidUids), so it defaults on for the same reason
    // denseAllEntries does: a harness run at 'vectorized' scores the pipeline as it was before that change,
    // which is an arm rather than a baseline. No stored capture records this field, and the populations
    // measured at cosine 0.99873-1.00000 of each other, so no recorded number is invalidated by the switch.
    centroidPopulation: 'memory',
    // HOW MANY LEADING COMPONENTS OF THE CENTRED CORPUS ARE PROJECTED OUT, on top of the mean. 0 is
    // production: mean-centering only.
    //
    // The mean is one direction, and measured across 10 books only 8-16% of it is the book's own — the
    // rest is shared with every other book (metrics.mjs topComponents). So the operation meant to make
    // "magic is unremarkable in a fantasy book" cheap spends most of its effect on something no book is
    // distinguished by, and least of it on the long memory books that most need it. What is unremarkable
    // in a book is plausibly several directions, which one vector cannot carry; this removes k of them.
    //
    // SCREENED ON THE LOO CHUNK-TO-SIBLING TASK AND NOT PROMISING THERE: helps in proportion to a book's
    // own-direction share (Spearman 0.94, n=6) and so helps small thematic reference books while going
    // slightly negative on the long narrative ones. That task cannot answer the question, though — it has
    // no selection stage, so every metric it emits is read at a window nobody chooses. This param is what
    // asks it against the delivered set instead.
    pcRemove: 0,
    // WHITENING: how many of the book's own directions to RESCALE, and by how much.
    //
    // The argument, and it is the one thing in this family that is not a translation: centering moves the
    // cloud and provably leaves its geometry intact — **measured**, per-book centring takes 1-NN
    // same-book purity from 99.4% to 98.2%, so book identity survives it entirely. A direction the book
    // SPREADS OUT along is not discriminating within that book, so it should count less rather than be
    // shifted. whitenAlpha 0 is production (nothing rescaled); 1 flattens the top `whitenR` directions to
    // the scale of the smallest retained one; the interior is the tunable version of what pcRemove does
    // discontinuously, since removal is this at weight 0.
    //
    // SCALED RELATIVE TO THE r-TH RETAINED DIRECTION, so the transform is continuous at the boundary — the
    // last kept component is unchanged and the untouched tail below it needs no adjustment. Scaling by an
    // absolute sigma instead would put a step between component r and component r+1.
    whitenR: 0,
    whitenAlpha: 1,
    // THE TOKEN CEILING stage 5 walks the layout under. 0 leaves the budget unmodelled, which is what every
    // measurement before this one did — @cut is stage 4's FIRST decision and three more follow it.
    //
    // WHAT THIS CANNOT MODEL, stated because the gap is in the captures rather than the code. Constants and
    // armed stickies are hoisted ahead of the dynamic block and spend the budget first (selection.mjs
    // walkOrder), and no capture records them: every candidate row in this corpus is `block: dynamic`. So
    // the dynamic block is given MORE room here than production would give it, by whatever the constants
    // cost. maxTotalEntries and the per-book cap are not recorded either and come from the caller.
    //
    // The ceiling itself is not a property of the scene — it is a user's cost decision — so it is passed in
    // rather than read off the bundle, and the 52 of 107 bundles that do record one write it as a display
    // string ("40%* = 29036") rather than a number.
    budgetTokens: 0,
    // HOW MANY SHARED COMPONENTS COME OFF FIRST (global-basis.mjs). 0 is production: no first stage.
    //
    // WITHOUT IT pcRemove DOES NOT TEST WHAT IT CLAIMS. A book's leading component is not its own —
    // **measured**, memory-tier PC1 sits 0.55-0.77 inside a subspace built from other lineages' memory
    // chunks, and the book mean carries only 8-16% of its mass orthogonal to the shared direction on the
    // long narrative books. So single-stage pcRemove takes mostly common structure, which is what its
    // negative F2 says. Strip the shared mean and its top m directions first, and whatever leads the
    // residual is the book's own by construction.
    //
    // The basis is per book, leave-one-LINEAGE-out, memory tier only; build it with
    // `node eval/global-basis.mjs <samples...>`.
    sharedComponents: 0,
    denseColumn: null,
    denseWeight: 0.5,
    maxVectorEntries: 20, entityFilter: true,
    // WHICH FIELDS THE GAZETTEER READS. Production is 'keys+titles' (buildGazetteer's own sources), chosen on
    // a 5-target gold set that no longer exists; 'bodies' was re-measured at n=3 scenes and lost. This param
    // exists so the choice can be re-run paired at the current scene count instead of re-argued.
    //   'keys+titles'  shipped
    //   'keys'         key/keysecondary only — the header claims this scores identically to shipped
    //   'titles'       comment only, which is what a mostly-vectorized book already reduces to
    //   'bodies'       shipped plus every entry's content
    //   'none'         empty gazetteer: the proper-noun boost alone
    gazetteerSource: 'keys+titles',
    // HOW STAGE A PICKS ITS COMPONENTS, which is a separate question from how they were estimated.
    //   'rank'    the first N by explained variance — what a PCA hands back, and the default so every
    //             stored measurement reproduces.
    //   'shared'  the N with the LOWEST eta^2, the between-lineage share of their projection's variance
    //             (global-basis.mjs). Stage A's job is to remove what the books SHARE, and variance rank
    //             is not sharedness rank: **measured** on this corpus the two disagree at the very top —
    //             PC1 scores 0.82-0.86 in four of the five bases against PC2's 0.005-0.049, so 'rank'
    //             removes the most book-specific direction available first. Needs a basis carrying `eta`.
    sharedSelect: 'rank',
    // WHICH SCATTER stage A's directions come off. 'pooled' is PCA on the raw corpus — what a basis has
    // always been. 'within' takes them off the pooled WITHIN-book scatter, so a direction that only
    // separates books cannot lead; see global-basis.mjs for the measurement and for why this is not LDA.
    // Reads a basis built with --within, which is a separate file.
    sharedScatter: 'pooled',
    // Exact key strings to treat as removed from the book (see scoringKeys). Null = none.
    dropKeys: null,
    // NO queryMode. The summarized-query mode is gone from production (measured: F2 over the delivered
    // set -0.021, n=106 scenes paired), and with it the only thing that read it here. Stored bundles
    // still carry the field; it is read and ignored, like `threshold`.
    // PER-BOOK QUOTA for stage 5 (applyBudget capOf), as {book: cap}. Null = no cap, which is what every
    // capture in the corpus ran under — the live setting lives on the world priority list and no bundle
    // records it, so this is an arm's knob rather than a replayed value.
    bookCaps: null,
    // NO ADMISSION PARAMS. `admit`, `bm25Floor`, `bm25FloorPct` and `threshold` are gone with the gates
    // they simulated — stage 1 now scores by cosine and returns everything (plugin/scoring.mjs). Bundles
    // captured before that carry `threshold` in `params`; it is READ AND IGNORED rather than rejected,
    // because every stored sample has one and refusing them would retire the whole graded corpus.
    ...(S.params ?? {}), ...overrides,
});

/**
 * Loads a sample into everything needed to score it.
 *
 * EVERY ATTACHED BOOK, one ranking. Production pools them: `scoreEntriesUnsafe` syncs a collection per
 * world and the plugin's /query-multi scores them all, each against its OWN centroid, before one top-K
 * across the lot. Loading only `primaryBook` made cross-book competition and `applyBudget`'s per-book cap
 * unmeasurable, and discarded every graded row from a second book — 336 of them across 12 cells here.
 *
 * PER-BOOK CENTROIDS, POOLED COSINES, deliberately: it is what production does, and the harness models
 * the pipeline rather than an argument about it. It does mean two books' cosines come from different
 * corpus means and are compared anyway. Nothing here is evidence either way; a divergence would have to be
 * measured before it could be justified.
 *
 * A ROW'S IDENTITY IS (book, uid), never uid: uids are per book and number from 0, so two books collide on
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
    // THE BOOKS MUST BE THE ONES THIS BUNDLE WAS DERIVED FROM. generatedFrom.attached records a fingerprint
    // per book at derivation time (synth-scenes, bookFingerprint), so an edit to an embedded copy afterwards
    // is detectable — and it has to be, because the gazetteer is built from these books and a silently
    // narrower vocabulary is what this record exists to catch. SELF-CONTAINED on purpose: it compares the
    // bundle against itself, so it holds on a machine with no ST install and no matching worlds. Comparing
    // against the LIVE world file answers a different and useful question ("has the book moved on since?"),
    // but it is not portable and is therefore nobody's precondition for scoring.
    //
    // Legacy bundles carry no `attached` and are skipped rather than rejected: absence is "derived before
    // this was recorded", which says nothing about whether they drifted.
    //
    // ONCE PER SAMPLE: dropUnavailable mutates the books in place, and a sweep calls loadScene repeatedly
    // on the SAME object, so re-checking would compare a stripped book against the pristine fingerprint.
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
    // AFTER the fingerprint guard — which asks whether these are the books the bundle was derived from, a
    // question about the PRISTINE bundle — and BEFORE `entries`, `byKey`, the gazetteer and POOL are built
    // from them.
    if (!S.availabilityFiltered) { dropUnavailable(S, S.name ?? 'sample'); S.availabilityFiltered = true; }
    // EVERY EMBEDDED BOOK, primary first. `Object.keys` is insertion order and a bundle does not promise
    // its primary is first, so it is hoisted: `loaded[0]` and `items` are the primary's, which is what the
    // callers' diagnostics read.
    const books = [primary, ...Object.keys(S.books).filter(b => b !== primary)];
    // STAMPED, because `world` is what identifies an entry across books and 1295 of the corpus's embedded
    // entries carry none — a bundle copies whatever the world file held, and the field is optional there.
    // entryKey, the content index, the name df and applyBudget's per-book cap all read it. Idempotent, and
    // `??=` rather than `=` because a copy that HAS a world is the authority: measured over all 107
    // bundles, none disagrees with the key it sits under.
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
        // A KEYWORD-ONLY BOOK HAS NO COLLECTION, and that is a configuration rather than a failure: indexing
        // gates on `vectorized` (reindex.mjs buildItems), so a book with no vectorized entry yields no items
        // and ensureIndex refuses to build one. Foxbridge is exactly that — 38 hand-keyed reference entries,
        // 0 vectorized — and until this branch existed its two clean captures could not be scored at all,
        // while the 8 that could embedded a reverted, partly-vectorized copy of the same book. Retrieval then
        // contributes nothing, every entry arrives by the keyword route, and the scene is deterministic: no
        // index, no embedding call, no ollama. corpusMean is the only thing that cannot take an empty list,
        // and it is guarded here rather than in plugin/ so this needs no redeploy.
        // AVAILABILITY IS ENFORCED HERE, NOT IN THE COLLECTION. The index is built from the pristine book
        // (reindex.mjs ensureIndex), so it may carry chunks of entries this scene post-dates; the book is the
        // filtered view, and dropping what it does not hold is the whole enforcement. Doing it this way is what
        // lets one cached collection serve every scene of a book without any of them seeing another's cutoff.
        const rawAll = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')).items : [];
        const raw = rawAll.filter(it => uids.has(Number(it.metadata?.index)));
        // DENSE-ALL SPLITS THE COLLECTION BY STAGE. An --all index (reindex.mjs) holds every entry's chunks; the
        // vectorized ones are item-for-item what the ordinary build produces, so keeping them as `items` leaves
        // stage 1 — admission, the top-K, the corpus mean, every baseline cosine — byte-identical to a run
        // against the ordinary index. The rest go to `extra`, scored at stage 3 only.
        // CENTROID-ONLY CHUNKS ARE NOT A COLLECTION. An --archived index (reindex.mjs) carries disabled memory
        // entries so they can weigh in the mean; they must reach neither `items` nor `extra`, because an entry
        // the author disabled is one core would never activate and one no ST install stores a vector for.
        const archived = raw.filter(it => it.metadata?.centroidOnly);
        const live = raw.filter(it => !it.metadata?.centroidOnly);
        const vectorUids = new Set(own.filter(e => e.vectorized).map(e => Number(e.uid)));
        const ofVectorized = it => vectorUids.has(Number(it.metadata?.index));
        const items = P.denseAllEntries ? live.filter(ofVectorized) : live;
        const extra = P.denseAllEntries ? live.filter(it => !ofVectorized(it)) : [];
        // An ordinary index under this param would score every entry at its production value and report the arm
        // as flat, which is the one failure that looks like a result. A book whose every entry is vectorized
        // legitimately has no extras, so the demand is on the BOOK rather than on the file.
        if (P.denseAllEntries && !extra.length && own.some(e => !e.vectorized && !e.disable && e.content)) throw new Error(`denseAllEntries is on but ${indexFile} holds no non-vectorized chunks for "${book}" — build that collection with: node eval/reindex.mjs <sample.json> --all --book ${JSON.stringify(book)}`);
        // A column population that includes the extras has nothing to put in the column without them, and would
        // report as a weight change on the vectorized half alone.
        if (!P.denseAllEntries && (P.denseColumn === 'nocos' || P.denseColumn === 'all')) throw new Error(`denseColumn '${P.denseColumn}' scores entries the ordinary collection has no vectors for — set denseAllEntries too`);
        // AN EMPTY COLLECTION IS ONLY LEGITIMATE WHEN THE BOOK HAS NOTHING TO INDEX. Same gate reindex.mjs
        // buildItems applies, so the two agree on what "nothing to index" means. Without this the two cases are
        // indistinguishable at runtime: a missing collection scores keyword-and-BM25-only and returns a
        // plausible number rather than an error, which is what a bundle opened on a machine that never held the
        // author's vectors does. Measured on this corpus: the same scene read 10/10 judged with the index and
        // 0/0 without, and only the second one looked like a result.
        if (!items.length && own.some(e => e.vectorized && !e.disable && e.content)) {
            throw new Error(`no vector collection for "${book}" at ${indexFile} — the book has vectorized entries, so scoring without one would silently drop cosine. Build it with: node eval/reindex.mjs <sample.json> --book ${JSON.stringify(book)}`);
        }
        // The mean is PRODUCTION'S by default — the vectorized corpus's centroid — so a dense-all entry is
        // centered by the same vector its competitors are. centroidPopulation is the arm that changes it.
        // A book with nothing vectorized has no production centroid, and there the arm's own corpus is the only
        // one there is; that book has no baseline cosine to preserve anyway.
        const memoryUids = new Set(own.filter(isMemory).map(e => Number(e.uid)));
        const ofMemory = it => memoryUids.has(Number(it.metadata?.index));
        // An ordinary or --all index under 'memoryArchived' has no archived mass to add, so it would score the
        // 'memory' population and report it as this arm — the one failure that looks like a result.
        //
        // ASKED OF THE BOOK, NOT THE INDEX ALONE. A book with nothing retired legitimately has no archived
        // chunks, and it is the most valuable scene in the arm rather than a misconfiguration: its delta MUST
        // come back exactly 0, which is the only check that the arm is wired to what it claims. Throwing on it
        // would remove the control and leave only scenes that cannot disconfirm anything.
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
        // A ZERO-LENGTH MEAN IS NOT A CENTROID. centeredCosineScores dimensions its work off mean.length, so an
        // empty one returns all-zero scores for every chunk rather than throwing — a whole book scored at cosine
        // 0, which is the failure that looks like a result rather than an error.
        //
        // FALLING BACK TO THE WHOLE COLLECTION IS WHAT PRODUCTION DOES, not a harness convenience: the client
        // names uids and the plugin means over them, and `centroidFor` (plugin/server.js) returns the full
        // corpus mean for an absent or empty list. So a reference-only book — no memory entries to name — is
        // centered on everything it has, in the runtime and here alike. Diverging would make this harness score
        // a pipeline nobody runs.
        const emptySelection = !meanSource.length && live.length;
        if (emptySelection) meanSource = live;
        // No `lexical`: scoreCollection is cosine-only, and stage 3's text index is content-lexical's.
        const loaded = { book, items, extra, mean: meanSource.length ? corpusMean(meanSource) : [] };

        // PROJECTING THE COMPONENTS OUT AT LOAD, not at scoring, because they are a property of the corpus and
        // recomputing them per query would be the same vectors and the same answer at N times the cost. The
        // vectors are transformed and the mean becomes zero, so the shipped centeredCosineScores still does the
        // arithmetic — subtracting a zero mean from an already-centred vector. The QUERY has to take the same
        // transform at each call site or the two sides are compared in different spaces.
        //
        // COMPONENTS OF THE CENTROID POPULATION, the same rows that define the mean. Taking them over a wider
        // set would remove directions the mean was never built from.
        // TWO STAGES, SHARED THEN OWN, and every centring moves into them once either is on — loaded.mean
        // becomes zero and the shipped centeredCosineScores subtracts it, so there is exactly one place that
        // decides what comes off. Stage B's mean is the book's centroid OF THE RESIDUAL, which is what the
        // book-specific direction is once the shared part is gone; with sharedComponents off it is the ordinary
        // centroid and the arm reduces to single-stage.
        if (P.sharedComponents > 0 || P.pcRemove > 0 || P.whitenR > 0) {
            if (!P.meanCentered) throw new Error('sharedComponents/pcRemove need meanCentered: both are defined as what comes off BEFORE the cosine, and uncentered scoring subtracts nothing');
            const stages = [];
            // STAGE A IS THE MEMORY REGISTER, so it comes off MEMORY CHUNKS AND NOTHING ELSE. Reference and
            // memory are parallel processes: the register is one direction across all memories on disk
            // (global-basis.mjs memoryChunks), and a reference sheet is not in the population it was
            // estimated over. Subtracting it from every chunk of the book applied a correction fitted on
            // one process to the other — 46 of Sommers' 327 entries, and the whole of a reference-only
            // book. The build side has always been memory-only; this is the apply side agreeing with it.
            //
            // A BOOK WITH NO MEMORIES HAS NOTHING FOR STAGE A TO ACT ON, so it needs no basis at all. That
            // is not a special case for a second book: it falls out of the tier gate, and it is why
            // `grounded omegaverse` (17 entries, 0 memory) does not need one built for the sommers scenes.
            const hasMemory = live.some(ofMemory);
            if (P.sharedComponents > 0 && hasMemory) {
                // Stage B's mean has to be taken over chunks in the SAME transform state, or it averages
                // projected memory vectors with unprojected reference ones. 'memory' and 'memoryArchived'
                // are exactly the gated set; 'vectorized' is not.
                if (P.centroidPopulation === 'vectorized') throw new Error(`sharedComponents with centroidPopulation 'vectorized' would average stage-A-projected memory chunks with unprojected reference ones in one centroid — use 'memory' or 'memoryArchived'`);
                if (P.sharedScatter !== 'pooled' && P.sharedScatter !== 'within') throw new Error(`unknown sharedScatter "${P.sharedScatter}" — one of pooled, within`);
                const within = P.sharedScatter === 'within';
                const basis = loadBasis(book, resolveModel(P.embedModel ?? S.embedModel ?? 'bge-m3').label, within);
                if (!basis) throw new Error(`sharedComponents needs a${within ? ' --within' : ''} basis for "${book}" — build it with: node eval/global-basis.mjs <samples...>${within ? ' --within' : ''}`);
                if (basis.comps.length < P.sharedComponents) throw new Error(`sharedComponents ${P.sharedComponents} but "${book}"'s basis holds ${basis.comps.length} components — rebuild with --m ${P.sharedComponents} --force`);
                // SELECTION IS NOT ESTIMATION. The components arrive in variance order; sharedness is a
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

    // ONE EMBEDDING MODEL ACROSS EVERY BOOK, or the pooled top-K orders cosines taken in two different
    // spaces — a ranking that looks entirely normal and means nothing. NOT ASSERTED HERE, deliberately:
    // the primary's path arrives already resolved (an --index, an ensureIndex build) and `label` may
    // differ from `model` for a prefixed family (reindex.mjs modelSpec), so nothing this file can read off
    // that path distinguishes a mismatch from a naming convention. What prevents it is that every caller
    // threads the SAME `MODEL` it resolved the primary with into indexOpts; a caller passing neither gets
    // the bundle's own `embedModel` for every book, which is consistent by construction. It is worth
    // saying out loud now that the install has moved off bge-m3 while all 107 stored bundles record it.
    // The primary's path is the caller's — an explicit --index, an ensureIndex build, or indexPath's own
    // resolution. Every other book resolves its own, because there is one indexFile and N collections.
    // ponytail: a chunk arm's rebuild reaches the primary only (its `index` is one ensureIndex build and
    // cachePath keys the others off the SCENE's chunkConfig), so a chunkSize sweep re-chunks one book of
    // two. Thread the arm's overrides through indexOpts if a chunk finding ever turns on a second book.
    // `embedModel` is a SPEC (it may carry a server stem); what names a collection is the LABEL, so it is
    // resolved rather than used raw. indexOpts.model is already a label — the caller resolved it.
    const modelLabel = indexOpts.model ?? resolveModel(S.embedModel ?? 'bge-m3').label;
    const loaded = books.map(b => loadBook(b, b === primary
        ? indexFile
        : indexPath(S, { ...indexOpts, model: modelLabel, book: b, all: P.denseAllEntries })));
    const items = loaded[0].items;

    // OUT OF SCOPE IS A BOOK THAT IS NOT HERE, and nothing else. A graded row can only be ranked if its
    // book was embedded; every embedded one now is. This replaces `excludeTitles`, a capture-time list of
    // titles from a non-primary book — that predicate was "not the primary book", which stopped being the
    // scope boundary the moment every book got loaded, and went from correct to WRONG rather than merely
    // stale: a reader honouring it would discard valid verdicts about a second book that is right here.
    // The field is gone from the writer (grading.mjs) and from every stored bundle; a copy from elsewhere
    // that still carries one is simply not read.
    // A row with no `book` is the primary's, which is what every reader here has always assumed.
    const outOfScope = r => !S.books[r?.book ?? primary];

    // THE AUTHORED VOCABULARY, which is what production builds from: queryTermWeights restores the
    // takeover's stash into a local view before calling buildGazetteer, so the gazetteer does not depend
    // on when in the scan it is asked. Offline the authored keys ARE e.key, since samples embed the book
    // raw — so the raw book is the faithful model and no blanking is applied here.
    //
    // The gazetteer spans every book the live chat had attached, as production's does: `entries` is now
    // that whole set, so the union it used to be assembled from is the list itself.
    const gazSource = entries;
    const gazEntries = gazSource;
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
    const gaz = ranking.buildGazetteer(gazEntries.flatMap(e => pick(e)));

    // THE POOL IS WHAT WAS JUDGED, and ONLY that — see graded-scene-grid.mjs. OWN is this capture's own
    // non-durable rows, kept separately so coverage warnings stay about re-derivation failing rather than
    // about sibling arms legitimately disagreeing.
    //
    // OWN USED TO BE UNIONED INTO THE POOL, which was a shorthand for "a capture logs exactly the rows the
    // grader was shown" — true while every logged row got a verdict, and false the moment a sample records a
    // population wider than the graded set. A re-derived bundle logging 144 rows against 47 grades then
    // reported judged@10 of 100% on a scene that was 18% judged, so the stopping rule said "pool is
    // adequate" precisely where it was not. An ungraded row is unjudged no matter who logged it.
    //
    // KEYED BY (book, uid), which is the only identity that survives a second book: uids are per book and
    // number from 0, so a bare-uid pool silently declares one book's row judged on the strength of the
    // other's grade.
    const OWN = new Set((S.candidates ?? []).filter(c => !isDurable(c) && !outOfScope(c)).map(c => entryKey({ world: c.book ?? primary, uid: c.uid })));
    const POOL = new Set((S.entries ?? [])
        .filter(g => Number.isFinite(Number(g.uid)) && !outOfScope(g))
        .map(g => entryKey({ world: g.book ?? primary, uid: g.uid })));

    return { primary, books, entries, byKey, items, loaded, gaz, gazSource, outOfScope, POOL, OWN, embedModel: S.embedModel ?? 'bge-m3', modelLabel, chunkCfg: chunkConfig(S) };
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
 * entry as a miss. Out-of-scope rows also return null: the harness has no usable verdict for them.
 *
 * BY (book, uid), not by uid — the scene ranks every attached book and uids number from 0 in each, so a
 * bare-uid map hands one book's row the other's grade. Rows carry their book on `book` (grades,
 * candidates) or on `entry.world` (scored rows); both resolve through content-lexical's `entryKey`.
 *
 * Callers that need a number say so. For nDCG that is `?? 0`, which is the standard partial-label
 * rule and is now written where it applies rather than assumed everywhere.
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
// the harness's callers keep one import. Two definitions of "is this a memory entry" is how the runtime
// and the fit would end up scoring different populations.
// Imported AND re-exported: a bare `export ... from` forwards the name without binding it in this
// module, and scene.mjs calls isMemory itself (tierRecall, the STMB_start audit).
import { isMemory, buildNameDf, properNames, properShared, properDensity, scoreRelevance, modelKey, postDates } from '../extension/relevance.mjs';
export { isMemory };
export const isReference = e => !isMemory(e);
export const isDurableEntry = e => Boolean(e?.constant);

/**
 * Recall split by TIER, over one selection's kept set.
 *
 * WHY IT IS STANDING RATHER THAN AD HOC. `memory` and `reference` have very different base rates — 7%
 * against 30% on this corpus — so a rule that favours the denser class raises every pooled metric while
 * delivering less of what the system exists to retrieve. Measured on a threshold that looked like a clean
 * win at 69% less material for 29% less relevance: it kept 93% of relevant reference rows and 56% of
 * relevant memory ones. F2, precision, recall, nDCG and calibration were all blind to it, because a class
 * prior that tracks base rates genuinely predicts. Only the split shows it.
 *
 * Identity comparison, not uid: `kept` holds the same row objects the population does (fuse sorts a copy
 * of the same references), so a uid join would be a second way to say the same thing and a place to drift.
 *
 * NO SCORING CALLER: nothing in this module splits a kept set, so it is exercised only by
 * paired-check.mjs. Stage 4's relevance cut now produces such a set at runtime, which is what this was
 * kept for.
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

/** Keys the production scan would actually score — every entry's, a vectorized one included, as
 *  worldsapart.js `scoreKeysOf` does. The value is measured and recorded; whether the model reads it is
 *  a question about the FEATURE SET, which `--without keys` answers.
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

/** The query under the same transform ONE BOOK'S collection took (loadScene pcRemove), or unchanged when
 *  none. Per book: each takes its own basis and its own centroid, so a query transformed by another book's
 *  stages is compared in the wrong space.
 *  Applied at every call site rather than once by the caller, because a query that reached only one of the
 *  two scoring paths would leave the dense-all extras compared in a different space from the collection. */
export const pcQuery = (loaded, qvec) => (loaded?.pc
    ? loaded.pc.stages.reduce((v, st) => projectOut(v, st.mean, st.comps, st.weights ?? null), qvec)
    : qvec);

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
 * SPANS THREE STAGES, and they are marked below because collapsing them is how this harness has produced
 * wrong numbers twice. Production keeps them apart by construction: retrieval runs in selectAndActivate on
 * one event and scoring in rankActivated on another. Offline there is no event loop, so they collapse into
 * one pass — which is a reason to label the boundaries, not to forget they exist.
 *
 * Stage 2 genuinely depends on a stage-3 computation: `keywordScore > 0` is what decides keyword
 * activation. Core has the same dependency — matching serves both — so this is faithful, not a shortcut.
 *
 * `topK` defaults to stage 1's own bound, and pooling happens before the cut here as it does in the
 * plugin, so K counts ENTRIES. It is not a function of any stage-5 cap: admission depth and how many
 * entries may reach the prompt are separate questions. Pass it only to probe window sensitivity.
 *
 * @returns {(k1: number, b: number, tw: object|null, qvec: number[], qtext: string, haystackFor: (entry: object) => string[]) => object[]}
 */
export function makeCandidateSet({ loaded, byKey, entries, params: P, chunkCfg, topK = admitCeiling(true) }) {
    const keywordScore = makeKeywordScore(P);
    // CONTENT-LEXICAL, the stage-3 text signal for every entry — built once here because it depends only
    // on the book and the chunk settings, not on the query. The runtime builds it per book at the same
    // point in the pipeline (worldsapart.js contentTextScores); a second copy of the pooling or the
    // chunking rule would be the drift the single-scorer rule exists to prevent, so both go through
    // content-lexical.mjs.
    //
    // ONE INDEX PER BOOK, because that is what `bookIndexes` keys and caches. Pooling the books into one
    // index would pool their IDF, so a term common in one book would read as rare in the other's entries —
    // a lexical signal this harness computed and production never does.
    const cfg = chunkCfg ?? { chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120 };
    const byBook = new Map();
    for (const e of entries) { const b = e.world; if (!byBook.has(b)) byBook.set(b, []); byBook.get(b).push(e); }
    const contentIndexes = [...byBook].map(([, own]) => buildContentIndex(own, cfg));
    const hasContent = e => Boolean(String(e?.content ?? '').trim());
    // DENSE-ALL, the stage-3 cosine for entries the collection has no row for (loadScene splits them out).
    // Pooled by MAX per entry, the same rule poolEntries applies to the vectorized half, and against the
    // BOOK'S OWN mean so both classes are centered by the same vector. Filled onto the keyword route below,
    // so it re-ranks entries a key already activated and admits nothing — the dense twin of content-lexical.
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
    // Which rows carry the dense cosine in the fourth column rather than in `score` (see denseColumn).
    const colExtras = P.denseColumn === 'nocos' || P.denseColumn === 'all';
    const colVectorized = P.denseColumn === 'cos' || P.denseColumn === 'all';
    // A HAYSTACK IS PER ENTRY, so the caller hands over the composer rather than one built window. It
    // resolves the entry's own scanDepth, admits the injects that depth reaches, and appends the sources
    // the entry opted into — which is what the runtime does. The document stores those inputs separately
    // precisely so a reader COMPOSES the window rather than taking a joined one apart.
    return (k1, b, tw, qvec, qtext, haystackFor) => {
        const dense = denseExtra(qvec);
        // --- STAGE 1: RETRIEVAL. Cosine over every chunk, no admission test — plugin/scoring.mjs carries
        // why the threshold and the lexical clause left this stage. `contentText` is stage 3's text signal
        // and is computed here only because this pass collapses the stages; it admits nothing.
        //
        // ONE TOP-K ACROSS EVERY BOOK, each scored against its own centroid — the plugin's /query-multi
        // loop exactly, which is why `scoreCollection` takes a collection id at all. The books compete:
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
        for (const [key, s] of per) { const e = byKey.get(key); if (e && !e.disable) rows.push({ uid: Number(e.uid), book: e.world, entry: e, title: wiTitle(e), score: s.score, sparseScore: colVectorized ? s.score : undefined, textScore: contentText.get(entryKey(e)) ?? 0, keywordScore: keywordScore(e, haystackFor(e), k1), vectorEligible: !!e.vectorized, textEligible: hasContent(e), keysEligible: scoringKeys(e, P).length > 0 }); }
        // --- STAGE 2: ACTIVATION (keyword route). Stands in for ST core's keyword match, so it may only
        // admit an entry core could actually have activated. One exclusion, a stage-2 fact:
        //
        //   disable            core never activates a disabled entry — 279 of 611 keyword-only rows on the
        //                      curated sommers scenes arrived this way before the guard. The retrieval route
        //                      needs the same exclusion for a different reason (see above): a disabled entry
        //                      stays in the collection, so that door does not close on its own.
        //
        // A vectorized entry is not excluded: WA judges it like any other candidate, and stage 1 has
        // usually admitted it already through `per`.
        for (const e of entries) { const key = entryKey(e); if (per.has(key) || e.disable) continue; const kw = keywordScore(e, haystackFor(e), k1); if (kw > 0) rows.push({ uid: Number(e.uid), book: e.world, entry: e, title: wiTitle(e), score: P.denseColumn ? undefined : dense.get(key), sparseScore: colExtras ? dense.get(key) : undefined, textScore: contentText.get(key) ?? 0, keywordScore: kw, vectorEligible: (!P.denseColumn && dense.has(key)) || !!e.vectorized, textEligible: hasContent(e), keysEligible: true }); }
        return rows;
    };
}

/** The fitted models, read once. `extension/` is the shipped location; the harness reads the same files
 *  the runtime fetches, so a refit reaches both without a second copy. */
const MODEL_FILES = (() => {
    const out = {};
    for (const tier of ['memory', 'reference']) {
        try { out[tier] = JSON.parse(fs.readFileSync(new URL(`../extension/relevance-model-${tier}.json`, import.meta.url), 'utf8')); }
        catch { out[tier] = null; }
    }
    return out;
})();

/** The fits for one embedding model, by tier. A model with no fit gets null for that tier, which makes
 *  `makeLayoutOrder` leave its rows unscored and stage 4 cut nothing on relevance — the same path an outage
 *  takes, and the only honest one: another embedder's coefficients are not a fallback. */
export const modelsFor = (embedModel) => {
    // Through resolveModel, because a bundle records a SPEC: `omlx:Qwen3-...` keys as the served id
    // `qwen3-...`, which is what the runtime can compute for itself. A bare name resolves to itself.
    const key = modelKey(resolveModel(embedModel).model);
    const out = {};
    for (const tier of ['memory', 'reference']) out[tier] = MODEL_FILES[tier]?.byModel?.[key] ?? null;
    return out;
};
/** Which models the shipped artifact carries a fit for, for a caller that wants to say so. */
export const fittedModels = () => [...new Set(Object.values(MODEL_FILES).flatMap(f => Object.keys(f?.byModel ?? {})))];

/**
 * The LAYOUT ORDER: rows sorted by predicted relevance, the quantity stage 4 selects on.
 *
 * NOT A FUSION. RRF is gone from the product — E[credit] reads the signals directly and orders the
 * dynamic block by the same number the cut thresholds, which is what makes every cap below it a prefix.
 * A harness ordering rows any other way would be scoring a pipeline that no longer exists.
 *
 * THE TWO EXTRA SIGNALS ARE COMPUTED HERE, through relevance.mjs — the same functions the runtime calls,
 * never a copy. df is per book with the ENTRY as the document and disabled entries included; the window
 * names come from a plain entry's haystack, because proper-noun overlap is a property of the SCENE.
 *
 * PER TIER, each standardised among its own rows, as each fit was built.
 */
export const makeLayoutOrder = ({ scene, haystack }) => {
    // The fits are per embedding model, resolved from the scene's own record — a bundle names the model
    // its collections are keyed under, so the fit follows the vectors rather than whatever shipped last.
    const MODELS = modelsFor(scene?.embedModel ?? 'bge-m3');
    // PER BOOK, as `bookIndexes` builds it — df asks how distinctive a name is IN ITS BOOK'S vocabulary,
    // and a name common in one book and unique in another has two answers, not one.
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
        for (const [tier, model] of Object.entries(MODELS)) {
            if (!model) continue;
            const mine = rows.filter(r => (isMemory(r.entry) ? 'memory' : 'reference') === tier);
            if (!mine.length) continue;
            const e = scoreRelevance(model, mine.map(r => ({
                cosine: Number.isFinite(r.score) ? r.score : 0,
                text: Number(r.textScore) || 0,
                keys: Number(r.keywordScore) || 0,
                properNouns: Number(r.properNouns) || 0,
                density: Number(r.density) || 0,
            })));
            // `tierCutoff` is the FIT'S OWN F2 optimum, carried as provenance and nothing else. STAGE 4
            // DOES NOT HAPPEN HERE: this function produces the layout order, and whoever cuts on it owns
            // which number it cuts at (scoreScene `admits`). Threading an overridable cutoff through the
            // scorer is what hid the fact that the fallback is not what the runtime reads — the runtime
            // stopped reading `model.cutoff` when the cut became the `relevanceCutoff` SETTING, one value
            // for every model.
            mine.forEach((r, i) => { r.eCredit = e[i]; r.tierCutoff = model.cutoff; });
        }
        return [...rows].sort((a, b) => (b.eCredit ?? -1) - (a.eCredit ?? -1));
    };
};

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
 * @param {number} [args.k] Coverage/nDCG cutoff (10)
 * @returns {Promise<{n: number, nAt5: number, judged: number, of: number, unjudged: string[], terms: number|null,
 *   atR: {precision: number, recall: number, f: number, n: number}}>}
 */
export async function scoreScene({ sample: S, overrides = {}, k = 10, vectors, model, ollama, index, topK, scene: preloaded, qv: cachedQv } = {}) {
    const P = sceneParams(S, overrides);
    // A preloaded scene is reused across arms so N arms cost ONE embed and ONE index parse per scene. Valid
    // only while no arm moves the gazetteer, which is baked in at load time — asserted
    // rather than trusted, because the failure would be a silently wrong gazetteer and those cost 74% BM25.
    // denseAllEntries is baked in the same way for a different reason: it is read when the index is split,
    // so against a preloaded scene it would silently score the ordinary collection and report flat.
    if (preloaded && (overrides.denseAllEntries !== undefined || overrides.gazetteerSource !== undefined)) {
        throw new Error('gazetteerSource/denseAllEntries are read at load time, so they cannot be swept against a preloaded scene — load per arm');
    }
    // `model` is a SPEC, resolved here so every caller can pass one: a bare ollama name, or a server stem
    // (`omlx:`, `lms:`) for a model served over an OpenAI-compatible /v1/embeddings. The LABEL names the
    // collection, the rest says how to call it, and `query` is the task prefix a prefix-trained family
    // needs — absent it does not fail, it just scores the model worse than it is.
    const em = resolveModel(model);
    const scene = preloaded ?? loadScene(S, { indexFile: indexPath(S, { vectors, model: em.label, index }), indexOpts: { vectors, model: em.label }, params: P });
    const scoreAll = makeCandidateSet({ ...scene, params: P, topK });
    const layoutOrder = makeLayoutOrder({ scene, haystack: haystackFor(S, P) });
    const gradeOf = makeGradeOf(S.entries, scene);

    const query = S.query;
    const tw = P.entityFilter ? ranking.buildTermWeights(query, scene.gaz, P.boost) : null;
    // No collection means no cosine to compute, so the embed call is skipped rather than made and ignored.
    // Under denseAllEntries a keyword-only book has an empty stage-1 collection and still has vectors to
    // score against, which is the whole point of the arm there.
    const qv = cachedQv ?? (scene.loaded.some(L => L.items.length || L.extra?.length)
        ? await embed(em.query + query, { ollama, model: em.model, label: em.label, endpoint: em.endpoint, url: em.endpoint === 'ollama' ? ollama : em.url })
        : []);
    // REBUILT, not read: the document stores the scan MESSAGES, the injects and the opted-in sources
    // SEPARATELY, so the haystack is composed here at this arm's depth, matchWindow and includeNames
    // rather than baked in at capture.
    const all = scoreAll(P.K1, P.B, tw, qv, query, haystackFor(S, P));

    // WHAT IS RANKED: the haystack, minus CONSTANTS. These metrics tune RANKING FEATURES — how should this
    // set be sorted for this query — so what the pipeline later filters out does not bear on them.
    //
    // CONSTANTS ARE OUT because relevance is not a concept that applies to them. They carry world rules and
    // sometimes generation instructions; they are not about the scene and were never competing to be.
    // Scoring them would ask a grader to rate a category they do not belong to.
    //
    // STICKY IS IN, and used not to be — isDurableEntry is `constant || sticky > 0`, which threw both out
    // together. A sticky entry is ordinary content that persists once activated, and how it should be
    // ordered is exactly the question here. The pair mattered: 34 of sommers' 45 reference entries are
    // sticky: 1 with constant false, so lumping them with constants deleted that book's whole reference
    // tier from every ranking measurement taken here.
    //
    // REFERENCE IS IN, also newly. Stage 1 once arbitrated a retrieval ranking only vectorized entries
    // could enter, so a keyword entry arrived by a route ranking never judged; stage 4 ended that, and
    // a keyword-activated entry is neither sticky nor constant, so at runtime it lands in the dynamic
    // block beside the retrieved ones.
    const rankable = all.filter(r => !r.entry?.constant);

    const top = layoutOrder(rankable).slice(0, k);
    const unjudged = top.filter(r => !scene.POOL.has(entryKey(r.entry)));
    // Read the DEPLOYED slice's grades before the pooled re-fuse below mutates shared rows.
    const topGrades = top.map(r => gradeOf(r) ?? 0);
    // Re-fuse the pooled subset AFTER reading the slice above: fuse mutates, and the subset shares references.
    // FROM `rankable`, NOT `all` — the exclusion above is the whole point, and reading `all` here applied it
    // to coverage alone. That is what it did until 2026-08-12: every nDCG this harness had ever printed still
    // ranked the reference tier, and a reference-only book reported `judged 0/0` beside a healthy nDCG.
    // `?? 0` is the standard partial-label rule: an unjudged row occupies its rank and contributes
    // nothing. Explicit here because gradeOf now returns null for it — see makeGradeOf.
    const g = layoutOrder(rankable.filter(r => scene.POOL.has(entryKey(r.entry)))).map(r => gradeOf(r) ?? 0);

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

    // TWO MORE WINDOWS ON THE SAME BARS, because a fixed k cannot answer either question this system is
    // selecting for. The bars, the gradeCredit rule and RECALL_WEIGHT are shared with the block above; only
    // the window changes, so the three are comparable to each other and nothing else needs restating.
    //
    //   @R          the top `relevant` rows. Budget-invariant by construction — a user's token ceiling is
    //               set by cost and is not a property of the ranking, so it cannot be in the window.
    // It drops the reference tier, exactly as the block above does — grading a keyword-activated entry is
    // the same category error at any window.
    // EVERY WINDOW CARRIES ITS OWN POOL HONESTY, not just the top-k one. `judged`/`of` below are read at
    // the unfiltered top-k, and no k bounds the admitted set: the cut is a prefix in eCredit for scored
    // memory rows, but reference rows and rows the model could not score are admitted wherever they sit,
    // so a window read at k=10 can miss an ungraded row the configuration actually delivers. It scores 0
    // and the window reads as a precision loss with nothing saying why — which is the same failure the
    // top-k flag exists to prevent, one window over.
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

    //   @cut        everything the relevance cut admits. THE ONLY WINDOW THE SYSTEM CHOOSES FOR ITSELF —
    //               @R is handed the answer and k is handed a number, so neither can be wrong about HOW
    //               MANY, which is half of what stage 4 decides. Reading it is how a cutoff is screened:
    //               move the cutoff, and this is the set that moves.
    //
    // MEMORY ONLY, mirroring the runtime — a reference entry that fires is included and answers only to
    // the budget (worldsapart.js `rankActivated`), so it is never cut here either. A row the model could
    // not score is kept for the same reason it is kept live: an absent verdict is not a negative one.
    // THE CUT IS APPLIED HERE, and the number it cuts at is chosen here too: an arm's `memoryCutoff` when
    // it set one, otherwise the fit's own. That fallback is NOT what production reads — the runtime cuts
    // at the `relevanceCutoff` setting, one value for every model — so a run that passes no cutoff
    // measures a cut production does not make. Left as it is because moving it changes every number ever
    // measured at the default, which is a decision about the corpus rather than a fix; `param-screen.mjs`
    // and any tool that cares passes one.
    const cutFor = r => (isMemory(r.entry) && Number.isFinite(P.memoryCutoff)) ? P.memoryCutoff : r.tierCutoff;
    const admits = r => !isMemory(r.entry) || !Number.isFinite(cutFor(r)) || !Number.isFinite(r.eCredit) || r.eCredit >= cutFor(r);
    const atCut = scoreWindow(ranked.filter(admits));

    //   @budget     what the token ceiling actually leaves — stages 4 and 5 end to end, so the only window here
    //               that is the DELIVERED set rather than a stage of it. Off by default; see budgetTokens
    //               for what the captures cannot supply.
    let atBudget = null;
    if (P.budgetTokens > 0) {
        // Recorded token counts where the capture has them, since they came from the real tokenizer; the
        // fallback is content length over 4.91, which is this corpus's MEASURED chars-per-token for entry
        // bodies (median over 1297 rows, p5 4.46 / p95 5.33). A flat /4 would be 23% out.
        const recorded = new Map((S.candidates ?? []).map(c => [entryKey({ world: c.book ?? S.primaryBook, uid: c.uid }), c.tokens]).filter(([, t]) => typeof t === 'number'));
        const tokensOf = r => recorded.get(entryKey(r.entry)) ?? Math.round(String(r.entry?.content ?? '').length / 4.91);
        const kept = await selection.applyBudget({
            ranked: selection.walkOrder({ results: ranked.filter(admits) }),
            isDynamic: () => true,
            maxTokens: P.budgetTokens,
            maxTotal: P.maxTotalEntries ?? 0,
            maxDynamic: 0,
            maxVectorEntries: P.maxVectorEntries ?? 0,
            isVector: r => Boolean(r.entry?.vectorized),
            // THE PER-BOOK QUOTA, which nothing offline could exercise while only one book was ranked.
            // No capture records it — the live setting is `priorityList[].cap` (worldsapart.js) and
            // paramSnapshot does not carry it — so it is an arm's to set and defaults to no cap.
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
        // The unjudged rows with their identity, which is what an offline pool extension needs: these are
        // exactly the entries this configuration would put in front of a user and nobody has judged.
        unjudgedRows: unjudged.map(r => ({ uid: Number(r.uid), book: r.entry?.world, title: r.title, rank: top.indexOf(r) + 1 })),
        terms: tw ? Object.keys(tw).length : null,
    };
}
