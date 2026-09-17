// Paired arm screening across graded scenes: each scene scored at its own baseline and again with one parameter changed, read by the sign test.
// Usage (from SillyTavern root):
//   node .../param-screen.mjs <sample.json> [sample2.json ...] [--arms K1=3,filter=off] [--k 10] [--list]
// Pool first (/wa-super-grade): an arm that surfaces unjudged entries scores them 0 and looks worse than it is.
import { readFileSync } from 'node:fs';
import { indexPath, loadScene, openSample, sceneParams, scoreScene, embed, sceneLabel, lineagesOf, fittedModels } from './lib/scene.mjs';
import { modelKey } from '../extension/relevance.mjs';
import { jaccard, signTest, spearman, gradeValue, arg } from './lib/metrics.mjs';
import { isDurable, rowKey } from '../extension/grading.mjs';
import { ensureIndex, resolveModel } from './lib/reindex.mjs';

const argv = process.argv.slice(2);
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));

// Values are absolute, not offsets: each scene is compared against its own params baseline.
const ARMS = {
    'K1=1.2': { K1: 1.2 }, 'K1=2': { K1: 2 }, 'K1=3': { K1: 3 },
    'B=0.6': { B: 0.6 }, 'B=0.9': { B: 0.9 },
    // repeatR and k1 are independent: k1 is how fast repeats accrue, R how far they can go.
    'repeat=presence': { repeatCurve: 'presence', repeatR: 1 },
    'repeat=presence-R2': { repeatCurve: 'presence', repeatR: 2 },
    'repeat=presence-R3': { repeatCurve: 'presence', repeatR: 3 },
    'repeat=log': { repeatCurve: 'presence-log', repeatR: 1 },
    'repeat=log-R0.5': { repeatCurve: 'presence-log', repeatR: 0.5 },
    'repeat=log-R2': { repeatCurve: 'presence-log', repeatR: 2 },
    // __reload because the gazetteer is baked at load time.
    'gaz=keys': { gazetteerSource: 'keys', __reload: true },
    'gaz=titles': { gazetteerSource: 'titles', __reload: true },
    'gaz=bodies': { gazetteerSource: 'bodies', __reload: true },
    'gaz=none': { gazetteerSource: 'none', __reload: true },
    'boost=1': { boost: 1 }, 'boost=5': { boost: 5 }, 'boost=8': { boost: 8 },
    'stopwordDf=0': { stopwordDf: 0 }, 'stopwordDf=0.15': { stopwordDf: 0.15 }, 'stopwordDf=0.4': { stopwordDf: 0.4 },
    'filter=off': { entityFilter: false },
    // Chunk arms need their own collection (reindex.mjs), cached on disk; the first run pays one embedding pass per book per dose.
    ...Object.fromEntries([200, 300, 400, 600, 800, 1200, 1600, 2400].map(v => [`chunkSize=${v}`, { __chunk: { chunkSize: v } }])),
    ...Object.fromEntries([0, 60, 120, 200, 300, 500].map(v => [`minChunk=${v}`, { __chunk: { minChunkSize: v } }])),
    'chunkMode=length': { __chunk: { chunkMode: 'length' } },

    // Embeds every entry with content; needs its own collection (reindex.mjs --all).
    'denseAll=on': { __dense: true, denseAllEntries: true },
    // 'memory' drops the vectorized filter, 'memoryArchived' adds the disabled entries; a book with no archived memory entries must come back exactly 0.
    'centroid=vectorized': { __dense: true, denseAllEntries: true, centroidPopulation: 'vectorized' },
    'pc=1': { __reload: true, pcRemove: 1 },
    // Needs node eval/global-basis.mjs <samples...> first. shared=N alone is the stage-A control; a gain only in shared=4+pcN is stage B's.
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`shared=${v}`, { __reload: true, sharedComponents: v }])),
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`sharedEta=${v}`, { __reload: true, sharedComponents: v, sharedSelect: 'shared' }])),
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`sharedWithin=${v}`, { __reload: true, sharedComponents: v, sharedScatter: 'within' }])),
    // alpha 0 is the control and must reproduce the baseline exactly.
    ...Object.fromEntries([0.25, 0.5, 1].map(a => [`whiten=${a}`, { __reload: true, whitenR: 16, whitenAlpha: a }])),
    'whiten=1r64': { __reload: true, whitenR: 64, whitenAlpha: 1 },
    'whiten=0': { __reload: true, whitenR: 16, whitenAlpha: 0 },
    'shared=4+pc1': { __reload: true, sharedComponents: 4, pcRemove: 1 },
    'shared=4+pc2': { __reload: true, sharedComponents: 4, pcRemove: 2 },
    'pc=2': { __reload: true, pcRemove: 2 },
    'pc=4': { __reload: true, pcRemove: 4 },
    'centroid=memoryArchived': { __dense: true, __archived: true, denseAllEntries: true, centroidPopulation: 'memoryArchived' },

    'centering=off': { meanCentered: false },

    // Read with --metric fAtCut; a fixed-k metric cannot see the cut.
    'cutoff=0.04': { memoryCutoff: 0.04 },
    'cutoff=0.12': { memoryCutoff: 0.12 },
    'cutoff=0.16': { memoryCutoff: 0.16 },
    'cutoff=0.22': { memoryCutoff: 0.22 },
    'cutoff=0.30': { memoryCutoff: 0.30 },
    'fit=noCosine': { relevanceFit: 'noCosine' },
    'fit=bge-m3': { relevanceFit: 'bge-m3' },
    'fit=jina': { relevanceFit: 'cohee/jina-embeddings-v2-base-en' },
    'fit=gemma': { relevanceFit: 'embeddinggemma' },
    'fit=mxbai': { relevanceFit: 'mxbai-embed-large' },
    'fit=qwen0.6b': { relevanceFit: 'qwen3-embedding:0.6b' },
    'fit=qwen4b': { relevanceFit: 'qwen3-embedding:4b' },
    'fit=qwen8b': { relevanceFit: 'qwen3-embedding-8b-4bit-dwq' },
};

/** Arms answering one question at different doses; Holm is corrected within a family. */
const familyOf = arm => arm.split('=')[0];

if (argv.includes('--list')) { console.log(Object.keys(ARMS).join('\n')); process.exit(0); }
if (!samples.length) {
    console.error('need at least one sample: node param-screen.mjs <sample.json> [more.json ...] [--arms a,b] [--k 10] [--metric fAtCut|fAtCutMemory|fAtCutReference|f2|n|fAtR] [--list]');
    console.error('one sample runs, but reports no sign test — pairing needs scenes to pair.');
    process.exit(2);
}

const picked = arg(argv, '--arms') ? String(arg(argv, '--arms')).split(',').map(s => s.trim()).filter(Boolean) : Object.keys(ARMS);
const unknown = picked.filter(a => !ARMS[a]);
if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — see --list`); process.exit(2); }

const K = Number(arg(argv, '--k') ?? 10);
// A user setting, so never off the bundle; required by --metric fAtBudget.
const BUDGET = Number(arg(argv, '--budget') ?? 0);
// A user setting (relevanceCutoff), never defaulted: without it scene.mjs reports no @cut window at all.
const CUTOFF = arg(argv, '--cutoff') === null ? null : Number(arg(argv, '--cutoff'));
if (CUTOFF !== null && !Number.isFinite(CUTOFF)) { console.error('--cutoff must be a number'); process.exit(2); }
if (CUTOFF === null && picked.some(a => 'relevanceFit' in ARMS[a])) {
    console.error('a fit= arm needs --cutoff: without it each fit cuts at its own provenance cutoff and the contrast is confounded');
    process.exit(2);
}
/** The globals that ride on the baseline and on every arm, so both are scored under one stage-4 condition. */
const GLOBAL = { ...(BUDGET ? { budgetTokens: BUDGET } : {}), ...(CUTOFF !== null ? { memoryCutoff: CUTOFF } : {}) };
// fAtCut is F-beta(2) over the set the relevance cut admits; the others are diagnostics on the ordering at a fixed window.
const METRIC = arg(argv, '--metric') ?? 'fAtCut';
const WINDOWED = { fAtR: r => r.atR.f, fAtCut: r => r.atCut?.f ?? NaN, nAtCut: r => r.atCut?.n ?? NaN, fAtBudget: r => r.atBudget?.f ?? NaN, nAtBudget: r => r.atBudget?.n ?? NaN,
    // One tier's delivered set only: a scene with no relevant rows in that tier contributes NaN, not a zero.
    fAtCutMemory: r => r.atCutMemory?.f ?? NaN, fAtCutReference: r => r.atCutReference?.f ?? NaN };
if (!['n', 'nAt5', 'f2', 'recall', 'precision', ...Object.keys(WINDOWED)].includes(METRIC)) { console.error(`unknown --metric ${METRIC}`); process.exit(2); }
// @cut is the one window the system chooses, and its cutoff is a user setting: scoring it needs --cutoff.
if (CUTOFF === null && METRIC.startsWith('fAtCut') || CUTOFF === null && METRIC === 'nAtCut') {
    console.error(`--metric ${METRIC} needs --cutoff: relevanceCutoff is a user setting, and nothing here may stand in for it`);
    process.exit(2);
}
const mOf = r => (WINDOWED[METRIC] ? WINDOWED[METRIC](r) : r[METRIC]);
// Falls back to the bundle's own model, never a hardcoded name.
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0], arg(argv, '--arm')).embedModel;
if (!MODEL) { console.error(`${samples[0]} records no embedModel — set WA_EMBED_MODEL`); process.exit(2); }
const EM = resolveModel(MODEL);
{
    const key = modelKey(EM.model);
    if (!fittedModels().includes(key)) {
        console.error(`embedder ${EM.label} resolves to fit key "${key}", which has no fit `
            + `(have: ${fittedModels().join(', ')}). Check the spec — an index directory name is not one, `
            + `pathSafe having replaced its "/" — or pass an explicit fit= arm.`);
        process.exit(2);
    }
    console.log(`embedder ${EM.label} -> fit "${key}"`);
}
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const fx = n => (n >= 0 ? '+' : '') + n.toFixed(4);

(async () => {
    const scenes = [];
    for (const path of samples) {
        // One arm per bundle: its arms are the same scene scored differently, and expanding them is pseudo-replication.
        const S = openSample(path, arg(argv, '--arm'));
        // Before loadScene: a configuration that is not real has no reason to have a usable collection.
        if (S.invalidConfiguration) {
            console.log(`!! ${sceneLabel(S) || path} IS NOT A REAL CONFIGURATION — ${S.invalidConfiguration}`);
            if (!argv.includes('--include-invalid')) { console.log('   excluded; pass --include-invalid to pool it anyway'); continue; }
            console.log('   POOLED ANYWAY (--include-invalid): every number below mixes it with real scenes');
        }
        if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`${path}: embeds no entries for primary book "${S.primaryBook ?? '?'}" — re-grade with books=full|meta`); process.exit(2); }
        if (!S.candidates?.length) { console.error(`${path}: logs no candidates`); process.exit(2); }
        const P = sceneParams(S, GLOBAL);
        const scene = loadScene(S, { indexFile: indexPath(S, { model: EM.label, all: P.denseAllEntries }), indexOpts: { model: EM.label }, params: P });
        const qv = await embed(EM.query + S.query, { ollama: OLLAMA, model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url });
        const base = await scoreScene({ sample: S, overrides: GLOBAL, k: K, scene, qv });
        scenes.push({ path, name: sceneLabel(S) || path, S, scene, qv, P, base });
        console.log(`scene "${sceneLabel(S) || path}": baseline ${METRIC}@${K} ${mOf(base).toFixed(4)} (nDCG ${base.n.toFixed(4)}, P ${base.precision.toFixed(3)}, R ${base.recall.toFixed(3)}, rel ${base.relevant}), judged ${base.judged}/${base.of}${base.judged < base.of ? ' !!' : ''}`);
        console.log(`    F@R ${base.atR.f.toFixed(4)} (P ${base.atR.precision.toFixed(3)} R ${base.atR.recall.toFixed(3)}, n ${base.atR.n})`);
        // of 0 = every candidate is reference tier; the judged<of check cannot see it.
        if (!base.of) console.log('  !! nothing rankable: every candidate is reference tier, so this scene can only produce ties. It counts in n and contributes nothing.');
    }
    if (scenes.length < 2) console.log('\n!! ONE SCENE: deltas are shown but no sign test is possible. Pairing needs scenes to pair.');

    const relOf = S => new Set((S.entries ?? []).filter(g => gradeValue(g) >= 3 && g.uid !== undefined).map(rowKey));
    const judgedOf = S => new Set((S.entries ?? []).filter(g => g.uid !== undefined).map(rowKey));
    console.log('\nscene independence — relevant-set overlap (grade>=3); the sign test assumes these are separate draws');
    const thin = scenes.filter(s => relOf(s.S).size < 4);
    for (const s of scenes) console.log(`  ${s.name.slice(0, 34).padEnd(34)} ${String(relOf(s.S).size).padStart(3)} relevant, ${String(judgedOf(s.S).size).padStart(3)} judged${relOf(s.S).size < 4 ? '   << thin: nDCG here is fragile' : ''}`);
    const dupes = [];
    if (scenes.length > 1) {
        for (let i = 0; i < scenes.length; i++) for (let j = i + 1; j < scenes.length; j++) {
            const jr = jaccard(relOf(scenes[i].S), relOf(scenes[j].S));
            const jj = jaccard(judgedOf(scenes[i].S), judgedOf(scenes[j].S));
            if (jr >= 0.5) dupes.push([scenes[i].name, scenes[j].name, jr]);
            console.log(`  ${scenes[i].name.slice(0, 20).padEnd(20)} vs ${scenes[j].name.slice(0, 20).padEnd(20)} relevant ${jr.toFixed(2)}  judged ${jj.toFixed(2)}${jr >= 0.5 ? '   << NOT INDEPENDENT' : ''}`);
        }
    }
    if (dupes.length) {
        console.log(`  !! ${dupes.length} pair(s) share most of their relevant set: ${dupes.map(([a, b, v]) => `${a}/${b} (${v.toFixed(2)})`).join(', ')}.`);
        console.log('     Those move together under every arm, so n below OVERSTATES the evidence. Drop one of each pair, or');
        console.log('     read the sign test at the number of independent clusters rather than the scene count.');
    } else if (scenes.length > 1) {
        console.log('  all pairs below 0.5 relevant-set overlap — these read as separate draws.');
    }
    if (thin.length) console.log(`  !! ${thin.length} scene(s) have fewer than 4 relevant entries; their deltas are noisy but count at full weight in the sign test.`);

    console.log('\nsignal quality — Spearman against the human grade (absent signal counts as 0)');
    for (const sc of scenes) {
        const gm = new Map((sc.S.entries ?? []).filter(x => x.uid !== undefined).map(x => [rowKey(x), gradeValue(x) || 0]));
        const rs = (sc.S.candidates ?? []).filter(c => !isDurable(c) && gm.has(rowKey(c)));
        if (rs.length < 5) { console.log(`  ${sc.name.slice(0, 34).padEnd(34)} only ${rs.length} judged candidate rows — skipped`); continue; }
        const gv = rs.map(r => gm.get(rowKey(r)));
        const sig = f => spearman(rs.map(f), gv).toFixed(2).padStart(5);
        console.log(`  ${sc.name.slice(0, 34).padEnd(34)} cosine ${sig(r => (r.cosine == null ? 0 : Number(r.cosine)))}   text ${sig(r => Number(r.text) || 0)}   keys ${sig(r => Number(r.keys) || 0)}`);
    }

    console.log(`\n${scenes.length} scene(s), ${picked.length} arm(s), ${METRIC}@${K}, each scene against its OWN params baseline.`);

    const swept = [...new Set(picked.flatMap(a => Object.keys(ARMS[a])))];
    const disagree = swept.filter(k => new Set(scenes.map(s => JSON.stringify(s.P[k]))).size > 1);
    if (disagree.length) {
        console.log('\n!! scenes disagree on the BASELINE value of: ' + disagree.map(k => `${k} (${scenes.map(s => `${s.name.slice(0, 12)}:${s.P[k]}`).join(', ')})`).join('; '));
        console.log('   an absolute arm is therefore a different contrast per scene. Re-capture at a common configuration, or read those arms as directional only.');
    }

    const results = [];
    for (const armName of picked) {
        const { __chunk: chunkCfg, __reload: needsReload, __dense: denseAll, __archived: archived, ...armParams } = ARMS[armName];
        // GLOBAL rides on every arm as well as the baseline, or the delta is the stage-4 difference.
        const scoring = { ...armParams, ...GLOBAL };
        const cells = [];
        for (const sc of scenes) {
            let r;
            if (chunkCfg || denseAll || archived) {
                // all from the scene's params when the arm does not force it: a vectorized-only collection cannot be scored under denseAllEntries.
                const built = await ensureIndex(sc.S, { overrides: chunkCfg ?? {}, all: !!denseAll || !!sc.P.denseAllEntries, archived: !!archived, model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url, ollama: OLLAMA, log: () => {} });
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: built.path, model: MODEL, ollama: OLLAMA, qv: sc.qv });
            } else if (needsReload) {
                // The gazetteer is baked at load time, so the preloaded scene is stale here; all from the scene's own params, as above.
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: indexPath(sc.S, { model: EM.label, all: sc.P.denseAllEntries }), model: MODEL, ollama: OLLAMA, qv: sc.qv });
            } else {
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, scene: sc.scene, qv: sc.qv });
            }
            // Read at the window the score is taken from, or a cell scored at the cut could deliver an ungraded row and print no ?.
            const win = WINDOWED[METRIC] ? { judged: r.atCut?.judged ?? 0, of: r.atCut?.n ?? 0 } : { judged: r.judged, of: r.of };
            cells.push({ scene: sc.name, delta: mOf(r) - mOf(sc.base), ...win, unjudged: r.unjudged });
        }
        results.push({ arm: armName, cells, stat: signTest(cells.map(c => c.delta)) });
    }

    // Holm within each family, never across every arm run.
    const byFamily = new Map();
    for (const r of results) { const f = familyOf(r.arm); if (!byFamily.has(f)) byFamily.set(f, []); byFamily.get(f).push(r); }
    for (const group of byFamily.values()) {
        const ordered = [...group].sort((a, b) => a.stat.p - b.stat.p);
        const m = ordered.length;
        ordered.forEach((r, i) => { r.holm = Math.min(1, Math.max(...ordered.slice(0, i + 1).map((x, j) => x.stat.p * (m - j)))); });
    }

    const w = Math.max(...results.map(r => r.arm.length), 8);
    console.log(`\n arm${' '.repeat(w - 3)} | +/-/tie | mean Δ    p      holm   | per-scene Δ`);
    for (const r of results) {
        const s = r.stat;
        const gaps = r.cells.filter(c => c.judged < c.of).length;
        const flag = s.consistent && s.n >= 2 ? (s.plus ? ' ^' : ' v') : '  ';
        console.log(` ${r.arm.padEnd(w)} | ${s.plus}/${s.minus}/${s.ties}     | ${fx(s.mean)}  ${s.p.toFixed(3)}  ${r.holm.toFixed(3)}${flag} | `
            + r.cells.map(c => `${fx(c.delta)}${c.judged < c.of ? '?' : ''}`).join('  ')
            + (gaps ? `   (${gaps} scene(s) with unjudged rows in ${WINDOWED[METRIC] ? `the ${METRIC} window` : `top ${K}`})` : ''));
    }

    console.log('\n^ = helps on every scene, v = hurts on every scene, ? = that cell kept unjudged rows so its Δ is a lower bound.');
    console.log(`comparisons made: ${results.length} across ${byFamily.size} parameter famil${byFamily.size === 1 ? 'y' : 'ies'} (holm corrected within family).`);
    console.log(`At n=${scenes.length} the best achievable two-sided p is ${signTest(Array(scenes.length).fill(1)).p.toFixed(3)}.`);

    // Lineage, not book name: a book is versioned and renamed in place (C11).
    const recency = new Map();
    for (const sc of scenes) {
        const at = String(sc.S.createdAt ?? '');
        if (at > (recency.get(sc.S.primaryBook) ?? '')) recency.set(sc.S.primaryBook, at);
    }
    const lin = lineagesOf(Object.fromEntries(scenes.map(sc => [sc.S.primaryBook, sc.S.books[sc.S.primaryBook]])), recency);
    const order = [...new Set(scenes.map(sc => lin.get(sc.S.primaryBook)))]
        .sort((a, b) => scenes.filter(s2 => lin.get(s2.S.primaryBook) === b).length - scenes.filter(s2 => lin.get(s2.S.primaryBook) === a).length);
    const lw = Math.min(Math.max(...order.map(l => l.length), 7), 22);
    console.log(`\nper LINEAGE — ${order.length} corpus(es) behind ${scenes.length} scenes, so the row above is ${scenes.length} draws only if books do not repeat`);
    console.log(` arm${' '.repeat(w - 3)} | ${order.map(l => l.slice(0, lw).padEnd(lw)).join(' | ')}`);
    for (const r of results) {
        const cell = l => {
            const ds = r.cells.filter((_, i) => lin.get(scenes[i].S.primaryBook) === l).map(c => c.delta);
            const up = ds.filter(d => d > 0).length, dn = ds.filter(d => d < 0).length;
            return `${fx(ds.reduce((a, b) => a + b, 0) / ds.length)} ${up}/${dn}/${ds.length - up - dn}`.padEnd(lw);
        };
        console.log(` ${r.arm.padEnd(w)} | ${order.map(cell).join(' | ')}`);
    }
    const byLin = new Map(order.map(l => [l, scenes.filter(sc => lin.get(sc.S.primaryBook) === l).length]));
    const split = [...byLin].filter(([, c]) => c > 0).map(([l, c]) => `${l.slice(0, 18)} ${c}`).join(', ');
    console.log(` (mean Δ and up/down/tie per lineage; scenes per lineage: ${split})`);
    const files = new Set(scenes.map(sc => sc.S.primaryBook));
    if (files.size !== order.length) {
        console.log(` !! ${files.size} book NAMES collapse to ${order.length} lineage(s) — those names are the same corpus and must not be read as separate books.`);
    }

    const ladders = [...byFamily.entries()].filter(([, g]) => g.length >= 3);
    if (ladders.length) {
        console.log('\ndose-response — per-scene peak (the dose each scene liked best; "base" = the sample\'s own value)');
        for (const [fam, group] of ladders) {
            const peaks = scenes.map((sc, i) => {
                let best = { dose: 'base', delta: 0 };
                for (const r of group) if (r.cells[i].delta > best.delta) best = { dose: r.arm.split('=')[1] ?? r.arm, delta: r.cells[i].delta };
                return best;
            });
            const doses = peaks.map(p => p.dose);
            const agree = new Set(doses).size === 1;
            const allBase = doses.every(d => d === 'base');
            const note = allBase ? 'every scene prefers its own current value — no dose beat baseline'
                : agree ? `ALL ${scenes.length} scenes peak at ${doses[0]} — the strongest signal this design can produce`
                    : `scenes disagree (${doses.join(' / ')}) — no common optimum at n=${scenes.length}`;
            console.log(`  ${fam.padEnd(12)} ${peaks.map((p, i) => `${scenes[i].name.slice(0, 10)}:${p.dose}${p.delta ? `(${fx(p.delta)})` : ''}`).join('  ')}`);
            console.log(`  ${' '.repeat(12)} ${note}`);
        }
    }

    const movers = results.filter(r => r.stat.consistent);
    const allZero = results.length && results.every(r => r.cells.every(c => c.delta === 0));
    if (allZero) {
        console.log(`\nEVERY DELTA IS EXACTLY ZERO across ${results.length} arm(s) and ${scenes.length} scene(s). That is not a`);
        console.log(`null result at this sample size, it is ${METRIC} being INVARIANT to these parameters — check that the`);
        console.log('window is one the arms can actually move before reading anything into it.');
    } else if (!movers.length) {
        console.log('\nNO ARM MOVED THE METRIC CONSISTENTLY. The defensible conclusion is that these parameters are');
        console.log(`flat at this sample size — record "measured flat, n=${scenes.length} scenes, paired" and leave the defaults alone.`);
    } else {
        console.log(`\nconsistent direction on all ${scenes.length} scene(s): ${movers.map(r => `${r.arm} (${fx(r.stat.mean)}${r.stat.plus ? '' : ''}, p=${r.stat.p.toFixed(3)}, holm=${r.holm.toFixed(3)})`).join(', ')}`);
        console.log('These are SCREENING hits, not results: confirm them on a real grid (and more scenes) before moving a default.');
        if (scenes.length < 6) console.log(`At n=${scenes.length} none of them can reach p<0.05 no matter how large the effect — treat the direction and the mean Δ as the finding.`);
    }
    const anyGaps = results.some(r => r.cells.some(c => c.judged < c.of)) || scenes.some(s => s.base.judged < s.base.of);
    if (anyGaps) console.log('\n!! some cells ranked unjudged entries. Pool first (/wa-super-grade, load these samples as priors) or those Δ are lower bounds.');
})();
