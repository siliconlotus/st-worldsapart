// LOO grid over baselineQuery WEIGHT — the proper test of whether subtracting the "shared background"
// similarity helps retrieval, run over every multi-chunk entry instead of one hand-graded scene.
//
// Method (same LOO task as bm25-grid.mjs): each chunk queries the sibling chunks of its own lorebook
// entry (metadata.index); siblings are the gold set. Query vectors are already on disk, so the only
// ollama call is embedding the fixed baseline text once. Per doc chunk the baseline term is
// query-independent (dot(baseline, doc)), so the plugin's `score = raw - weight*baseline` becomes a
// cheap per-weight re-rank + re-fuse. Vectors are mean-centered + normalized exactly as the plugin does.
//
// Self-check: re-embeds a stored chunk's text via ollama and reports cosine vs its stored vector. If
// that isn't ~1.0, the embedding path doesn't match ST's and the numbers can't be trusted.
//
// Usage (from SillyTavern root):
//   node public/scripts/extensions/third-party/WorldsApart/baseline-grid.mjs <index.json> ["baseline text"]
//   WA_BASELINE="..." OLLAMA_URL=http://localhost:11434 node ... <index.json>
import { readFileSync } from 'node:fs';

const INDEX = process.argv.find(a => a.endsWith('.json'));
if (!INDEX) { console.error('pass the collection index.json path'); process.exit(2); }
const BASELINE_TEXT = process.argv.slice(2).find(a => !a.endsWith('.json')) ?? process.env.WA_BASELINE
    ?? 'Kyle, Jeffrey, Liam, Brad and Shane are at the Grove.';
const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.WA_EMBED_MODEL ?? 'bge-m3';
// Production params from the tested chat's settings snapshot.
const K = 20, K1 = 2, B = 0.75, LEXW = 1.5;
const WEIGHTS = [0, 0.15, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const items = idx.items.filter(i => (i.metadata.text ?? '').length > 120);   // drop stubs, as the harnesses do
const D = items[0].vector.length, N = items.length;
const tok = t => String(t ?? '').toLowerCase().split(/[^a-z0-9']+/).filter(x => x.length > 1);

// --- BM25 (k1,b fixed) ---
const df = new Map();
const tfs = items.map(it => { const m = new Map(); for (const t of tok(it.metadata.text)) m.set(t, (m.get(t) ?? 0) + 1); for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1); return m; });
const idf = t => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
const dl = items.map((_, i) => [...tfs[i].values()].reduce((a, b) => a + b, 0));
const avgdl = dl.reduce((a, b) => a + b, 0) / N;
const postings = new Map();
items.forEach((_, d) => { for (const [t, tf] of tfs[d]) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([d, tf]); } });
const bm25 = (qt) => { const s = new Float64Array(N); for (const t of new Set(qt)) { const l = postings.get(t); if (!l) continue; const w = idf(t); for (const [d, tf] of l) s[d] += w * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl[d] / avgdl)); } return s; };

// --- mean-center + normalize (matches the plugin) ---
const raw = items.map(i => Float64Array.from(i.vector));
const mean = new Float64Array(D);
for (const v of raw) for (let i = 0; i < D; i++) mean[i] += v[i];
for (let i = 0; i < D; i++) mean[i] /= N;
const center = v => { const o = new Float64Array(D); let s = 0; for (let i = 0; i < D; i++) { o[i] = v[i] - mean[i]; s += o[i] * o[i]; } const n = Math.sqrt(s) || 1; for (let i = 0; i < D; i++) o[i] /= n; return o; };
const cRaw = raw.map(center);
const dot = (a, b) => { let s = 0; for (let i = 0; i < D; i++) s += a[i] * b[i]; return s; };

async function embed(text) {
    const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: text }) });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return (await r.json()).embeddings[0];
}

const rankMap = (scores, q) => { const o = Array.from(scores, (s, d) => [s, d]); o[q][0] = -2; o.sort((a, b) => b[0] - a[0]); const m = new Int32Array(N); o.forEach(([, d], i) => { m[d] = i + 1; }); return m; };
const hit = (map, targets) => { let best = Infinity; for (const t of targets) if (map[t] < best) best = map[t]; return [1 / best, best <= 5 ? 1 : 0]; };
// nDCG@k. `gradeOf(doc)` returns a relevance grade (LOO: 1 for a sibling, else 0 — but any graded
// vector works, which is what the human-graded scene mode will pass). Ideal DCG from the sorted grades.
const ndcgAt = (map, targets, k, gradeOf = () => 1) => {
    let dcg = 0; for (const t of targets) { const r = map[t]; if (r <= k) dcg += gradeOf(t) / Math.log2(r + 1); }
    const ideal = [...targets].map(gradeOf).sort((a, b) => b - a);
    let idcg = 0; for (let i = 0; i < Math.min(ideal.length, k); i++) idcg += ideal[i] / Math.log2(i + 2);
    return idcg ? dcg / idcg : 0;
};

(async () => {
    // Fidelity self-check: does our ollama embedding reproduce the stored vector?
    const reembed = center(await embed(items[0].metadata.text));
    const selfCos = dot(reembed, cRaw[0]);
    console.log(`corpus: ${INDEX}\nchunks: ${N}, dim: ${D}`);
    console.log(`self-check (re-embed stored chunk → cosine vs stored): ${selfCos.toFixed(4)} ${selfCos > 0.98 ? 'ok' : 'FAIL — embedding path differs from ST; numbers untrustworthy'}`);
    console.log(`baseline text: "${BASELINE_TEXT}"\n`);

    // Per-doc baseline similarity (query-independent).
    const cBase = center(await embed(BASELINE_TEXT));
    const bscore = Float64Array.from(cRaw, cd => dot(cBase, cd));

    // LOO trials + precomputed BM25 ranks and raw vector scores (both weight-independent).
    const groups = new Map();
    items.forEach((it, i) => { const e = String(it.metadata.index); if (!groups.has(e)) groups.set(e, []); groups.get(e).push(i); });
    const trials = [];
    for (const [, arr] of groups) if (arr.length >= 2) for (const q of arr) trials.push({ q, targets: new Set(arr.filter(x => x !== q)) });
    const n = trials.length;
    const bmMaps = trials.map(({ q }) => rankMap(bm25(tok(items[q].metadata.text)), q));
    const vScore = trials.map(({ q }) => Float64Array.from(cRaw, cd => dot(cRaw[q], cd)));
    console.log(`LOO trials: ${n} (entries with ≥2 chunks)\n`);

    console.log('weight | vecMRR  fusMRR  | fus r@5  nDCG@5  nDCG@10');
    for (const w of WEIGHTS) {
        let mV = 0, mF = 0, rF = 0, g5 = 0, g10 = 0;
        trials.forEach(({ q, targets }, ti) => {
            const sv = new Float64Array(N);
            for (let d = 0; d < N; d++) sv[d] = d === q ? -2 : vScore[ti][d] - w * bscore[d];
            const vMap = rankMap(sv, q);
            mV += hit(vMap, targets)[0];
            const f = new Float64Array(N);
            for (let d = 0; d < N; d++) f[d] = d === q ? -2 : LEXW / (K + bmMaps[ti][d]) + 1 / (K + vMap[d]);
            const fMap = rankMap(f, q);
            const [m, r] = hit(fMap, targets); mF += m; rF += r;
            g5 += ndcgAt(fMap, targets, 5); g10 += ndcgAt(fMap, targets, 10);
        });
        const tag = w === 0 ? '  <- OFF' : '';
        console.log(`${String(w).padStart(5)}  | ${(mV / n).toFixed(3)}   ${(mF / n).toFixed(3)}   | ${(100 * rF / n).toFixed(1)}%    ${(g5 / n).toFixed(4)}  ${(g10 / n).toFixed(4)}${tag}`);
    }
})();
