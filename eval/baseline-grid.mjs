// LOO grid over baselineQuery WEIGHT — the proper test of whether subtracting the "shared background"
// similarity helps retrieval, run over every multi-chunk entry instead of one hand-graded scene.
//
// Method (same LOO task as bm25-grid.mjs): each chunk queries the sibling chunks of its own lorebook
// entry (metadata.index); siblings are the gold set. Query vectors are already on disk, so the only
// ollama call is embedding the fixed baseline text once. Per doc chunk the baseline term is
// query-independent (dot(baseline, doc)), so the plugin's `score = raw - weight*baseline` becomes a
// cheap per-weight re-rank + re-fuse. BM25 and mean-centered cosine come from the SHARED plugin
// modules (lexical.mjs / vector.mjs) — the exact code the server runs, so the signal cannot drift.
//
// Self-check: re-embeds a stored chunk's text via ollama and reports cosine vs its stored vector. If
// that isn't ~1.0, the embedding path doesn't match ST's and the numbers can't be trusted.
//
// Usage (from SillyTavern root):
//   node public/scripts/extensions/third-party/WorldsApart/eval/baseline-grid.mjs <index.json> ["baseline text"]
//   WA_BASELINE="..." OLLAMA_URL=http://localhost:11434 node ... <index.json>
import { readFileSync } from 'node:fs';
import { buildLexical, bm25Scores } from '../plugin/lexical.mjs';
import { corpusMean, centeredCosineScores } from '../plugin/vector.mjs';
import { rankMap, hit, ndcgAt } from './metrics.mjs';

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

// Shared plugin math: BM25 index + mean-centered cosine.
const lexical = buildLexical(items);
const mean = corpusMean(items);

async function embed(text) {
    const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, input: text }) });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return (await r.json()).embeddings[0];
}

(async () => {
    // Fidelity self-check: does our ollama embedding reproduce the stored vector?
    const selfCos = centeredCosineScores(items, await embed(items[0].metadata.text), mean)[0];
    console.log(`corpus: ${INDEX}\nchunks: ${N}, dim: ${D}`);
    console.log(`self-check (re-embed stored chunk → cosine vs stored): ${selfCos.toFixed(4)} ${selfCos > 0.98 ? 'ok' : 'FAIL — embedding path differs from ST; numbers untrustworthy'}`);
    console.log(`baseline text: "${BASELINE_TEXT}"\n`);

    // Per-doc baseline similarity (query-independent).
    const bscore = centeredCosineScores(items, await embed(BASELINE_TEXT), mean);

    // LOO trials + precomputed BM25 ranks and raw vector scores (both weight-independent).
    const groups = new Map();
    items.forEach((it, i) => { const e = String(it.metadata.index); if (!groups.has(e)) groups.set(e, []); groups.get(e).push(i); });
    const trials = [];
    for (const [, arr] of groups) if (arr.length >= 2) for (const q of arr) trials.push({ q, targets: new Set(arr.filter(x => x !== q)) });
    const n = trials.length;
    const bmMaps = trials.map(({ q }) => rankMap(bm25Scores(lexical, items[q].metadata.text, N, K1, B), q));
    const vScore = trials.map(({ q }) => centeredCosineScores(items, items[q].vector, mean));
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
