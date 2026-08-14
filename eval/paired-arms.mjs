// Paired arm screening across several graded scenes — the estimator for single-digit n.
//
// WHY NOT graded-scene-grid.mjs PER SAMPLE. That tool answers "which cell wins on THIS scene", and with a
// handful of scenes that question has no defensible answer: between-scene variance swamps between-parameter
// variance (one sample's grid spans nDCG@10 0.87-0.99, another's sits elsewhere), and picking the argmax of
// hundreds of cells from three scenes is noise-mining. Gradeable chats are structurally rare — a chat has to
// be long enough to have history worth retrieving and rich enough for some of it to be irrelevant — so n is
// never going to rescue that approach.
//
// What single-digit n DOES support is a paired contrast. Score each scene at its own baseline, score it again
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
//   node .../paired-arms.mjs <sample.json> [sample2.json ...] [--arms K1=3,filter=off] [--k 10] [--list]
//
// Samples are /wa-grade or /wa-super-grade manifests. Their POOLS MUST BE HONEST for this to mean anything:
// an arm that surfaces unjudged entries scores them 0 and looks worse than it is, so judged coverage is
// reported per cell and a run with gaps is flagged. Pool first with /wa-super-grade, then screen here.
import { readFileSync } from 'node:fs';
import { indexPath, loadScene, openSample, sceneParams, scoreScene, embed } from './scene.mjs';
import { jaccard, signTest, spearman, gradeValue } from './metrics.mjs';
import { isReference, rowKey } from '../extension/grading.mjs';
import { ensureIndex } from './reindex.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));

// One-at-a-time deviations. Values are ABSOLUTE, not offsets: each scene is compared against its own
// captureParams baseline, so the tool prints that baseline per parameter and flags when the samples disagree
// about it — a contrast that means +1.8 on one scene and +1.0 on another is not one contrast.
const ARMS = {
    'K1=1.2': { K1: 1.2 }, 'K1=2': { K1: 2 }, 'K1=3': { K1: 3 },
    'B=0.6': { B: 0.6 }, 'B=0.9': { B: 0.9 },
    'LEXW=0.5': { LEXW: 0.5 }, 'LEXW=1': { LEXW: 1 }, 'LEXW=2': { LEXW: 2 }, 'LEXW=3': { LEXW: 3 },
    // KEYS WEIGHT, now separable from text. null mirrors LEXW, which is what every capture before the split
    // used; a number overrides it. The per-scene optima that motivated the split were (text 0.5, keys 3),
    // (1.5, 0) and (1.5, 1), so 0 is a real candidate, not a degenerate one.
    'KEYW=0': { KEYW: 0 }, 'KEYW=0.5': { KEYW: 0.5 }, 'KEYW=1': { KEYW: 1 }, 'KEYW=2': { KEYW: 2 }, 'KEYW=3': { KEYW: 3 },
    // Whether a VECTORIZED entry's keys score at all — SELECTION vs SCORING, and only the second one.
    // suppressVectorKeys governs selection: core never activates on those keys, and blanking them is baked
    // into the gazetteer at load time (hence the throw in scoreScene). scoreVectorKeys governs scoring
    // alone — the keys are re-admitted to scoringKeys() to re-rank candidates retrieval already returned,
    // so it can reorder the top 10 but can never add an entry to it.
    //
    // BOTH DIRECTIONS ARE ARMS because values here are absolute and captures disagree: the harness default
    // is off, every sommers capture is on, so only one of these is a live contrast for a given scene and
    // the other is a silent no-op. Check the printed baseline before reading a flat result as a finding.
    // Only means anything on a book whose keys have been curated — on an uncurated one it measures the
    // generator, not the hypothesis.
    'scoreVectorKeys=on': { scoreVectorKeys: true },
    'scoreVectorKeys=off': { scoreVectorKeys: false },
    // SELECTION, the other half of the pair above — and it is NOT one variable. suppressVectorKeys blanks
    // vectorized keys so core cannot activate on them (stage 2) AND, because the gazetteer is built
    // downstream of that blanking, changes the BM25 term set (stage 1). So `vectorKeys=live` moves both, and
    // the captured keys-live arm is not a superset of shipped: measured across 65 scenes it adds 767
    // keyword-only rows but loses 174 vector rows to the reranking. The other two hold one half fixed via
    // suppressGazetteerKeys, so the effect splits. __reload because the gazetteer is baked at load time.
    'vectorKeys=live': { suppressVectorKeys: false, __reload: true },
    'vectorKeys=live-gazfixed': { suppressVectorKeys: false, suppressGazetteerKeys: true, __reload: true },
    'vectorKeys=gazraw': { suppressVectorKeys: true, suppressGazetteerKeys: false, __reload: true },
    'K=10': { K: 10 }, 'K=60': { K: 60 },
    'boost=1': { boost: 1 }, 'boost=5': { boost: 5 }, 'boost=8': { boost: 8 },
    'stopwordDf=0.15': { stopwordDf: 0.15 }, 'stopwordDf=0.4': { stopwordDf: 0.4 },
    'filter=off': { entityFilter: false },
    'thr=0.3': { threshold: 0.3 }, 'thr=0.8': { threshold: 0.8 },
    // Self-calibrating floor: p90 of the query's own centered scores (scoring.mjs 'auto'). Shipping this
    // requires it to be a measured no-op vs the stored 0.1 on bge-m3 scenes — 0.1 IS the bge-m3 p90, so any
    // gap means the quantile is tracking something the constant didn't.
    'thr=auto': { threshold: 'auto' },
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
    ...Object.fromEntries([200, 300, 400, 600, 1200, 1600, 2400].map(v => [`chunkSize=${v}`, { __chunk: { chunkSize: v } }])),
    ...Object.fromEntries([0, 60, 120, 200, 300, 500].map(v => [`minChunk=${v}`, { __chunk: { minChunkSize: v } }])),
    'chunkMode=length': { __chunk: { chunkMode: 'length' } },

    // Mean-centering off: rank on RAW cosine. The contrast is end-to-end — it moves the retrieval ranking,
    // the top-K, the admission gate and the fused layout order together, which is what makes it different
    // from comparing the two score columns on a fixed candidate set.
    'centering=off': { meanCentered: false },

    // ADMISSION ARMS — how a vectorized entry's chunk earns its way into the candidate set. The plugin ships
    // `score >= threshold || bm25 > 0` (scoring.mjs scoreCollection). Kept as standing arms so that if anyone
    // later "fixes" that OR into something stricter, the regression shows up here instead of shipping.
    //
    // WHAT WAS MEASURED (3 scenes, n=3, sample threshold 0.1):
    //   admit=cosine  the strict per-entry-type gate — cosine alone decides for vector entries, which is what
    //                 the OR looks like it should be. Sommers dropped 3/3 -> 1/3 critical entries in the top
    //                 10; time-whore lost a relevant entry outright (recall 0.88). Worse at EVERY threshold
    //                 down to 0, so it is not a calibration problem: the chunks it drops have below-average
    //                 centered cosine but real lexical hits, and mean-centering is what puts them there.
    //   admit=both    strict AND. Byte-identical to admit=cosine on all three scenes (differs by one chunk in
    //                 two books at threshold 0) — there is essentially no chunk with a clearing cosine and no
    //                 lexical overlap, so the extra conjunct removes nothing.
    //   bm25Floor=*   percentile floor on the lexical clause. Free up to p75: recall stayed 1.00, crit@10
    //                 intact, nDCG moved <=0.007 either way, candidate set shrank 7-10%. A set-size lever, not
    //                 a quality one. p90 cost time-whore a relevant entry while its nDCG ROSE — read recall
    //                 alongside. Note it is not free downstream: elbowSensitivity is a multiple of the mean
    //                 gap across the retrieved list, so shortening the list moves where the cliff fires, and
    //                 any real adoption needs the cutoff arms re-run.
    //
    // These arms only ever NARROW the candidate set, so unlike the chunk arms they cannot surface an unjudged
    // entry — judged coverage can only improve, and their deltas are not pool-biased lower bounds.
    // Only admit=cosine is a standing arm. admit=both and bm25FloorPct are still implemented in scene.mjs and
    // re-runnable by hand (--arms cannot reach them; call scoreScene with the override) — they are left out
    // here because they measured nothing, and an arm that measures nothing still costs a comparison in every
    // future run's multiplicity count.
    'admit=cosine': { admit: 'cosine' },
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
    // The shipped wrong-book failsafe (state.mjs uncenteredGate). Samples score at gate 0 for
    // reproducibility, so this arm is the tripwire: it must stay ~0.0000 on every real scene — the gate's
    // whole contract is "free on the right book" — and a nonzero Δ here means the calibration broke.
    'gate=0.5': { uncenteredGate: 0.5 },
};

/** Arms that answer the SAME question at different doses. Derived from the name, so adding a dose needs no
 *  bookkeeping. Multiplicity is corrected within a family, because eight chunkSize doses are one question
 *  asked eight ways, not eight independent findings. */
const familyOf = arm => arm.split('=')[0];

if (argv.includes('--list')) { console.log(Object.keys(ARMS).join('\n')); process.exit(0); }
if (!samples.length) {
    console.error('need at least one sample: node paired-arms.mjs <sample.json> [more.json ...] [--arms a,b] [--k 10] [--list]');
    console.error('one sample runs, but reports no sign test — pairing needs scenes to pair.');
    process.exit(2);
}

const picked = arg('--arms') ? String(arg('--arms')).split(',').map(s => s.trim()).filter(Boolean) : Object.keys(ARMS);
const unknown = picked.filter(a => !ARMS[a]);
if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — see --list`); process.exit(2); }

const K = Number(arg('--k') ?? 10);
// WHICH METRIC THE SIGN TEST READS. nDCG is a ranking metric and cannot see an entry that lands outside k,
// so an arm whose action is ADMISSION is measured by the half it does not move. `--metric f2` switches the
// delta to F-beta(2) on the asymmetric bars (scene.mjs), which weights recall twice. Baseline and arm are
// always scored on the same one, so a run mixing them is impossible.
const METRIC = arg('--metric') ?? 'n';
if (!['n', 'nAt5', 'f2', 'recall', 'precision'].includes(METRIC)) { console.error(`unknown --metric ${METRIC}`); process.exit(2); }
const mOf = r => r[METRIC];
const MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const fx = n => (n >= 0 ? '+' : '') + n.toFixed(4);

(async () => {
    // Load and embed each scene ONCE. Arms only reweight, so nothing below needs a second embed call.
    const scenes = [];
    for (const path of samples) {
        // A bundle contributes ONE arm, never all of them: its arms are the same scene scored differently,
        // so expanding them would be textbook pseudo-replication in the sign test.
        const S = openSample(path, arg('--arm'));
        if (!Object.keys(S.books?.[S.primaryBook] ?? {}).length) { console.error(`${path}: embeds no entries for primary book "${S.primaryBook ?? '?'}" — re-grade with books=full|meta`); process.exit(2); }
        if (!S.candidates?.length) { console.error(`${path}: logs no candidates`); process.exit(2); }
        const P = sceneParams(S);
        const scene = loadScene(S, { indexFile: indexPath(S, { model: MODEL }), params: P });
        const qv = await embed(S.query, { ollama: OLLAMA, model: MODEL });
        const base = await scoreScene({ sample: S, k: K, scene, qv });
        scenes.push({ path, name: S.name ?? path, S, scene, qv, P, base });
        console.log(`scene "${S.name ?? path}": baseline ${METRIC}@${K} ${mOf(base).toFixed(4)} (nDCG ${base.n.toFixed(4)}, P ${base.precision.toFixed(3)}, R ${base.recall.toFixed(3)}, rel ${base.relevant}), judged ${base.judged}/${base.of}${base.judged < base.of ? ' !!' : ''}`);
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
    const relOf = S => new Set((S.grades ?? []).filter(g => gradeValue(g) >= 3 && g.uid !== undefined).map(rowKey));
    const judgedOf = S => new Set((S.grades ?? []).filter(g => g.uid !== undefined).map(rowKey));
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
        const gm = new Map((sc.S.grades ?? []).filter(x => x.uid !== undefined).map(x => [rowKey(x), gradeValue(x) || 0]));
        const rs = (sc.S.candidates ?? []).filter(c => !isReference(c) && gm.has(rowKey(c)));
        if (rs.length < 5) { console.log(`  ${sc.name.slice(0, 34).padEnd(34)} only ${rs.length} judged candidate rows — skipped`); continue; }
        const gv = rs.map(r => gm.get(rowKey(r)));
        const sig = f => spearman(rs.map(f), gv).toFixed(2).padStart(5);
        console.log(`  ${sc.name.slice(0, 34).padEnd(34)} cosine ${sig(r => (r.cosine == null ? 0 : Number(r.cosine)))}   text ${sig(r => Number(r.text) || 0)}   keys ${sig(r => Number(r.keys) || 0)}`);
    }

    console.log(`\n${scenes.length} scene(s), ${picked.length} arm(s), ${METRIC}@${K}, each scene against its OWN captureParams baseline.`);

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
        const { __chunk: chunkCfg, __reload: needsReload, ...scoring } = ARMS[armName];
        const cells = [];
        for (const sc of scenes) {
            let r;
            if (chunkCfg) {
                // A chunk arm needs its OWN collection, so the preloaded scene can't be reused — the index is
                // exactly what changed. The query embedding still can: the query text is untouched.
                const built = await ensureIndex(sc.S, { overrides: chunkCfg, model: MODEL, ollama: OLLAMA, log: () => {} });
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: built.path, model: MODEL, ollama: OLLAMA, qv: sc.qv });
            } else if (needsReload) {
                // Same collection, but the gazetteer is baked at load time, so the preloaded scene is stale
                // for this arm (scoreScene throws rather than let it pass). Reload; the query embedding still
                // holds, since the query text is what did not change.
                r = await scoreScene({ sample: sc.S, overrides: scoring, k: K, index: indexPath(sc.S, { model: MODEL }), model: MODEL, ollama: OLLAMA, qv: sc.qv });
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
    if (!movers.length) {
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
