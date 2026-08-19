// Logistic regression by IRLS, and the matrix solve it needs. Library, no CLI.
//
// Split from its caller for the same reason the gazetteer and the scorers are: the fit is what a relevance
// claim rests on, and a second copy of it in a second tool would let the two disagree about a coefficient
// while both printed one. Small enough to read in full, which is the point — a fitted weight nobody can
// check is not evidence.
//
// IRLS RATHER THAN GRADIENT DESCENT because the standard errors come free. Newton's method already forms
// (X'WX)^-1 at every step, and its diagonal at convergence IS the coefficient covariance — so "the BM25
// weight moved" can be read against the interval it moved inside, instead of being asserted from two point
// estimates. A gradient method would have to bootstrap for the same thing.

/** Gauss-Jordan inverse with partial pivoting. n is the feature count (single digits here), so the cubic
 *  cost is irrelevant and the clarity is not. Returns null for a singular matrix — a collinear feature set,
 *  which the caller reports rather than papers over. */
export function inverse(A) {
    const n = A.length;
    const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return null;
        [M[c], M[p]] = [M[p], M[c]];
        const d = M[c][c];
        for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c];
            if (!f) continue;
            for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
        }
    }
    return M.map(row => row.slice(n));
}

export const sigmoid = z => 1 / (1 + Math.exp(-z));

/**
 * Fits P(y=1) = sigmoid(X·beta) by iteratively reweighted least squares.
 *
 * RIDGE BY DEFAULT, small. Graded pools are mostly zeros and an eligibility indicator can be constant
 * within one arm's rows, which is exactly the separation that sends a coefficient to infinity and reports
 * it as a finding. A 1e-6 penalty leaves an identified fit untouched at the printed precision and keeps an
 * unidentified one finite and visibly huge.
 *
 * @param {number[][]} X Rows of features. The caller prepends its own intercept column if it wants one.
 * @param {number[]} y Labels, 0 or 1
 * @param {object} [opts]
 * @param {number} [opts.ridge] L2 penalty (1e-6)
 * @param {number} [opts.iterations] Max Newton steps (50)
 * @returns {{beta: number[], se: number[], iterations: number, converged: boolean, logLoss: number}}
 */
export function logisticFit(X, y, { ridge = 1e-6, iterations = 50 } = {}) {
    const n = X.length, p = X[0].length;
    let beta = Array(p).fill(0);
    let cov = null, iter = 0, converged = false;

    for (; iter < iterations; iter++) {
        const eta = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0));
        const mu = eta.map(sigmoid);
        // Weights floor at 1e-8: a saturated probability contributes no curvature, and dividing by it is
        // how a fit that has already converged turns into NaN on the next step.
        const w = mu.map(m => Math.max(m * (1 - m), 1e-8));

        const H = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_, b) => (a === b ? ridge : 0)));
        const g = Array(p).fill(0);
        for (let i = 0; i < n; i++) {
            const r = y[i] - mu[i];
            for (let a = 0; a < p; a++) {
                g[a] += X[i][a] * r;
                for (let b = a; b < p; b++) H[a][b] += X[i][a] * X[i][b] * w[i];
            }
        }
        for (let a = 0; a < p; a++) { g[a] -= ridge * beta[a]; for (let b = 0; b < a; b++) H[a][b] = H[b][a]; }

        const Hinv = inverse(H);
        if (!Hinv) return { beta, se: Array(p).fill(NaN), iterations: iter, converged: false, logLoss: NaN };
        cov = Hinv;
        const step = Hinv.map(row => row.reduce((s, h, j) => s + h * g[j], 0));
        beta = beta.map((b, j) => b + step[j]);
        if (Math.max(...step.map(Math.abs)) < 1e-8) { converged = true; iter++; break; }
    }

    const mu = X.map(row => sigmoid(row.reduce((s, x, j) => s + x * beta[j], 0)));
    const logLoss = -y.reduce((s, yi, i) => s + Math.log(Math.max(yi ? mu[i] : 1 - mu[i], 1e-12)), 0) / n;
    return { beta, se: cov.map((row, j) => Math.sqrt(Math.max(row[j], 0))), iterations: iter, converged, logLoss };
}

/**
 * Area under the ROC curve, by the rank-sum identity. Ties get averaged ranks, the same correction
 * metrics.mjs spearman applies and for the same reason: a graded pool is mostly zeros, so an arm that
 * gives many rows an identical score would otherwise score differently depending on sort order.
 * @returns {number} AUC, or NaN when one class is absent
 */
export function auc(scores, y) {
    const pos = y.reduce((s, v) => s + v, 0), neg = y.length - pos;
    if (!pos || !neg) return NaN;
    const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
    const rank = Array(scores.length).fill(0);
    for (let i = 0; i < order.length;) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
        const avg = (i + j) / 2 + 1;
        for (let t = i; t <= j; t++) rank[order[t][1]] = avg;
        i = j + 1;
    }
    const sumPos = rank.reduce((s, r, i) => s + (y[i] ? r : 0), 0);
    return (sumPos - pos * (pos + 1) / 2) / (pos * neg);
}

/**
 * The cumulative-logit family: one binary fit per boundary of an ordinal label, P(g >= k) for each cut.
 *
 * SEPARATE SLOPES PER BOUNDARY, WHICH IS NOT PROPORTIONAL ODDS — deliberately. Proportional odds shares
 * one slope vector across every cut and buys efficiency with that assumption; here the assumption IS the
 * question. Fitting each boundary alone lets the slopes be compared: if they agree, proportional odds is
 * justified and can be fitted later for the tighter intervals; if a boundary's slope collapses or inverts,
 * that is the signals failing to see a distinction the scale asserts, which a shared slope would average
 * away into the boundaries that do work.
 *
 * The caller supplies the design matrix once — the features do not change with the cut, only the label —
 * so this is K-1 fits over one X, and whatever intercept columns the caller built are reused as they
 * are. A cut with one class absent is skipped rather than fitted: it has no boundary to find.
 *
 * @param {number[][]} X Rows of features, intercept columns included by the caller
 * @param {number[]} g Ordinal labels (need not be integers; the cut is `>= k`)
 * @param {number[]} cuts Boundaries to fit, e.g. [1, 2, 3, 4]
 * @param {object} [opts] Passed through to logisticFit
 * @returns {Array<{cut: number, n: number, pos: number, fit: object|null, auc: number}>}
 */
export function cumulativeFit(X, g, cuts, opts = {}) {
    return cuts.map(cut => {
        const y = g.map(v => (v >= cut ? 1 : 0));
        const pos = y.reduce((a, b) => a + b, 0);
        if (!pos || pos === y.length) return { cut, n: y.length, pos, fit: null, auc: NaN };
        const fit = logisticFit(X, y, opts);
        const eta = X.map(row => row.reduce((s, x, j) => s + x * fit.beta[j], 0));
        return { cut, n: y.length, pos, fit, auc: auc(eta, y) };
    });
}

/**
 * Precision-recall readout: average precision, and precision at chosen recall levels.
 *
 * AUC IS THE WRONG HEADLINE FOR A THRESHOLDED SCORE. It is prevalence-independent, which makes it the
 * right thing for comparing signals and the wrong thing for asking what a threshold would deliver: at a
 * 1% base rate an AUC near 0.98 can still mean most of what clears the bar is wrong. AP is the area under
 * the precision-recall curve and moves with prevalence, so it answers the operational question — and the
 * precision-at-recall rows answer it in the units a bar is actually chosen in.
 *
 * AP by the step-sum (precision summed at each positive, divided by the positive count) rather than by
 * interpolating the curve: no trapezoid can be drawn through a step function without inventing points
 * between the ones the data has.
 *
 * @param {number[]} scores Higher = more likely positive
 * @param {number[]} y Labels, 0 or 1
 * @param {number[]} [recalls] Recall levels to report precision at
 * @returns {{ap: number, pos: number, n: number, at: Record<number, {precision: number, admitted: number}>}}
 */
export function prCurve(scores, y, recalls = [0.5, 0.75, 0.9]) {
    const pos = y.reduce((a, b) => a + b, 0);
    const at = {};
    if (!pos) return { ap: NaN, pos, n: y.length, at };
    const order = scores.map((s, i) => [s, y[i]]).sort((a, b) => b[0] - a[0]);
    let tp = 0, ap = 0;
    order.forEach(([, yi], i) => {
        if (!yi) return;
        tp++;
        ap += tp / (i + 1);
        for (const R of recalls) if (at[R] === undefined && tp / pos >= R) at[R] = { precision: tp / (i + 1), admitted: i + 1 };
    });
    return { ap: ap / pos, pos, n: y.length, at };
}

/**
 * Reliability: do the predicted probabilities MEAN what they say. AP and AUC read the ordering, and a
 * monotone rescaling leaves both untouched — so a model can rank perfectly and still be wrong about
 * every number it reports. A bar argued in probability terms ("ship above 0.3") rests on the numbers,
 * not the order, and nothing here checked them.
 *
 * READ IT OUT OF FOLD OR IT MEASURES NOTHING. A logistic fit with an intercept satisfies
 * sum(p) == sum(y) at convergence — that is one of its score equations — so in-sample the global
 * calibration is zero by construction and the bins only show how the residual redistributes. The
 * in-sample row is worth printing precisely so a near-zero ECE there is recognised as arithmetic
 * rather than read as evidence.
 *
 * QUANTILE BINS, NOT EQUAL WIDTH. Prevalence here is ~7%, so predictions pile up near zero: ten
 * equal-width bins put nine rows in ten into the first and leave the upper tail — the only region a
 * bar is ever drawn in — with a handful of rows each, where the observed rate is noise. Equal-count
 * bins spend the same n on every point of the curve. The cost is that bin EDGES move between runs,
 * so compare ECE across models rather than bin against bin.
 *
 * Ties are kept together: a run of identical probabilities in one bin is a real property of the
 * predictor, and splitting it to hit a target count would invent a distinction the model did not make.
 * So bins are approximately, not exactly, equal in size.
 *
 * ECE is the n-weighted mean gap, MCE the worst single bin. Both are reported because they answer
 * different questions: ECE is what the average prediction is off by, MCE is what the worst region is
 * off by, and a bar sits in one region rather than on the average.
 *
 * @param {number[]} p Predicted probabilities in [0,1]
 * @param {number[]} y Labels, 0 or 1
 * @param {number} [bins] Target bin count
 * @returns {{bins: Array<{n: number, meanP: number, observed: number, lo: number, hi: number}>,
 *            ece: number, mce: number, meanP: number, observed: number, n: number}}
 */
export function reliability(p, y, { bins = 10 } = {}) {
    const n = p.length;
    const order = p.map((v, i) => [v, y[i]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    const target = n / bins;
    for (let i = 0; i < n;) {
        let j = Math.min(n, Math.max(i + 1, Math.round((out.length + 1) * target))) - 1;
        while (j + 1 < n && order[j + 1][0] === order[j][0]) j++;   // never split a tie across bins
        const slice = order.slice(i, j + 1);
        out.push({
            n: slice.length,
            lo: slice[0][0], hi: slice[slice.length - 1][0],
            meanP: slice.reduce((a, r) => a + r[0], 0) / slice.length,
            observed: slice.reduce((a, r) => a + r[1], 0) / slice.length,
        });
        i = j + 1;
    }
    const ece = out.reduce((a, b) => a + b.n * Math.abs(b.meanP - b.observed), 0) / (n || 1);
    const mce = out.reduce((a, b) => Math.max(a, Math.abs(b.meanP - b.observed)), 0);
    return {
        bins: out, ece, mce, n,
        meanP: p.reduce((a, b) => a + b, 0) / (n || 1),
        observed: y.reduce((a, b) => a + b, 0) / (n || 1),
    };
}
