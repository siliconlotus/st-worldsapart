// Does mean-centering still help when the query is a SUMMARY, not an in-corpus chunk?
//
// The chunk-as-query benchmark (bm25-grid.mjs) centers an in-corpus vector by the corpus
// mean — ideal conditions, because the shared direction it removes is genuinely present in
// the query. Production never does that: the query is an LLM summary of recent chat, an
// out-of-corpus vector, and centering subtracts a mean built from a distribution the query
// isn't drawn from. This measures that regime directly.
//
// For each multi-chunk entry we summarize its FIRST chunk with the production summary
// prompt (out-of-corpus prose), then ask whether the entry's OTHER chunks — which the
// summary never saw — rank high. Exactly parallel to the leave-one-out task, but the query
// representation is a summary instead of the raw chunk. Centered vs uncentered, vec-only
// and fused. Summaries are cached to summary-cache.json so re-runs skip the LLM.
//
// Usage (from the SillyTavern root, ollama running):
//   node public/scripts/extensions/third-party/Worlds-Apart/summary-center.mjs [path/to/worldsapart.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HERE = new URL('.', import.meta.url).pathname;
const INDEX = process.argv.find(a => a.endsWith('.json')) ?? 'data/default-user/vectors/ollama/wa_3810524038950542/bge-m3/worldsapart.json';
const CACHE = `${HERE}summary-cache.json`;
const OLLAMA = 'http://localhost:11434';
const CHAT_MODEL = 'gemma3:4b';
const EMBED_MODEL = 'bge-m3';
const K = 20, LEXW = 1;   // production fusion
const PROMPT = 'Describe the current scene in three or four plain sentences of flowing prose. Name the characters present, the location, and what each group of them is doing, covering every thread that is active. Use concrete names and places. Do not write a list or bullet points. No dialogue, no atmosphere, no commentary. Output only the description.';

const idx = JSON.parse(readFileSync(INDEX, 'utf8'));
const items = idx.items.filter(i => (i.metadata.text ?? '').length > 120);
const D = items[0].vector.length, N = items.length;

// --- trials: one per multi-chunk entry. seed = first chunk (summarized), gold = the rest ---
const groups = new Map();
items.forEach((it, i) => { const e = String(it.metadata.index); if (!groups.has(e)) groups.set(e, []); groups.get(e).push(i); });
const trials = [];
for (const [, arr] of groups) if (arr.length >= 2) trials.push({ seed: arr[0], targets: new Set(arr.slice(1)) });

// --- summaries (cached by seed chunk hash) ---
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const chat = async (text) => {
    const r = await fetch(`${OLLAMA}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CHAT_MODEL, prompt: `${PROMPT}\n\n${text}`, stream: false, options: { temperature: 0 } }) });
    return (await r.json()).response.trim();
};
let made = 0;
for (const t of trials) {
    const key = String(items[t.seed].metadata.hash);
    if (!cache[key]) { cache[key] = await chat(items[t.seed].metadata.text); made++; if (made % 10 === 0) process.stdout.write(`  summarized ${made}...\n`); }
    t.summary = cache[key];
}
if (made) writeFileSync(CACHE, JSON.stringify(cache, null, 0));
console.log(`corpus: ${INDEX}\ntrials: ${trials.length} (one summary per multi-chunk entry, ${made} newly generated)`);

// --- embed summaries ---
const embed = async (arr) => { const out = []; for (let i = 0; i < arr.length; i += 100) {
    const r = await fetch(`${OLLAMA}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: arr.slice(i, i + 100), model: EMBED_MODEL, truncate: true }) });
    out.push(...(await r.json()).embeddings); } return out; };
const qVecs = (await embed(trials.map(t => t.summary))).map(v => Float64Array.from(v));

// --- BM25 over the corpus (production k1/b), query = summary text ---
const tok = t => String(t ?? '').toLowerCase().split(/[^a-z0-9']+/).filter(x => x.length > 1);
const df = new Map();
const tfs = items.map(it => { const m = new Map(); for (const t of tok(it.metadata.text)) m.set(t, (m.get(t) ?? 0) + 1); for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1); return m; });
const idf = t => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
const dl = items.map((_, i) => [...tfs[i].values()].reduce((a, b) => a + b, 0));
const avgdl = dl.reduce((a, b) => a + b, 0) / N;
const postings = new Map();
items.forEach((_, d) => { for (const [t, tf] of tfs[d]) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([d, tf]); } });
const bm25 = (q, k1, b) => { const s = new Float64Array(N); for (const t of new Set(q)) { const l = postings.get(t); if (!l) continue; const w = idf(t); for (const [d, tf] of l) s[d] += w * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl[d] / avgdl)); } return s; };

// --- vectors: (optionally center by corpus mean) + normalize, docs AND query alike ---
const raw = items.map(i => Float64Array.from(i.vector));
const mean = new Float64Array(D);
for (const v of raw) for (let i = 0; i < D; i++) mean[i] += v[i];
for (let i = 0; i < D; i++) mean[i] /= N;
const prep = (v, useMean) => { const o = new Float64Array(D); let s = 0; for (let i = 0; i < D; i++) { o[i] = useMean ? v[i] - mean[i] : v[i]; s += o[i] * o[i]; } const n = Math.sqrt(s) || 1; for (let i = 0; i < D; i++) o[i] /= n; return o; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < D; i++) s += a[i] * b[i]; return s; };

const rankMap = (sc, excl) => { const o = Array.from(sc, (s, d) => [s, d]); o[excl][0] = -2; o.sort((a, b) => b[0] - a[0]); const m = new Int32Array(N); o.forEach(([, d], i) => { m[d] = i + 1; }); return m; };
const hit = (map, targets) => { let best = Infinity; for (const t of targets) if (map[t] < best) best = map[t]; return [1 / best, best <= 5 ? 1 : 0]; };

// Two query representations over the SAME trials/gold, so raw-text vs summary is isolated:
//   raw     — the seed chunk's own text (BM25) and stored embedding (vector)
//   summary — the LLM summary's text (BM25) and its embedding (vector)
// The seed is excluded from ranking in both; gold is always the sibling chunks.
const OPT = { k1: 2.0, b: 0.75 };   // optimal hybrid (with lexW=1, mean-centered)
const n = trials.length;

const arm = (label, textOf, vecOf, useMean, { k1, b }) => {
    const docs = raw.map(v => prep(v, useMean));
    let vM = 0, vR = 0, fM = 0, fR = 0;
    trials.forEach((t, ti) => {
        const q = prep(vecOf(t, ti), useMean);
        const sv = new Float64Array(N);
        for (let d = 0; d < N; d++) sv[d] = dot(q, docs[d]);
        const vmap = rankMap(sv, t.seed);
        const [vm, vr] = hit(vmap, t.targets); vM += vm; vR += vr;
        const bmap = rankMap(bm25(tok(textOf(t, ti)), k1, b), t.seed);
        const f = new Float64Array(N);
        for (let d = 0; d < N; d++) f[d] = d === t.seed ? -2 : LEXW / (K + bmap[d]) + 1 / (K + vmap[d]);
        const [fm, fr] = hit(rankMap(f, t.seed), t.targets); fM += fm; fR += fr;
    });
    console.log(`${label.padEnd(24)} |   ${(vM / n).toFixed(3)}  ${(100 * vR / n).toFixed(1)}%   |   ${(fM / n).toFixed(3)}  ${(100 * fR / n).toFixed(1)}%`);
};

console.log(`\noptimal hybrid: k1=${OPT.k1} b=${OPT.b} lexW=${LEXW} — ${n} trials, gold = sibling chunks`);
console.log('query / vectors          | vec-only MRR  r@5   | bm25+raw MRR  r@5');
arm('raw text  mean-centered', t => items[t.seed].metadata.text, t => raw[t.seed], true, OPT);
arm('raw text  uncentered',    t => items[t.seed].metadata.text, t => raw[t.seed], false, OPT);
arm('summary   mean-centered', t => t.summary, (t, ti) => qVecs[ti], true, OPT);
arm('summary   uncentered',    t => t.summary, (t, ti) => qVecs[ti], false, OPT);
