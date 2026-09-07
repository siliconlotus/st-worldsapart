// metrics.mjs — the statistics the eval tools share, plus the one-line assertion the check scripts share
// and the argv reader the CLI tools share.

/**
 * "ok <label>" / "FAIL <label>: got (want …)".
 *
 * A mismatch sets `process.exitCode`, so a failing check and a crash are the same signal and the suite is
 * `for f in eval/*-check.mjs; do node "$f" || …; done` — grepping stdout for `^FAIL` misses thrown errors,
 * since a stack trace contains no such line.
 *
 * `exitCode`, not `exit()`: the run finishes and reports every failure rather than stopping at the first.
 */
const report = (ok, got, want, label) => {
    if (!ok) process.exitCode = 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${got}${ok ? '' : ` (want ${want})`}`);
};

/** Exact-equality console check. */
export const eq = (got, want, label) => report(got === want, got, want, label);

/** eq for floats. Same reporting and the same exit signal, `===` swapped for a tolerance. */
export const eqNear = (got, want, label, tol = 1e-9) => report(Math.abs(got - want) < tol, got, want, label);

/**
 * The value after `k` in `argv`, or `d`. Absent flag and flag-with-no-value are both the default, so a
 * harness refusing when a required setting is unsupplied tests one thing (CLAUDE.md, *A harness may contain
 * no literal that has an authoritative home*). `argv` is passed rather than read off `process.argv`,
 * because the callers disagree about whether it is sliced.
 */
export const arg = (argv, k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

/** Arithmetic mean, NaN on empty — an absent number rather than a zero, which would read as a result. */
export const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Table cell for a score: three decimals, em dash when there is no number to print. */
export const fmt3 = x => (Number.isFinite(x) ? x.toFixed(3) : '—');

/**
 * Precision credit for one delivered entry, on the 0-4 anchors (extension/grading.mjs GRADE_ANCHORS).
 *
 * A 3 or 4 is "should likely / should absolutely be included", so delivering one is fully correct. A 2 is
 * "Weakly relevant; 50/50 on inclusion" — the grader declined to call it, so half credit leaves precision
 * drifting toward 0.5 as 2s are added rather than toward 1. Full credit would let padding with ambiguous
 * entries raise the score, against delivering as many as are relevant and no more; dropping 2s from the
 * denominator fails for the mirror reason, letting a configuration shrink what it is judged on.
 *
 * Banded, not interpolated: a grader may type 2.5 and it credits 0.5 like any other 2, since the credit
 * follows the anchors inter-rater agreement was measured on. Whether half-grades should carry their own
 * weight is a separate decision, unmade.
 */
export const gradeCredit = g => (g >= 3 ? 1 : g >= 2 ? 0.5 : 0);

// The verdict in force on a row — human first, then the judges' median. It lives in extension/grading.mjs
// with the schema whose record it resolves, and is re-exported here because every reader imports it from
// this module and a second copy of the rule is the drift the single-matcher discipline exists to prevent.
export { gradeValue } from '../extension/grading.mjs';

/**
 * F-beta. beta > 1 weights recall; the harness passes RECALL_WEIGHT.
 *
 * Spelled out rather than hardcoded as F2's (5pr)/(4p+r), because the exponent is a judgement about
 * relative cost and a pair of magic constants hides which decision was made.
 */
export const fbeta = (precision, recall, beta = 2) => {
    const b2 = beta * beta;
    return (precision || recall) ? ((1 + b2) * precision * recall) / (b2 * precision + recall) : 0;
};

/**
 * How much worse a lost relevant entry is than a gained irrelevant one. Asserted, not measured: the author's
 * stated preference is that missing something relevant costs at least twice what delivering something
 * irrelevant does. Named here rather than left as a literal at the call site.
 *
 * Not the same lever as gradeCredit: that one decides what counts as an error at all, this one sets the
 * exchange rate between the two kinds.
 */
export const RECALL_WEIGHT = 2;

/**
 * Exact two-sided sign test over paired per-scene deltas.
 *
 * The estimator for single-digit n: absolute nDCG varies far more between scenes than between parameter
 * settings (H10), so averaging absolute scores mostly measures which scenes you happened to grade. Pairing
 * each scene against its own baseline cancels that variance, leaving the DIRECTION of the change.
 *
 * Deliberately the sign test and not a t-test: n is single-digit, nDCG deltas are bounded and skewed, and
 * normality is not available to assume. Exact binomial, so the p-value is not an approximation. Ties
 * (|delta| <= eps) are dropped, the standard treatment, and conservative — it shrinks n.
 *
 * Below about six scenes no result reaches conventional significance (6/6 one-way is p=0.031), so the
 * honest report is the direction, the count and the effect size — never a bare winner.
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
    const mu = mean(d);
    if (!n) return { plus, minus, ties, n, p: 1, mean: mu, consistent: false };
    // P(X >= k) under Binomial(n, 1/2), doubled for two-sided and capped — exact integer binomials, since n
    // is single digit and floating-point factorials would be silly here.
    const choose = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1); return Math.round(r); };
    const k = Math.max(plus, minus);
    let tail = 0;
    for (let i = k; i <= n; i++) tail += choose(n, i);
    return { plus, minus, ties, n, p: Math.min(1, 2 * tail / 2 ** n), mean: mu, consistent: n > 1 && (plus === 0 || minus === 0) };
};

/**
 * Jaccard overlap of two sets. |A∩B| / |A∪B|; two empty sets are 0, not NaN.
 *
 * Used on graded scenes' RELEVANT sets to detect pseudo-replication: nDCG is driven almost entirely by
 * where the grade>=3 entries land, so two scenes agreeing on which entries are relevant move in lockstep
 * under every parameter change. They are one observation, and a sign test counting them as two invents
 * power it does not have.
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
 * Midranks, not the shortcut: `1 - 6*sum(d^2)/(n(n^2-1))` is only valid when no value repeats, and graded
 * scenes repeat constantly. With ties the shortcut depends on how the sort happened to break them, making
 * the coefficient partly an artifact of array order. Tied values get the average of the ranks they span,
 * and the coefficient is Pearson over those.
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

/**
 * Quadratic weighted kappa over the 0-4 grade anchors — inter-rater agreement corrected for chance.
 *
 * Weighted because the anchors are ordered: 3-vs-4 is not the same error as 0-vs-4. `pairs` is [[a, b], …]
 * of two raters' grades for the same rows.
 *
 * An agreement statistic answers whether two raters put rows in the same band, never whether either is
 * right. Against grades produced under a superseded rubric it measures a changed construct as much as rater
 * drift (CLAUDE.md, "Graded scenes"), which is why the tools that print it print the band counts beside it.
 */
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

/**
 * The leading principal components of a set of vectors, about `mean`.
 *
 * Mean-centering subtracts one direction, and most of that direction is not the book's own but the
 * component every book shares (R15), so it spends the least book-specific effort on the long memory books
 * that most need it. What is unremarkable in a book is plausibly several directions, which one vector
 * cannot carry; this is the standard all-but-the-top treatment — remove the mean, then project out the
 * leading components.
 *
 * Power iteration with deflation, because k is small (1-8 against dim 1024) and a full SVD would pull in a
 * dependency to compute components nobody reads.
 *
 * Deterministic, and it has to be: an arm whose result moves between runs cannot be paired against a
 * baseline. The seed vector is a fixed pattern, so the same corpus always yields the same components down
 * to sign — and sign does not matter, since only the projection is used.
 *
 * @param {Array<{vector: number[]}>} items Vectors to decompose
 * @param {number} k How many components
 * @param {ArrayLike<number>} mean Subtracted first; pass zeros for uncentered
 * @param {number} [iters] Power iterations per component
 * @returns {Float64Array[]} k orthonormal components, strongest first
 */
export const topComponents = (items, k, mean, iters = 40) => {
    if (k <= 0 || !items.length) return [];
    const D = mean.length, N = items.length;
    const X = items.map(it => Float64Array.from({ length: D }, (_, i) => it.vector[i] - mean[i]));
    const nrm = v => { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); };
    const energy = () => { let s = 0; for (const x of X) for (const v of x) s += v * v; return s; };
    const start = energy();
    const out = [];
    for (let c = 0; c < k; c++) {
        // Fewer than k when the residual is dead, never a made-up direction: deflation can exhaust the
        // data's actual rank, and power iteration on a zero residual leaves the SEED vector, which would
        // project an arbitrary direction out of every document and query. Callers read the length.
        if (energy() <= start * 1e-12) break;
        // Fixed seed pattern, varied by component so a deflated residual is not seeded orthogonally to
        // its own leading direction by coincidence.
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
        // Deflate, so the next iteration sees the residual rather than re-finding this direction.
        for (const x of X) {
            let p = 0;
            for (let i = 0; i < D; i++) p += x[i] * v[i];
            for (let i = 0; i < D; i++) x[i] -= p * v[i];
        }
    }
    return out;
};

/** The standard deviation of `vectors` along each of `comps`, about `mean` — the eigenvalue's square root,
 *  by the Rayleigh quotient. topComponents finds the directions and discards these, but a direction without
 *  its scale cannot say how much a corpus VARIES along it, which is what whitening rescales by. */
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

/** `vector` with `mean` subtracted and each of `comps` scaled by its `weights` entry — 0 removes the
 *  direction outright, 1 leaves it alone, and the interior shrinks it. Applied to the query and to every
 *  document alike; doing it to one side only would compare vectors in different spaces.
 *
 *  Whitening and top-k removal are the same operation at different weights, hence one function: removal is
 *  weight 0, deleting the direction along with whatever real signal sits on it and violently sensitive to
 *  how many you take, while whitening down-weights a direction in proportion to how much the corpus spreads
 *  along it — a direction a book varies along is by construction not discriminating WITHIN that book.
 *  Weights default to 0, so an omitted argument is the removal behaviour. */
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
