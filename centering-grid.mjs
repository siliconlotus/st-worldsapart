// LOO grade of mean-centering: does subtracting the corpus mean vector before cosine help retrieval?
// Same leave-one-out task as bm25-grid / baseline-grid (each chunk queries its entry's sibling chunks;
// siblings are the gold), scored both WITH and WITHOUT centering. Pure disk — no ollama (queries are
// stored chunks). Metrics: vector-only + production-fused (bm25+vector RRF), MRR / recall@5 / nDCG.
//
// Usage (from SillyTavern root):
//   node public/scripts/extensions/third-party/WorldsApart/centering-grid.mjs <index.json>
import { readFileSync } from 'node:fs';

const INDEX = process.argv.find(a => a.endsWith('.json'));
if (!INDEX) { console.error('pass the collection index.json path'); process.exit(2); }
const K = 20, K1 = 2, B = 0.75, LEXW = 1.5;   // production params

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const items = idx.items.filter(i => (i.metadata.text ?? '').length > 120);
const D = items[0].vector.length, N = items.length;
const tok = t => String(t ?? '').toLowerCase().split(/[^a-z0-9']+/).filter(x => x.length > 1);

// --- BM25 (fixed) ---
const df = new Map();
const tfs = items.map(it => { const m = new Map(); for (const t of tok(it.metadata.text)) m.set(t, (m.get(t) ?? 0) + 1); for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1); return m; });
const idf = t => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
const dl = items.map((_, i) => [...tfs[i].values()].reduce((a, b) => a + b, 0));
const avgdl = dl.reduce((a, b) => a + b, 0) / N;
const postings = new Map();
items.forEach((_, d) => { for (const [t, tf] of tfs[d]) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([d, tf]); } });
const bm25 = (qt) => { const s = new Float64Array(N); for (const t of new Set(qt)) { const l = postings.get(t); if (!l) continue; const w = idf(t); for (const [d, tf] of l) s[d] += w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl[d] / avgdl)); } return s; };

const raw = items.map(i => Float64Array.from(i.vector));
const mean = new Float64Array(D);
for (const v of raw) for (let i = 0; i < D; i++) mean[i] += v[i];
for (let i = 0; i < D; i++) mean[i] /= N;
const meanNorm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0));
// Normalize, optionally subtracting the corpus mean first.
const prep = centered => raw.map(v => { const o = new Float64Array(D); let s = 0; for (let i = 0; i < D; i++) { o[i] = centered ? v[i] - mean[i] : v[i]; s += o[i] * o[i]; } const n = Math.sqrt(s) || 1; for (let i = 0; i < D; i++) o[i] /= n; return o; });
const dot = (a, b) => { let s = 0; for (let i = 0; i < D; i++) s += a[i] * b[i]; return s; };

const rankMap = (scores, q) => { const o = Array.from(scores, (s, d) => [s, d]); o[q][0] = -2; o.sort((a, b) => b[0] - a[0]); const m = new Int32Array(N); o.forEach(([, d], i) => { m[d] = i + 1; }); return m; };
const hit = (map, targets) => { let best = Infinity; for (const t of targets) if (map[t] < best) best = map[t]; return [1 / best, best <= 5 ? 1 : 0]; };
const ndcgAt = (map, targets, k, gradeOf = () => 1) => {
    let dcg = 0; for (const t of targets) { const r = map[t]; if (r <= k) dcg += gradeOf(t) / Math.log2(r + 1); }
    const ideal = [...targets].map(gradeOf).sort((a, b) => b - a);
    let idcg = 0; for (let i = 0; i < Math.min(ideal.length, k); i++) idcg += ideal[i] / Math.log2(i + 2);
    return idcg ? dcg / idcg : 0;
};

const groups = new Map();
items.forEach((it, i) => { const e = String(it.metadata.index); if (!groups.has(e)) groups.set(e, []); groups.get(e).push(i); });
const trials = [];
for (const [, arr] of groups) if (arr.length >= 2) for (const q of arr) trials.push({ q, targets: new Set(arr.filter(x => x !== q)) });
const n = trials.length;
const bmMaps = trials.map(({ q }) => rankMap(bm25(tok(items[q].metadata.text)), q));

console.log(`corpus: ${INDEX}\nchunks: ${N}, dim: ${D}, corpus-mean norm: ${meanNorm.toFixed(4)} (higher = more shared direction to remove)`);
console.log(`LOO trials: ${n}\n`);
console.log('centering | vecMRR  fusMRR  | fus r@5  nDCG@5  nDCG@10');
for (const centered of [true, false]) {
    const cRaw = prep(centered);
    let mV = 0, mF = 0, rF = 0, g5 = 0, g10 = 0;
    trials.forEach(({ q, targets }, ti) => {
        const vMap = rankMap(Float64Array.from(cRaw, cd => dot(cRaw[q], cd)), q);
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
