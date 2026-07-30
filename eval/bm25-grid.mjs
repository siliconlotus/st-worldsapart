// Grid search over BM25 k1/b and the fusion lexical weight, measured on the leave-one-out task that locked in the
// other retrieval params: each chunk queries the sibling chunks of its own lorebook entry
// (metadata.index), and those siblings are the gold set. k1/b touch only BM25 ranking and
// the raw vectors are already stored, so this needs no ollama call.
//
// Metric: MRR + recall@5, both for BM25 alone and for the production bm25+raw RRF fusion.
// The fused number is the one that matters — but expect it to be nearly flat, because RRF
// fuses on BM25 *rank*, not magnitude, so k1/b mostly reshuffle within a similar ranking.
//
// Usage (from the SillyTavern root):
//   node public/scripts/extensions/third-party/WorldsApart/eval/bm25-grid.mjs [path/to/index.json]
// Default corpus path is a personal collection; pass your own vectra index.json to retune.
import { readFileSync } from 'node:fs';
import { buildLexical, bm25Scores } from '../plugin/lexical.mjs';
import { corpusMean, centeredCosineScores } from '../plugin/vector.mjs';
import { rankMap, hit } from './metrics.mjs';

const INDEX = process.argv.find(a => a.endsWith('.json')) ?? 'data/default-user/vectors/ollama/wa_3810524038950542/bge-m3/worldsapart.json';
// Mean-centering removes the corpus's shared direction before comparing (see the plugin).
// On by default; pass --uncentered to measure without it — the switch is here so a future
// embedding model that already spreads its space can be checked for whether centering has
// stopped earning its keep.
const CENTERED = !process.argv.includes('--uncentered');
const K = 20;    // rrfK (production)
// Three axes. k1/b shape the BM25 ranking; lexW is the fusion balance — BM25's RRF term is
// lexW/(K+rank), vector's is 1/(K+rank). Widen any array to retune on a new corpus; the
// fused leaderboard caps its printed rows (TOP) so a large 3-D sweep stays readable.
// The shipped defaults (k1 1.2, b 0.75) must sit INSIDE the swept range, not on its edge — a default that
// wins at the boundary hasn't been validated, it's just untested in one direction.
const k1s = [0.6, 0.9, 1.2, 2.0, 3.0];
const bs = [0.5, 0.6, 0.75, 0.9, 1.0];
const lexws = [0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5];
const TOP = 30;  // max fused rows printed

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const items = idx.items.filter(i => (i.metadata.text ?? '').length > 120);   // drop stubs, as the baseline harness did
const N = items.length;

// Shared plugin math: BM25 index + corpus mean for centered cosine, and the shared LOO metrics. All four
// were local reimplementations here (this was the first harness, written before the modules were split
// out) — same numbers, but now the grid measures the shipped scorers and can't drift away from them.
const lexical = buildLexical(items);
const mean = corpusMean(items);

// --- leave-one-out trials: sibling chunks of the same lorebook entry are the gold ---
const groups = new Map();
items.forEach((it, i) => { const e = String(it.metadata.index); if (!groups.has(e)) groups.set(e, []); groups.get(e).push(i); });
const trials = [];
for (const [, arr] of groups) if (arr.length >= 2) for (const q of arr) trials.push({ q, targets: new Set(arr.filter(x => x !== q)) });
const n = trials.length;

// Vector ranks depend on nothing we sweep — compute once per trial.
console.log(`corpus: ${INDEX}\nvectors: ${CENTERED ? 'mean-centered' : 'uncentered'}\ntrials: ${n}, chunks: ${N}`);
const vecMaps = trials.map(({ q }) => rankMap(centeredCosineScores(items, items[q].vector, mean, CENTERED), q));

const bmRows = [];   // bm25 alone — one per (k1,b), lexW-independent
const rows = [];     // fused bm25+raw — one per (k1,b,lexW)
for (const k1 of k1s) for (const b of bs) {
    // BM25 ranking depends only on (k1,b); compute it once, then sweep lexW on top.
    const bmMaps = trials.map(({ q }) => rankMap(bm25Scores(lexical, items[q].metadata.text, N, k1, b), q));
    let mB = 0, rB = 0;
    trials.forEach(({ targets }, ti) => { const [m, r] = hit(bmMaps[ti], targets); mB += m; rB += r; });
    bmRows.push({ k1, b, mrr: mB / n, rec: 100 * rB / n });

    for (const lexW of lexws) {
        let mF = 0, rF = 0;
        trials.forEach(({ q, targets }, ti) => {
            const f = new Float64Array(N);
            for (let d = 0; d < N; d++) f[d] = d === q ? -2 : lexW / (K + bmMaps[ti][d]) + 1 / (K + vecMaps[ti][d]);
            const [m, r] = hit(rankMap(f, q), targets); mF += m; rF += r;
        });
        rows.push({ k1, b, lexW, fuMRR: mF / n, fuRec: 100 * rF / n });
    }
}

// bm25 alone (does not vary with lexW).
console.log('\nbm25 alone:\n k1     b    | MRR    r@5');
for (const r of [...bmRows].sort((a, b) => b.mrr - a.mrr)) {
    console.log(`${r.k1.toFixed(2)}  ${r.b.toFixed(2)} | ${r.mrr.toFixed(3)}  ${r.rec.toFixed(1)}%`);
}

// Fused bm25+raw — the decision metric.
rows.sort((a, b) => b.fuMRR - a.fuMRR);
const isDefault = r => r.k1 === 1.2 && r.b === 0.75 && r.lexW === 1;
const shown = rows.slice(0, TOP);
const def = rows.find(isDefault);
if (def && !shown.includes(def)) shown.push(def);   // always surface the current default
console.log(`\nbm25+raw fusion (sorted by MRR, top ${Math.min(TOP, rows.length)} of ${rows.length}):`);
console.log(' k1     b     lexW | MRR    r@5');
for (const r of shown) {
    const tag = isDefault(r) ? '  <- current default' : (r === rows[0] ? '  <- best' : '');
    console.log(`${r.k1.toFixed(2)}  ${r.b.toFixed(2)}  ${String(r.lexW).padStart(4)} | ${r.fuMRR.toFixed(3)}  ${r.fuRec.toFixed(1)}%${tag}`);
}
const best = rows[0];
console.log(`\nbest fused: k1=${best.k1} b=${best.b} lexW=${best.lexW} -> MRR ${best.fuMRR.toFixed(3)}, recall@5 ${best.fuRec.toFixed(1)}%`);
