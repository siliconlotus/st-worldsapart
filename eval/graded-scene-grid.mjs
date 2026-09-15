// Graded-scene grid: reproduce WA's retrieval ranking for a real scene offline, score it against human 0-4 grades with nDCG, and sweep any parameter.
// Usage (from SillyTavern root):
//   node .../graded-scene-grid.mjs --sample <sample.json> [--index <index.json>] [--validate <capture.json>]
//   node .../graded-scene-grid.mjs --sample <sample.json> --chat <chat.jsonl> --depth 5 --freeze    # snapshots query + scan messages into the bundle
// --sample is a /wa-grade sample, paths relative to the ST root. Shape:
//
//   {
//     "name": "scene1",
//     "query": "Apollo: …",          // the retrieval query, verbatim — see FREEZE below
//     "queryChat": [{name, mes}, ...],    // the messages it was joined from, for the depth sweep
//     "scanChat": [{name, mes}, ...],     // the messages the keyword scan window is cut from
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
// The query text is frozen, never the chat: a played-on chat scores a different scene against the old grades with no error.
import { readFileSync, writeFileSync, statSync, openSync, readSync } from 'node:fs';
import { isDurable } from '../extension/grading.mjs';
import { defaultSettings } from '../extension/state.mjs';
import { tokenize } from '../extension/lexical.mjs';
import { norm } from '../plugin/vector.mjs';
import * as queryBuild from '../extension/query.mjs';
import * as entity from '../extension/entity.mjs';
import * as matcher from '../extension/matcher.mjs';
import { gradeValue } from './lib/metrics.mjs';
// One copy of the gazetteer and scorers: scene.mjs.
import { entryKey } from '../extension/content-lexical.mjs';
import { resolveModel } from './lib/reindex.mjs';
import { dcg, embed as embedWith, haystackFor, indexPath, isDurableEntry, loadScene, makeLayoutOrder, makeGradeOf, makeKeywordScore, makeCandidateSet, ndcg, nrm, openSample, sceneParams, inVectorIndex, wiTitle, sceneLabel } from './lib/scene.mjs';

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
if (!arg('--sample')) { console.error('need --sample <sample.json> (write one with /wa-grade)'); process.exit(2); }
const S = openSample(arg('--sample'), arg('--arm'));
// '' is a failed capture, not a frozen query.
if (!S.query) delete S.query;
const CHAT = arg('--chat') ?? S.sceneChat;
const GRADES = S.entries ?? [];
const UNJUDGED_ZERO = arg('--unjudged') === 'zero';
// Opt-in: a sample records its capture, but naming one must not turn a grid run into a validation run.
const vArg = arg('--validate');
const VALIDATE = process.argv.includes('--validate') ? ((vArg && !vArg.startsWith('--')) ? vArg : S.capture) : null;
if (process.argv.includes('--validate') && !VALIDATE) { console.error('--validate given but the sample records no "capture" — pass --validate <capture.json>, or add a "capture" path to the sample'); process.exit(2); }
const DEPTH = Number(arg('--depth') ?? S.params?.depth ?? 10);
// Falls back to the bundle's own model, never a hardcoded name (H3).
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434', MODEL = process.env.WA_EMBED_MODEL ?? S.embedModel;
if (!MODEL) { console.error('sample records no embedModel — set WA_EMBED_MODEL'); process.exit(2); }
const EM = resolveModel(MODEL);
const P = sceneParams(S);
const FREEZE = process.argv.includes('--freeze');
// --depths rebuilds the query from the chat at each depth; the query text is the frozen artifact.
const DEPTHS = arg('--depths') ? String(arg('--depths')).split(',').map(Number).filter(d => d > 0) : null;
// No disk fallback: reading the live lorebook is what let an edit move an already-graded scene's numbers.
if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`sample embeds no entries for its primary book "${S.primaryBook ?? '?'}" — malformed; re-capture it with /wa-grade`); process.exit(2); }
// The population is the log, never a re-derivation: half of what core activates is not computable offline.
if (!S.candidates?.length) { console.error('sample logs no `candidates` — nothing to rank; re-grade with /wa-grade'); process.exit(2); }
if (!CHAT && !S.sceneChat && (S.query === undefined || (DEPTHS && !S.queryChat?.length))) { console.error(DEPTHS ? '--depths needs the original chat or an embedded "queryChat": pass --chat, or record "sceneChat" on the scene' : 'sample has no frozen "query" — pass --chat (with --freeze to snapshot it into the sample)'); process.exit(2); }
if (S.name) console.log(`scene: ${sceneLabel(S)}${S.notes ? ` — ${S.notes}` : ''}`);
const VECTORS = arg('--vectors') ?? 'data/default-user/vectors/ollama';
// all from the scene's own params: denseAllEntries cannot be scored against a vectorized-only build.
const INDEX = indexPath(S, { vectors: VECTORS, model: EM.label, index: arg('--index'), all: P.denseAllEntries });
const TOPK = Number(arg('--topk')) || undefined;   // unset = stage 1's own bound (scene.mjs makeCandidateSet); --topk probes the elbow's window sensitivity.

// Nothing here reads a live book; the sample carries copies of every attached book.
const scene = loadScene(S, { indexFile: INDEX, indexOpts: { vectors: VECTORS, model: EM.label }, params: P });
const { primary, books, entries, byKey, items, loaded, gaz, gazSource, outOfScope, POOL, OWN } = scene;
console.log(`books: ${books.length} ranked (primary "${primary}"), ${entries.length} entries`);

// Tail-read: a long graded chat is ~100MB and only the last few messages are used.
function tailMessages(path, bytes = 8e6) {
    const size = statSync(path).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    const fd = openSync(path, 'r');
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();   // a mid-line start yields a broken first record
    return lines.filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}
// The composer, not a window: per entry, so its own scanDepth and injects apply.
const haystackOf = (msgs, depth) => haystackFor(S, P, { chat: msgs, depth });
// queryChat reproduces any depth <= the capture depth without the chat file; an explicit --chat wins because only the file can go wider.
const wantChat = S.query === undefined || FREEZE || (DEPTHS && (arg('--chat') !== null || !S.queryChat?.length));
if (wantChat && !CHAT) { console.error(FREEZE ? '--freeze needs a chat to snapshot from: pass --chat, or record "chat" in the sample' : 'no chat available: pass --chat, or record "chat" in the sample'); process.exit(2); }
// Only the depth sweep re-derives; re-deriving unconditionally would replace a SUMMARY query with raw messages.
const chat = wantChat ? tailMessages(CHAT) : (DEPTHS && S.queryChat?.length ? S.queryChat : null);
if (DEPTHS && chat === S.queryChat) {
    const over = DEPTHS.filter(d => d > S.queryChat.length);
    if (over.length) console.log(`!! depths ${over.join(',')} exceed the ${S.queryChat.length} captured messages — those rows repeat the widest window; pass --chat to actually widen it`);
}
const query = chat ? queryBuild.buildQuery(chat, { depth: DEPTH }) : S.query;
const scanText = haystackOf(chat ?? S.scanChat ?? [], DEPTH);
if (S.invalidConfiguration) console.log(`!! NOT A REAL CONFIGURATION — ${S.invalidConfiguration}. Scored here for inspection; it must not enter a pooled set.`);
if (S.pluginFP && S.sourceFP && S.pluginFP !== S.sourceFP) console.log(`!! sample captured against a STALE plugin (deployed ${S.pluginFP} vs source ${S.sourceFP}) — its recorded scores predate the current retrieval math`);
if (S.params?.allowWIScan && !(S.injects ?? []).length) console.log('!! captured with the Author\'s Note in the WI scan but recording no injects — the rebuild scans less text than the capture did');
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
    // Into the document, never `S`: that is one arm flattened, with loadScene's availability filter
    // already applied to its entries, so writing it back drops every sibling arm and every filtered row.
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const sc = doc.scenes?.[0];
    if (!sc) { console.error(`${path} carries no \`scenes\` — not a graded-scene document`); process.exit(2); }
    const cell = (doc.arms ?? []).find(a => a.name === S.arm)?.scenes?.[sc.id];
    const target = cell?.query !== undefined ? cell : sc;   // stays where the bundle already hoisted it
    const frozenChat = chat.slice(-DEPTH).map(m => ({ name: m.name, mes: m.mes }));
    target.query = query;
    target.queryChat = frozenChat;
    (doc.sceneChats ??= {})[sc.id] = frozenChat;   // the scan MESSAGES; scanText is a per-entry composer
    sc.frozenAt = new Date().toISOString();
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`froze query (${query.length} chars) + ${frozenChat.length} scan message(s) into ${path}`);
}

// The gazetteer is built in loadScene (R22); only the query-dependent term weights are derived here.
const termWeights = P.entityFilter ? entity.buildTermWeights(query, gaz, P.boost) : null;

const keywordScore = makeKeywordScore(P);
// Two embedders: the self-check re-embeds a stored chunk with the doc prefix; prefixing it as a query drops the cosine.
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

    const score = makeCandidateSet({ loaded, byKey, entries, params: P, topK: TOPK });
    const scoreAll = (k1, b, tw = termWeights, qvec = qv, qtext = query, st = scanText) => score(k1, b, tw, qvec, qtext, st);
    // The pool is what was judged (POOL); an unjudged logged row scores as 0 (G10).
    // ponytail: the pool is the union of the arms actually run, so a param swept far outside them ranks against a pool that never saw its population.
    const ownJudged = [...OWN].filter(k => POOL.has(k)).length;
    console.log(`pool: ${POOL.size} judged entries; this capture logged ${S.candidates.length} rows, ${ownJudged} of them judged`
        + `${POOL.size > ownJudged ? ` (+${POOL.size - ownJudged} judged under a sibling arm)` : ''}`
        + `${OWN.size > ownJudged ? ` — ${OWN.size - ownJudged} logged rows are UNJUDGED and score as 0` : ''}`);

    let poolWarned = false;
    // Two populations: layout (every non-durable row) and vector (vectorized rows alone); durable rows leave both.
    // nDCG@R, R = relevant count (>= 3) in the population scored; a null scene prints — rather than 0/0.
    const ndcgAtR = g => { const R = g.filter(x => x >= 3).length; return R ? ndcg(g, R) : NaN; };
    const fmtR = v => (Number.isNaN(v) ? '  —   ' : v.toFixed(4));

    const layoutOf = list => list.filter(r => !isDurableEntry(r.entry));
    const vectorOf = list => list.filter(r => !isDurableEntry(r.entry) && inVectorIndex(r));

    const activated = rows => {
        // --unjudged zero keeps ungraded rows at 0 rather than filtering them out, which hides a wrong promotion (R21).
        if (UNJUDGED_ZERO) return rows;
        const kept = rows.filter(r => POOL.has(entryKey(r.entry)));
        // Coverage against this capture's own rows, not the union, or every super-sample fires.
        const own = kept.filter(r => OWN.has(entryKey(r.entry))).length;
        if (!poolWarned && own < OWN.size) {
            poolWarned = true;
            console.log(`   pool coverage: re-derivation produced ${own}/${OWN.size} of this capture's own entries at these params (missing ones score no signals and drop out of the ranking)`);
        }
        return kept;
    };

    const layoutOrder = makeLayoutOrder({ scene, haystack: haystackFor(S, P) });

    if (VALIDATE) {
        const capAll = JSON.parse(readFileSync(VALIDATE, 'utf8')).filter(r => !isDurable(r) && !(Number(r.sticky) > 0));
        const cap = capAll.filter(r => !outOfScope(r));
        if (cap.length < capAll.length) console.log(`(skipping ${capAll.length - cap.length} out-of-scope row(s): ${capAll.filter(r => outOfScope(r)).map(r => r.title).join(', ')})`);
        const mine = layoutOrder(scoreAll(P.K1, P.B));
        const find = title => { const gt = nrm(title); return mine.find(m => { const mt = new Set(nrm(m.title)); return gt.length && gt.every(t => mt.has(t)); }); };
        console.log('validation vs capture (dynamic) — cosine / text / keys, then ranks:');
        console.log('cap#  my#  | cosine(cap/mine)  text(cap/mine)  keys(cap/mine)  title');
        let n = 0, sd = 0;
        // Which signal disagrees is the diagnosis: cosine pins query + vectors + centering, keys the keyword scorer, text the lexical scorer.
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
    const DEF = { k1: defaultSettings.bm25K1, b: defaultSettings.bm25B };   // state.mjs owns them
    const relCount = grades.filter(x => x.g >= 3).length;

    // --depths: the grades are held fixed; widening the window reaches further back from the same graded moment.
    if (DEPTHS) {
        const own = queryBuild.buildQuery(chat, { depth: DEPTH });
        const faithful = own === S.query;
        console.log(`chat check: rebuilding at the sample's own depth ${DEPTH} ${faithful ? 'reproduces its frozen query exactly' : `DIFFERS (${own.length} vs ${S.query?.length ?? 0} chars) — chat played on since grading; wider depths describe a different scene`}`);
        if (!faithful && !process.argv.includes('--force')) { console.error('refusing to sweep an unfaithful chat; pass --force to override'); process.exit(1); }

        console.log(`\ndepth sweep at shipped k1=${DEF.k1} b=${DEF.b}, ${relCount} relevant (grade>=3)`);
        // blind: entries this depth keeps that the grader never saw, scoring 0 whether or not relevant.
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

    console.log('grid (k1 × b) — graded nDCG on the scene\n  k1     b | layout@10 layout@R vector@10 vector@R  judged@10');
    let best = null;
    let worst = null;
    for (const k1 of [1.2, 2, 3]) for (const b of [0.6, 0.75, 0.9]) {
        const all = scoreAll(k1, b);
        const rows = activated(all);
        // judged@10 on the unfiltered re-derivation, before activated(), or it reports 10/10 by construction.
        // layoutOrder() mutates the rows it is handed and rows shares references with all, so read this slice first.
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
    if (best.j10 < best.of) {
        console.log(`!! THE ARGMAX IS NOT FULLY JUDGED (${best.j10}/${best.of}) — its nDCG is a lower bound and this pick is not defensible.`);
        console.log(`   ungraded in its top 10: ${best.unjudged.join(', ')}`);
        console.log('   re-run /wa-super-grade, load this sample as a prior, and grade the delta. If no arm ever surfaces those entries, see the judged@10 note above.');
    }
    if (worst.j10 < worst.of) console.log(`!! worst coverage in the grid: ${worst.j10}/${worst.of} at k1=${worst.k1} b=${worst.b} — that cell is penalised for surfacing entries nobody judged.`);
    else console.log('pool is reusable across this grid: every cell\'s top-10 is fully judged.');

    const rankMetrics = tw => {
        const all = scoreAll(DEF.k1, DEF.b, tw);
        // Coverage before the pool filter, as in the grid.
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
