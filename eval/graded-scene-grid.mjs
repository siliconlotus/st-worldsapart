// Graded-scene grid: reproduce WA's retrieval ranking for a REAL scene (chat query) offline, score it
// against human 0-5 grades with nDCG, and sweep any parameter — the sensitive complement to the LOO grid.
//
// Vector + BM25 + chunk-selection come from the SHARED scoring module (scoring.mjs), the exact code the
// server plugin runs; query construction, the entity filter, keyword scoring and RRF fusion come from the
// SHARED ranking module (ranking.mjs), the exact code the extension runs. Nothing here is reimplemented,
// so no signal can drift. The query embedding is the same model via ollama (validated: re-embedding a
// stored chunk → cosine ~1).
//
// VALIDATE FIRST: --validate <capture.json> prints my per-entry cosine/text/keys vs a /wa-debug capture.
//
// Usage (from SillyTavern root):
//   node .../graded-scene-grid.mjs --sample <sample.json> [--index <index.json>] [--validate <capture.json>]
//
// --sample is REQUIRED and is a /wa-grade sample: one graded scene in a self-contained JSON manifest, so a
// scene stays re-runnable after the settings that produced it have moved on — and so scoring ACROSS samples
// is a loop over manifests rather than a pile of remembered paths. The older hand-written form (--chat
// --book --grades over a "title | grade" text file, with the population re-derived rather than logged) is
// gone: it could not record what production activated, so its numbers described an approximation of a scene
// rather than the scene. /wa-grade writes everything below.
// Paths are relative to the ST root (where this is run from). Shape:
//
//   {
//     "name": "scene1",
//     "query": "Sommers ABO: …",          // the retrieval query, verbatim — see FREEZE below
//     "queryChat": [{name, mes}, ...],    // the messages it was joined from, for the depth sweep
//     "scanText": "…",                    // the keyword scan window for the same messages
//     "chat":  "data/default-user/chats/<char>/<chat>.jsonl",   // provenance / re-freezing only
//     "book":  "data/default-user/worlds/<book>.json",          // provenance only; entries come from "books"
//     "grades": [{ "title": "…", "grade": 4 }, ...],
//     "candidates": [ ...selection-candidate rows... ],         // the population; REQUIRED, see POOL below
//     "primaryBook": "<book name>",                             // the book whose collection was searched
//     "books": { "<book name>": { "<uid>": {entry}, ... } },     // embedded copies of every attached book
//     "bookMode": "full",                                       // fidelity those copies were taken at
//     "capture": ".../sceneN_off.json",                         // /wa-debug capture, for --validate
//     "depth": 5,                                               // messageDepth the query was built at
//     "captureParams": { "K1": 2, "LEXW": 1.5, ... },            // overrides P below, per sample
//     "excludeTitles": ["Intimacy & Mechanics"],                 // graded, but out of THIS harness's scope
//     "notes": "free text"
//   }
//
// excludeTitles drops graded titles this harness cannot rank — in practice, entries from a second attached
// book, since only one book/collection is loaded here while the live chat scanned several. Declared in the
// sample rather than dropped from `grades`, because relevance-eval.mjs scores the real captures,
// where those entries ARE present and a missing grade would silently score them as irrelevant. Excluding
// changes no nDCG: the ideal DCG is built from the ranked grade vector, so a title that never gets ranked
// was already contributing to neither DCG nor ideal. It only stops the row reading as a repro failure.
//
// FREEZE THE QUERY, NOT THE CHAT. A graded scene is a fixed pair of (query text, grades), so the sample
// stores the text itself. Re-deriving it from the chat each run would make every number depend on a live
// multi-megabyte file that nobody promised not to append to — play the chat on one turn and the harness
// silently starts scoring a DIFFERENT scene against the old grades, with no error to notice. So the chat
// is read only to mint the snapshot:
//
//   node .../graded-scene-grid.mjs --sample <sample.json> --chat <chat.jsonl> --depth 5 --freeze
//
// which writes `query` + `scanText` back into the sample. Every later run needs neither the chat nor the
// depth. The query VECTOR is deliberately not frozen: it is one cheap local embed call, and a stored
// vector would keep answering after the embedding model underneath it changed.
import { readFileSync, writeFileSync, statSync, openSync, readSync } from 'node:fs';
import { tokenize } from '../plugin/lexical.mjs';
import { norm } from '../plugin/vector.mjs';
import * as ranking from '../extension/ranking.mjs';   // shared client tuning layer — same code the extension runs
import { cutRetrieved } from '../extension/selection.mjs';
// Scene loading, the gazetteer, the scorers, the pool and the nDCG math all live in scene.mjs, shared with
// paired-arms.mjs — there must be exactly one copy of them (see that module's header).
import { CID, dcg, embed as embedWith, indexPath, loadScene, makeFuse, makeGradeOf, makeKeywordScore, makeScorer, ndcg, nrm, openSample, sceneParams, wiTitle } from './scene.mjs';

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
if (!arg('--sample')) { console.error('need --sample <sample.json> (write one with /wa-grade)'); process.exit(2); }
const S = openSample(arg('--sample'), arg('--arm'));
// '' is a failed capture (retrieval activated nothing), not a frozen query — treat it as missing so the
// guards below demand a chat instead of silently embedding and scoring an empty string.
if (!S.query) delete S.query;
const CHAT = arg('--chat') ?? S.chat;
const GRADES = S.grades ?? [];
const UNJUDGED_ZERO = arg('--unjudged') === 'zero';
// --validate is opt-in: a sample RECORDS its capture (so the check is always one bare flag away) but
// naming one must not silently turn a grid run into a validation run.
const vArg = arg('--validate');
const VALIDATE = process.argv.includes('--validate') ? ((vArg && !vArg.startsWith('--')) ? vArg : S.capture) : null;
// The converse silent turn is just as wrong: an explicitly requested validation must not quietly become a
// grid run because the sample happens to record no capture (/wa-grade doesn't write one).
if (process.argv.includes('--validate') && !VALIDATE) { console.error('--validate given but the sample records no "capture" — pass --validate <capture.json>, or add a "capture" path to the sample'); process.exit(2); }
const DEPTH = Number(arg('--depth') ?? S.depth ?? 5);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434', MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
// Signals the capture was produced under. Defaults are one tuned chat's snapshot, NOT the shipped defaults
// (extension/state.mjs ships K1 1.2, LEXW 1) — a sample overrides them via its own captureParams, which is
// the point of putting them in the manifest: each graded scene carries the settings it was graded under.
const P = sceneParams(S);
const FREEZE = process.argv.includes('--freeze');
// --depths 3,5,10,15 rebuilds the query from the chat at each depth and scores it at the shipped defaults.
// messageDepth is the one parameter a frozen sample CANNOT sweep on its own — the query text is the frozen
// artifact — so this is the one mode that needs the original chat, and it verifies the chat still yields the
// sample's own query at its own depth before trusting anything wider.
const DEPTHS = arg('--depths') ? String(arg('--depths')).split(',').map(Number).filter(d => d > 0) : null;
// The books must be IN the sample. There is no disk fallback: reading the live lorebook is what let a later
// edit move the numbers of an already-graded scene, which is the whole reason samples embed their books.
// Keyed-but-empty is the bookMode 'none' case: the book is named, its entries were not copied.
if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`sample embeds no entries for its primary book "${S.primaryBook ?? '?'}" (bookMode "${S.bookMode ?? '?'}") — re-grade with /wa-grade books=full`); process.exit(2); }
// The population is the log, never a re-derivation: half of what core activates (secondary keys, inclusion
// groups, recursion, min-activations, probability rolls) is not computable offline. See POOL below.
if (!S.candidates?.length) { console.error('sample logs no `candidates` — nothing to rank; re-grade with /wa-grade'); process.exit(2); }
// --depths needs a message list, not necessarily the FILE: an embedded `queryChat` ablates down to any
// depth <= the capture depth without it (see below). Only going wider needs the chat.
if (!CHAT && !S.chat && (S.query === undefined || (DEPTHS && !S.queryChat?.length))) { console.error(DEPTHS ? '--depths needs the original chat or an embedded "queryChat": pass --chat, or record "chat" in the sample' : 'sample has no frozen "query" — pass --chat (with --freeze to snapshot it into the sample)'); process.exit(2); }
if (S.name) console.log(`sample: ${S.name}${S.notes ? ` — ${S.notes}` : ''}`);
const VECTORS = arg('--vectors') ?? 'data/default-user/vectors/ollama';
const INDEX = indexPath(S, { vectors: VECTORS, model: MODEL, index: arg('--index') });
const TOPK = Number(arg('--topk')) || Math.max(100, P.maxVectorEntries * 2);   // ENTRIES, as production now asks — the plugin pools before it cuts. --topk probes the elbow's window sensitivity.

// --- inputs ---
// A /wa-grade sample carries copies of every attached book, so it re-runs identically after the live
// lorebooks have been edited. Nothing here reads a live book.
const { primary, entries, byUid, items, loaded, gaz, gazSource, isExcluded, POOL, OWN } = loadScene(S, { indexFile: INDEX, params: P });
console.log(`books: ${Object.keys(S.books).length} embedded at fidelity "${S.bookMode ?? '?'}" (primary "${primary}")`);

// --- query (shared buildQuery; macros left literal via identity substituteParams) + keyword scan window.
// Read from the sample's snapshot; the chat is opened only to mint one (--freeze) or re-derive one (--requery).
// Tail-read, because a long-running graded chat is ~100MB and only the last few messages are ever used.
function tailMessages(path, bytes = 8e6) {
    const size = statSync(path).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    const fd = openSync(path, 'r');
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();   // a mid-line start yields a broken first record
    return lines.filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const scanWindowOf = (msgs, depth) => ranking.scanWindow(msgs, { depth, includeNames: P.includeNames });
// DEPTH ABLATION FROM ONE CAPTURE. A sample's `queryChat` holds the messages its query was joined from, so
// any depth <= the capture depth is reproducible exactly with no chat file: capture deliberately too wide
// (say 20) and narrow from there. Preferred over the chat file, which a played-on chat invalidates — but an
// EXPLICIT --chat wins, because the file is the only way to go WIDER than the capture and being handed one
// is as explicit as the request gets.
const wantChat = S.query === undefined || FREEZE || (DEPTHS && (arg('--chat') !== null || !S.queryChat?.length));
if (wantChat && !CHAT) { console.error(FREEZE ? '--freeze needs a chat to snapshot from: pass --chat, or record "chat" in the sample' : 'no chat available: pass --chat, or record "chat" in the sample'); process.exit(2); }
// Only the depth sweep re-derives; a plain run reads the frozen `query`/`scanText`, which is the whole
// point of freezing them. Re-deriving unconditionally would silently replace a SUMMARY query with the raw
// messages, and rebuild a scan window that is missing production's injects and is_system filtering.
const chat = wantChat ? tailMessages(CHAT) : (DEPTHS && S.queryChat?.length ? S.queryChat : null);
if (DEPTHS && chat === S.queryChat) {
    const over = DEPTHS.filter(d => d > S.queryChat.length);
    if (over.length) console.log(`!! depths ${over.join(',')} exceed the ${S.queryChat.length} captured messages — those rows repeat the widest window; pass --chat to actually widen it`);
}
const query = chat ? ranking.buildQuery(chat, { depth: DEPTH }) : S.query;
const scanText = chat ? scanWindowOf(chat, DEPTH) : S.scanText;
// The retrieval math lives in the deployed plugin, so a redeploy can move every per-entry signal without a
// settings change (server-side entry pooling did). Grades collected under different arithmetic are still
// valid as RELEVANCE, but the ranking they were paired with is not the one being scored here.
if (S.pluginFP && S.sourceFP && S.pluginFP !== S.sourceFP) console.log(`!! sample captured against a STALE plugin (deployed ${S.pluginFP} vs source ${S.sourceFP}) — its recorded scores predate the current retrieval math`);
// The embedding model is the one input that silently invalidates everything: cosines from a different model
// are not comparable, the derived index path would point somewhere else, and nothing downstream would look
// wrong. Harmless to skip while every sample is your own capture at your own default; a hard stop as soon as
// samples arrive from other people, which is the entire point of collecting grade dumps.
if (S.embedModel && S.embedModel !== MODEL) {
    console.error(`sample was captured under embedding model "${S.embedModel}" but this run uses "${MODEL}" — cosines are not comparable. Set WA_EMBED_MODEL=${S.embedModel}, or pass --index explicitly if you have rebuilt the index under ${MODEL}.`);
    if (!process.argv.includes('--force')) process.exit(2);
    console.error('(--force given: continuing anyway, numbers are not trustworthy)');
}

if (FREEZE) {
    const path = arg('--sample');
    if (!path) { console.error('--freeze needs --sample <manifest.json> to write into'); process.exit(2); }
    if (S.query !== undefined && S.query !== query) {
        console.warn('!! --freeze is REPLACING an existing snapshot and the chat no longer yields the same query — has the chat been played on since grading? The grades may no longer describe this scene.');
    }
    writeFileSync(path, `${JSON.stringify({ ...S, query, scanText, frozenAt: new Date().toISOString().slice(0, 10) }, null, 2)}\n`);
    console.log(`froze query (${query.length} chars) + scan window (${scanText.length} chars) into ${path}`);
}

// --- entity filter: the gazetteer is built in loadScene (see scene.mjs for why suppressVectorKeys matters
// here — reading raw book keys admitted 2.3x the terms and moved BM25 by up to 74%). Only the query-
// dependent term weights are derived per run, since --depths rebuilds the query.
const termWeights = (P.entityFilter && P.queryMode !== 'summary') ? ranking.buildTermWeights(query, gaz, P.boost) : null;

const keywordScore = makeKeywordScore(P);
const embed = text => embedWith(text, { ollama: OLLAMA, model: MODEL });
const fmt = n => (n == null ? '·' : (+n).toFixed(3));

(async () => {
    const qv = await embed(query);
    // self-check: re-embed a stored chunk → mean-centered cosine ~1
    const c0 = (v => { const o = v.map((x, i) => x - loaded.mean[i]); const n = norm(o) || 1; return o.map(x => x / n); })(items[0].vector);
    const r0 = (v => { const o = v.map((x, i) => x - loaded.mean[i]); const n = norm(o) || 1; return o.map(x => x / n); })(await embed(items[0].metadata.text));
    console.log(`query (${DEPTH} msgs, ${query.length} chars): "${query.slice(0, 80).replace(/\n/g, ' ')}…"`);
    console.log(`self-check cosine: ${r0.reduce((s, x, i) => s + x * c0[i], 0).toFixed(4)} | entities kept: ${termWeights ? Object.keys(termWeights).length : 'all (filter off)'}\n`);

    // Per-entry signals via the SHARED scorer in scene.mjs (exact plugin vector + BM25 + selection, then
    // keyword). Wrapped only to keep this file's defaults — the report code below sweeps k1/b/tw and leaves
    // the query and scan window alone.
    const score = makeScorer({ loaded, byUid, entries, params: P, topK: TOPK });
    const scoreAll = (k1, b, tw = termWeights, qvec = qv, qtext = query, st = scanText) => score(k1, b, tw, qvec, qtext, st);
    // POPULATION COMES FROM THE LOG, NOT FROM RE-DERIVATION. /wa-grade records the entries production
    // actually activated (`candidates`), which is the one thing offline code cannot recompute: half that set
    // is ST core's doing — secondary-key AND/NOT logic, inclusion groups, recursion, min-activations,
    // probability rolls, delay/sticky state — and WA never performs it. An earlier version reconstructed the
    // population by re-applying the cutoff and approximating core with `keywordScore > 0`; that admitted
    // entries core would reject and missed ones recursion adds.
    //
    // Population and SIGNALS are separable, which is what makes this work for every axis: the pool is fixed
    // by the log, and only the scores are re-derived under the swept params. That is the standard pooled-
    // judgement design — judge a candidate pool once, then evaluate any ranker over it — and it is why k1/b
    // can be swept without the population drifting out from under the grades.
    //
    // Scaffolding (constants, configured stickies) is tiered off: always-on entries aren't relevance results.
    //
    // THE POOL IS WHAT A HUMAN JUDGED, not what this one capture logged. For an ordinary single-arm sample
    // those are the same set — grades are collected FROM the candidate list — so this reads exactly as it
    // always did. They diverge by design for a /wa-super-grade sample, which captures N population-changing
    // arms, unions their candidate lists, and grades the union once: an entry only a SIBLING arm surfaced is
    // judged too, and admitting it here is what makes a wrong promotion visible instead of silently filtered
    // out of the ranking.
    //
    // ponytail: the union is over the arms actually run, not over the whole parameter space, so a param swept
    // far outside those arms is still ranking against a pool that never saw its population. Widen the arm set
    // (or grade a fresh super-sample) rather than trusting a lone distant arm.
    console.log(`pool: ${POOL.size} judged entries (${OWN.size} from this capture's ${S.candidates.length} logged rows${POOL.size > OWN.size ? `, +${POOL.size - OWN.size} judged under a sibling arm` : ''})`);

    let poolWarned = false;
    const activated = rows => {
        // --unjudged zero: don't restrict to the pool at all; ungraded rows keep their signals and score 0
        // (gradeOf's default). Restricting to the pool makes a wrong promotion INVISIBLE — the promoted entry
        // is filtered out rather than penalised — which is why fine-grained arms (boost 1..8) collapse to
        // identical scores there while coarse ones (filter on/off) still separate. Scoring unjudged as 0
        // restores that resolution at the cost of assuming nothing relevant sits outside the pool; see the
        // grade profiles in eval-data (relevance is sparse and the pools bottom out around rank 24-28).
        if (UNJUDGED_ZERO) return rows;
        const kept = rows.filter(r => POOL.has(Number(r.uid)));
        // Coverage is measured against THIS capture's own rows, not the union. A sibling arm's entry that
        // fails to re-derive here is the arms disagreeing about population — the thing a super-sample exists
        // to measure — not a swept param drifting off the graded reality, which is the thing being warned
        // about. Comparing against the union would fire on every super-sample and mean nothing.
        const own = kept.filter(r => OWN.has(Number(r.uid))).length;
        if (!poolWarned && own < OWN.size) {
            poolWarned = true;
            console.log(`   pool coverage: re-derivation produced ${own}/${OWN.size} of this capture's own entries at these params (missing ones score no signals and drop out of the ranking)`);
        }
        return kept;
    };

    const fuse = makeFuse(P);

    if (VALIDATE) {
        const capAll = JSON.parse(readFileSync(VALIDATE, 'utf8')).filter(r => (r.block === undefined || r.block === 'dynamic') && !(Number(r.sticky) > 0));
        const cap = capAll.filter(r => !isExcluded(r.title));
        if (cap.length < capAll.length) console.log(`(skipping ${capAll.length - cap.length} out-of-scope row(s): ${capAll.filter(r => isExcluded(r.title)).map(r => r.title).join(', ')})`);
        const mine = fuse(scoreAll(P.K1, P.B), P.LEXW);
        const find = title => { const gt = nrm(title); return mine.find(m => { const mt = new Set(nrm(m.title)); return gt.length && gt.every(t => mt.has(t)); }); };
        console.log('validation vs capture (dynamic) — cosine / text / keys, then ranks:');
        console.log('cap#  my#  | cosine(cap/mine)  text(cap/mine)  keys(cap/mine)  title');
        let n = 0, sd = 0;
        // Per-signal agreement, stated rather than left to the eye. A wall of cap/mine pairs invites
        // "looks close enough": the BM25 column has sat ~30% out since this fixture was made and got
        // carried through a refactor as "unchanged" without anyone characterising it. Each signal is
        // reproduced by a different half of the pipeline, so which one disagrees is the diagnosis —
        // cosine pins the query text + vectors + centering, keys pins the keyword scorer, text pins the
        // lexical scorer and everything feeding its term weights.
        const gaps = { cosine: [], text: [], keys: [] };
        const note = (k, capV, myV) => { if (capV == null || !Number.isFinite(+capV)) return; gaps[k].push(+capV ? Math.abs(+myV - +capV) / Math.abs(+capV) : (+myV ? 1 : 0)); };
        cap.forEach((c, ci) => {
            const m = find(c.title);
            if (!m) { console.log(`${String(ci).padStart(3)}   --  | (no match)  ${c.title}`); return; }
            const mi = mine.indexOf(m); n++; sd += (ci - mi) ** 2;
            note('cosine', c.cosine, m.score); note('text', c.text, m.textScore); note('keys', c.keys, m.keywordScore);
            console.log(`${String(ci).padStart(3)}  ${String(mi).padStart(3)}  | ${fmt(c.cosine)}/${fmt(m.score)}   ${fmt(c.text)}/${fmt(m.textScore)}   ${fmt(c.keys)}/${fmt(m.keywordScore)}   ${c.title.slice(0, 38)}`);
        });
        console.log(`\nmatched ${n}/${cap.length}; rank MSE ${(sd / n).toFixed(1)} (0 = identical order)`);
        console.log('signal agreement — rows within 0.1% of the capture (the capture prints 2-3dp, so that is its own precision):');
        for (const [k, v] of Object.entries(gaps)) {
            if (!v.length) { console.log(`  ${k.padEnd(6)} — no values in capture`); continue; }
            const ok = v.filter(x => x <= 0.001).length;
            console.log(`  ${k.padEnd(6)} ${String(ok).padStart(2)}/${v.length}  worst ${(100 * Math.max(...v)).toFixed(1)}%  ${ok === v.length ? 'reproduced' : '<- DIVERGES'}`);
        }
        return;
    }

    // Grades come inline from the sample: an array of {title, grade}, matched to a ranked row by token subset.
    const gradesAll = GRADES.filter(x => x && x.title && Number.isFinite(Number(x.grade))).map(x => ({ tk: nrm(x.title), g: Number(x.grade), title: x.title }));
    const grades = gradesAll.filter(g => !isExcluded(g.title));
    if (grades.length < gradesAll.length) console.log(`excluded ${gradesAll.length - grades.length} out-of-scope grade(s) — not rankable from this book: ${gradesAll.filter(g => isExcluded(g.title)).map(g => `"${g.title}"`).join(', ')}\n`);
    const gradeOf = makeGradeOf(S.grades, isExcluded);
    const DEF = { k1: 1.2, b: 0.75, lexW: 1 };   // shipped defaults (extension/state.mjs)
    const relCount = grades.filter(x => x.g >= 3).length;

    // --- depth sweep (--depths): the one axis a frozen sample can't test by itself, because the query TEXT
    // is what's frozen. Rebuilds the query and the keyword scan window from the chat at each depth, re-embeds
    // (one local call each), and scores at the shipped defaults. The grades are held fixed: widening the
    // window only reaches further BACK from the same graded moment, so it adds context to the same scene
    // rather than moving to a different one.
    if (DEPTHS) {
        // Trust check first: does the chat still reproduce this sample's own query at its own depth? If not,
        // it has been played on since grading and every wider depth would describe a different scene.
        const own = ranking.buildQuery(chat, { depth: DEPTH });
        const faithful = own === S.query;
        console.log(`chat check: rebuilding at the sample's own depth ${DEPTH} ${faithful ? 'reproduces its frozen query exactly' : `DIFFERS (${own.length} vs ${S.query?.length ?? 0} chars) — chat played on since grading; wider depths describe a different scene`}`);
        if (!faithful && !process.argv.includes('--force')) { console.error('refusing to sweep an unfaithful chat; pass --force to override'); process.exit(1); }

        console.log(`\ndepth sweep at shipped k1=${DEF.k1} b=${DEF.b} lexW=${DEF.lexW}, ${relCount} relevant (grade>=3)`);
        // `blind` is the ablation's honesty column: entries this depth's cut keeps that the grader was never
        // shown, and which therefore score 0 whether or not they are relevant. Narrowing the window is not a
        // pure subset operation — a shorter, more focused query can promote an entry the wide capture ranked
        // out of the graded pool entirely — so a depth row with a high blind count is understating itself.
        // If it stays at 0, one wide capture ablates down cleanly and no extra grading is needed.
        console.log(' depth | qChars  msgs  terms | nDCG@5  nDCG@10  nDCG@20  meanRank  cut P     R     F1     blind');
        for (const d of DEPTHS) {
            const q = ranking.buildQuery(chat, { depth: d });
            const st = scanWindowOf(chat, d);
            const tw = P.entityFilter && P.queryMode !== 'summary' ? ranking.buildTermWeights(q, gaz, P.boost) : null;
            const v = await embed(q);
            const rows = scoreAll(DEF.k1, DEF.b, tw, v, q).map(r => ({ ...r, keywordScore: keywordScore(byUid.get(Number(r.uid)) ?? { key: [] }, st, DEF.k1) }));
            const fused = fuse(rows, DEF.lexW);
            const g = fused.map(r => gradeOf(r));
            const hits = fused.map((r, i) => [gradeOf(r), i + 1]).filter(([gr]) => gr >= 3).map(([, i]) => i);
            const mean = hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : NaN;
            // Cutoff, on the retrieval ranking as production cuts it.
            const retr = rows.filter(r => r.score !== undefined);
            const rk = ranking.fuseRetrieval(new Map(retr.map(r => [r.uid, { score: r.score, bm25: r.textScore }])), { rrfK: P.K, retrievalMode: P.retrievalMode, lexicalWeight: DEF.lexW })
                .map(r => ({ ...r, title: byUid.get(Number(r.key)) ? wiTitle(byUid.get(Number(r.key))) : String(r.key) }));
            // The sample's own cutoff config, not a hardcoded count/10 — a depth sweep that cuts differently
            // from the configuration under test measures the wrong thing.
            const keep = cutRetrieved(rk, { mode: P.vectorCutoff ?? 'count', maxVectorEntries: P.maxVectorEntries ?? 10, minVectorEntries: P.minVectorEntries ?? 3, elbowSensitivity: P.elbowSensitivity ?? 1.5, dropoffThreshold: P.dropoffThreshold ?? 0.06 });
            const relInRank = rk.filter(r => gradeOf(r) >= 3).length;
            const tp = keep.filter(r => gradeOf(r) >= 3).length;
            const pr = keep.length ? tp / keep.length : 0, rc = relInRank ? tp / relInRank : 0;
            const blind = keep.filter(r => !POOL.has(Number(r.key))).length;
            const tag = d === DEPTH ? '  <- as graded' : '';
            console.log(`${String(d).padStart(6)} | ${String(q.length).padStart(6)}  ${String(Math.min(d, chat.length)).padStart(4)}  ${String(tw ? Object.keys(tw).length : 'all').padStart(5)} | ${ndcg(g, 5).toFixed(4)}  ${ndcg(g, 10).toFixed(4)}  ${ndcg(g, 20).toFixed(4)}  ${mean.toFixed(1).padStart(8)}  ${pr.toFixed(3)} ${rc.toFixed(3)} ${((pr + rc) ? 2 * pr * rc / (pr + rc) : 0).toFixed(3)}  ${String(blind).padStart(4)}/${keep.length}${tag}`);
        }
        return;
    }

    // --- ranking: k1 × b × lexW, graded nDCG. Per-entry scoring depends only on (k1,b), so score once
    // per pair and sweep lexW on top of it (fusion is a re-rank of the same rows).
    // @10 IS THE TARGET, @5 is carried as a secondary column. The shipped cut is `elbow` capped at
    // maxVectorEntries 10 with a floor of 3 (state.mjs), so 10 is the widest rank that can reach the prompt
    // at all — tuning on @5 optimised a window narrower than the decision being made, and relevance on these
    // scenes runs deep enough (pools bottom out around rank 24-28) that ranks 6-10 carry real signal rather
    // than padding. Argmax on @10 for the same reason.
    console.log('grid (k1 × b × lexW) — graded nDCG on the scene\n  k1     b   lexW | nDCG@10  nDCG@5  judged@10');
    let best = null;
    let worst = null;
    for (const k1 of [1.2, 2, 3]) for (const b of [0.6, 0.75, 0.9]) {
        const all = scoreAll(k1, b);
        const rows = activated(all);
        for (const lexW of [0.5, 1, 1.5, 2, 3]) {
            // JUDGED@10 — pool reusability, and the stopping rule for /wa-super-grade's rounds.
            //
            // Computed on the UNFILTERED re-derivation, before activated(), which is the whole point:
            // restricting to the pool first would report 10/10 by construction. The question this answers is
            // "if this configuration shipped, has a human looked at the top 10 it would produce" — and where
            // the answer is no, this row's nDCG is a LOWER BOUND, because an unjudged entry scores 0 whether
            // or not it is relevant. A config with gaps therefore cannot be compared against one without
            // until the gap is graded, which is exactly what makes a pool built from one configuration
            // useless for a zero-based defaults review. Fix by adding arms, not by reading past it.
            //
            // fuse() mutates the row objects it is handed and `rows` shares references with `all`, so this
            // has to read its slice before the fuse below re-ranks the subset.
            //
            // NOT ALWAYS REACHABLE AT 10/10, and it matters that you know why before chasing it. This fused
            // layout ranking spans every entry with any signal — including keyword-only rows that scoreAll
            // adds from the book directly — whereas a live capture only ever logs what ST CORE activated.
            // A keyword-only row core would have rejected (failed secondary keys, lost a probability roll,
            // outside an inclusion group) can therefore sit in this top-10 and never be gradeable by any arm.
            // The named titles below are how you tell that case from a real pooling gap: if a missing entry
            // shows up in a live /wa-super-grade run, grade it; if no arm ever surfaces it, it is a phantom of
            // offline re-derivation and the honest ceiling for this cell is below 10/10.
            const top = fuse(all, lexW).slice(0, 10);
            const unjudged = top.filter(r => !POOL.has(Number(r.uid)));
            const j10 = top.length - unjudged.length;
            const g = fuse(rows, lexW).map(r => gradeOf(r));
            const n5 = ndcg(g, 5), n10 = ndcg(g, 10);
            if (!best || n10 > best.n10) best = { k1, b, lexW, n5, n10, j10, of: top.length, unjudged: unjudged.map(r => `${r.title} (#${top.indexOf(r) + 1})`) };
            if (!worst || j10 - top.length < worst.j10 - worst.of) worst = { k1, b, lexW, j10, of: top.length };
            const tag = k1 === DEF.k1 && b === DEF.b && lexW === DEF.lexW ? '  <- shipped default' : '';
            console.log(`${String(k1).padStart(4)}  ${String(b).padStart(4)}  ${String(lexW).padStart(4)} | ${n10.toFixed(4)}   ${n5.toFixed(4)}   ${String(j10).padStart(2)}/${top.length}${j10 < top.length ? ' !!' : '   '}${tag}`);
        }
    }
    console.log(`\nbest nDCG@10: k1=${best.k1} b=${best.b} lexW=${best.lexW} -> ${best.n10.toFixed(4)} (@5 ${best.n5.toFixed(4)}), judged ${best.j10}/${best.of}`);
    // The argmax is the cell whose coverage matters most: if ITS top-10 isn't fully judged, the grid picked a
    // winner partly because nobody graded what it surfaced.
    if (best.j10 < best.of) {
        console.log(`!! THE ARGMAX IS NOT FULLY JUDGED (${best.j10}/${best.of}) — its nDCG is a lower bound and this pick is not defensible.`);
        console.log(`   ungraded in its top 10: ${best.unjudged.join(', ')}`);
        console.log('   re-run /wa-super-grade, load this sample as a prior, and grade the delta. If no arm ever surfaces those entries, see the judged@10 note above.');
    }
    if (worst.j10 < worst.of) console.log(`!! worst coverage in the grid: ${worst.j10}/${worst.of} at k1=${worst.k1} b=${worst.b} lexW=${worst.lexW} — that cell is penalised for surfacing entries nobody judged.`);
    else console.log('pool is reusable across this grid: every cell\'s top-10 is fully judged.');

    // --- selection criteria: where the cut falls, scored as a SET. nDCG above grades the ORDER and is
    // blind to how many survive it, so the cutoff settings need their own metric. Relevant = grade >= 3,
    // the same bar relevance-eval.mjs reports recall against. Human grades on a real scene's entry-level
    // ranking — the production shape, where cutoff-grid.mjs's arm is chunk-level and gold-free.
    //
    // The cut is applied to the RETRIEVAL ranking (shared fuseRetrieval: vector + BM25 over retrieved
    // entries), which is what cutRetrieved is handed in production — NOT the fuseRanks layout ranking used
    // for nDCG above. That one also carries keyword and order ranks over entries retrieval never saw, so
    // cutting it would measure a decision WA never makes.
    const retrieved = scoreAll(DEF.k1, DEF.b).filter(r => r.score !== undefined);
    const ranked = ranking.fuseRetrieval(
        new Map(retrieved.map(r => [r.uid, { score: r.score, bm25: r.textScore }])),
        { rrfK: P.K, retrievalMode: P.retrievalMode, lexicalWeight: DEF.lexW },
    ).map(r => ({ ...r, uid: r.key, title: byUid.get(Number(r.key)) ? wiTitle(byUid.get(Number(r.key))) : String(r.key) }));
    const relN = ranked.filter(r => gradeOf(r) >= 3).length;
    const arms = [
        ...[...new Set([3, 5, 10, 20, P.maxVectorEntries ?? 10])].sort((a, b) => a - b).map(v => [`count   max=${v}`, { mode: 'count', maxVectorEntries: v }]),
        ...[1.2, 1.5, 2, 2.5].map(v => [`elbow   sens=${v}`, { mode: 'elbow', elbowSensitivity: v }]),
        ...[0.04, 0.06, 0.08, 0.12].map(v => [`dropoff thr=${v}`, { mode: 'dropoff', dropoffThreshold: v }]),
    ];
    // Cliff modes get the SAMPLE's cap, not a hardcoded 10: capping a cliff search below the candidate
    // list makes it structurally unable to find an inflection further down, which is the whole question.
    const CAP = P.maxVectorEntries ?? 10;
    // Best F1 any prefix cut of this ranking could achieve — the ceiling the modes are trying to hit. Honest
    // here (unlike the LOO arm) because the gold set is human, entry-level, and the right size.
    let oracle = { f1: 0, at: 0 };
    for (let i = 1; i <= Math.min(CAP, ranked.length); i++) {
        const tp = ranked.slice(0, i).filter(r => gradeOf(r) >= 3).length;
        const p = tp / i, r = relN ? tp / relN : 0;
        const f = (p + r) ? 2 * p * r / (p + r) : 0;
        if (f > oracle.f1) oracle = { f1: f, at: i, p, r };
    }
    // How many rows the grader was actually shown. Beyond this, entries are ungraded and score 0, so a mode
    // that keeps more is charged for rows nobody judged — it looks worse than it is. /wa-grade widens its own
    // cut to a plain count precisely to push this boundary out past any mode being assessed.
    const GRADED = Number(S.gradedCandidates) || 0;
    console.log(`\ncutoff at shipped k1/b/lexW — ${relN} relevant (grade>=3) of ${ranked.length} candidates, cap=${CAP}, floor min=3`);
    if (GRADED) console.log(`  grader saw ${GRADED} rows${S.cutoff?.gradingOverride ? ` (graded at ${S.cutoff.gradingOverride.mode}/${S.cutoff.gradingOverride.maxVectorEntries}${S.cutoff.live ? `; live setting was ${S.cutoff.live.mode}/${S.cutoff.live.maxVectorEntries}` : ''})` : ''} — rows past that are ungraded, so any arm keeping more is marked (?)`);
    else console.log('  !! sample records no gradedCandidates: cannot tell where the grades stop, so deep arms may be scored against ungraded rows');
    // A NULL scene (0 relevant, by construction) has no oracle cut: the only right answer is "keep nothing",
    // which no mode can reach (minVectorEntries floors them), so `kept` below reads as pure contamination.
    if (oracle.at) console.log(`  BEST POSSIBLE cut: keep ${oracle.at} -> P ${oracle.p.toFixed(3)} R ${oracle.r.toFixed(3)} F1 ${oracle.f1.toFixed(3)}  (the inflection a cliff mode should find)`);
    else console.log('  NULL scene (0 relevant): no oracle cut exists — every kept row is contamination, smaller kept is better');
    console.log('  mode / param     | kept   P      R      F1   %oracle  missed relevant');
    for (const [label, cfg] of arms) {
        const keep = cutRetrieved(ranked, { maxVectorEntries: CAP, minVectorEntries: 3, ...cfg });
        const kept = new Set(keep.map(r => r.uid));
        const tp = keep.filter(r => gradeOf(r) >= 3).length;
        const p = keep.length ? tp / keep.length : 0, r = relN ? tp / relN : 0;
        const missed = ranked.filter(x => gradeOf(x) >= 3 && !kept.has(x.uid)).map(x => `${x.title.slice(0, 24)} (#${ranked.indexOf(x) + 1})`);
        const shipped = cfg.mode === 'elbow' && cfg.elbowSensitivity === 1.5 ? ' <- shipped default' : '';
        // (?) = this arm kept rows nobody judged, so its F1 is a LOWER BOUND, not a measurement. Counted per
        // row against the judged set rather than as `keep.length > gradedCandidates`: with a pooled grade set
        // the boundary is which entries were judged, not how many, and a count comparison both misses an
        // unjudged row inside the first N and cries wolf on a deep cut whose rows are all judged anyway.
        const unjudged = keep.filter(r => !POOL.has(Number(r.uid))).length;
        const beyond = unjudged ? ` (? ${unjudged} of ${keep.length} kept are unjudged)` : '';
        const tag = shipped + beyond;
        const f1 = (p + r) ? 2 * p * r / (p + r) : 0;
        console.log(`  ${label.padEnd(16)} | ${String(keep.length).padStart(4)}  ${p.toFixed(3)}  ${r.toFixed(3)}  ${f1.toFixed(3)}  ${`${(100 * (oracle.f1 ? f1 / oracle.f1 : 0)).toFixed(0)}%`.padStart(6)}   ${missed.join(', ') || '(none)'}${tag}`);
    }

    // --- entity filter: re-measures the claims in ranking.mjs buildTermWeights, whose figures ("mean
    // target rank 11.2 vs 21.6-28.2 unfiltered", "gazetteer costs half a rank", "boost plateaus 3..5")
    // were taken on a 5-target gold set that no longer exists AND, on the evidence of this harness's own
    // bug, against a gazetteer built from raw book keys — 2.3x the terms production admits. Same metric
    // (mean rank of the graded targets) on the validated fixture, at production's suppressed gazetteer.
    const rankMetrics = tw => {
        const all = scoreAll(DEF.k1, DEF.b, tw);
        // Coverage before the pool filter, same reasoning as the grid above. These arms need it most: turning
        // the entity filter off is exactly the kind of population change a defaults-shaped pool never saw.
        const top = fuse(all, DEF.lexW).slice(0, 10);
        const j10 = top.filter(r => POOL.has(Number(r.uid))).length;
        const rows = fuse(activated(all), DEF.lexW);
        const hits = rows.map((r, i) => [gradeOf(r), i + 1]).filter(([g]) => g >= 3).map(([, i]) => i);
        const g = rows.map(r => gradeOf(r));
        return { found: hits.length, mean: hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : NaN, top10: hits.filter(i => i <= 10).length, n10: ndcg(g, 10), j10, of: top.length };
    };
    const filterArms = [
        ['production (gaz + boost 3)', termWeights],
        ['NO entity filter (raw query)', null],
        ['no gazetteer (boost only)', ranking.buildTermWeights(query, new Set(), P.boost)],
        ...[1, 2, 5, 8].map(bo => [`boost=${bo} (with gazetteer)`, ranking.buildTermWeights(query, gaz, bo)]),
        // Gazetteer widened with every entry BODY, not just keys+titles. Term count alone can't judge this
        // (it still keeps the proper-noun boost, and stopwordDf still strips corpus-common terms), so it
        // gets measured like any other arm rather than argued about.
        ['+ entry content in gaz', ranking.buildTermWeights(query, new Set([...gaz, ...gazSource.flatMap(e => tokenize(e.content ?? ''))]), P.boost)],
    ];
    console.log(`\nentity filter — mean rank of the ${relN} graded targets (grade>=3), lower is better`);
    console.log('  arm                          | terms  found  mean rank  in top10  nDCG@10  judged@10');
    for (const [label, tw] of filterArms) {
        const m = rankMetrics(tw);
        const tag = tw === termWeights ? '  <- shipped' : '';
        console.log(`  ${label.padEnd(28)} | ${String(tw ? Object.keys(tw).length : 'all').padStart(5)}  ${String(m.found).padStart(5)}  ${m.mean.toFixed(1).padStart(9)}  ${String(m.top10).padStart(8)}  ${m.n10.toFixed(4)}   ${String(m.j10).padStart(2)}/${m.of}${m.j10 < m.of ? ' !!' : ''}${tag}`);
    }
})();
