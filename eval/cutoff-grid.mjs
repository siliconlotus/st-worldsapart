// Cutoff BEHAVIOUR grid: how the three vectorCutoff modes actually behave over hundreds of real rankings —
// how many entries each keeps, how much that varies query to query, how often the cliff search fires at all,
// and whether the threshold survives a change of window. No gold set, by design.
//
// WHAT THIS DOES NOT MEASURE: whether the kept set is the RIGHT set. That needs human grades and lives in
// graded-scene-grid.mjs. It deliberately isn't attempted here, because the LOO gold set the other grids use
// ("the other chunks of my own entry") has the wrong SIZE by construction — it's a function of how finely an
// entry was chunked (mean 13, max 38 on the reference corpus), not of how many entries a scene needs. Any
// precision/recall/F1 built on it is maximised by whichever cap happens to land nearest that number, so it
// ranks `count max=20` top and punishes an adaptive mode for keeping a sensible 6. Normalising against an
// oracle cut doesn't rescue it: the oracle faces the same mis-sized gold. So the numbers aren't printed.
//
// What IS testable without a gold set is the claim selection.mjs makes for the two cliff modes: that elbow's
// threshold (a multiple of the MEAN gap) "shifts with the window" while dropoff's (a fraction of the TOP
// score) is "window-independent" and "comparable across queries". Those are statements about spread and
// stability, which hundreds of real rankings answer directly:
//
//   sd       — spread of kept-count across queries. Low = predictable, high = adapts (or is erratic).
//   fired%   — how often the cliff search found a cliff instead of falling through to the cap. A mode that
//              rarely fires is decorative: it's `count` wearing a hat.
//   drift    — mean kept at window 20 minus mean kept at window 10. ~0 is window-independence. `count` is
//              the reference row: it drifts by the full 10, because in count mode the window IS the setting.
//
// Rankings come from the same LOO queries as the other grids (each chunk of the corpus, in turn, as a real
// query), fused with the shared plugin BM25 + mean-centered cosine and cut by the real cutRetrieved from
// selection.mjs. Pure disk — no ollama call, since the query vectors are already stored.
//
// Usage (from SillyTavern root):
//   node public/scripts/extensions/third-party/WorldsApart/eval/cutoff-grid.mjs <index.json>
import { readFileSync } from 'node:fs';
import { buildLexical, bm25Scores } from '../plugin/lexical.mjs';
import { corpusMean, centeredCosineScores } from '../plugin/vector.mjs';
import { cutRetrieved } from '../extension/selection.mjs';
import { fuseRetrieval } from '../extension/ranking.mjs';

const INDEX = process.argv.find(a => a.endsWith('.json'));
if (!INDEX) { console.error('pass the collection index.json path'); process.exit(2); }
// The ranking underneath is held at the SHIPPED defaults (extension/state.mjs) — the cut is what's being
// swept, so the thing it cuts has to be the thing that ships.
const K1 = 1.2, B = 0.75, LEXW = 1, MIN = 3;
const RRFKS = [10, 20, 60];
const WINDOWS = [10, 20];   // maxVectorEntries; 10 is the shipped default

const items = JSON.parse(readFileSync(INDEX, 'utf8')).items.filter(i => (i.metadata.text ?? '').length > 120);
const N = items.length;
const lexical = buildLexical(items);
const mean = corpusMean(items);

// Every chunk is a query. No gold set is needed, so unlike the LOO grids this doesn't require entries with
// >=2 chunks — every chunk yields a real ranking to cut.
const queries = items.map((_, i) => i);
const n = queries.length;

// Both raw signals are cutoff- and rrfK-independent; score once per query.
const bmScores = queries.map(q => bm25Scores(lexical, items[q].metadata.text, N, K1, B));
const vecScores = queries.map(q => centeredCosineScores(items, items[q].vector, mean));

// The real fuseRetrieval — the exact ranking cutRetrieved is handed in production, not a copy of its
// formula (which is why it was lifted out of worldsapart.js into ranking.mjs). Only the deepest window is
// ever inspected, so truncate there.
//
// ponytail: no scoreThreshold is applied, where production only fuses chunks that cleared it, so the tail
// here is longer than a live one. It changes the candidate count, not the shape of the cliff the modes read.
const CAP = Math.max(...WINDOWS);
const rankedAt = k => queries.map((q, qi) => {
    const scores = new Map();
    for (let d = 0; d < N; d++) if (d !== q) scores.set(d, { score: vecScores[qi][d], bm25: bmScores[qi][d] });
    return fuseRetrieval(scores, { rrfK: k, retrievalMode: 'hybrid', lexicalWeight: LEXW }).slice(0, CAP);
});

const stats = (ranked, cfg, W) => {
    const kept = ranked.map(rows => cutRetrieved(rows, { maxVectorEntries: W, minVectorEntries: MIN, ...cfg }).length);
    const m = kept.reduce((a, b) => a + b, 0) / n;
    return {
        mean: m,
        sd: Math.sqrt(kept.reduce((s, x) => s + (x - m) ** 2, 0) / n),
        fired: 100 * kept.filter(x => x < W).length / n,   // cut short of the cap = the cliff search bit
    };
};

const arms = [
    ['count           ', { mode: 'count' }],
    ...[1.2, 1.5, 2, 2.5].map(v => [`elbow   sens=${v}`.padEnd(16), { mode: 'elbow', elbowSensitivity: v }]),
    ...[0.04, 0.06, 0.08, 0.12].map(v => [`dropoff thr=${v}`.padEnd(16), { mode: 'dropoff', dropoffThreshold: v }]),
];
// vectorCutoff 'elbow' at elbowSensitivity 1.5 is what ships (extension/state.mjs); the other cliff params
// are the documented alternatives.
const shipped = ([, c]) => c.mode === 'elbow' && c.elbowSensitivity === 1.5;

console.log(`corpus: ${INDEX}\nchunks: ${N}, queries: ${n} (every chunk, no gold set needed)`);
console.log(`ranking held at shipped defaults: k1=${K1} b=${B} lexW=${LEXW}, floor min=${MIN}`);
console.log(`windows: max=${WINDOWS.join(' and max=')}  (drift = mean kept at ${WINDOWS[1]} minus at ${WINDOWS[0]}; ~0 = window-independent)`);

for (const k of RRFKS) {
    const ranked = rankedAt(k);
    console.log(`\nrrfK=${k}${k === 20 ? '  (shipped)' : ''}`);
    console.log(`  mode / param     | max=10: kept   sd   fired% | max=20: kept   sd   fired% | drift`);
    for (const arm of arms) {
        const a = stats(ranked, arm[1], WINDOWS[0]), b = stats(ranked, arm[1], WINDOWS[1]);
        const f = s => `${s.mean.toFixed(1).padStart(4)}  ${s.sd.toFixed(2).padStart(4)}  ${s.fired.toFixed(0).padStart(4)}%`;
        const tag = k === 20 && shipped(arm) ? '  <- shipped' : '';
        console.log(`  ${arm[0]} |         ${f(a)} |         ${f(b)} | ${(b.mean - a.mean >= 0 ? '+' : '')}${(b.mean - a.mean).toFixed(1)}${tag}`);
    }
}
