// core-compare.mjs — WA against ST core, scored on the set each one SHIPS.
//
// WHY THE BUDGET HAS TO BE IN THE LOOP. Every other readout here scores the set a rule NOMINATES, which
// for core is a claim about a prompt that does not fit: measured on this corpus, core nominates 34.2
// memory entries at 86.1% recall, and at a 25k budget it ships 14.4 at 66.4% — twenty points of that
// recall is cut by `entry.order`, a sort key that knows nothing about the turn. Reporting the nominated
// number as core's recall is a mistake this file exists to stop being made twice.
//
// WHAT CORE IS, HERE. Two activation routes unioned, exactly as an install runs them:
//   keywords  — every entry whose keys fire, INCLUDING vectorized ones. Core has no cosine opinion; a
//               vectorized entry with a keyword hit is activated on the hit alone. On this corpus 40.4%
//               of vectorized rows have one, which is why core's delivered set is so large and so
//               imprecise: STMB generates broad keys and they fire constantly.
//   vectors   — ST's Vector Storage extension force-activates its top `max_entries` above
//               `score_threshold`. Modelled as top-K by cosine, which OVERSTATES it: ST hashes whole
//               entries where this pools an entry's best chunk, and the threshold would cut some of K.
// Then the walk: `entry.order` descending, filled until the budget is gone. Ties keep insertion order.
//
// STILL AN UPPER BOUND. No probability rolls, inclusion groups, delay/cooldown, character or tag filters,
// `@@dont_activate`, `delayUntilRecursion` or recursion — every one of which only removes entries. A real
// core scores at or below what this prints. `--core-uids` takes a real install's answer when you have it.
//
// Usage (from SillyTavern root):
//   node .../core-compare.mjs <sample.json> [...] [--tier memory|reference|all] [--budget 25083,37624]
//        [--core-top-k 10] [--core-order order|newest|oldest] [--core-uids 1,2,3] [--tokenizer gpt-3.5-turbo]
import fs from 'node:fs';
import { haystackFor, indexPath, isMemory, loadScene, makeCandidateSet, makeGradeOf, openSample, sceneParams, makeFuse, sceneLabel } from './scene.mjs';
import { gradeCredit, fbeta, RECALL_WEIGHT } from './metrics.mjs';
import { offlineTokenCounter } from './tokens.mjs';
import { ensureIndex, resolveModel } from './reindex.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const VALUED = new Set(['--tier', '--budget', '--core-top-k', '--core-order', '--core-uids', '--tokenizer']);
const samples = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!samples.length) {
    console.error('need at least one sample: node core-compare.mjs <sample.json> [more.json ...] [--budget 25083]');
    process.exit(2);
}
const TIER = arg('--tier') ?? 'memory';
if (!['memory', 'reference', 'all'].includes(TIER)) { console.error(`--tier must be memory|reference|all, got ${TIER}`); process.exit(2); }
const BUDGETS = String(arg('--budget') ?? '5000,10000,15000,25000,40000').split(',').map(Number).filter(Number.isFinite);
const TOP_K = Number(arg('--core-top-k') ?? 10);
// A hand-tuned `order` is one author's workaround; uid is story order on an STMB book and stands in for a
// book nobody tuned. Both extremes are offered because an untuned book leaves every order equal, and which
// way the tie falls is ST's business rather than something to assume — measured, it is worth ~0.07 F2.
const CORE_ORDER = arg('--core-order') ?? 'order';
const ORDERS = {
    order: (a, b) => (Number(b.entry?.order ?? 0) - Number(a.entry?.order ?? 0)) || (Number(a.uid) - Number(b.uid)),
    newest: (a, b) => Number(b.uid) - Number(a.uid),
    oldest: (a, b) => Number(a.uid) - Number(b.uid),
};
if (!ORDERS[CORE_ORDER]) { console.error(`--core-order must be order|newest|oldest, got ${CORE_ORDER}`); process.exit(2); }
// A REAL INSTALL'S ANSWER, when you have one: run with WA disabled and read the entries ST inserted. It
// replaces the model entirely for that scene, which is the only way to retire the approximations above.
const CORE_UIDS = arg('--core-uids') ? new Set(String(arg('--core-uids')).split(',').map(Number)) : null;
const MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
const tk = offlineTokenCounter(arg('--tokenizer') ?? 'gpt-3.5-turbo');

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
/** Walk in the given order, taking what fits. Every cap in both systems is a prefix cut, so this is it. */
const fill = (rows, budget) => {
    const out = []; let spent = 0;
    for (const r of rows) { if (spent + r.tokens > budget) continue; out.push(r); spent += r.tokens; }
    return out;
};
/** The score of record: F2 over the DELIVERED SET, recall at >= 3, precision crediting a 2 at half. */
const scoreSet = (got, relevant) => {
    const precision = got.length ? mean(got.map(r => gradeCredit(r.graded ? r.g : 0))) : 0;
    const recall = got.filter(r => r.graded && r.g >= 3).length / relevant;
    return { f: fbeta(precision, recall, RECALL_WEIGHT), precision, recall, n: got.length, tokens: got.reduce((a, r) => a + r.tokens, 0) };
};

const scenes = [];
for (const file of samples) {
    let S; try { S = openSample(file); } catch (e) { console.error(`  ${file}: ${e.message}`); continue; }
    const P = sceneParams(S);
    // denseAllEntries is production's split and the harness default, so the collection wanted is the
    // --all one. ensureIndex returns an existing build rather than re-embedding; a book without one says
    // so and names the command, which is better than silently scoring the ordinary collection.
    let indexFile;
    try {
        const em = resolveModel(MODEL);
        indexFile = P.denseAllEntries
            ? (await ensureIndex(S, { all: true, model: em.model, prefix: em.doc, label: em.label, endpoint: em.endpoint, url: em.url, log: () => {} })).path
            : indexPath(S, { model: MODEL });
    } catch (e) { console.error(`  ${sceneLabel(S) || file}: ${e.message}`); continue; }
    let scene; try { scene = loadScene(S, { indexFile, params: P }); } catch (e) { console.error(`  ${sceneLabel(S) || file}: ${e.message}`); continue; }
    const rows = makeCandidateSet({ ...scene, params: P })(P.K1, P.B, null, [], S.query, haystackFor(S, P));
    if (!rows.length) continue;
    // makeFuse is what stage 4 orders by, so this reads WA's own layout rather than a second copy of it.
    const ranked = makeFuse({ scene, haystack: haystackFor(S, P) })(rows);
    const gradeOf = makeGradeOf(S.entries, scene.isExcluded);
    const enriched = ranked
        .filter(r => TIER === 'all' || (isMemory(r.entry) ? 'memory' : 'reference') === TIER)
        .map(r => {
            const g = gradeOf(r);
            return { ...r, tokens: tk.count(r.entry?.content), graded: Number.isFinite(g), g: Number.isFinite(g) ? g : 0 };
        });
    const relevant = enriched.filter(r => r.graded && r.g >= 3).length;
    if (!relevant) continue;
    scenes.push({ name: sceneLabel(S) || file, rows: enriched, relevant });
}
if (!scenes.length) { console.error('no scene had a relevant row in that tier'); tk.free(); process.exit(2); }

const coreNominate = (rows) => {
    if (CORE_UIDS) return rows.filter(r => CORE_UIDS.has(Number(r.uid)));
    const picked = new Set(rows.filter(r => (Number(r.keywordScore) || 0) > 0));
    for (const r of [...rows].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)).slice(0, TOP_K)) picked.add(r);
    return [...picked].sort(ORDERS[CORE_ORDER]);
};
// WA nominates what clears its tier's cutoff and walks it in the same quantity — which is what makes the
// budget a prefix cut rather than a second opinion.
const waNominate = rows => rows.filter(r => Number.isFinite(r.eCredit) && Number.isFinite(r.cutoff) && r.eCredit >= r.cutoff);

console.log(`${scenes.length} scene(s), ${TIER} tier, ${tk.tokenizer} tokens, core walked by ${CORE_UIDS ? 'a real install\'s answer' : CORE_ORDER}`);
console.log(`mean ${mean(scenes.map(s => s.rows.length)).toFixed(0)} candidates, ${mean(scenes.map(s => s.relevant)).toFixed(1)} relevant per scene\n`);
console.log('budget      core F2   core P   core R  core n  core tok |     WA F2     WA P     WA R    WA n   WA tok');
for (const budget of [...BUDGETS, Infinity]) {
    const c = scenes.map(s => scoreSet(fill(coreNominate(s.rows), budget), s.relevant));
    const w = scenes.map(s => scoreSet(fill(waNominate(s.rows), budget), s.relevant));
    const lbl = budget === Infinity ? 'none' : String(budget);
    console.log(`${lbl.padStart(7)}    ${mean(c.map(x => x.f)).toFixed(4)}   ${(100 * mean(c.map(x => x.precision))).toFixed(1).padStart(5)}%   ${(100 * mean(c.map(x => x.recall))).toFixed(1).padStart(5)}%  ${mean(c.map(x => x.n)).toFixed(1).padStart(5)}  ${Math.round(mean(c.map(x => x.tokens))).toString().padStart(8)} |   ${mean(w.map(x => x.f)).toFixed(4)}   ${(100 * mean(w.map(x => x.precision))).toFixed(1).padStart(5)}%   ${(100 * mean(w.map(x => x.recall))).toFixed(1).padStart(5)}%  ${mean(w.map(x => x.n)).toFixed(1).padStart(5)}  ${Math.round(mean(w.map(x => x.tokens))).toString().padStart(7)}`);
    // RELEVANT MATERIAL PER TOKEN, which is the comparison a budget actually poses and the one no F-beta
    // makes: a rule that finds more by spending more has not necessarily done better.
    const per = (x, s2) => (mean(x.map(y => y.recall)) * mean(s2.map(z => z.relevant)) / Math.max(1, mean(x.map(y => y.tokens))) * 1000).toFixed(3);
    console.log(`${' '.repeat(11)}relevant entries per 1k tokens — core ${per(c, scenes)}, WA ${per(w, scenes)}`);
}
// AT UNBOUNDED BUDGET CORE CAN SCORE WORSE THAN UNDER ONE, which is not a bug in the walk: truncation
// removes low-precision entries it should never have nominated, so the constraint partly rescues it.
tk.free();
