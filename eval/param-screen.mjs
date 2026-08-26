// Paired arm screening across graded scenes — the estimator for small n.
//
// WHY NOT graded-scene-grid.mjs PER SAMPLE. That tool answers "which cell wins on THIS scene", and with a
// handful of scenes that question has no defensible answer: between-scene variance swamps between-parameter
// variance (one sample's grid spans nDCG@10 0.87-0.99, another's sits elsewhere), and picking the argmax of
// hundreds of cells from three scenes is noise-mining. Gradeable chats are structurally rare — a chat has to
// be long enough to have history worth retrieving and rich enough for some of it to be irrelevant.
//
// What small n DOES support is a paired contrast. Score each scene at its own baseline, score it again
// with ONE parameter changed, and look at the sign of the difference. Each scene is its own control, so the
// between-scene variance cancels, and the claim becomes "this change helps consistently" rather than "this
// cell scored highest once". The price is that the claim is directional: see signTest in metrics.mjs for the
// p-value floor (6/6 one-way is p=0.031; 3/3 is p=0.25 and is not significance, it is an observation).
//
// ONE PARAMETER AT A TIME, DELIBERATELY. This is a screen, not a grid. Its job is to find the few parameters
// that move the metric at all, so the expensive interaction grid can be confined to those; every parameter
// that comes back flat here should be left at its default with "measured flat, n=X scenes across Y chats"
// written next to it, which is an honest and useful finding rather than a failure.
//
// MULTIPLICITY IS REAL. Every arm below is a comparison, and at n=6 a run of ~20 arms will manufacture a
// consistent-looking direction by chance. The footer reports the comparison count and a Holm-corrected view
// for exactly this reason; treat an uncorrected p as a screening signal, never as a result.
//
// Usage (from SillyTavern root):
//   node .../param-screen.mjs <sample.json> [sample2.json ...] [--arms K1=3,filter=off] [--k 10] [--list]
//
// Samples are /wa-grade or /wa-super-grade manifests. Their POOLS MUST BE HONEST for this to mean anything:
// an arm that surfaces unjudged entries scores them 0 and looks worse than it is, so judged coverage is
// reported per cell and a run with gaps is flagged. Pool first with /wa-super-grade, then screen here.
import { readFileSync } from 'node:fs';
import { indexPath, loadScene, openSample, sceneParams, scoreScene, embed, sceneLabel, lineagesOf } from './scene.mjs';
import { jaccard, signTest, spearman, gradeValue } from './metrics.mjs';
import { isDurable, rowKey } from '../extension/grading.mjs';
import { ensureIndex, resolveModel } from './reindex.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));

// One-at-a-time deviations. Values are ABSOLUTE, not offsets: each scene is compared against its own
// `params` baseline, so the tool prints that baseline per parameter and flags when the scenes disagree
// about it — a contrast that means +1.8 on one scene and +1.0 on another is not one contrast.
const ARMS = {
    'K1=1.2': { K1: 1.2 }, 'K1=2': { K1: 2 }, 'K1=3': { K1: 3 },
    'B=0.6': { B: 0.6 }, 'B=0.9': { B: 0.9 },
    // OCCURRENCES -> SCORE. The shipped curve gives a key present once 1/(1+k1); these make presence worth
    // the key's full weight and let only repeats accrue, bounded at R (presence) or never (presence-log).
    // R and k1 are independent: k1 is how fast repeats accrue, R is how far they can go.
    'repeat=presence': { repeatCurve: 'presence', repeatR: 1 },
    'repeat=presence-R2': { repeatCurve: 'presence', repeatR: 2 },
    'repeat=presence-R3': { repeatCurve: 'presence', repeatR: 3 },
    'repeat=log': { repeatCurve: 'presence-log', repeatR: 1 },
    'repeat=log-R0.5': { repeatCurve: 'presence-log', repeatR: 0.5 },
    'repeat=log-R2': { repeatCurve: 'presence-log', repeatR: 2 },
    'LEXW=0.5': { LEXW: 0.5 }, 'LEXW=1': { LEXW: 1 }, 'LEXW=2': { LEXW: 2 }, 'LEXW=3': { LEXW: 3 },
    // KEYS WEIGHT, now separable from text. null mirrors LEXW, which is what every capture before the split
    // used; a number overrides it. The per-scene optima that motivated the split were (text 0.5, keys 3),
    // (1.5, 0) and (1.5, 1), so 0 is a real candidate, not a degenerate one.
    'KEYW=0': { KEYW: 0 }, 'KEYW=0.5': { KEYW: 0.5 }, 'KEYW=1': { KEYW: 1 }, 'KEYW=2': { KEYW: 2 }, 'KEYW=3': { KEYW: 3 },
    // Whether a VECTORIZED entry's keys score at all. SCORING, never selection: the keys are admitted to
    // scoringKeys() to re-rank candidates retrieval already returned, so it can reorder the top 10 but can
    // never add an entry to it.
    //
    // BOTH DIRECTIONS ARE ARMS because values here are absolute and captures disagree: the harness default
    // is off, every sommers capture is on, so only one of these is a live contrast for a given scene and
    // the other is a silent no-op. Check the printed baseline before reading a flat result as a finding.
    // Only means anything on a book whose keys have been curated — on an uncurated one it measures the
    // generator, not the hypothesis.
    // THESE NO LONGER MOVE THE POPULATION. Measured at the current architecture, 70 scenes: every arm below
    // returns a BYTE-IDENTICAL candidate set — 10103 vector rows, 353 keyword rows, 670 of 672 retrievable
    // relevant — and only the query-term count differs (6130 shipped, 9839 keys-live). The old figure here
    // ("adds 767 keyword-only rows, loses 174 vector rows across 65 scenes") was an artifact of
    // admitCeiling 100: those rows were vectorized entries the ceiling kept out of the pooled set, which
    // live keys then re-admitted by the keyword route. At 1000 the ceiling excludes nothing and stage 1
    // reads no term weights, so suppression cannot reach admission from either direction.
    //
    // What is left is stage 3 alone: the term set feeds content-lexical, and scoringKeys decides whether a
    // vectorized entry's keys are counted. One upside — an arm that cannot change the population cannot
    // surface an unjudged row, so unlike a chunk arm its delta is not a pool-biased lower bound.
    //
    // WHAT THE GAZETTEER READS. Shipped is keys+titles, and everything defending that choice is thin: the
    // "keys alone score identically" claim comes from a 5-target gold set that no longer exists, and the
    // bodies arm lost at n=3 scenes. One family, so the doses correct against each other. __reload because
    // the gazetteer is baked at load time.
    //
    // ALL FOUR MEASURED FLAT, n=71 scenes, paired — including gaz=none, which deletes the gazetteer
    // outright (nDCG@10 -0.0082, 28/42, p=0.120; F@R -0.0054, 19/15/37, p=0.608). So the field choice is not
    // what to argue about: at this sample size the whole gazetteer is inside noise, and the proper-noun
    // boost is carrying the entity filter on its own. Kept as standing arms because that null is the answer
    // to a question that keeps getting re-asked, and re-asking it should cost one command.
    //
    // THOSE DELTAS WERE MEASURED WHEN THESE ARMS ALSO MOVED ADMISSION, by up to 137 rows. They no longer
    // do: re-measured at the current architecture over 70 scenes, all four return a byte-identical
    // candidate set to baseline and to each other (10103 vector rows, 353 keyword rows, 670 relevant),
    // differing only in query terms — 2911 for none, 4042 keys, 6130 shipped, 36789 bodies. Stage 1 reads
    // no term weights, so the gazetteer reaches content-lexical at stage 3 and nothing else. The flat
    // finding survives the narrowing; what changed is that these now measure a pure reweighting, which is
    // a cleaner contrast than the one that produced the numbers above.
    'gaz=keys': { gazetteerSource: 'keys', __reload: true },
    'gaz=titles': { gazetteerSource: 'titles', __reload: true },
    'gaz=bodies': { gazetteerSource: 'bodies', __reload: true },
    'gaz=none': { gazetteerSource: 'none', __reload: true },
    'K=10': { K: 10 }, 'K=60': { K: 60 },
    'boost=1': { boost: 1 }, 'boost=5': { boost: 5 }, 'boost=8': { boost: 8 },
    'stopwordDf=0.15': { stopwordDf: 0.15 }, 'stopwordDf=0.4': { stopwordDf: 0.4 },
    'filter=off': { entityFilter: false },
    // CHUNK ARMS. These change what text gets EMBEDDED, so unlike every arm above they cannot be re-derived
    // from the stored index — each needs its own collection, rebuilt from the sample's embedded books
    // (reindex.mjs) and cached on disk. That makes them the slow arms: first run pays one embedding pass per
    // scene per arm, later runs are free. They are also the arms most worth having, since chunk settings were
    // the one class of parameter nobody could measure, and WA's own defaults there were chosen by eye.
    // A LADDER, NOT TWO PROBES. chunkSize plausibly has an INTERIOR optimum — too small and a chunk carries
    // no context, too large and its centroid represents nothing in particular — so three points cannot
    // locate it, they can only report a direction. Eight doses can show the shape, and the dose-response
    // block below reads the per-scene peak off them.
    //
    // Cheaper than it looks: the index cache is keyed on book + model + chunk settings, NOT on scene, so every
    // scene graded against the same lorebook reuses one build per dose. Cost scales with BOOKS x doses.
    ...Object.fromEntries([200, 300, 400, 600, 800, 1200, 1600, 2400].map(v => [`chunkSize=${v}`, { __chunk: { chunkSize: v } }])),
    ...Object.fromEntries([0, 60, 120, 200, 300, 500].map(v => [`minChunk=${v}`, { __chunk: { minChunkSize: v } }])),
    'chunkMode=length': { __chunk: { chunkMode: 'length' } },

    // A COSINE FOR EVERY ENTRY — the dense twin of giving keyword entries a text score (content-lexical.mjs).
    // A keyword-only entry has no vector row, so its semantic standing is estimated from keys and content
    // BM25 alone; this embeds every entry with content and hands stage 3 the cosine as a fourth column's
    // worth of evidence on the rows it already ranks. Needs its own collection (reindex.mjs --all), so it is
    // a slow arm on first run like the chunk arms, and free after.
    //
    // STAGE 3 ONLY, which is what makes its Δ readable: activation is untouched, so unlike a chunk arm it
    // cannot surface an unjudged row and its delta is not a pool-biased lower bound. It does move two things
    // at once — see denseAllEntries in scene.mjs for the tilt that stops applying.
    'denseAll=on': { __dense: true, denseAllEntries: true },
    // THE SAME COSINE THROUGH THE COLUMN THE LEARNED-SPARSE SCORES WERE MEASURED IN (ranking.mjs
    // sparseWeight, scene.mjs denseColumn). Weight 0.5, same eligibility rule, `score` and the keyword-only
    // tilt untouched — so denseCol=nocos against the sparse run's own nocos arm differs in the number the
    // column holds and nothing else, which denseAll=on does not.
    //
    // Only 'nocos' is a standing arm. denseColumn 'all' and 'cos' put a vectorized entry's own cosine in
    // the column beside itself, so they can only reweight the vector signal — a question the vector weight
    // asks directly. Measured on 70 scenes they moved +0.0056 and +0.0005 nDCG@10, and an arm that measures
    // nothing still costs a comparison in every later run's multiplicity count. scene.mjs still implements
    // both; call scoreScene with the override to run them.
    'denseCol=nocos': { __dense: true, denseAllEntries: true, denseColumn: 'nocos' },
    // WHAT THE CORPUS MEAN IS TAKEN OVER (scene.mjs centroidPopulation). Two doses of one question, run
    // separately because they are two independent changes: 'memory' only drops the `vectorized` filter, and
    // moves nothing on a book whose memory entries are all flagged; 'memoryArchived' adds the disabled ones,
    // and moves nothing on a book with no retired arcs.
    //
    // READ PER BOOK, NOT POOLED. Treatment intensity is a property of the lorebook — the archived fraction
    // — so a pooled sign test averages a no-op book with a large-move one and reports a middle that
    // describes neither. Time Whore has zero archived memory entries and its delta must come back exactly 0;
    // that is the arm's own correctness check, not a data point.
    'centroid=vectorized': { __dense: true, denseAllEntries: true, centroidPopulation: 'vectorized' },
    // ALL-BUT-THE-TOP (scene.mjs pcRemove). Same collection as the baseline — the components come off the
    // vectors already on disk — so these need only a reload, not a build.
    //
    // WHY IT IS ASKED HERE AND NOT ON centering-grid'S LOO TASK, where it was screened first: that task has
    // no selection stage, so nDCG@10 and recall@5 are read at windows nothing chooses, while a real layout
    // runs past 200 entries. It screened unpromising — helps in proportion to a book's own-direction share,
    // which means it helps the small thematic reference books and goes slightly negative on the long
    // narrative ones — but it cannot see the delivered set, which is what the answer is about.
    'pc=1': { __reload: true, pcRemove: 1 },
    // TWO-STAGE (scene.mjs globalBasis + pcRemove). Stage A removes the mean and top-m directions shared
    // with other LINEAGES' memory chunks; stage B then centres on what is left and removes k of ITS leading
    // directions, which are the book's own by construction rather than by hope.
    //
    // `shared=N` alone is the control that separates the halves: it strips the shared part and keeps ordinary
    // centring on the residual, so a gain there is stage A's and a gain only in gb=4+pcN is stage B's.
    // Needs `node eval/global-basis.mjs <samples...>` first; loadScene throws with that line if absent.
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`shared=${v}`, { __reload: true, sharedComponents: v }])),
    // THE SAME DOSES, PICKED BY SHAREDNESS instead of by explained variance — one family with the arms
    // above, so the two selection rules are contrasted at matched N rather than against each other's best.
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`sharedEta=${v}`, { __reload: true, sharedComponents: v, sharedSelect: 'shared' }])),
    // The same doses off the WITHIN-book scatter, one family with the two above so the estimator and the
    // selection rule are each contrasted at matched N rather than against the other's best.
    ...Object.fromEntries([1, 2, 4, 8].map(v => [`sharedWithin=${v}`, { __reload: true, sharedComponents: v, sharedScatter: 'within' }])),
    // WHITENING (scene.mjs whitenR/whitenAlpha) — the only lever in this family that changes the cloud's
    // SHAPE rather than its position. Centring is a translation and provably cannot remove book identity
    // (measured: 1-NN same-book purity 99.4% -> 98.2%); rescaling the directions a book spreads along is
    // the operation that can. alpha 0 is the control and must reproduce the baseline exactly.
    ...Object.fromEntries([0.25, 0.5, 1].map(a => [`whiten=${a}`, { __reload: true, whitenR: 16, whitenAlpha: a }])),
    'whiten=1r64': { __reload: true, whitenR: 64, whitenAlpha: 1 },
    'whiten=0': { __reload: true, whitenR: 16, whitenAlpha: 0 },
    'shared=4+pc1': { __reload: true, sharedComponents: 4, pcRemove: 1 },
    'shared=4+pc2': { __reload: true, sharedComponents: 4, pcRemove: 2 },
    'pc=2': { __reload: true, pcRemove: 2 },
    'pc=4': { __reload: true, pcRemove: 4 },
    'centroid=memoryArchived': { __dense: true, __archived: true, denseAllEntries: true, centroidPopulation: 'memoryArchived' },
    // THE OTHER HALF OF THAT ARM, on its own: denseAll=on both adds the cosine and removes the keyword-only
    // tie-break from the entries that get one, so tilt=1 is what splits the pair (the cosine's own
    // contribution reads as denseAllΔ - tiltΔ).
    //
    // THE DOSE QUESTION IS CLOSED — the ladder finding lives at ranking.mjs KEYWORD_ONLY_TILT (13 doses
    // 0.75-3, 70 scenes, unimodal on both metrics, joint plateau [1.25, 1.3]). These two are TRIPWIRES,
    // one per cliff edge: tilt=1 must read ~-0.02 F@R and tilt=1.5 ~-0.02 nDCG, and a flat cell means the
    // fusion or the population changed shape and the ladder wants re-running, not that the tilt is free.

    // Mean-centering off: rank on RAW cosine. The contrast is end-to-end — it moves the retrieval ranking,
    // the top-K, the admission gate and the fused layout order together, which is what makes it different
    // from comparing the two score columns on a fixed candidate set.
    'centering=off': { meanCentered: false },

    // THE HIGH-BAND HOLD-OUT. Sommers curation deliberately retained every key firing above 15.6% of
    // messages (whole-word, frozen chat) so keep-vs-remove could be answered here instead of by intuition:
    // Jeffrey 39%, Liam 29%, Brad 25%, Arthur 22%, Shane 21%. Teddy sits AT 15.6% and was judged per-entry
    // (removed from 9 entries, kept on 71), so it is not in the arm. Removal semantics via scoringKeys:
    // stops scoring and keyword-activating; gazetteer untouched (see scene.mjs). READ THE SIGN, per the
    // curator: consistent negative = removal hurts (keep wins); consistent positive = removal helps; flat
    // or mixed = "not better, not worse" — which licenses nothing beyond itself.
    'dropKeys=hiband': { dropKeys: ['Jeffrey', 'Liam', 'Brad', 'Arthur', 'Shane'] },
    // UNIFORM CAST PLACEMENT. The curation kept main-cast bare names only where the generator had already
    // put them, so dropKeys=hiband measured removal from INCONSISTENT placement. These arms fill the gap
    // mechanically (scene.mjs addCastKeys: name appended wherever entry content mentions it whole-word and
    // no key form exists — 700 (entry,name) fills over the curated book, dominated by pack principals:
    // Jeffrey 178 fills vs 2 keyed, Brad 151/1, Shane 134/3). Kyle excluded (player persona), Sara and Ian
    // excluded (known orthographic collisions the fill would reintroduce).
    // cast+dropHi is the interaction: uniform placement of the non-band cast with the band absent — read it
    // against addKeys=cast, not only against baseline, to see whether the band still earns its keep once
    // placement is uniform.
    'addKeys=cast': { addCastKeys: ['Jeffrey', 'Shane', 'Brad', 'Micah', 'Teddy', 'Alex', 'Dylan', 'Liam', 'Marjorie', 'Valentina', 'Arthur'] },
    'addKeys=cast+dropHi': { addCastKeys: ['Jeffrey', 'Shane', 'Brad', 'Micah', 'Teddy', 'Alex', 'Dylan', 'Liam', 'Marjorie', 'Valentina', 'Arthur'], dropKeys: ['Jeffrey', 'Liam', 'Brad', 'Arthur', 'Shane'] },
    // THE CUT ITSELF, read with --metric fAtCut. The shipped memory fit's own cutoff is the baseline, so
    // these are absolute doses around it; the window they move is the only one the system sizes for
    // itself (scene.mjs, @cut). Screening it against a fixed-k metric measures nothing — k is handed the
    // count the cutoff is supposed to decide.
    'cutoff=0.04': { memoryCutoff: 0.04 },
    'cutoff=0.12': { memoryCutoff: 0.12 },
    'cutoff=0.16': { memoryCutoff: 0.16 },
    'cutoff=0.22': { memoryCutoff: 0.22 },
    'cutoff=0.30': { memoryCutoff: 0.30 },
};

/** Arms that answer the SAME question at different doses. Derived from the name, so adding a dose needs no
 *  bookkeeping. Multiplicity is corrected within a family, because eight chunkSize doses are one question
 *  asked eight ways, not eight independent findings. */
const familyOf = arm => arm.split('=')[0];

if (argv.includes('--list')) { console.log(Object.keys(ARMS).join('\n')); process.exit(0); }
if (!samples.length) {
    console.error('need at least one sample: node param-screen.mjs <sample.json> [more.json ...] [--arms a,b] [--k 10] [--metric fAtCut|f2|n|fAtR] [--list]');
    console.error('one sample runs, but reports no sign test — pairing needs scenes to pair.');
    process.exit(2);
}

const picked = arg('--arms') ? String(arg('--arms')).split(',').map(s => s.trim()).filter(Boolean) : Object.keys(ARMS);
const unknown = picked.filter(a => !ARMS[a]);
if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — see --list`); process.exit(2); }

const K = Number(arg('--k') ?? 10);
// The token ceiling every scene is walked under, baseline and arms alike — it is a user's cost decision,
// not a property of a scene, so it cannot come off the bundle. Required by --metric fAtBudget.
const BUDGET = Number(arg('--budget') ?? 0);
// WHICH METRIC THE SIGN TEST READS, and the default is the VALIDITY SCORE rather than a diagnostic.
//
// `fAtCut` is F-beta(2) on the asymmetric bars over the set the relevance cut admits — the only window the
// system chooses for itself, so it is the one that can see an arm change HOW MANY entries survive, which is
// half of what stage 4 decides. It was `n`, and that is a ranking metric read at a fixed k: it cannot see an
// entry that lands outside the window, and it cannot see a count change at all.
//
// THE DEFAULT IS LOAD-BEARING, which is why it is not left at the diagnostic. Measured across five arms on
// 103 scenes, moving the window from top-10 to the admitted set roughly halved every tie column — 82 to 52
// on a chunkSize dose, 84 to 47 on a two-stage PCA arm — and reversed the sign of the largest per-lineage
// effect in the set. A screen reporting `n` therefore says "flat" about arms that move the delivered set,
// and it says it in the same words as a real null.
//
// The others stay available and are diagnostics on the ORDERING: `n`/`nAt5` are nDCG at a fixed depth, `f2`
// is F-beta(2) at a fixed k, and `fAtR` is sized by the scene's relevant count rather than by --k. Baseline
// and arm are always scored on the same one, so a run mixing them is impossible.
const METRIC = arg('--metric') ?? 'fAtCut';
const WINDOWED = { fAtR: r => r.atR.f, fAtCut: r => r.atCut.f, nAtCut: r => r.atCut.n, fAtBudget: r => r.atBudget?.f ?? NaN, nAtBudget: r => r.atBudget?.n ?? NaN };
if (!['n', 'nAt5', 'f2', 'recall', 'precision', ...Object.keys(WINDOWED)].includes(METRIC)) { console.error(`unknown --metric ${METRIC}`); process.exit(2); }
const mOf = r => (WINDOWED[METRIC] ? WINDOWED[METRIC](r) : r[METRIC]);
// THE MODEL IS A SPEC, resolved once (reindex.mjs resolveModel). The LABEL names collections and bases;
// the rest says how to call the model, including the task prefix a prefix-trained family needs. A bare
// name still means ollama, so `bge-m3` behaves exactly as before.
// FALLS BACK TO THE BUNDLE'S OWN MODEL, not to a hardcoded name. A bundle records the model its
// collections are keyed under, and hardcoding one meant a corpus that had moved on still resolved the old
// collections — which exist, so nothing errored, it just quietly measured the previous model.
// Read off the FIRST sample; a screen pools scenes, and pooling two models' cosines is not a
// comparison, so a disagreement is reported below rather than silently averaged.
const MODEL = process.env.WA_EMBED_MODEL ?? openSample(samples[0], arg('--arm')).embedModel ?? 'bge-m3';
const EM = resolveModel(MODEL);
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const fx = n => (n >= 0 ? '+' : '') + n.toFixed(4);

(async () => {
    // Load and embed each scene ONCE. Arms only reweight, so nothing below needs a second embed call.
    const scenes = [];
    for (const path of samples) {
        // A bundle contributes ONE arm, never all of them: its arms are the same scene scored differently,
        // so expanding them would be textbook pseudo-replication in the sign test.
        const S = openSample(path, arg('--arm'));
        // EXCLUDED, NOT WARNED ABOUT, AND BEFORE ANYTHING ELSE TOUCHES IT. A warning in a 250-line log is
        // not a guard: this corpus holds a deliberate WRONG-BOOK null fixture — a scene paired with a book
        // from another story, composed to measure what retrieval does when the corpus cannot answer — and
        // it sat in every screen this file ran, contributing a tie to every arm, because the only thing
        // that said so was its FILENAME.
        //
        // FIRST, not after loadScene: a configuration that is not real has no reason to have a usable
        // collection either, and checking it late means the run dies on the index of a bundle it was about
        // to skip. --include-invalid puts it back for the one question it is evidence about.
        if (S.invalidConfiguration) {
            console.log(`!! ${sceneLabel(S) || path} IS NOT A REAL CONFIGURATION — ${S.invalidConfiguration}`);
            if (!argv.includes('--include-invalid')) { console.log('   excluded; pass --include-invalid to pool it anyway'); continue; }
            console.log('   POOLED ANYWAY (--include-invalid): every number below mixes it with real scenes');
        }
        if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`${path}: embeds no entries for primary book "${S.primaryBook ?? '?'}" — re-grade with books=full|meta`); process.exit(2); }
        if (!S.candidates?.length) { console.error(`${path}: logs no candidates`); process.exit(2); }
        const P = sceneParams(S, BUDGET ? { budgetTokens: BUDGET } : {});
        const scene = loadScene(S, { indexFile: indexPath(S, { model: EM.label, all: P.denseAllEntries }), indexOpts: { model: EM.label }, params: P });
        const qv = await embed(EM.query + S.query, { ollama: OLLAMA, model: EM.model, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url });
        const base = await scoreScene({ sample: S, overrides: BUDGET ? { budgetTokens: BUDGET } : {}, k: K, scene, qv });
        scenes.push({ path, name: sceneLabel(S) || path, S, scene, qv, P, base });
        console.log(`scene "${sceneLabel(S) || path}": baseline ${METRIC}@${K} ${mOf(base).toFixed(4)} (nDCG ${base.n.toFixed(4)}, P ${base.precision.toFixed(3)}, R ${base.recall.toFixed(3)}, rel ${base.relevant}), judged ${base.judged}/${base.of}${base.judged < base.of ? ' !!' : ''}`);
        console.log(`    F@R ${base.atR.f.toFixed(4)} (P ${base.atR.precision.toFixed(3)} R ${base.atR.recall.toFixed(3)}, n ${base.atR.n})`);
        // `of` is the rankable top-k, so 0 means the reference-tier removal took EVERYTHING — a
        // reference-only book. Every arm then scores 0 and every delta is a tie, so the scene inflates the
        // scene count without contributing evidence. The judged<of check cannot see it: 0 < 0 is false.
        if (!base.of) console.log('  !! nothing rankable: every candidate is reference tier, so this scene can only produce ties. It counts in n and contributes nothing.');
    }
    if (scenes.length < 2) console.log('\n!! ONE SCENE: deltas are shown but no sign test is possible. Pairing needs scenes to pair.');

    // --- ARE THESE SCENES ACTUALLY DISTINCT? -----------------------------------------------------------
    // Finding well-separated gradeable moments in one chat is the hard part of raising n, and "far enough
    // apart" is not eyeballable: two points can sit hundreds of messages apart and still retrieve the same
    // handful of entries because the same thread is live. So it gets measured.
    //
    // The measure is Jaccard on the RELEVANT sets (grade>=3), not on the judged pools. nDCG is driven by
    // where the relevant entries land, so two scenes that agree on which entries matter will move in lockstep
    // under every arm below — they are one observation, and counting them as two manufactures power. Sharing
    // JUDGED entries is fine and expected (same book); sharing the relevant set is not.
    //
    // Also reported: how many relevant entries each scene has. nDCG on a scene with two or three is fragile —
    // one rank change swings it hard — so a thin scene contributes noise to the sign test at full weight.
    // That is the other half of "signals fairly clear", and it is worth knowing BEFORE spending grading time.
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

    // SIGNAL QUALITY per scene. Every arm below is a reweighting of these three signals, so knowing which of
    // them actually tracks relevance on which book is the context that makes a delta interpretable — a keys
    // arm moving nothing on a book whose keys correlate 0.27 with grade is not a null result about the arm.
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
        // The ceiling rides on every arm as well as the baseline, or the two are scored under different
        // stage-4 conditions and the delta is that difference rather than the parameter's.
        const scoring = BUDGET ? { ...armParams, budgetTokens: BUDGET } : armParams;
        const cells = [];
        for (const sc of scenes) {
            let r;
            if (chunkCfg || denseAll || archived) {
                // A chunk arm needs its OWN collection, so the preloaded scene can't be reused — the index is
                // exactly what changed. The query embedding still can: the query text is untouched.
                // A dense-all arm is the same shape: same chunk settings, a collection covering every entry.
                // A centroid arm likewise, and --archived adds disabled memory chunks that only weigh in the mean.
                // `all` FROM THE SCENE'S PARAMS when the arm does not force it, for the same reason the
                // reload branch needs it: a chunk arm builds its own collection, and a vectorized-only one
                // cannot be scored under denseAllEntries — which is the default, so every chunk arm was
                // building a collection loadScene then refused.
                const built = await ensureIndex(sc.S, { overrides: chunkCfg ?? {}, all: !!denseAll || !!sc.P.denseAllEntries, archived: !!archived, model: EM.model, prefix: EM.doc, label: EM.label, endpoint: EM.endpoint, url: EM.endpoint === 'ollama' ? OLLAMA : EM.url, ollama: OLLAMA, log: () => {} });
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: built.path, model: MODEL, ollama: OLLAMA, qv: sc.qv });
            } else if (needsReload) {
                // Same collection, but the gazetteer is baked at load time, so the preloaded scene is stale
                // for this arm (scoreScene throws rather than let it pass). Reload; the query embedding still
                // holds, since the query text is what did not change.
                // `all` FROM THE SCENE'S OWN PARAMS. indexPath resolves the live vectorized-only collection
                // without it, which a denseAllEntries scene cannot be scored against — and denseAllEntries is
                // the default now, so every reload arm was resolving a collection loadScene then refused.
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: indexPath(sc.S, { model: EM.label, all: sc.P.denseAllEntries }), model: MODEL, ollama: OLLAMA, qv: sc.qv });
            } else {
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, scene: sc.scene, qv: sc.qv });
            }
            cells.push({ scene: sc.name, delta: mOf(r) - mOf(sc.base), judged: r.judged, of: r.of, unjudged: r.unjudged });
        }
        results.push({ arm: armName, cells, stat: signTest(cells.map(c => c.delta)) });
    }

    // Holm-Bonferroni WITHIN each family, not across every arm run. A family is one question ("what should
    // chunkSize be?"), so correcting eight of its doses against each other is right; correcting them against
    // unrelated LEXW arms would make the answer depend on what else you happened to pass on the command line.
    // Reported alongside the raw p, never replacing it: the raw value is the screening signal.
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
            + (gaps ? `   (${gaps} scene(s) with unjudged rows in top ${K})` : ''));
    }

    console.log('\n^ = helps on every scene, v = hurts on every scene, ? = that cell kept unjudged rows so its Δ is a lower bound.');
    console.log(`comparisons made: ${results.length} across ${byFamily.size} parameter famil${byFamily.size === 1 ? 'y' : 'ies'} (holm corrected within family).`);
    console.log(`At n=${scenes.length} the best achievable two-sided p is ${signTest(Array(scenes.length).fill(1)).p.toFixed(3)}.`);

    // --- PER LINEAGE, which is the unit the sign test above is NOT using ---------------------------------
    // Scenes of one book are not independent draws, and books are not either: a book is versioned in place
    // and renamed by whatever card it hung off, so file names split one corpus into several. Measured here:
    // three of this corpus's file names are the same Ascensus at 92-100% identical bodies. Grouping by
    // content (scene.mjs lineagesOf) is the only thing that recovers the real n.
    //
    // BOTH ROWS ARE REPORTED, and neither replaces the other. The scene-level sign test above has power and
    // pseudo-replication; the lineage means below have neither. What the lineage view is FOR is showing
    // whether the books agree in DIRECTION — an arm that helps one corpus and hurts another is not a flat
    // arm, and the pooled row cannot tell those apart.
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
    // a sign test per dose only says "differs from baseline", while the per-scene PEAK says where the optimum
    // sits and whether the scenes agree about it. Agreement across independent scenes on a peak region is a
    // much stronger signal than any single dose clearing a p-value threshold, and it is the only readout that
    // can distinguish a genuine interior optimum from a monotone drift.
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
    // EXACTLY zero everywhere is invariance, not a null result, and the two want opposite conclusions:
    // "flat, leave the defaults alone" versus "this metric cannot see this parameter at all". A set
    // metric read over a population no arm can change reads 0.0000 for every cell — which is what a
    // whole-population window does while stage 4 makes no relevance decision.
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
