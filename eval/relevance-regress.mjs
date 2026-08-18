// What each stage-3 signal is WORTH as a predictor of per-entry relevance, and how a parameter moves that.
//
// Stage 4 predicts whether an individual entry is relevant, so the question a tuning parameter has to
// answer is no longer "did the ranking improve" but "did this signal become a better or worse predictor".
// param-screen answers the first; this answers the second. They can disagree, and that disagreement is
// informative rather than a contradiction: a parameter can leave nDCG flat while moving what the fusion
// would have to weight, because RRF reads only RANKS and this reads the scores themselves.
//
// THE MODEL IS LOGISTIC, on the project's own relevance line (grade >= 3, metrics.mjs). Linear would put
// predictions outside [0,1] on a bounded target and weight a 0-vs-1 error the same as a 0.4-vs-0.5 one;
// polynomial terms are not ruled out but are not free — every added term is another coefficient fitted on
// the same rows, and the pooled n here is thousands of rows over 3 corpora, not thousands of corpora. Fit
// quality is printed (AUC, log-loss) so a case for either can be made against a number.
//
// THREE READINGS OF A COEFFICIENT, because they answer different questions and only one of them is what
// "the weight moved" usually means:
//
//   raw     per unit of the signal. Moves when the SCALE moves — and the gazetteer changes which query
//           terms reach BM25, so it changes BM25's scale by construction. A raw shift alone is not
//           evidence the signal got better.
//   std     per within-scene standard deviation. Scale-free, so this is the discriminative value: it
//           moves only when the signal separates relevant from irrelevant better or worse.
//   AUC     the signal alone, ranked. No fit, no other columns — what the column would be worth if it
//           were the only thing stage 4 read.
//
// WITHIN-SCENE standardisation, not pooled: BM25 is not comparable across queries or corpora (the same
// note governs bm25FloorPct in scene.mjs), so pooling raw scores across 71 scenes would let a scene's
// scale masquerade as a coefficient. ONE intercept over all of them — a per-scene intercept was tried as
// a control for differing base rates and measured to buy nothing, while reproducing each scene's base
// rate by construction and so inflating any in-sample number that carried it.
//
// THE POOL IS WHAT WAS JUDGED. An ungraded row has no label, so it is dropped rather than scored 0 — a
// 0 here would be a claim about relevance, where in a ranking metric it is a claim about a rank. Judged
// coverage is printed per arm for the same reason param-screen prints it.
//
// Usage (from SillyTavern root):
//   node .../relevance-regress.mjs <sample.json> [...] [--sweep gazetteerSource=keys,titles]
//        [--tier memory|reference] [--cut 4] [--ordinal] [--loso] [--lobo]
import { indexPath, isMemory, loadScene, openSample, sceneParams, makeCandidateSet, makeGradeOf, embed } from './scene.mjs';
import { ensureIndex } from './reindex.mjs';
import { gradeValue } from './metrics.mjs';
import { logisticFit, auc, cumulativeFit, prCurve } from './logistic.mjs';
import * as ranking from '../extension/ranking.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
if (!samples.length) {
    console.error('need at least one sample: node relevance-regress.mjs <sample.json> [more.json ...] [--sweep param=v1,v2]');
    process.exit(2);
}

// One parameter, several values — the same shape param-screen's arms have, minus the pairing, because a
// coefficient is fitted over the pooled rows and has no per-scene counterpart to pair.
const sweep = arg('--sweep') ?? 'gazetteerSource=keys+titles,keys,titles,bodies,none';
const [SWEPT, valuesRaw] = [sweep.slice(0, sweep.indexOf('=')), sweep.slice(sweep.indexOf('=') + 1)];
// Values arrive as strings from a shell; a numeric parameter swept as "0.5" would silently become a string
// and compare unequal to every default. Booleans the same.
const coerce = v => (v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v));
const VALUES = valuesRaw.split(',').map(s => coerce(s.trim()));
// WHICH TIER IS FITTED. The ruled predictor fits per tier (matcher-design.md, Stage 4), and the tiers do
// not carry the same signals — memory is ~all vectorized, reference ~all keyword-only — so a pooled fit
// reads one slope across two eligibility regimes. 'all' is the pooled fit and stays the default, because
// it is what the recorded figures were measured on.
// ORDINAL MODE. The 0-4 scale asserts four boundaries and the shipped model fits only one of them
// (>=3), which is also the one the signals separate worst: pooled, grades 2 and 3 sit at the same mean
// standardised cosine. --ordinal fits every boundary so the scale can be read rather than assumed — see
// logistic.mjs cumulativeFit for why the slopes are fitted separately instead of shared.
const ORDINAL = argv.includes('--ordinal');
// HELD OUT BY SCENE. Within-scene standardisation leaks nothing across the fold: it reads only the
// held-out scene's own candidates, which stage 3 also holds.
const LOSO = argv.includes('--loso');
// HELD OUT BY BOOK, which is the generalisation the system actually needs. A held-out SCENE still shares
// its book's vocabulary, entry style, chunk statistics and BM25 scale with the rows that fitted the model,
// so --loso measures "another moment in a book we know" — and production meets books it has never seen.
// Folds are wildly unequal here (one book is 58% of the rows), so read the per-fold sizes, not just the
// pooled number.
const LOBO = argv.includes('--lobo');
// WHICH BOUNDARY IS THE TARGET. 3 is the project's relevance line and the default; --cut 4 fits the band
// the anchors reserve for the scene's current subject, which separates far better and is far rarer, so it
// is the one place AUC and AP disagree loudly enough to be worth reading side by side.
const CUT = Number(arg('--cut') ?? 3);
if (!Number.isFinite(CUT)) { console.error(`--cut must be a number, got ${arg('--cut')}`); process.exit(2); }
const TIER = arg('--tier') ?? 'all';
if (!['all', 'memory', 'reference'].includes(TIER)) { console.error(`--tier must be all|memory|reference, got ${TIER}`); process.exit(2); }
const MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';

// THE FEATURE SET, and the eligibility indicators that go with it. An absent signal and a signal that
// competed and scored zero are different states — the distinction fuseRanks is built around — so each
// signal carries its own indicator and the slope is read on the rows that could earn it. Without them a
// keyword-only entry's missing cosine reads as "average-cosine entry", which is the one reading that is
// certainly wrong.
const FEATURES = [
    ['cosine', r => (Number.isFinite(r.score) ? r.score : 0), r => (Number.isFinite(r.score) ? 1 : 0)],
    ['text', r => Number(r.textScore) || 0, r => (r.textEligible ? 1 : 0)],
    ['keys', r => Number(r.keywordScore) || 0, r => (r.keysEligible ? 1 : 0)],
];

const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const fx = n => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(3) : '  n/a');

(async () => {
    // Load once, embed once. Only the gazetteer-dependent half is rebuilt per value, and loadScene is
    // cheap next to the embed call it would otherwise repeat.
    const loaded = [];
    for (const path of samples) {
        const S = openSample(path, arg('--arm'));
        if (!S.candidates?.length) { console.error(`${path}: logs no candidates`); process.exit(2); }
        const qv = await embed(S.query, { ollama: OLLAMA, model: MODEL });
        loaded.push({ path, name: S.name ?? path, book: S.primaryBook ?? path, S, qv });
    }
    console.log(`${loaded.length} scene(s); sweeping ${SWEPT} over ${VALUES.join(', ')}${TIER === 'all' ? '' : `; ${TIER} tier only`}${CUT === 3 ? '' : `; target grade >= ${CUT}`}`);

    const table = [];
    for (const value of VALUES) {
        // Rows keep their scene, because standardisation and the intercepts are within-scene.
        const perScene = [];
        let dropped = 0;
        for (const { S, qv, name, book } of loaded) {
            const P = sceneParams(S, { [SWEPT]: value });
            // THE INDEX FOLLOWS THE PARAMS. denseAllEntries wants a collection covering every entry, not
            // only the vectorized ones — scored against the standard index it would find no extra vectors
            // and report a null result that reads like an answer. ensureIndex is cached per (book, cfg,
            // all), so this costs an existsSync on every scene after the first.
            const indexFile = P.denseAllEntries
                ? (await ensureIndex(S, { all: true, model: MODEL, ollama: OLLAMA, log: () => {} })).path
                : indexPath(S, { model: MODEL });
            const scene = loadScene(S, { indexFile, params: P });
            const tw = (P.entityFilter && P.queryMode !== 'summary') ? ranking.buildTermWeights(S.query, scene.gaz, P.boost) : null;
            const rows = makeCandidateSet({ ...scene, params: P })(P.K1, P.B, tw, qv, S.query, S.scanText);
            const gradeOf = makeGradeOf(S.grades, scene.isExcluded);
            // Same population scoreScene ranks: constants are out, because relevance is not a concept that
            // applies to them. Ungraded rows are out because they carry no label.
            const kept = [];
            for (const r of rows.filter(r => !r.entry?.constant)) {
                if (TIER !== 'all' && (isMemory(r.entry) ? 'memory' : 'reference') !== TIER) continue;
                const g = gradeOf(r);
                if (g === null || g === undefined || Number.isNaN(g)) { dropped++; continue; }
                kept.push({ r, y: g >= CUT ? 1 : 0, g });
            }
            if (kept.length >= 5 && kept.some(k => k.y) && kept.some(k => !k.y)) perScene.push({ name, book, kept });
        }
        if (!perScene.length) { console.log(`  ${SWEPT}=${value}: no scene has both classes among its judged rows`); continue; }

        // Design matrix: one intercept, then for each signal its standardised value and its eligibility
        // indicator. Standardising within scene is what makes one slope mean one thing across corpora
        // whose BM25 lives on different scales.
        const X = [], y = [], rawCols = FEATURES.map(() => []), stats = FEATURES.map(() => ({ sd: [], mean: [] }));
        const perSignal = FEATURES.map(() => ({ s: [], y: [] }));
        for (const [si, { kept }] of perScene.entries()) {
            const cols = FEATURES.map(([, get]) => kept.map(k => get(k.r)));
            cols.forEach((c, fi) => { stats[fi].sd.push(sd(c)); stats[fi].mean.push(mean(c)); });
            kept.forEach((k, i) => {
                const scene = [1];
                const feats = [];
                cols.forEach((c, fi) => {
                    const s = sd(c) || 1;   // a signal constant within a scene carries no information there; 1 keeps it finite and its column stays flat
                    feats.push((c[i] - mean(c)) / s, FEATURES[fi][2](k.r));
                    rawCols[fi].push(c[i]);
                    perSignal[fi].s.push(c[i]);
                    perSignal[fi].y.push(k.y);
                });
                X.push([...scene, ...feats]);
                y.push(k.y);
            });
        }
        const grades = perScene.flatMap(({ kept }) => kept.map(k => k.g));
        const stdFit = logisticFit(X, y);

        const sceneOf = perScene.flatMap(({ kept }, si) => kept.map(() => si));
        const etaOf = (fit, rows) => rows.map(row => row.reduce((a, x, j) => a + x * fit.beta[j], 0));
        // One held-out estimator, two groupings. The fold is the unit the model must generalise ACROSS.
        const holdOut = (groupOf, nGroups) => {
            const held = Array(y.length).fill(NaN);
            for (let g = 0; g < nGroups; g++) {
                const tr = [], trY = [];
                X.forEach((row, i) => { if (groupOf(i) !== g) { tr.push(row); trY.push(y[i]); } });
                if (!trY.some(v => v) || trY.every(v => v)) continue;
                const f = logisticFit(tr, trY);
                X.forEach((row, i) => { if (groupOf(i) === g) held[i] = row.reduce((a, x, j) => a + x * f.beta[j], 0); });
            }
            const keep = held.map((v, i) => [v, y[i]]).filter(([v]) => Number.isFinite(v));
            return { eta: keep.map(k => k[0]), y: keep.map(k => k[1]) };
        };
        const books = [...new Set(perScene.map(p => p.book))];
        const bookOf = perScene.flatMap(({ kept, book }) => kept.map(() => books.indexOf(book)));
        const loso = LOSO ? holdOut(i => sceneOf[i], perScene.length) : null;
        const lobo = LOBO ? holdOut(i => bookOf[i], books.length) : null;
        if (LOBO) {
            console.log(`\n  held out by book: ${books.length} folds — ${books.map(b => `${String(b).split(/[ _]/).slice(-1)[0].slice(0, 10)} ${bookOf.filter(x => x === books.indexOf(b)).length}`).join(', ')} rows`);
        }
        // The raw fit is the same design with unstandardised signals — the per-unit reading. Same intercepts,
        // so the only difference between the two is the scale the slope is expressed in.
        const Xraw = X.map((row, i) => {
            const out = row.slice(0, 1);
            FEATURES.forEach((_, fi) => out.push(rawCols[fi][i], row[1 + fi * 2 + 1]));
            return out;
        });
        const rawFit = logisticFit(Xraw, y);
        const base = 1;
        table.push({
            value, scenes: perScene.length, n: y.length, pos: y.reduce((a, b) => a + b, 0), dropped,
            rows: FEATURES.map(([name], fi) => ({
                name,
                std: stdFit.beta[base + fi * 2], stdSe: stdFit.se[base + fi * 2],
                raw: rawFit.beta[base + fi * 2],
                sd: mean(stats[fi].sd),
                auc: auc(perSignal[fi].s, perSignal[fi].y),
            })),
            logLoss: stdFit.logLoss, converged: stdFit.converged,
            auc: auc(X.map((row, i) => row.reduce((s, x, j) => s + x * stdFit.beta[j], 0)), y),
            ordinal: ORDINAL ? cumulativeFit(X, grades, [1, 2, 3, 4]) : null,
            base,
            fits: {
                'in-sample': { eta: etaOf(stdFit, X), y },
                ...(loso ? { 'held out by scene': loso } : {}),
                ...(lobo ? { 'held out by BOOK': lobo } : {}),
            },
        });
    }

    console.log(`\nlogistic fit of P(grade>=${CUT}), signals standardised within scene`);
    console.log(`  ${SWEPT.padEnd(14)} signal | std beta (SE)   raw beta   mean within-scene SD   solo AUC`);
    for (const t of table) {
        for (const [i, r] of t.rows.entries()) {
            const head = i === 0 ? String(t.value).padEnd(14) : ' '.repeat(14);
            console.log(`  ${head} ${r.name.padEnd(6)} | ${fx(r.std)} (${r.stdSe.toFixed(3)})  ${fx(r.raw).padStart(9)}   ${r.sd.toFixed(4).padStart(20)}   ${r.auc.toFixed(3).padStart(8)}`);
        }
        console.log(`  ${' '.repeat(14)} model  | AUC ${t.auc.toFixed(4)}  log-loss ${t.logLoss.toFixed(4)}  n ${t.n} rows (${t.pos} relevant) over ${t.scenes} scenes, ${t.dropped} ungraded dropped${t.converged ? '' : '  !! DID NOT CONVERGE'}`);
    }

    if (ORDINAL) {
        // ONE ROW PER BOUNDARY OF THE SCALE. `n>=k` is how many rows sit at or above that grade, so the
        // boundaries get rarer down the column and the last one is often too thin to fit. Read the slopes
        // ACROSS boundaries: a scale whose levels the signals can see gives similar slopes with rising
        // intercepts, and a boundary whose slope collapses is a distinction the grader made and the
        // features cannot reproduce.
        console.log('\nordinal: P(grade >= k) fitted at every boundary, same design matrix, slopes free');
        for (const t of table) {
            console.log(`  ${SWEPT}=${t.value}`);
            console.log('    cut |  n>=k |  cosine     text      keys   | model AUC  log-loss');
            for (const o of t.ordinal) {
                if (!o.fit) { console.log(`    >=${o.cut} | ${String(o.pos).padStart(5)} | not fitted — one class absent at this boundary`); continue; }
                const b = i => o.fit.beta[t.base + i * 2];
                console.log(`    >=${o.cut} | ${String(o.pos).padStart(5)} | ${fx(b(0))}   ${fx(b(1))}   ${fx(b(2))}   |   ${o.auc.toFixed(4)}    ${o.fit.logLoss.toFixed(4)}${o.fit.converged ? '' : '  !! DID NOT CONVERGE'}`);
            }
        }
    }

    // WHAT A THRESHOLD WOULD DELIVER, which the AUC above does not say: AP moves with prevalence and the
    // precision-at-recall rows are in the units a bar is chosen in. The in-sample row is the same fit
    // scored on the rows that produced it; the held-out rows are what the number of record reads.
    console.log(`\noperational readout of P(grade>=${CUT}): average precision, and precision at recall`);
    console.log(`  ${SWEPT.padEnd(14)} scored on            | prevalence   AUC     AP   | P@R50   P@R75   P@R90`);
    for (const t of table) {
        for (const [i, [label, f]] of Object.entries(t.fits).entries()) {
            const m = prCurve(f.eta, f.y);
            const cell = R => (m.at[R] ? `${(100 * m.at[R].precision).toFixed(1)}%`.padStart(6) : '     -');
            const head = i === 0 ? String(t.value).padEnd(14) : ' '.repeat(14);
            console.log(`  ${head} ${label.padEnd(21)} | ${`${(100 * m.pos / m.n).toFixed(2)}%`.padStart(9)}  ${auc(f.eta, f.y).toFixed(4)}  ${m.ap.toFixed(3)} | ${cell(0.5)}  ${cell(0.75)}  ${cell(0.9)}`);
        }
    }
    if (!LOSO || !LOBO) console.log('  (--loso holds out a scene, --lobo a book; only the second is the generalisation production needs)');

    if (table.length > 1) {
        const b = table[0];
        console.log(`\ndeltas against ${SWEPT}=${b.value} — a std-beta shift is the signal's discriminative value moving;`);
        console.log('a raw-beta shift with std flat is only the scale moving, which the gazetteer does by construction.');
        for (const t of table.slice(1)) {
            const parts = t.rows.map((r, i) => `${r.name} std ${fx(r.std - b.rows[i].std)} raw ${fx(r.raw - b.rows[i].raw)} AUC ${fx(r.auc - b.rows[i].auc)}`);
            console.log(`  ${String(t.value).padEnd(14)} ${parts.join('   ')}`);
            console.log(`  ${' '.repeat(14)} model AUC ${fx(t.auc - b.auc)}  log-loss ${fx(t.logLoss - b.logLoss)}  n ${t.n - b.n >= 0 ? '+' : ''}${t.n - b.n} rows`);
        }
    }

    console.log('\nA coefficient is fitted over POOLED rows, so it has no paired sign test behind it — read the SE,');
    console.log('and remember these rows sit on 3 corpora however many scenes they span (CLAUDE.md, graded scenes).');
})();
