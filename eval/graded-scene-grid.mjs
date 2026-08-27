// Graded-scene grid: reproduce WA's retrieval ranking for a REAL scene (chat query) offline, score it
// against human 0-4 grades with nDCG, and sweep any parameter — the sensitive complement to the LOO grid.
//
// Vector + BM25 + chunk-selection come from the SHARED scoring module (scoring.mjs), the exact code the
// server plugin runs; query construction, the entity filter, keyword scoring and RRF fusion come from the
// SHARED modules (entity.mjs, query.mjs), the exact code the extension runs. Nothing here is reimplemented,
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
//     "primaryBook": "<book name>",                             // the book the scene is keyed to
//     "books": { "<book name>": { "<uid>": {entry}, ... } },     // embedded copies of every attached book
//     "capture": ".../sceneN_off.json",                         // /wa-debug capture, for --validate
//     "depth": 5,                                               // messageDepth the query was built at
//     "params": { "K1": 2, ... },                                // overrides P below, per arm
//     "notes": "free text"
//   }
//
// EVERY EMBEDDED BOOK IS RANKED, one collection each, pooled into one top-K — what production does. So a
// graded row is out of scope only when its book was NOT embedded, and nothing about the ranking is
// per-book except the centroid, the BM25 IDF and the name df, each of which production also keeps per
// book. A grade the harness cannot rank changes no nDCG: the ideal DCG is built from the ranked grade
// vector, so a title that never gets ranked was already contributing to neither DCG nor ideal. It only
// stops the row reading as a repro failure.
//
// `excludeTitles`, which used to name those rows, is no longer read: its predicate was "not the primary
// book", and that stopped being the scope boundary once every book got loaded.
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
import { tokenize } from '../extension/lexical.mjs';
import { norm } from '../plugin/vector.mjs';
import * as queryBuild from '../extension/query.mjs';
import * as entity from '../extension/entity.mjs';
import * as matcher from '../extension/matcher.mjs';
import { gradeValue } from './metrics.mjs';
// Scene loading, the gazetteer, the scorers, the pool and the nDCG math all live in scene.mjs, shared with
// param-screen.mjs — there must be exactly one copy of them (see that module's header).
import { entryKey } from '../extension/content-lexical.mjs';
import { resolveModel } from './reindex.mjs';
import { dcg, embed as embedWith, haystackFor, indexPath, isDurableEntry, loadScene, makeLayoutOrder, makeGradeOf, makeKeywordScore, makeCandidateSet, ndcg, nrm, openSample, sceneParams, inVectorIndex, wiTitle, sceneLabel } from './scene.mjs';

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
if (!arg('--sample')) { console.error('need --sample <sample.json> (write one with /wa-grade)'); process.exit(2); }
const S = openSample(arg('--sample'), arg('--arm'));
// '' is a failed capture (retrieval activated nothing), not a frozen query — treat it as missing so the
// guards below demand a chat instead of silently embedding and scoring an empty string.
if (!S.query) delete S.query;
const CHAT = arg('--chat') ?? S.sceneChat;
const GRADES = S.entries ?? [];
const UNJUDGED_ZERO = arg('--unjudged') === 'zero';
// --validate is opt-in: a sample RECORDS its capture (so the check is always one bare flag away) but
// naming one must not silently turn a grid run into a validation run.
const vArg = arg('--validate');
const VALIDATE = process.argv.includes('--validate') ? ((vArg && !vArg.startsWith('--')) ? vArg : S.capture) : null;
// The converse silent turn is just as wrong: an explicitly requested validation must not quietly become a
// grid run because the sample happens to record no capture (/wa-grade doesn't write one).
if (process.argv.includes('--validate') && !VALIDATE) { console.error('--validate given but the sample records no "capture" — pass --validate <capture.json>, or add a "capture" path to the sample'); process.exit(2); }
const DEPTH = Number(arg('--depth') ?? S.params?.depth ?? 10);
// THE MODEL IS A SPEC, resolved once (reindex.mjs resolveModel). The LABEL names collections and bases;
// the rest says how to call the model, including the task prefix a prefix-trained family needs. A bare
// name is an ollama model.
// FALLS BACK TO THE BUNDLE'S OWN MODEL, not to a hardcoded name. A bundle records the model its
// collections are keyed under, and hardcoding one meant a corpus that had moved on still resolved the old
// collections — which exist, so nothing errored, it just quietly measured the previous model.
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434', MODEL = process.env.WA_EMBED_MODEL ?? S.embedModel;
if (!MODEL) { console.error('sample records no embedModel — set WA_EMBED_MODEL'); process.exit(2); }
const EM = resolveModel(MODEL);
// Signals the capture was produced under. Defaults are one tuned chat's snapshot, NOT the shipped defaults
// (extension/state.mjs ships K1 1.2) — an arm overrides them via its own `params`, which is
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
// Keyed-but-empty is a malformed bundle: the book is named, its entries were not copied.
if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`sample embeds no entries for its primary book "${S.primaryBook ?? '?'}" — malformed; re-capture it with /wa-grade`); process.exit(2); }
// The population is the log, never a re-derivation: half of what core activates (secondary keys, inclusion
// groups, recursion, min-activations, probability rolls) is not computable offline. See POOL below.
if (!S.candidates?.length) { console.error('sample logs no `candidates` — nothing to rank; re-grade with /wa-grade'); process.exit(2); }
// --depths needs a message list, not necessarily the FILE: an embedded `queryChat` ablates down to any
// depth <= the capture depth without it (see below). Only going wider needs the chat.
if (!CHAT && !S.sceneChat && (S.query === undefined || (DEPTHS && !S.queryChat?.length))) { console.error(DEPTHS ? '--depths needs the original chat or an embedded "queryChat": pass --chat, or record "sceneChat" on the scene' : 'sample has no frozen "query" — pass --chat (with --freeze to snapshot it into the sample)'); process.exit(2); }
if (S.name) console.log(`scene: ${sceneLabel(S)}${S.notes ? ` — ${S.notes}` : ''}`);
const VECTORS = arg('--vectors') ?? 'data/default-user/vectors/ollama';
// `all` FROM THE SCENE'S OWN PARAMS, which default it on: denseAllEntries splits the collection by stage
// and cannot be scored against a vectorized-only build, so resolving without it named a file loadScene
// then refused. Same resolution param-screen's reload arms take.
const INDEX = indexPath(S, { vectors: VECTORS, model: EM.label, index: arg('--index'), all: P.denseAllEntries });
const TOPK = Number(arg('--topk')) || undefined;   // unset = stage 1's own bound (scene.mjs makeCandidateSet); --topk probes the elbow's window sensitivity.

// --- inputs ---
// A /wa-grade sample carries copies of every attached book, so it re-runs identically after the live
// lorebooks have been edited. Nothing here reads a live book.
// Bound whole AND destructured: `makeLayoutOrder` takes the scene object (it reads `entries` for the per-book
// name df), and referencing an undefined `scene` there was a latent ReferenceError this file could not
// reach while its index resolution was also wrong.
const scene = loadScene(S, { indexFile: INDEX, indexOpts: { vectors: VECTORS, model: EM.label }, params: P });
const { primary, books, entries, byKey, items, loaded, gaz, gazSource, outOfScope, POOL, OWN } = scene;
console.log(`books: ${books.length} ranked (primary "${primary}"), ${entries.length} entries`);

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
// THE COMPOSER, not a window: per entry, so its own scanDepth, the injects that depth reaches and the
// card/persona fields it opted into all apply — the same assembly the runtime uses.
const haystackOf = (msgs, depth) => haystackFor(S, P, { chat: msgs, depth });
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
const query = chat ? queryBuild.buildQuery(chat, { depth: DEPTH }) : S.query;
const scanText = haystackOf(chat ?? S.scanChat ?? [], DEPTH);
// The retrieval math lives in the deployed plugin, so a redeploy can move every per-entry signal without a
// settings change (server-side entry pooling did). Grades collected under different arithmetic are still
// valid as RELEVANCE, but the ranking they were paired with is not the one being scored here.
if (S.invalidConfiguration) console.log(`!! NOT A REAL CONFIGURATION — ${S.invalidConfiguration}. Scored here for inspection; it must not enter a pooled set.`);
if (S.pluginFP && S.sourceFP && S.pluginFP !== S.sourceFP) console.log(`!! sample captured against a STALE plugin (deployed ${S.pluginFP} vs source ${S.sourceFP}) — its recorded scores predate the current retrieval math`);
// Injects ARE modelled now — the document records them with their depth and `haystackFor` admits them, so a
// depth row scans what the capture would have at that depth. What it cannot invent is an inject a capture
// never recorded, which is what a pre-`sceneInjects` bundle is.
if (S.params?.allowWIScan && !(S.injects ?? []).length) console.log('!! captured with the Author\'s Note in the WI scan but recording no injects — the rebuild scans less text than the capture did');
// The embedding model is the one input that silently invalidates everything: cosines from a different model
// are not comparable, the derived index path would point somewhere else, and nothing downstream would look
// wrong. Harmless to skip while every sample is your own capture at your own default; a hard stop as soon as
// samples arrive from other people, which is the entire point of collecting grade dumps.
if (S.embedModel && resolveModel(S.embedModel).label !== EM.label) {
    console.error(`sample was captured under embedding model "${S.embedModel}" but this run uses "${EM.label}" — cosines are not comparable. Set WA_EMBED_MODEL=${S.embedModel}, or pass --index explicitly if you have rebuilt the index under ${EM.label}.`);
    if (!process.argv.includes('--force')) process.exit(2);
    console.error('(--force given: continuing anyway, numbers are not trustworthy)');
}

if (FREEZE) {
    const path = arg('--sample');
    if (!path) { console.error('--freeze needs --sample <manifest.json> to write into'); process.exit(2); }
    if (S.query !== undefined && S.query !== query) {
        console.warn('!! --freeze is REPLACING an existing snapshot and the chat no longer yields the same query — has the chat been played on since grading? The grades may no longer describe this scene.');
    }
    writeFileSync(path, `${JSON.stringify({ ...S, query, scanText, frozenAt: new Date().toISOString() }, null, 2)}\n`);
    console.log(`froze query (${query.length} chars) + scan window (${scanText.length} chars) into ${path}`);
}

// --- entity filter: the gazetteer is built in loadScene (see scene.mjs for what it reads
// here — reading raw book keys admitted 2.3x the terms and moved BM25 by up to 74%). Only the query-
// dependent term weights are derived per run, since --depths rebuilds the query.
const termWeights = P.entityFilter ? entity.buildTermWeights(query, gaz, P.boost) : null;

const keywordScore = makeKeywordScore(P);
// TWO EMBEDDERS, because the prefixes differ and mixing them compares two spaces. A query takes the task
// instruction; a DOCUMENT takes the doc prefix, which is what the self-check below re-embeds a stored
// chunk with — prefixing that as a query would drop the self-check cosine and read as a broken index.
const embedOpts = { ollama: OLLAMA, model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url };
const embed = text => embedWith(EM.query + text, embedOpts);
const embedDoc = text => embedWith(text, embedOpts);
const fmt = n => (n == null ? '·' : (+n).toFixed(3));

(async () => {
    const qv = await embed(query);
    // self-check: re-embed a stored chunk → mean-centered cosine ~1
    const c0 = (v => { const o = v.map((x, i) => x - loaded[0].mean[i]); const n = norm(o) || 1; return o.map(x => x / n); })(items[0].vector);
    const r0 = (v => { const o = v.map((x, i) => x - loaded[0].mean[i]); const n = norm(o) || 1; return o.map(x => x / n); })(await embedDoc(items[0].metadata.text));
    console.log(`query (${DEPTH} msgs, ${query.length} chars): "${query.slice(0, 80).replace(/\n/g, ' ')}…"`);
    console.log(`self-check cosine: ${r0.reduce((s, x, i) => s + x * c0[i], 0).toFixed(4)} | entities kept: ${termWeights ? Object.keys(termWeights).length : 'all (filter off)'}\n`);

    // Per-entry signals via the SHARED scorer in scene.mjs (exact plugin vector + BM25 + selection, then
    // keyword). Wrapped only to keep this file's defaults — the report code below sweeps k1/b/tw and leaves
    // the query and scan window alone.
    const score = makeCandidateSet({ loaded, byKey, entries, params: P, topK: TOPK });
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
    // Reference rows (constants, configured stickies) are tiered off: always-on entries aren't relevance results.
    //
    // THE POOL IS WHAT WAS JUDGED, and nothing else. For an ordinary single-arm sample it reads as it always
    // did, because grades are collected FROM the candidate list. For a /wa-super-grade sample the grades span
    // the union of N population-changing arms, so an entry only a SIBLING arm surfaced is judged too, and
    // counting it is what makes a wrong promotion visible instead of silently filtered out of the ranking.
    //
    // What is NOT in the pool is a logged row nobody graded. A sample may record a population wider than the
    // graded set — an offline re-derivation does — and treating those rows as judged reported full coverage
    // on a scene that was 18% judged.
    //
    // ponytail: the union is over the arms actually run, not over the whole parameter space, so a param swept
    // far outside those arms is still ranking against a pool that never saw its population. Widen the arm set
    // (or grade a fresh super-sample) rather than trusting a lone distant arm.
    const ownJudged = [...OWN].filter(k => POOL.has(k)).length;
    console.log(`pool: ${POOL.size} judged entries; this capture logged ${S.candidates.length} rows, ${ownJudged} of them judged`
        + `${POOL.size > ownJudged ? ` (+${POOL.size - ownJudged} judged under a sibling arm)` : ''}`
        + `${OWN.size > ownJudged ? ` — ${OWN.size - ownJudged} logged rows are UNJUDGED and score as 0` : ''}`);

    let poolWarned = false;
    // TWO RANKING POPULATIONS, PRINTED SIDE BY SIDE, because a parameter can belong to either and which one
    // it belongs to CHANGES. Neither is the eval metric: selection is, and it is unranked.
    //
    //   layout   every non-DURABLE row — memory and reference together. The cliff cuts a prefix of exactly
    //            this, so it is the diagnostic for cutoff and tail decisions, and the primary column.
    //   vector   vectorized rows alone. The narrow diagnostic for the cosine half — centering, chunking,
    //            threshold, embedder.
    //
    // Durable rows leave both: relevance never chose a constant or an armed sticky, so ranking one charges
    // the ranker for an author's declaration. Reference rows STAY in layout — they compete for the same
    // slots and the cliff can drop them, so removing them would hide the decision being measured.
    //
    // BOTH ARE PRINTED because a parameter's membership changes. k1, b and lexicalWeight move only
    // vectorized rows while they are the only rows carrying textScore, and move every row once a keyword
    // entry's CONTENT is lexically scored.
    // nDCG@R, R = the relevant count in the population being scored, at the recall bar (>= 3). A fixed k
    // asks a different question of every scene: at k=10 a scene with 2 relevant saturates on two positions
    // and one with 26 cannot express sixteen of them. R holds the depth at the scene's own difficulty, so
    // the number reads as "given a cut in the right place, how good is the ordering" — which is the half
    // nDCG is for, the other half being where the cut actually fell.
    //
    // R IS POOL-DEPENDENT: an incomplete pool understates it and evaluates too shallow. judged@10 is the
    // guard, and a null scene (R=0) prints '—' rather than 0/0.
    const ndcgAtR = g => { const R = g.filter(x => x >= 3).length; return R ? ndcg(g, R) : NaN; };
    const fmtR = v => (Number.isNaN(v) ? '  —   ' : v.toFixed(4));

    const layoutOf = list => list.filter(r => !isDurableEntry(r.entry));
    const vectorOf = list => list.filter(r => !isDurableEntry(r.entry) && inVectorIndex(r));

    const activated = rows => {
        // --unjudged zero: don't restrict to the pool at all; ungraded rows keep their signals and score 0
        // (gradeOf's default). Restricting to the pool makes a wrong promotion INVISIBLE — the promoted entry
        // is filtered out rather than penalised — which is why fine-grained arms (boost 1..8) collapse to
        // identical scores there while coarse ones (filter on/off) still separate. Scoring unjudged as 0
        // restores that resolution at the cost of assuming nothing relevant sits outside the pool; see the
        // grade profiles in eval-data (relevance is sparse and the pools bottom out around rank 24-28).
        if (UNJUDGED_ZERO) return rows;
        const kept = rows.filter(r => POOL.has(entryKey(r.entry)));
        // Coverage is measured against THIS capture's own rows, not the union. A sibling arm's entry that
        // fails to re-derive here is the arms disagreeing about population — the thing a super-sample exists
        // to measure — not a swept param drifting off the graded reality, which is the thing being warned
        // about. Comparing against the union would fire on every super-sample and mean nothing.
        const own = kept.filter(r => OWN.has(entryKey(r.entry))).length;
        if (!poolWarned && own < OWN.size) {
            poolWarned = true;
            console.log(`   pool coverage: re-derivation produced ${own}/${OWN.size} of this capture's own entries at these params (missing ones score no signals and drop out of the ranking)`);
        }
        return kept;
    };

    const layoutOrder = makeLayoutOrder({ scene, haystack: haystackFor(S, P) });

    if (VALIDATE) {
        const capAll = JSON.parse(readFileSync(VALIDATE, 'utf8')).filter(r => (r.block === undefined || r.block === 'dynamic') && !(Number(r.sticky) > 0));
        const cap = capAll.filter(r => !outOfScope(r));
        if (cap.length < capAll.length) console.log(`(skipping ${capAll.length - cap.length} out-of-scope row(s): ${capAll.filter(r => outOfScope(r)).map(r => r.title).join(', ')})`);
        const mine = layoutOrder(scoreAll(P.K1, P.B));
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
    const gradesAll = GRADES.filter(x => x && x.title && Number.isFinite(gradeValue(x))).map(x => ({ tk: nrm(x.title), g: gradeValue(x), title: x.title }));
    const grades = gradesAll.filter(g => !outOfScope(g));
    if (grades.length < gradesAll.length) console.log(`excluded ${gradesAll.length - grades.length} out-of-scope grade(s) — their book is not embedded, so nothing here can rank them: ${gradesAll.filter(g => outOfScope(g)).map(g => `"${g.title}"`).join(', ')}\n`);
    const gradeOf = makeGradeOf(S.entries, { outOfScope, primary });
    const DEF = { k1: 1.2, b: 0.75 };   // shipped defaults (extension/state.mjs)
    const relCount = grades.filter(x => x.g >= 3).length;

    // --- depth sweep (--depths): the one axis a frozen sample can't test by itself, because the query TEXT
    // is what's frozen. Rebuilds the query and the keyword scan window from the chat at each depth, re-embeds
    // (one local call each), and scores at the shipped defaults. The grades are held fixed: widening the
    // window only reaches further BACK from the same graded moment, so it adds context to the same scene
    // rather than moving to a different one.
    if (DEPTHS) {
        // Trust check first: does the chat still reproduce this sample's own query at its own depth? If not,
        // it has been played on since grading and every wider depth would describe a different scene.
        const own = queryBuild.buildQuery(chat, { depth: DEPTH });
        const faithful = own === S.query;
        console.log(`chat check: rebuilding at the sample's own depth ${DEPTH} ${faithful ? 'reproduces its frozen query exactly' : `DIFFERS (${own.length} vs ${S.query?.length ?? 0} chars) — chat played on since grading; wider depths describe a different scene`}`);
        if (!faithful && !process.argv.includes('--force')) { console.error('refusing to sweep an unfaithful chat; pass --force to override'); process.exit(1); }

        console.log(`\ndepth sweep at shipped k1=${DEF.k1} b=${DEF.b}, ${relCount} relevant (grade>=3)`);
        // `blind` is the ablation's honesty column: entries this depth's cut keeps that the grader was never
        // shown, and which therefore score 0 whether or not they are relevant. Narrowing the window is not a
        // pure subset operation — a shorter, more focused query can promote an entry the wide capture ranked
        // out of the graded pool entirely — so a depth row with a high blind count is understating itself.
        // If it stays at 0, one wide capture ablates down cleanly and no extra grading is needed.
        console.log(' depth | qChars  msgs  terms | layout@10 layout@R vector@R  meanRank  blind');
        for (const d of DEPTHS) {
            const q = queryBuild.buildQuery(chat, { depth: d });
            const st = haystackOf(chat, d);
            const tw = P.entityFilter ? entity.buildTermWeights(q, gaz, P.boost) : null;
            const v = await embed(q);
            const rows = scoreAll(DEF.k1, DEF.b, tw, v, q).map(r => ({ ...r, keywordScore: (e => keywordScore(e, st(e), DEF.k1))(byKey.get(entryKey(r.entry)) ?? { key: [] }) }));
            const fused = layoutOrder(layoutOf(rows));
            const gVec = layoutOrder(vectorOf(rows)).map(r => gradeOf(r) ?? 0);
            const g = fused.map(r => gradeOf(r) ?? 0);   // unjudged occupies its rank and contributes nothing (makeGradeOf returns null)
            const hits = fused.map((r, i) => [gradeOf(r), i + 1]).filter(([gr]) => gr >= 3).map(([, i]) => i);
            const mean = hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : NaN;
            const blind = fused.filter(r => !POOL.has(entryKey(r.entry))).length;
            const tag = d === DEPTH ? '  <- as graded' : '';
            console.log(`${String(d).padStart(6)} | ${String(q.length).padStart(6)}  ${String(Math.min(d, chat.length)).padStart(4)}  ${String(tw ? Object.keys(tw).length : 'all').padStart(5)} | ${ndcg(g, 10).toFixed(4)}   ${fmtR(ndcgAtR(g))}   ${fmtR(ndcgAtR(gVec))}  ${mean.toFixed(1).padStart(8)}  ${String(blind).padStart(4)}/${fused.length}${tag}`);
        }
        return;
    }

    // --- ranking: k1 × b, graded nDCG. NO lexW DIMENSION: it weighted BM25 against the vector signal
    // inside RRF, and RRF is gone — the layout is ordered by E[credit], which reads the signals through
    // fitted coefficients rather than a hand-set ratio. Sweeping it returned five identical cells per
    // (k1, b) and named an arbitrary one of them best.
    // @10 IS THE TARGET, @5 is carried as a secondary column. Relevance on these scenes runs deep enough
    // (pools bottom out around rank 24-28) that ranks 6-10 carry real signal rather than padding, so tuning
    // on @5 optimises a window narrower than the decision being made. Argmax on @10 for the same reason.
    console.log('grid (k1 × b) — graded nDCG on the scene\n  k1     b | layout@10 layout@R vector@10 vector@R  judged@10');
    let best = null;
    let worst = null;
    for (const k1 of [1.2, 2, 3]) for (const b of [0.6, 0.75, 0.9]) {
        const all = scoreAll(k1, b);
        const rows = activated(all);
        // JUDGED@10 — pool reusability, and the stopping rule for /wa-super-grade's rounds.
        //
        // Computed on the UNFILTERED re-derivation, before activated(), which is the whole point:
        // restricting to the pool first would report 10/10 by construction. The question is whether the
        // top 10 THIS RANKING produces carries grades at all, from any rater — and where it does not,
        // this row's nDCG is a LOWER BOUND, because an unjudged entry scores 0 whether
        // or not it is relevant. NOT a statement about what ships: this is a prefix of a ranking, and
        // what ships is what survives selection. Nor about human raters — most of the pool is judged. A config with gaps therefore cannot be compared against one without
        // until the gap is graded, which is exactly what makes a pool built from one configuration
        // useless for a zero-based defaults review. Fix by adding arms, not by reading past it.
        //
        // layoutOrder() mutates the row objects it is handed and `rows` shares references with `all`, so this
        // has to read its slice before the re-rank below reorders the subset.
        //
        // NOT ALWAYS REACHABLE AT 10/10, and it matters that you know why before chasing it. This fused
        // layout ranking spans every entry with any signal — including keyword-only rows that scoreAll
        // adds from the book directly — whereas a live capture only ever logs what ST CORE activated.
        // A keyword-only row core would have rejected (failed secondary keys, lost a probability roll,
        // outside an inclusion group) can therefore sit in this top-10 and never be gradeable by any arm.
        // The named titles below are how you tell that case from a real pooling gap: if a missing entry
        // shows up in a live /wa-super-grade run, grade it; if no arm ever surfaces it, it is a phantom of
        // offline re-derivation and the honest ceiling for this cell is below 10/10.
        const top = layoutOrder(all).slice(0, 10);
        const unjudged = top.filter(r => !POOL.has(entryKey(r.entry)));
        const j10 = top.length - unjudged.length;
        const g = layoutOrder(layoutOf(rows)).map(r => gradeOf(r) ?? 0);   // unjudged occupies its rank and contributes nothing (makeGradeOf returns null)
        const gVec = layoutOrder(vectorOf(rows)).map(r => gradeOf(r) ?? 0);
        const n10 = ndcg(g, 10), v10 = ndcg(gVec, 10), nR = ndcgAtR(g), vR = ndcgAtR(gVec);
        if (!best || nR > best.nR || (Number.isNaN(best.nR) && n10 > best.n10)) best = { k1, b, nR, n10, j10, of: top.length, unjudged: unjudged.map(r => `${r.title} (#${top.indexOf(r) + 1})`) };
        if (!worst || j10 - top.length < worst.j10 - worst.of) worst = { k1, b, j10, of: top.length };
        const tag = k1 === DEF.k1 && b === DEF.b ? '  <- shipped default' : '';
        console.log(`${String(k1).padStart(4)}  ${String(b).padStart(4)} | ${n10.toFixed(4)}   ${fmtR(nR)}   ${v10.toFixed(4)}   ${fmtR(vR)}    ${String(j10).padStart(2)}/${top.length}${j10 < top.length ? ' !!' : '   '}${tag}`);
    }
    console.log(`\nbest layout@R: k1=${best.k1} b=${best.b} -> ${fmtR(best.nR)} (@10 ${best.n10.toFixed(4)}), judged ${best.j10}/${best.of}`);
    // The argmax is the cell whose coverage matters most: if ITS top-10 isn't fully judged, the grid picked a
    // winner partly because nobody graded what it surfaced.
    if (best.j10 < best.of) {
        console.log(`!! THE ARGMAX IS NOT FULLY JUDGED (${best.j10}/${best.of}) — its nDCG is a lower bound and this pick is not defensible.`);
        console.log(`   ungraded in its top 10: ${best.unjudged.join(', ')}`);
        console.log('   re-run /wa-super-grade, load this sample as a prior, and grade the delta. If no arm ever surfaces those entries, see the judged@10 note above.');
    }
    if (worst.j10 < worst.of) console.log(`!! worst coverage in the grid: ${worst.j10}/${worst.of} at k1=${worst.k1} b=${worst.b} — that cell is penalised for surfacing entries nobody judged.`);
    else console.log('pool is reusable across this grid: every cell\'s top-10 is fully judged.');

    // --- entity filter: mean rank of the graded targets, at production's suppressed gazetteer. This is
    // the arm that re-measures entity.mjs buildTermWeights, whose own tuning was done at stage 1 against
    // a gazetteer built from raw book keys — 2.3x the terms production admits.
    const rankMetrics = tw => {
        const all = scoreAll(DEF.k1, DEF.b, tw);
        // Coverage before the pool filter, same reasoning as the grid above. These arms need it most: turning
        // the entity filter off is exactly the kind of population change a defaults-shaped pool never saw.
        const top = layoutOrder(all).slice(0, 10);
        const j10 = top.filter(r => POOL.has(entryKey(r.entry))).length;
        const rows = layoutOrder(layoutOf(activated(all)));
        const gVec = layoutOrder(vectorOf(activated(all))).map(r => gradeOf(r) ?? 0);
        const hits = rows.map((r, i) => [gradeOf(r), i + 1]).filter(([g]) => g >= 3).map(([, i]) => i);
        const g = rows.map(r => gradeOf(r) ?? 0);   // unjudged occupies its rank and contributes nothing (makeGradeOf returns null)
        return { found: hits.length, mean: hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : NaN, top10: hits.filter(i => i <= 10).length, n10: ndcg(g, 10), nR: ndcgAtR(g), v10: ndcg(gVec, 10), vR: ndcgAtR(gVec), j10, of: top.length };
    };
    const filterArms = [
        ['production (gaz + boost 3)', termWeights],
        ['NO entity filter (raw query)', null],
        ['no gazetteer (boost only)', entity.buildTermWeights(query, new Set(), P.boost)],
        ...[1, 2, 5, 8].map(bo => [`boost=${bo} (with gazetteer)`, entity.buildTermWeights(query, gaz, bo)]),
        // Gazetteer widened with every entry BODY, not just keys+titles. Term count alone can't judge this
        // (it still keeps the proper-noun boost, and stopwordDf still strips corpus-common terms), so it
        // gets measured like any other arm rather than argued about.
        ['+ entry content in gaz', entity.buildTermWeights(query, new Set([...gaz, ...gazSource.flatMap(e => tokenize(e.content ?? ''))]), P.boost)],
    ];
    console.log(`\nentity filter — mean rank of the ${relCount} graded targets (grade>=3), lower is better`);
    console.log('  arm                          | terms  found  mean rank  in top10  layout@10 layout@R vector@10 vector@R  judged@10');
    for (const [label, tw] of filterArms) {
        const m = rankMetrics(tw);
        const tag = tw === termWeights ? '  <- shipped' : '';
        console.log(`  ${label.padEnd(28)} | ${String(tw ? Object.keys(tw).length : 'all').padStart(5)}  ${String(m.found).padStart(5)}  ${m.mean.toFixed(1).padStart(9)}  ${String(m.top10).padStart(8)}  ${m.n10.toFixed(4)}  ${fmtR(m.nR)}  ${m.v10.toFixed(4)}  ${fmtR(m.vR)}   ${String(m.j10).padStart(2)}/${m.of}${m.j10 < m.of ? ' !!' : ''}${tag}`);
    }
})();
