// Fusion-method comparison: is reciprocal-rank fusion the right way to combine WA's signals, or is score
// fusion better now that there is graded data to check against?
//
// RRF was chosen before any of this existed, for a good reason: cosine, BM25-over-chunk-text and
// BM25-over-keys live on incomparable scales, and ranks are the only currency that needs no calibration.
// The cost is that ranks throw away magnitude, and two magnitudes were being thrown away:
//
//   WITHIN a list — at the shipped rrfK of 20, rank 1 contributes 1/21 and rank 5 contributes 1/25, a 16%
//   spread, while the underlying cosines can differ by 2x. RRF is nearly flat exactly where the cutoff has
//   to make its decision.
//
//   BETWEEN lists — rank 1 of a list gets full credit whether it is an excellent match or the best of a bad
//   lot. A book with four keyword-matching entries hands its top one the same contribution a 300-entry
//   vector list hands its best.
//
// paired-arms.mjs already found supporting evidence: rrfK=60 hurt all three scenes and rrfK=10 helped two.
// Less flattening measured better, and score fusion is the limit of that direction.
//
// READS THE LOGGED SIGNALS, DOES NOT RE-DERIVE THEM. Every sample records per-entry cosine/text/keys from
// the live run, so this compares fusion arithmetic on exactly the numbers production produced — no index, no
// embedding, no chance of a re-derivation difference being read as a fusion effect. The cost is that logged
// values are rounded (cosine 5dp, text/keys 2dp), which is far below the differences being measured.
//
// Usage (from SillyTavern root):
//   node .../fusion-grid.mjs <sample.json> [more.json ...] [--k 10]
import { readFileSync } from 'node:fs';
import { openBundle, isScaffolding, rowKey } from '../extension/grading.mjs';
import { ndcg, sceneParams } from './scene.mjs';
import { signTest, spearman } from './metrics.mjs';

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const samples = argv.filter(a => a.endsWith('.json') && !a.startsWith('--'));
if (!samples.length) {
    console.error('need at least one sample: node fusion-grid.mjs <sample.json> [more.json ...] [--k 10]');
    console.error('compares RRF against score-fusion methods on the per-entry signals each sample logged.');
    process.exit(2);
}
const K = Number(arg('--k') ?? 10);

/** Min-max to [0,1] within the candidate set. Absent signals stay absent — a zero and a missing signal are
 *  different claims, and collapsing them is what makes CombMAX and CombMNZ meaningless. */
const minmax = vals => {
    const present = vals.filter(v => v != null);
    if (!present.length) return vals.map(() => null);
    const lo = Math.min(...present), hi = Math.max(...present);
    return vals.map(v => (v == null ? null : (hi === lo ? 1 : (v - lo) / (hi - lo))));
};
/** Z-score, then shifted so the weakest present value sits at 0 — keeps weights meaningful without letting
 *  a negative z flip the sign of a signal's contribution. */
const zshift = vals => {
    const present = vals.filter(v => v != null);
    if (!present.length) return vals.map(() => null);
    const mean = present.reduce((a, b) => a + b, 0) / present.length;
    const sd = Math.sqrt(present.reduce((a, b) => a + (b - mean) ** 2, 0) / present.length) || 1;
    const z = vals.map(v => (v == null ? null : (v - mean) / sd));
    const lo = Math.min(...z.filter(v => v != null));
    return z.map(v => (v == null ? null : v - lo));
};
/** Quantile within the present values: 1 = best, 0 = worst, ties broken by position. Scale-free, so it
 *  transfers across scenes whose raw distributions differ — which absolute thresholds provably do not
 *  (text medians run 41/53/57 across three scenes, and keys never exceeds 3.5 while text reaches 158). */
const quant = vals => {
    const present = vals.map((v, i) => [v, i]).filter(([v]) => v != null).sort((a, b) => a[0] - b[0]);
    const out = vals.map(() => null);
    present.forEach(([, i], r) => { out[i] = present.length < 2 ? 1 : r / (present.length - 1); });
    return out;
};
const rankOf = vals => {
    const idx = vals.map((v, i) => [v, i]).filter(([v]) => v != null).sort((a, b) => b[0] - a[0]);
    const out = vals.map(() => null);
    idx.forEach(([, i], r) => { out[i] = r + 1; });
    return out;
};

for (const path of samples) {
    const S = openBundle(JSON.parse(readFileSync(path, 'utf8')));
    const P = sceneParams(S);
    const rows = (S.candidates ?? []).filter(c => !isScaffolding(c));
    // Grades are keyed by world+uid; scaffolding is excluded above because relevance never chose it.
    const gradeOf = new Map((S.grades ?? []).filter(g => g.uid !== undefined).map(g => [rowKey(g), Number(g.grade) || 0]));
    const judged = rows.filter(r => gradeOf.has(rowKey(r)));
    if (judged.length < 5) { console.log(`${S.name}: only ${judged.length} judged candidate rows — skipping`); continue; }

    const cos = judged.map(r => (r.cosine == null ? null : Number(r.cosine)));
    const txt = judged.map(r => (r.text ? Number(r.text) : null));
    const key = judged.map(r => (r.keys ? Number(r.keys) : null));
    const g = judged.map(r => gradeOf.get(rowKey(r)));

    const W = { cos: 1, txt: P.LEXW, key: P.LEXW };
    const score = fn => {
        const order = judged.map((_, i) => i).sort((a, b) => fn(b) - fn(a));
        return ndcg(order.map(i => g[i]), K);
    };
    const sum3 = (a, b, c, i) => (a[i] ?? 0) * W.cos + (b[i] ?? 0) * W.txt + (c[i] ?? 0) * W.key;
    const nz = i => [cos[i], txt[i], key[i]].filter(v => v != null).length;

    const [mc, mt, mk] = [minmax(cos), minmax(txt), minmax(key)];
    const [zc, zt, zk] = [zshift(cos), zshift(txt), zshift(key)];
    const [rc, rt, rk] = [rankOf(cos), rankOf(txt), rankOf(key)];
    const [qc, qt, qk] = [quant(cos), quant(txt), quant(key)];
    const rrf = k => i => (rc[i] ? 1 / (k + rc[i]) : 0) + (rt[i] ? W.txt / (k + rt[i]) : 0) + (rk[i] ? W.key / (k + rk[i]) : 0);

    const methods = [
        [`RRF k=${P.K} (shipped)`, rrf(P.K)],
        ['RRF k=5', rrf(5)],
        ['RRF k=1', rrf(1)],
        ['CombSUM (min-max)', i => sum3(mc, mt, mk, i)],
        ['CombSUM (z-score)', i => sum3(zc, zt, zk, i)],
        ['CombMNZ (min-max)', i => sum3(mc, mt, mk, i) * nz(i)],
        ['CombMAX (min-max)', i => Math.max((mc[i] ?? 0) * W.cos, (mt[i] ?? 0) * W.txt, (mk[i] ?? 0) * W.key)],
        // Quantile family — the "at or above the median is good enough" model, made scale-free. Sum is a
        // Borda count (linear in rank, unlike RRF's hyperbolic 1/(k+r)); max is the either-one-suffices rule;
        // the step version is that rule at its most literal, a flat bonus for clearing the median.
        ['Quantile sum (Borda)', i => sum3(qc, qt, qk, i)],
        ['Quantile max', i => Math.max((qc[i] ?? 0) * W.cos, (qt[i] ?? 0) * W.txt, (qk[i] ?? 0) * W.key)],
        ['Quantile step @median', i => ((qc[i] ?? 0) >= 0.5 ? W.cos : 0) + ((qt[i] ?? 0) >= 0.5 ? W.txt : 0) + ((qk[i] ?? 0) >= 0.5 ? W.key : 0)],
        ['cosine only', i => cos[i] ?? -1],
        ['text only', i => txt[i] ?? -1],
        ['keys only', i => key[i] ?? -1],
    ];

    // CRITICAL ENTRIES, counted rather than scored. A grade of 5 does not mean "five times as useful as a
    // 1" — it means "the system is broken if this is left out", which is a categorical claim no continuous
    // gain function can express. nDCG will happily trade one 5 for a couple of 3s; a human will not.
    //
    // The gain function itself is deliberately left linear. Every conclusion drawn from these samples is
    // invariant to it: linear (a 5 worth 5x a 1) through 2^g-1 (31x) produce identical per-book weight
    // argmaxes AND identical single-signal orderings on all three scenes. If a future result ever depends on
    // the gain choice, distrust the result rather than tuning the metric.
    const crit = g.filter(x => x >= 5).length;
    const critIn = fn => { const order = judged.map((_, i) => i).sort((a, b) => fn(b) - fn(a)); return order.slice(0, K).filter(i => g[i] >= 5).length; };

    console.log(`\n${S.name} — ${judged.length} judged rows, ${g.filter(x => x >= 3).length} relevant, ${crit} critical (5), weights cos=1 txt=${W.txt} key=${W.key}`);
    console.log(`  method                 | nDCG@${K}  crit@${K}`);
    const out = {};
    for (const [label, fn] of methods) {
        out[label] = score(fn);
        const c = crit ? `${critIn(fn)}/${crit}${critIn(fn) < crit ? ' !!' : '   '}` : '  -  ';
        console.log(`  ${label.padEnd(22)} | ${out[label].toFixed(4)}  ${c}${label.endsWith('(shipped)') ? ' <- current' : ''}`);
    }
    // SIGNAL QUALITY, per scene — the most direct read on "is this signal any good on this book", and the
    // thing that turned out to vary most. Absent signals count as 0 rather than being dropped: failing to
    // fire on a relevant entry is the signal being wrong, not missing data.
    const z = v => v.map(x => x ?? 0);
    console.log(`  vs grade (Spearman): cosine ${spearman(z(cos), g).toFixed(2)}  text ${spearman(z(txt), g).toFixed(2)}  keys ${spearman(z(key), g).toFixed(2)}`);
    // Complementarity, over the rows where both lexical signals fire. High means they agree — which for
    // curated keys is what you want, since good keys should point where the content does. Low was initially
    // read as complementarity worth exploiting by a max-style fusion; it tracks keys being NOISE instead.
    const both = judged.map((_, i) => i).filter(i => txt[i] != null && key[i] != null);
    if (both.length > 2) {
        console.log(`  text vs keys agreement: Spearman ${spearman(both.map(i => txt[i]), both.map(i => key[i])).toFixed(2)} over ${both.length} rows scoring on both`);
    }

    globalThis.__acc = globalThis.__acc ?? [];
    globalThis.__acc.push(out);
}

// Paired across scenes, same estimator as paired-arms: direction per scene against the shipped fusion.
const acc = globalThis.__acc ?? [];
if (acc.length > 1) {
    const base = Object.keys(acc[0]).find(k => k.endsWith('(shipped)'));
    console.log(`\npaired vs "${base}" across ${acc.length} scenes`);
    console.log('  method                 | +/-/tie | mean Δ    p     | per-scene Δ');
    for (const m of Object.keys(acc[0])) {
        if (m === base) continue;
        const d = acc.map(o => o[m] - o[base]);
        const s = signTest(d);
        const flag = s.consistent ? (s.plus ? ' ^' : ' v') : '  ';
        console.log(`  ${m.padEnd(22)} | ${s.plus}/${s.minus}/${s.ties}     | ${(s.mean >= 0 ? '+' : '') + s.mean.toFixed(4)}  ${s.p.toFixed(3)}${flag} | ${d.map(x => (x >= 0 ? '+' : '') + x.toFixed(4)).join('  ')}`);
    }
    console.log(`\nAt n=${acc.length} the best two-sided p is ${signTest(Array(acc.length).fill(1)).p.toFixed(3)} — direction and effect size are the finding.`);
}
