// logistic.mjs — logistic regression by IRLS and the matrix solve it needs. Library, no CLI; the only copy of the fit.

/** Gauss-Jordan inverse with partial pivoting; null for a singular matrix, which the caller reports. */
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
 * Fits P(y=1) = sigmoid(X·beta) by IRLS. Ridge is small by default (1e-6): it keeps a separated fit finite and visibly
 * huge without moving an identified one at printed precision.
 * @param {number[][]} X Rows of features; the caller prepends its own intercept column
 */
export function logisticFit(X, y, { ridge = 1e-6, iterations = 50 } = {}) {
    const n = X.length, p = X[0].length;
    let beta = Array(p).fill(0);
    let cov = null, iter = 0, converged = false;

    for (; iter < iterations; iter++) {
        const eta = X.map(row => row.reduce((s, x, j) => s + x * beta[j], 0));
        const mu = eta.map(sigmoid);
        // Weights floor at 1e-8: a saturated probability has no curvature, and dividing by it turns a converged fit into NaN.
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

/** Area under the ROC curve by the rank-sum identity, ties at averaged ranks; NaN when one class is absent. */
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

/** The cumulative-logit family: one binary fit per boundary of an ordinal label, P(g >= k) for each of `cuts`, over one
 *  X (intercept columns included by the caller). Separate slopes per boundary, deliberately NOT proportional odds; a
 *  cut with one class absent is skipped. */
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

/** Precision-recall readout: average precision by the step-sum, and precision at each of `recalls`. */
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
 * Reliability of predicted probabilities: quantile bins (ties kept together), ECE, MCE and a seeded parametric-bootstrap
 * null (`eceNull`, `eceP`) — an ECE is meaningless without it (F30). Read it OUT OF FOLD: in-sample, an intercept fit
 * has zero global calibration by construction.
 * @param {number} [nullSamples] Bootstrap draws for the calibrated-model null; 0 skips it
 */
export function reliability(p, y, { bins = 10, nullSamples = 0, seed = 1 } = {}) {
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
    const eceOf = rows => rows.reduce((a, b) => a + b.n * Math.abs(b.meanP - b.observed), 0) / (n || 1);
    const ece = eceOf(out);
    const mce = out.reduce((a, b) => Math.max(a, Math.abs(b.meanP - b.observed)), 0);

    // The null: every bin as cut, each row's label redrawn from its own predicted probability.
    let eceNull = NaN, eceP = NaN;
    if (nullSamples > 0) {
        let state = seed >>> 0;
        const rnd = () => {   // mulberry32
            state = (state + 0x6D2B79F5) >>> 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        let sum = 0, atLeast = 0;
        for (let s = 0; s < nullSamples; s++) {
            let i = 0;
            const drawn = out.map(b => {
                let hits = 0;
                for (let k = 0; k < b.n; k++, i++) if (rnd() < order[i][0]) hits++;
                return { n: b.n, meanP: b.meanP, observed: hits / b.n };
            });
            const e = eceOf(drawn);
            sum += e;
            if (e >= ece) atLeast++;
        }
        eceNull = sum / nullSamples;
        eceP = atLeast / nullSamples;
    }
    return {
        bins: out, ece, mce, n, eceNull, eceP,
        meanP: p.reduce((a, b) => a + b, 0) / (n || 1),
        observed: y.reduce((a, b) => a + b, 0) / (n || 1),
    };
}
