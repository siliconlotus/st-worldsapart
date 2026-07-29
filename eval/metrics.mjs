// metrics.mjs — LOO ranking metrics shared by the eval grids (baseline-grid, centering-grid),
// plus the one-line assertion the check scripts share.

/** Exact-equality console check: "ok <label>" / "FAIL <label>: got (want …)". */
export const eq = (got, want, label) => console.log(`${got === want ? 'ok  ' : 'FAIL'} ${label}: ${got}${got === want ? '' : ` (want ${want})`}`);

/** scores -> 1-based rank per doc, with the query doc q forced to the bottom. */
export const rankMap = (scores, q) => { const o = Array.from(scores, (s, d) => [s, d]); o[q][0] = -2; o.sort((a, b) => b[0] - a[0]); const m = new Int32Array(o.length); o.forEach(([, d], i) => { m[d] = i + 1; }); return m; };

/** [reciprocal rank of the best target, 1 if any target lands in the top 5]. */
export const hit = (map, targets) => { let best = Infinity; for (const t of targets) if (map[t] < best) best = map[t]; return [1 / best, best <= 5 ? 1 : 0]; };

// nDCG@k. `gradeOf(doc)` returns a relevance grade (LOO: 1 for a sibling, else 0 — but any graded
// vector works, which is what the human-graded scene mode will pass). Ideal DCG from the sorted grades.
export const ndcgAt = (map, targets, k, gradeOf = () => 1) => {
    let dcg = 0; for (const t of targets) { const r = map[t]; if (r <= k) dcg += gradeOf(t) / Math.log2(r + 1); }
    const ideal = [...targets].map(gradeOf).sort((a, b) => b - a);
    let idcg = 0; for (let i = 0; i < Math.min(ideal.length, k); i++) idcg += ideal[i] / Math.log2(i + 2);
    return idcg ? dcg / idcg : 0;
};
