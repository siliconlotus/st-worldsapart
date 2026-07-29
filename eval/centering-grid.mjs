// LOO grade of mean-centering: does subtracting the corpus mean vector before cosine help retrieval?
// Same leave-one-out task as bm25-grid / baseline-grid (each chunk queries its entry's sibling chunks;
// siblings are the gold), scored both WITH and WITHOUT centering. Pure disk — no ollama (queries are
// stored chunks). Metrics: vector-only + production-fused (bm25+vector RRF), MRR / recall@5 / nDCG.
//
// Usage (from SillyTavern root):
//   node public/scripts/extensions/third-party/WorldsApart/eval/centering-grid.mjs <index.json>
import { readFileSync } from 'node:fs';
import { buildLexical, bm25Scores } from '../plugin/lexical.mjs';
import { corpusMean, centeredCosineScores, norm } from '../plugin/vector.mjs';
import { rankMap, hit, ndcgAt } from './metrics.mjs';

const INDEX = process.argv.find(a => a.endsWith('.json'));
if (!INDEX) { console.error('pass the collection index.json path'); process.exit(2); }
const K = 20, K1 = 2, B = 0.75, LEXW = 1.5;   // production params

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const items = idx.items.filter(i => (i.metadata.text ?? '').length > 120);
const D = items[0].vector.length, N = items.length;

// Shared plugin math: BM25 index + mean-centered cosine (with a centered=false arm for the OFF row).
const lexical = buildLexical(items);
const mean = corpusMean(items);
const meanNorm = norm(mean);

const groups = new Map();
items.forEach((it, i) => { const e = String(it.metadata.index); if (!groups.has(e)) groups.set(e, []); groups.get(e).push(i); });
const trials = [];
for (const [, arr] of groups) if (arr.length >= 2) for (const q of arr) trials.push({ q, targets: new Set(arr.filter(x => x !== q)) });
const n = trials.length;
const bmMaps = trials.map(({ q }) => rankMap(bm25Scores(lexical, items[q].metadata.text, N, K1, B), q));

console.log(`corpus: ${INDEX}\nchunks: ${N}, dim: ${D}, corpus-mean norm: ${meanNorm.toFixed(4)} (higher = more shared direction to remove)`);
console.log(`LOO trials: ${n}\n`);
console.log('centering | vecMRR  fusMRR  | fus r@5  nDCG@5  nDCG@10');
for (const centered of [true, false]) {
    let mV = 0, mF = 0, rF = 0, g5 = 0, g10 = 0;
    trials.forEach(({ q, targets }, ti) => {
        const vMap = rankMap(centeredCosineScores(items, items[q].vector, mean, centered), q);
        mV += hit(vMap, targets)[0];
        const f = new Float64Array(N);
        for (let d = 0; d < N; d++) f[d] = d === q ? -2 : LEXW / (K + bmMaps[ti][d]) + 1 / (K + vMap[d]);
        const fMap = rankMap(f, q);
        const [m, r] = hit(fMap, targets); mF += m; rF += r;
        g5 += ndcgAt(fMap, targets, 5); g10 += ndcgAt(fMap, targets, 10);
    });
    const tag = centered ? '  <- ON (current default)' : '';
    console.log(`${centered ? 'ON ' : 'OFF'}       | ${(mV / n).toFixed(3)}   ${(mF / n).toFixed(3)}   | ${(100 * rF / n).toFixed(1)}%    ${(g5 / n).toFixed(4)}  ${(g10 / n).toFixed(4)}${tag}`);
}
