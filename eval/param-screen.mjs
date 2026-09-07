// Paired arm screening across graded scenes — the estimator for small n.
//
// Not graded-scene-grid.mjs per sample: that answers "which cell wins on this scene", and between-scene
// variance swamps between-parameter variance (H10), so the argmax of hundreds of cells is noise-mining.
// What small n supports is a paired contrast — each scene scored at its own baseline and again with one
// parameter changed, read by the sign of the difference. Each scene is its own control, so between-scene
// variance cancels; the price is that the claim is directional, and signTest in metrics.mjs carries the
// p-value floor. One parameter at a time, deliberately: this is a screen, not a grid, and an arm that comes
// back flat should be left at its default with "measured flat, n=X scenes across Y chats" written next to
// it. Multiplicity is real — many arms at small n manufacture a consistent-looking direction by chance — so
// the footer reports the comparison count and a Holm-corrected view, and an uncorrected p is a screening
// signal, never a result.
//
// Usage (from SillyTavern root):
//   node .../param-screen.mjs <sample.json> [sample2.json ...] [--arms K1=3,filter=off] [--k 10] [--list]
//
// Samples are /wa-grade or /wa-super-grade manifests. Their pools must be honest: an arm that surfaces
// unjudged entries scores them 0 and looks worse than it is, so judged coverage is reported per cell and a
// run with gaps is flagged. Pool first with /wa-super-grade, then screen here.
import { readFileSync } from 'node:fs';
import { indexPath, loadScene, openSample, sceneParams, scoreScene, embed, sceneLabel, lineagesOf, fittedModels } from './scene.mjs';
import { modelKey } from '../extension/relevance.mjs';
import { jaccard, signTest, spearman, gradeValue, arg } from './metrics.mjs';
import { isDurable, rowKey } from '../extension/grading.mjs';
import { ensureIndex, resolveModel } from './reindex.mjs';

const argv = process.argv.slice(2);
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));

// One-at-a-time deviations. Values are absolute, not offsets: each scene is compared against its own
// `params` baseline, so the tool prints that baseline per parameter and flags when the scenes disagree
// about it — a contrast that means +1.8 on one scene and +1.0 on another is not one contrast.
const ARMS = {
    'K1=1.2': { K1: 1.2 }, 'K1=2': { K1: 2 }, 'K1=3': { K1: 3 },
    'B=0.6': { B: 0.6 }, 'B=0.9': { B: 0.9 },
    // Occurrences -> score. The shipped curve gives a key present once 1/(1+k1); these make presence worth
    // the key's full weight and let only repeats accrue, bounded at R (presence) or never (presence-log).
    // R and k1 are independent: k1 is how fast repeats accrue, R is how far they can go.
    'repeat=presence': { repeatCurve: 'presence', repeatR: 1 },
    'repeat=presence-R2': { repeatCurve: 'presence', repeatR: 2 },
    'repeat=presence-R3': { repeatCurve: 'presence', repeatR: 3 },
    'repeat=log': { repeatCurve: 'presence-log', repeatR: 1 },
    'repeat=log-R0.5': { repeatCurve: 'presence-log', repeatR: 0.5 },
    'repeat=log-R2': { repeatCurve: 'presence-log', repeatR: 2 },
    // No lexw/keyw/K arms: they described the RRF fusion, which no longer exists — nothing between here and
    // the layout score reads any of the three, so an arm setting one could only ever report flat.
    //
    // What the gazetteer reads. Shipped is keys+titles, and everything defending that choice is thin. One
    // family, so the doses correct against each other; __reload because the gazetteer is baked at load time.
    // All four measured flat, paired — including gaz=none, which deletes the gazetteer outright (R20): at
    // this sample size the whole gazetteer is inside noise and the proper-noun boost is carrying the entity
    // filter on its own. Kept as standing arms because that null is the answer to a question that keeps
    // getting re-asked. They reach stage 3 only — stage 1 reads no term weights, so all four return a
    // byte-identical candidate set to baseline and to each other, differing only in query terms (R20), and
    // an arm that cannot change the population cannot surface an unjudged row, so unlike a chunk arm its
    // delta is not a pool-biased lower bound.
    'gaz=keys': { gazetteerSource: 'keys', __reload: true },
    'gaz=titles': { gazetteerSource: 'titles', __reload: true },
    'gaz=bodies': { gazetteerSource: 'bodies', __reload: true },
    'gaz=none': { gazetteerSource: 'none', __reload: true },
    'boost=1': { boost: 1 }, 'boost=5': { boost: 5 }, 'boost=8': { boost: 8 },
    'stopwordDf=0.15': { stopwordDf: 0.15 }, 'stopwordDf=0.4': { stopwordDf: 0.4 },
    'filter=off': { entityFilter: false },
    // Chunk arms change what text gets embedded, so unlike every arm above they cannot be re-derived from the
    // stored index — each needs its own collection, rebuilt from the sample's embedded books (reindex.mjs)
    // and cached on disk. First run pays one embedding pass per scene per arm, later runs are free.
    //
    // A ladder, not two probes: chunkSize plausibly has an interior optimum — too small and a chunk carries
    // no context, too large and its centroid represents nothing in particular — so three points can only
    // report a direction while eight doses show the shape, and the dose-response block below reads the
    // per-scene peak off them. The index cache is keyed on book + model + chunk settings, not on scene, so
    // every scene graded against the same lorebook reuses one build per dose; cost scales with books x doses.
    ...Object.fromEntries([200, 300, 400, 600, 800, 1200, 1600, 2400].map(v => [`chunkSize=${v}`, { __chunk: { chunkSize: v } }])),
    ...Object.fromEntries([0, 60, 120, 200, 300, 500].map(v => [`minChunk=${v}`, { __chunk: { minChunkSize: v } }])),
    'chunkMode=length': { __chunk: { chunkMode: 'length' } },

    // A cosine for every entry — the dense twin of giving keyword entries a text score (content-lexical.mjs).
    // A keyword-only entry has no vector row, so its semantic standing is estimated from keys and content
    // BM25 alone; this embeds every entry with content and hands stage 3 the cosine as a fourth column's
    // worth of evidence on the rows it already ranks. Needs its own collection (reindex.mjs --all), so it is
    // a slow arm on first run like the chunk arms. Stage 3 only, which is what makes its Δ readable:
    // activation is untouched, so unlike a chunk arm it cannot surface an unjudged row and its delta is not
    // a pool-biased lower bound. It does move two things at once — see denseAllEntries in scene.mjs for the
    // tilt that stops applying.
    'denseAll=on': { __dense: true, denseAllEntries: true },
    // What the corpus mean is taken over (scene.mjs centroidPopulation). Two doses of one question, run
    // separately because they are two independent changes: 'memory' only drops the `vectorized` filter, and
    // moves nothing on a book whose memory entries are all flagged; 'memoryArchived' adds the disabled ones,
    // and moves nothing on a book with no retired arcs. Read per book, not pooled — treatment intensity is a
    // property of the lorebook (its archived fraction), so a pooled sign test averages a no-op book with a
    // large-move one and reports a middle that describes neither. A book with no archived memory entries
    // must come back exactly 0; that is the arm's own correctness check, not a data point.
    'centroid=vectorized': { __dense: true, denseAllEntries: true, centroidPopulation: 'vectorized' },
    // All-but-the-top (scene.mjs pcRemove). Same collection as the baseline — the components come off the
    // vectors already on disk — so these need only a reload, not a build. Asked here rather than on the LOO
    // chunk-to-sibling task because that has no selection stage: its nDCG@10 and recall@5 are read at windows
    // nothing chooses, and it cannot see the delivered set, which is what the answer is about.
    'pc=1': { __reload: true, pcRemove: 1 },
    // Two-stage (scene.mjs globalBasis + pcRemove). Stage A removes the mean and top-m directions shared with
    // other lineages' memory chunks; stage B then centres on what is left and removes k of its leading
    // directions, which are the book's own by construction. `shared=N` alone is the control that separates
    // the halves: it strips the shared part and keeps ordinary centring on the residual, so a gain there is
    // stage A's and a gain only in gb=4+pcN is stage B's. Needs `node eval/global-basis.mjs <samples...>`
    // first; loadScene throws with that line if absent.
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`shared=${v}`, { __reload: true, sharedComponents: v }])),
    // The same doses, picked by sharedness instead of by explained variance — one family with the arms
    // above, so the two selection rules are contrasted at matched N rather than against each other's best.
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`sharedEta=${v}`, { __reload: true, sharedComponents: v, sharedSelect: 'shared' }])),
    // The same doses off the within-book scatter, one family with the two above so the estimator and the
    // selection rule are each contrasted at matched N rather than against the other's best.
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`sharedWithin=${v}`, { __reload: true, sharedComponents: v, sharedScatter: 'within' }])),
    // Whitening (scene.mjs whitenR/whitenAlpha) — the only lever in this family that changes the cloud's
    // shape rather than its position: centring is a translation and provably cannot remove book identity
    // (R18), where rescaling the directions a book spreads along can. alpha 0 is the control and must
    // reproduce the baseline exactly.
    ...Object.fromEntries([0.25, 0.5, 1].map(a => [`whiten=${a}`, { __reload: true, whitenR: 16, whitenAlpha: a }])),
    'whiten=1r64': { __reload: true, whitenR: 64, whitenAlpha: 1 },
    'whiten=0': { __reload: true, whitenR: 16, whitenAlpha: 0 },
    'shared=4+pc1': { __reload: true, sharedComponents: 4, pcRemove: 1 },
    'shared=4+pc2': { __reload: true, sharedComponents: 4, pcRemove: 2 },
    'pc=2': { __reload: true, pcRemove: 2 },
    'pc=4': { __reload: true, pcRemove: 4 },
    'centroid=memoryArchived': { __dense: true, __archived: true, denseAllEntries: true, centroidPopulation: 'memoryArchived' },

    // Mean-centering off: rank on raw cosine. The contrast is end-to-end — it moves the retrieval ranking,
    // the top-K, the admission gate and the fused layout order together, which is what makes it different
    // from comparing the two score columns on a fixed candidate set.
    'centering=off': { meanCentered: false },

    // The high-band hold-out. Sommers curation deliberately retained every key firing above 15.6% of messages
    // (whole-word, frozen chat) so keep-vs-remove could be answered here instead of by intuition (F41); Teddy
    // sits at the band edge and was judged per-entry, so it is not in the arm. Removal semantics via
    // scoringKeys: stops scoring and keyword-activating, gazetteer untouched (see scene.mjs). Read the sign —
    // consistent negative = removal hurts (keep wins), consistent positive = removal helps, flat or mixed
    // licenses nothing beyond itself.
    'dropKeys=hiband': { dropKeys: ['Jeffrey', 'Liam', 'Brad', 'Arthur', 'Shane'] },
    // Uniform cast placement. The curation kept main-cast bare names only where the generator had already put
    // them, so dropKeys=hiband measured removal from inconsistent placement. These arms fill the gap
    // mechanically (scene.mjs addCastKeys: name appended wherever entry content mentions it whole-word and no
    // key form exists, F41). Kyle excluded (player persona), Sara and Ian excluded (known orthographic
    // collisions the fill would reintroduce). cast+dropHi is the interaction — read it against addKeys=cast,
    // not only against baseline, to see whether the band still earns its keep once placement is uniform.
    'addKeys=cast': { addCastKeys: ['Jeffrey', 'Shane', 'Brad', 'Micah', 'Teddy', 'Alex', 'Dylan', 'Liam', 'Marjorie', 'Valentina', 'Arthur'] },
    'addKeys=cast+dropHi': { addCastKeys: ['Jeffrey', 'Shane', 'Brad', 'Micah', 'Teddy', 'Alex', 'Dylan', 'Liam', 'Marjorie', 'Valentina', 'Arthur'], dropKeys: ['Jeffrey', 'Liam', 'Brad', 'Arthur', 'Shane'] },
    // The cut itself, read with --metric fAtCut. The shipped memory fit's own cutoff is the baseline, so
    // these are absolute doses around it; the window they move is the only one the system sizes for itself
    // (scene.mjs, @cut). Screening it against a fixed-k metric measures nothing — k is handed the count the
    // cutoff is supposed to decide.
    'cutoff=0.04': { memoryCutoff: 0.04 },
    'cutoff=0.12': { memoryCutoff: 0.12 },
    'cutoff=0.16': { memoryCutoff: 0.16 },
    'cutoff=0.22': { memoryCutoff: 0.22 },
    'cutoff=0.30': { memoryCutoff: 0.30 },
    // Which fit scores the column, by name. Standardisation removes the scale difference between embedders,
    // so what a foreign beta gets wrong is the signal's discriminative power, not its units. Requires
    // --cutoff: each fit carries its own provenance cutoff, so without a fixed one the arms differ in how
    // many rows they admit as well as how they order.
    'fit=noCosine': { relevanceFit: 'noCosine' },
    'fit=bge-m3': { relevanceFit: 'bge-m3' },
    'fit=jina': { relevanceFit: 'cohee/jina-embeddings-v2-base-en' },
    'fit=gemma': { relevanceFit: 'embeddinggemma' },
    'fit=mxbai': { relevanceFit: 'mxbai-embed-large' },
    'fit=qwen0.6b': { relevanceFit: 'qwen3-embedding:0.6b' },
    'fit=qwen4b': { relevanceFit: 'qwen3-embedding:4b' },
    'fit=qwen8b': { relevanceFit: 'qwen3-embedding-8b-4bit-dwq' },
};

/** Arms that answer the same question at different doses. Derived from the name, so adding a dose needs no
 *  bookkeeping. Multiplicity is corrected within a family, because eight chunkSize doses are one question
 *  asked eight ways, not eight independent findings. */
const familyOf = arm => arm.split('=')[0];

if (argv.includes('--list')) { console.log(Object.keys(ARMS).join('\n')); process.exit(0); }
if (!samples.length) {
    console.error('need at least one sample: node param-screen.mjs <sample.json> [more.json ...] [--arms a,b] [--k 10] [--metric fAtCut|f2|n|fAtR] [--list]');
    console.error('one sample runs, but reports no sign test — pairing needs scenes to pair.');
    process.exit(2);
}

const picked = arg(argv, '--arms') ? String(arg(argv, '--arms')).split(',').map(s => s.trim()).filter(Boolean) : Object.keys(ARMS);
const unknown = picked.filter(a => !ARMS[a]);
if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — see --list`); process.exit(2); }

const K = Number(arg(argv, '--k') ?? 10);
// The token ceiling every scene is walked under, baseline and arms alike — it is a user's cost decision,
// not a property of a scene, so it cannot come off the bundle. Required by --metric fAtBudget.
const BUDGET = Number(arg(argv, '--budget') ?? 0);
// The relevance cutoff every scene is cut at, baseline and arms alike. A user setting (`relevanceCutoff`,
// one value for every model), so never defaulted here. Absent it each scene cuts at its fit's provenance
// cutoff, which is wrong the moment two arms use different fits. Required by any `fit=` arm.
const CUTOFF = arg(argv, '--cutoff') === null ? null : Number(arg(argv, '--cutoff'));
if (CUTOFF !== null && !Number.isFinite(CUTOFF)) { console.error('--cutoff must be a number'); process.exit(2); }
if (CUTOFF === null && picked.some(a => 'relevanceFit' in ARMS[a])) {
    console.error('a fit= arm needs --cutoff: without it each fit cuts at its own provenance cutoff and the contrast is confounded');
    process.exit(2);
}
/** The globals that ride on the baseline and on every arm, so both are scored under one stage-4 condition. */
const GLOBAL = { ...(BUDGET ? { budgetTokens: BUDGET } : {}), ...(CUTOFF !== null ? { memoryCutoff: CUTOFF } : {}) };
// Which metric the sign test reads; the default is the validity score rather than a diagnostic. `fAtCut` is
// F-beta(2) on the asymmetric bars over the set the relevance cut admits — the only window the system chooses
// for itself, so it is the one that can see an arm change how many entries survive, which is half of what
// stage 4 decides. The default is load-bearing: moving the window from top-10 to the admitted set roughly
// halved the tie columns and reversed the sign of the largest per-lineage effect in the set (F42), so a screen
// reporting `n` says "flat" about arms that move the delivered set, in the same words as a real null.
//
// The others stay available and are diagnostics on the ordering: `n`/`nAt5` are nDCG at a fixed depth, `f2`
// is F-beta(2) at a fixed k, and `fAtR` is sized by the scene's relevant count rather than by --k. Baseline
// and arm are always scored on the same one, so a run mixing them is impossible.
const METRIC = arg(argv, '--metric') ?? 'fAtCut';
const WINDOWED = { fAtR: r => r.atR.f, fAtCut: r => r.atCut.f, nAtCut: r => r.atCut.n, fAtBudget: r => r.atBudget?.f ?? NaN, nAtBudget: r => r.atBudget?.n ?? NaN };
if (!['n', 'nAt5', 'f2', 'recall', 'precision', ...Object.keys(WINDOWED)].includes(METRIC)) { console.error(`unknown --metric ${METRIC}`); process.exit(2); }
const mOf = r => (WINDOWED[METRIC] ? WINDOWED[METRIC](r) : r[METRIC]);
// The model is a spec, resolved once (reindex.mjs resolveModel): the label names collections and bases, the
// rest says how to call the model, including the task prefix a prefix-trained family needs. A bare name is an
// ollama model. Falls back to the bundle's own model, never a hardcoded name — a hardcoded one resolves
// collections that exist for a corpus that has moved on, so nothing errors and the previous model is quietly
// measured (H3). Read off the first sample; a screen pools scenes, and pooling two models' cosines is not a
// comparison, so a disagreement is reported below rather than silently averaged.
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0], arg(argv, '--arm')).embedModel;
if (!MODEL) { console.error(`${samples[0]} records no embedModel — set WA_EMBED_MODEL`); process.exit(2); }
const EM = resolveModel(MODEL);
// Which fit the embedder resolved to, before the first index parse. The usual way to get here is a spec read
// off an index directory name: `pathSafe` maps `/` to `-`, so `st:Cohee-jina-…` and `st:Cohee/jina-…` share a
// directory and are different models.
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
    // Load and embed each scene once. Arms only reweight, so nothing below needs a second embed call.
    const scenes = [];
    for (const path of samples) {
        // A bundle contributes one arm, never all of them: its arms are the same scene scored differently,
        // so expanding them would be textbook pseudo-replication in the sign test.
        const S = openSample(path, arg(argv, '--arm'));
        // Excluded, not warned about, and before anything else touches it — a warning in a long log is not a
        // guard, and this corpus holds a deliberate wrong-book null fixture whose only marker was its
        // filename. First, not after loadScene: a configuration that is not real has no reason to have a
        // usable collection either, so checking it late kills the run on the index of a bundle it was about
        // to skip. --include-invalid puts it back for the one question it is evidence about.
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
        // `of` is the rankable top-k, so 0 means the reference-tier removal took everything — a
        // reference-only book. Every arm then scores 0 and every delta is a tie, so the scene inflates the
        // scene count without contributing evidence. The judged<of check cannot see it: 0 < 0 is false.
        if (!base.of) console.log('  !! nothing rankable: every candidate is reference tier, so this scene can only produce ties. It counts in n and contributes nothing.');
    }
    if (scenes.length < 2) console.log('\n!! ONE SCENE: deltas are shown but no sign test is possible. Pairing needs scenes to pair.');

    // --- ARE THESE SCENES ACTUALLY DISTINCT? -----------------------------------------------------------
    // "Far enough apart" is not eyeballable: two scenes can sit hundreds of messages apart and still retrieve
    // the same handful of entries because the same thread is live. The measure is Jaccard on the relevant sets
    // (grade>=3), not on the judged pools — two scenes that agree on which entries matter move in lockstep
    // under every arm below, so they are one observation and counting them as two manufactures power. Sharing
    // judged entries is fine and expected (same book); sharing the relevant set is not. Also reported: how
    // many relevant entries each scene has, since a thin scene contributes noise at full weight in the sign
    // test, and that is worth knowing before spending grading time.
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

    // Signal quality per scene. Every arm below is a reweighting of these three signals, so which of them
    // tracks relevance on which book is the context that makes a delta interpretable — a keys arm moving
    // nothing on a book whose keys barely correlate with grade is not a null result about the arm (F45).
    // Measured with tie-corrected Spearman (graded pools are mostly zeros); absent signals count as 0.
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

    // Baseline disagreement check. If the scenes don't share a starting value for a parameter, an absolute arm
    // is a different contrast on each of them and the sign test is answering a muddled question.
    const swept = [...new Set(picked.flatMap(a => Object.keys(ARMS[a])))];
    const disagree = swept.filter(k => new Set(scenes.map(s => JSON.stringify(s.P[k]))).size > 1);
    if (disagree.length) {
        console.log('\n!! scenes disagree on the BASELINE value of: ' + disagree.map(k => `${k} (${scenes.map(s => `${s.name.slice(0, 12)}:${s.P[k]}`).join(', ')})`).join('; '));
        console.log('   an absolute arm is therefore a different contrast per scene. Re-capture at a common configuration, or read those arms as directional only.');
    }

    const results = [];
    for (const armName of picked) {
        const { __chunk: chunkCfg, __reload: needsReload, __dense: denseAll, __archived: archived, ...armParams } = ARMS[armName];
        // The ceiling and the cutoff ride on every arm as well as the baseline, or the two are scored under
        // different stage-4 conditions and the delta is that difference rather than the parameter's.
        const scoring = { ...armParams, ...GLOBAL };
        const cells = [];
        for (const sc of scenes) {
            let r;
            if (chunkCfg || denseAll || archived) {
                // A chunk arm needs its own collection, so the preloaded scene can't be reused — the index is
                // exactly what changed; the query embedding still can, since the query text is untouched. A
                // dense-all arm is the same shape, a centroid arm likewise, and --archived adds disabled
                // memory chunks that only weigh in the mean. `all` comes from the scene's params when the arm
                // does not force it: a vectorized-only collection cannot be scored under denseAllEntries,
                // which is the default.
                const built = await ensureIndex(sc.S, { overrides: chunkCfg ?? {}, all: !!denseAll || !!sc.P.denseAllEntries, archived: !!archived, model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url, ollama: OLLAMA, log: () => {} });
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: built.path, model: MODEL, ollama: OLLAMA, qv: sc.qv });
            } else if (needsReload) {
                // Same collection, but the gazetteer is baked at load time, so the preloaded scene is stale
                // for this arm (scoreScene throws rather than let it pass). Reload; the query embedding still
                // holds. `all` comes from the scene's own params: indexPath otherwise resolves the live
                // vectorized-only collection, which a denseAllEntries scene cannot be scored against.
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: indexPath(sc.S, { model: EM.label, all: sc.P.denseAllEntries }), model: MODEL, ollama: OLLAMA, qv: sc.qv });
            } else {
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, scene: sc.scene, qv: sc.qv });
            }
            // The flag is read at the window the score is taken from — no k bounds the admitted set, so a
            // cell scored at the cut and flagged at the top-k could deliver an ungraded row and print no `?`
            // at all. See scoreWindow in scene.mjs.
            const win = WINDOWED[METRIC] ? { judged: r.atCut.judged, of: r.atCut.n } : { judged: r.judged, of: r.of };
            cells.push({ scene: sc.name, delta: mOf(r) - mOf(sc.base), ...win, unjudged: r.unjudged });
        }
        results.push({ arm: armName, cells, stat: signTest(cells.map(c => c.delta)) });
    }

    // Holm-Bonferroni within each family, not across every arm run. A family is one question ("what should
    // chunkSize be?"), so correcting its doses against each other is right; correcting them against unrelated
    // arms would make the answer depend on what else was passed on the command line. Reported alongside the
    // raw p, never replacing it: the raw value is the screening signal.
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

    // --- PER LINEAGE, which is the unit the sign test above is NOT using ---------------------------------
    // Scenes of one book are not independent draws, and books are not either: a book is versioned in place
    // and renamed by whatever card it hung off, so file names split one corpus into several (C11). Grouping
    // by content (scene.mjs lineagesOf) is the only thing that recovers the real n. Both rows are reported
    // and neither replaces the other — the scene-level sign test has power and pseudo-replication, the
    // lineage means have neither, and the lineage view is for showing whether the books agree in direction:
    // an arm that helps one corpus and hurts another is not a flat arm, and the pooled row cannot tell them
    // apart.
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

    // --- DOSE-RESPONSE, for any family swept at 3+ values. This is what carries the information at small n:
    // a sign test per dose only says "differs from baseline", while the per-scene peak says where the optimum
    // sits and whether the scenes agree about it — the only readout that can distinguish a genuine interior
    // optimum from a monotone drift.
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
    // Exactly zero everywhere is invariance, not a null result, and the two want opposite conclusions:
    // "flat, leave the defaults alone" versus "this metric cannot see this parameter at all".
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
