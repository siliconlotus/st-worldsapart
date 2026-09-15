// core-compare.mjs — WA against ST core, F2 scored on the set each one ships under a token budget.
// Core here is its keyword route at --core-depth unioned with top-K by cosine (the threshold is not modelled), walked by --core-order until the budget is gone: an upper bound, with no probability rolls, inclusion groups, delay/cooldown, filters, decorators or recursion. --core-uids takes a real install's answer instead (WA disabled, read what ST inserted).
// Usage (from SillyTavern root):
//   node .../core-compare.mjs <sample.json> [...] [--tier memory|reference|all] [--budget 25083,37624] [--core-top-k 5] [--core-order order|newest|oldest] [--core-depth 2] [--core-uids 1,2,3] [--tokenizer gpt-3.5-turbo]
// The defaults are a stock install (max_entries 5, depth 2, order untouched); a tuned install scores measurably higher (R14), so say which is being quoted.
import fs from 'node:fs';
import { haystackFor, indexPath, isMemory, loadScene, makeCandidateSet, makeGradeOf, openSample, sceneParams, makeLayoutOrder, sceneLabel } from './lib/scene.mjs';
import { gradeCredit, fbeta, RECALL_WEIGHT, arg } from './lib/metrics.mjs';
import { offlineTokenCounter } from './lib/tokens.mjs';
import { ensureIndex, resolveModel } from './lib/reindex.mjs';

const argv = process.argv.slice(2);
const VALUED = new Set(['--tier', '--budget', '--core-top-k', '--core-order', '--core-depth', '--core-uids', '--tokenizer']);
const samples = argv.filter((a, i) => a.endsWith('.json') && !a.startsWith('--') && !VALUED.has(argv[i - 1]));
if (!samples.length) {
    console.error('need at least one sample: node core-compare.mjs <sample.json> [more.json ...] [--budget 25083]');
    process.exit(2);
}
const TIER = arg(argv, '--tier') ?? 'memory';
if (!['memory', 'reference', 'all'].includes(TIER)) { console.error(`--tier must be memory|reference|all, got ${TIER}`); process.exit(2); }
const BUDGETS = String(arg(argv, '--budget') ?? '5000,10000,15000,25000,40000').split(',').map(Number).filter(Number.isFinite);
const TOP_K = Number(arg(argv, '--core-top-k') ?? 5);
// uid is story order on an STMB book; both tie directions are offered because an untuned book leaves every order equal, and the direction is worth real F2 (R14).
const CORE_ORDER = arg(argv, '--core-order') ?? 'oldest';
const ORDERS = {
    order: (a, b) => (Number(b.entry?.order ?? 0) - Number(a.entry?.order ?? 0)) || (Number(a.uid) - Number(b.uid)),
    newest: (a, b) => Number(b.uid) - Number(a.uid),
    oldest: (a, b) => Number(a.uid) - Number(b.uid),
};
if (!ORDERS[CORE_ORDER]) { console.error(`--core-order must be order|newest|oldest, got ${CORE_ORDER}`); process.exit(2); }
// Core scans its own depth (ST's default 2 against WA's 10); scoring its keyword route on WA's window would hand it activations it never had.
const CORE_DEPTH = arg(argv, '--core-depth') === null ? 2 : Number(arg(argv, '--core-depth'));
const CORE_UIDS = arg(argv, '--core-uids') ? new Set(String(arg(argv, '--core-uids')).split(',').map(Number)) : null;
const MODEL = process.env.WA_EMBED_MODEL ?? null;   // per-sample: the bundle's own record unless overridden
const tk = offlineTokenCounter(arg(argv, '--tokenizer') ?? 'gpt-3.5-turbo');

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
/** Walk in the given order, taking what fits. Every cap in both systems is a prefix cut, so this is it. */
const fill = (rows, budget) => {
    const out = []; let spent = 0;
    for (const r of rows) { if (spent + r.tokens > budget) continue; out.push(r); spent += r.tokens; }
    return out;
};
/** The score of record: F2 over the delivered set, recall at >= 3, precision crediting a 2 at half. */
const scoreSet = (got, relevant) => {
    const precision = got.length ? mean(got.map(r => gradeCredit(r.graded ? r.g : 0))) : 0;
    const recall = got.filter(r => r.graded && r.g >= 3).length / relevant;
    return { f: fbeta(precision, recall, RECALL_WEIGHT), precision, recall, n: got.length, tokens: got.reduce((a, r) => a + r.tokens, 0) };
};

const scenes = [];
for (const file of samples) {
    let S; try { S = openSample(file); } catch (e) { console.error(`  ${file}: ${e.message}`); continue; }
    const P = sceneParams(S);
    // ensureIndex returns an existing --all build rather than re-embedding; a book without one names the command rather than scoring the ordinary collection.
    let indexFile;
    try {
        const em = resolveModel(MODEL ?? S.embedModel);
        indexFile = P.denseAllEntries
            ? (await ensureIndex(S, { all: true, model: em.model, label: em.label, endpoint: em.endpoint, url: em.url, log: () => {} })).path
            : indexPath(S, { model: em.label });
    } catch (e) { console.error(`  ${sceneLabel(S) || file}: ${e.message}`); continue; }
    let scene; try { scene = loadScene(S, { indexFile, indexOpts: { model: MODEL }, params: P }); } catch (e) { console.error(`  ${sceneLabel(S) || file}: ${e.message}`); continue; }
    const build = makeCandidateSet({ ...scene, params: P });
    const rows = build(P.K1, P.B, null, [], S.query, haystackFor(S, P));
    if (!rows.length) continue;
    if (Number.isFinite(CORE_DEPTH) && CORE_DEPTH > Number(S.depth)) {
        console.error(`  ${sceneLabel(S) || file}: --core-depth ${CORE_DEPTH} exceeds the ${S.depth} messages this capture stored; skipped rather than scored at ${S.depth}`);
        continue;
    }
    // Core's keyword route, re-scored at ITS scan depth. Same candidate builder, shallower haystack.
    const coreKeyed = Number.isFinite(CORE_DEPTH) && CORE_DEPTH !== P.depth
        ? new Set(build(P.K1, P.B, null, [], S.query, haystackFor(S, P, { depth: CORE_DEPTH }))
            .filter(r => (Number(r.keywordScore) || 0) > 0).map(r => Number(r.uid)))
        : null;
    // makeLayoutOrder is what stage 4 orders by, so this reads WA's own layout rather than a second copy of it.
    const ranked = makeLayoutOrder({ scene, haystack: haystackFor(S, P) })(rows);
    const gradeOf = makeGradeOf(S.entries, scene);
    const enriched = ranked
        .filter(r => TIER === 'all' || (isMemory(r.entry) ? 'memory' : 'reference') === TIER)
        .map(r => {
            const g = gradeOf(r);
            return { ...r, tokens: tk.count(r.entry?.content), graded: Number.isFinite(g), g: Number.isFinite(g) ? g : 0,
                coreKeyed: coreKeyed ? coreKeyed.has(Number(r.uid)) : (Number(r.keywordScore) || 0) > 0 };
        });
    const relevant = enriched.filter(r => r.graded && r.g >= 3).length;
    if (!relevant) continue;
    scenes.push({ name: sceneLabel(S) || file, rows: enriched, relevant });
}
if (!scenes.length) { console.error('no scene had a relevant row in that tier'); tk.free(); process.exit(2); }

const coreNominate = (rows) => {
    if (CORE_UIDS) return rows.filter(r => CORE_UIDS.has(Number(r.uid)));
    const picked = new Set(rows.filter(r => r.coreKeyed));
    for (const r of [...rows].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)).slice(0, TOP_K)) picked.add(r);
    return [...picked].sort(ORDERS[CORE_ORDER]);
};
const waNominate = rows => rows.filter(r => Number.isFinite(r.eCredit) && Number.isFinite(r.cutoff) && r.eCredit >= r.cutoff);

console.log(`${scenes.length} scene(s), ${TIER} tier, ${tk.tokenizer} tokens; core: top-${TOP_K}, scan depth ${CORE_DEPTH}, walked by ${CORE_UIDS ? "a real install's answer" : CORE_ORDER}`);
console.log(`mean ${mean(scenes.map(s => s.rows.length)).toFixed(0)} candidates, ${mean(scenes.map(s => s.relevant)).toFixed(1)} relevant per scene\n`);
console.log('budget      core F2   core P   core R  core n  core tok |     WA F2     WA P     WA R    WA n   WA tok');
for (const budget of [...BUDGETS, Infinity]) {
    const c = scenes.map(s => scoreSet(fill(coreNominate(s.rows), budget), s.relevant));
    const w = scenes.map(s => scoreSet(fill(waNominate(s.rows), budget), s.relevant));
    const lbl = budget === Infinity ? 'none' : String(budget);
    console.log(`${lbl.padStart(7)}    ${mean(c.map(x => x.f)).toFixed(4)}   ${(100 * mean(c.map(x => x.precision))).toFixed(1).padStart(5)}%   ${(100 * mean(c.map(x => x.recall))).toFixed(1).padStart(5)}%  ${mean(c.map(x => x.n)).toFixed(1).padStart(5)}  ${Math.round(mean(c.map(x => x.tokens))).toString().padStart(8)} |   ${mean(w.map(x => x.f)).toFixed(4)}   ${(100 * mean(w.map(x => x.precision))).toFixed(1).padStart(5)}%   ${(100 * mean(w.map(x => x.recall))).toFixed(1).padStart(5)}%  ${mean(w.map(x => x.n)).toFixed(1).padStart(5)}  ${Math.round(mean(w.map(x => x.tokens))).toString().padStart(7)}`);
    const per = (x, s2) => (mean(x.map(y => y.recall)) * mean(s2.map(z => z.relevant)) / Math.max(1, mean(x.map(y => y.tokens))) * 1000).toFixed(3);
    console.log(`${' '.repeat(11)}relevant entries per 1k tokens — core ${per(c, scenes)}, WA ${per(w, scenes)}`);
}
// Core scoring worse at unbounded budget than under one is not a bug in the walk: truncation removes entries it should never have nominated.
tk.free();
