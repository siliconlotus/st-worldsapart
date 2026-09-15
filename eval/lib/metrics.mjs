// metrics.mjs — the statistics, the console assertion and the argv reader the eval tools share.

/** "ok <label>" / "FAIL <label>: got (want …)". `exitCode`, not `exit()`: the run reports every failure, and the
 *  suite reads the exit status, since a stack trace has no FAIL line to grep. */
const report = (ok, got, want, label) => {
    if (!ok) process.exitCode = 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}${ok ? '' : ` (want ${want})`}`);
};

export const eq = (got, want, label) => report(got === want, got, want, label);

export const eqNear = (got, want, label, tol = 1e-9) => report(Math.abs(got - want) < tol, got, want, label);

/** The value after `k` in `argv`, or `d`; a flag with no value is also the default. `argv` is passed in: callers disagree about whether it is sliced. */
export const arg = (argv, k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d; };

export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export const fmt3 = x => (Number.isFinite(x) ? x.toFixed(3) : '—');

/** Precision credit for one delivered entry on the 0-4 anchors: 3-4 full, 2 half. Banded, not interpolated: a 2.5 credits as a 2. */
export const gradeCredit = g => (g >= 3 ? 1 : g >= 2 ? 0.5 : 0);

// Re-exported from grading.mjs, beside the schema it reads; a second copy of the rule must never appear here.
export { gradeValue } from '../../extension/grading.mjs';

/** F-beta; beta > 1 weights recall (the harness passes RECALL_WEIGHT). */
export const fbeta = (precision, recall, beta = 2) => {
    const b2 = beta * beta;
    return (precision || recall) ? ((1 + b2) * precision * recall) / (b2 * precision + recall) : 0;
};

/** How much worse a lost relevant entry is than a gained irrelevant one. Asserted, not measured. */
export const RECALL_WEIGHT = 2;

/** Exact two-sided sign test over paired per-scene (arm - baseline) deltas; ties (|delta| <= eps) are dropped.
 *  Report direction, count and mean delta — at single-digit n nothing reaches significance. */
export const signTest = (deltas, eps = 1e-9) => {
    const d = (deltas ?? []).filter(x => Number.isFinite(x));
    const plus = d.filter(x => x > eps).length;
    const minus = d.filter(x => x < -eps).length;
    const ties = d.length - plus - minus;
    const n = plus + minus;
    const mu = mean(d);
    if (!n) return { plus, minus, ties, n, p: 1, mean: mu, consistent: false };
    // P(X >= k) under Binomial(n, 1/2), doubled and capped; exact integer binomials.
    const choose = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1); return Math.round(r); };
    const k = Math.max(plus, minus);
    let tail = 0;
    for (let i = k; i <= n; i++) tail += choose(n, i);
    return { plus, minus, ties, n, p: Math.min(1, 2 * tail / 2 ** n), mean: mu, consistent: n > 1 && (plus === 0 || minus === 0) };
};

/** Jaccard overlap of two sets; two empty sets are 0, not NaN. */
export const jaccard = (a, b) => {
    const A = a instanceof Set ? a : new Set(a), B = b instanceof Set ? b : new Set(b);
    if (!A.size && !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter);
};

/** Spearman rank correlation with midranks for ties (the 6*sum(d^2) shortcut is wrong under ties); NaN without variance. Encode an absent signal as 0, never drop the row. */
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

/** Quadratic weighted kappa over the 0-4 anchors. `pairs` is [[a, b], …] of two raters' grades for the same rows. */
export const qwk = (pairs, k = 5) => {
    const n = pairs.length;
    if (!n) return NaN;
    const O = Array.from({ length: k }, () => new Array(k).fill(0));
    for (const [a, b] of pairs) O[a][b]++;
    const ra = new Array(k).fill(0), rb = new Array(k).fill(0);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { ra[i] += O[i][j]; rb[j] += O[i][j]; }
    let num = 0, den = 0;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
        const w = ((i - j) ** 2) / ((k - 1) ** 2);
        num += w * O[i][j];
        den += w * ra[i] * rb[j] / n;
    }
    return den ? 1 - num / den : NaN;
};

/** The leading `k` principal components of `items` about `mean` (zeros for uncentered), by power iteration with deflation.
 *  Deterministic; returns FEWER than k when the residual is dead, so callers read the length. */
export const topComponents = (items, k, mean, iters = 40) => {
    if (k <= 0 || !items.length) return [];
    const D = mean.length, N = items.length;
    const X = items.map(it => Float64Array.from({ length: D }, (_, i) => it.vector[i] - mean[i]));
    const nrm = v => { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); };
    const energy = () => { let s = 0; for (const x of X) for (const v of x) s += v * v; return s; };
    const start = energy();
    const out = [];
    for (let c = 0; c < k; c++) {
        // A dead residual would leave the SEED as a component; stop instead.
        if (energy() <= start * 1e-12) break;
        // Seed varied by component, so a deflated residual is not seeded orthogonally to its own leading direction.
        let v = Float64Array.from({ length: D }, (_, i) => Math.sin(i + 1 + c * 0.5));
        let vn = nrm(v);
        for (let i = 0; i < D; i++) v[i] /= vn;
        for (let t = 0; t < iters; t++) {
            const w = new Float64Array(D);
            for (let d = 0; d < N; d++) {
                const x = X[d];
                let p = 0;
                for (let i = 0; i < D; i++) p += x[i] * v[i];
                for (let i = 0; i < D; i++) w[i] += p * x[i];
            }
            vn = nrm(w);
            if (!vn) break;   // unreachable given the energy guard above; kept so the divide is total
            for (let i = 0; i < D; i++) w[i] /= vn;
            v = w;
        }
        out.push(v);
        for (const x of X) {
            let p = 0;
            for (let i = 0; i < D; i++) p += x[i] * v[i];
            for (let i = 0; i < D; i++) x[i] -= p * v[i];
        }
    }
    return out;
};

/** The standard deviation of `vectors` along each of `comps` about `mean` — what whitening rescales by. */
export const componentScales = (vectors, comps, mean) => comps.map(c => {
    const D = mean.length;
    let s2 = 0;
    for (const it of vectors) {
        let p = 0;
        for (let i = 0; i < D; i++) p += (it.vector[i] - mean[i]) * c[i];
        s2 += p * p;
    }
    return Math.sqrt(s2 / (vectors.length || 1));
});

/** `vector` with `mean` subtracted and each of `comps` scaled by its `weights` entry (0 removes, 1 keeps; omitted weights remove all). Apply to the query and every document alike. */
export const projectOut = (vector, mean, comps, weights = null) => {
    const D = mean.length;
    const v = Float64Array.from({ length: D }, (_, i) => vector[i] - mean[i]);
    comps.forEach((c, j) => {
        const w = weights ? weights[j] : 0;
        if (w === 1) return;
        let p = 0;
        for (let i = 0; i < D; i++) p += v[i] * c[i];
        const k = p * (1 - w);
        for (let i = 0; i < D; i++) v[i] -= k * c[i];
    });
    return v;
};
