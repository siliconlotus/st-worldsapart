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

/**
 * Exact two-sided sign test over paired per-scene deltas.
 *
 * THE ESTIMATOR FOR SINGLE-DIGIT n. Absolute nDCG varies far more between scenes than between parameter
 * settings — one graded scene's grid spans 0.87-0.99, another's sits elsewhere entirely — so averaging
 * absolute scores across scenes mostly measures which scenes you happened to grade. Pairing each scene
 * against its own baseline cancels that variance, and what survives is the DIRECTION of the change, which is
 * the only thing a handful of scenes can support.
 *
 * Deliberately the sign test and not a t-test: n is single-digit, nDCG deltas are bounded and skewed, and
 * normality is not available to assume. Exact binomial, so the p-value is not an approximation. Ties (|delta|
 * <= eps) are dropped, which is the standard treatment and is conservative — it shrinks n.
 *
 * Read the floor honestly: 6/6 one-way is p=0.031, 5/5 is 0.063, 4/4 is 0.125, 3/3 is 0.25. Below about six
 * scenes NO result reaches conventional significance, so the honest report is the direction, the count and
 * the effect size — never a bare winner.
 *
 * @param {number[]} deltas Per-scene (arm - baseline) differences
 * @param {number} [eps] Below this magnitude a delta is a tie
 * @returns {{plus: number, minus: number, ties: number, n: number, p: number, mean: number, consistent: boolean}}
 */
export const signTest = (deltas, eps = 1e-9) => {
    const d = (deltas ?? []).filter(x => Number.isFinite(x));
    const plus = d.filter(x => x > eps).length;
    const minus = d.filter(x => x < -eps).length;
    const ties = d.length - plus - minus;
    const n = plus + minus;
    const mean = d.length ? d.reduce((a, b) => a + b, 0) / d.length : NaN;
    if (!n) return { plus, minus, ties, n, p: 1, mean, consistent: false };
    // P(X >= k) under Binomial(n, 1/2), doubled for two-sided and capped — exact integer binomials, since n
    // is single digit and floating-point factorials would be silly here.
    const choose = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1); return Math.round(r); };
    const k = Math.max(plus, minus);
    let tail = 0;
    for (let i = k; i <= n; i++) tail += choose(n, i);
    return { plus, minus, ties, n, p: Math.min(1, 2 * tail / 2 ** n), mean, consistent: n > 1 && (plus === 0 || minus === 0) };
};

/**
 * Jaccard overlap of two sets. |A∩B| / |A∪B|; two empty sets are 0, not NaN.
 *
 * Used on graded scenes' RELEVANT sets to detect pseudo-replication. nDCG is driven almost entirely by where
 * the grade>=3 entries land, so two scenes that agree on which entries are relevant will move in lockstep
 * under every parameter change — they are one observation, and a sign test that counts them as two is
 * inventing power it does not have.
 */
export const jaccard = (a, b) => {
    const A = a instanceof Set ? a : new Set(a), B = b instanceof Set ? b : new Set(b);
    if (!A.size && !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
};

/**
 * Spearman rank correlation, tie-corrected.
 *
 * MIDRANKS, NOT THE SHORTCUT. The familiar `1 - 6*sum(d^2)/(n(n^2-1))` is only valid when no value repeats,
 * and graded scenes repeat constantly — half a pool is typically grade 0. With ties the shortcut silently
 * depends on how the sort happened to break them, which makes the coefficient partly an artifact of array
 * order. So tied values get the average of the ranks they span, and the coefficient is Pearson over those.
 *
 * Absent signals are the caller's problem to encode: pass 0 (or any floor) for "this signal did not fire",
 * because not firing on a relevant entry is the signal being wrong, not missing data to be dropped.
 *
 * @param {number[]} x
 * @param {number[]} y
 * @returns {number} -1..1, or NaN when either input has no variance
 */
export const spearman = (x, y) => {
    const midranks = v => {
        const idx = v.map((val, i) => [val, i]).sort((a, b) => a[0] - b[0]);
        const r = new Array(v.length);
        for (let i = 0; i < idx.length;) {
            let j = i;
            while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
            const mid = (i + j) / 2 + 1;
            for (let k = i; k <= j; k++) r[idx[k][1]] = mid;
            i = j + 1;
        }
        return r;
    };
    const [a, b] = [midranks(x), midranks(y)];
    const n = a.length;
    if (n < 2) return NaN;
    const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return (da && db) ? num / Math.sqrt(da * db) : NaN;
};
