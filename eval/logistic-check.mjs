// The fit is checked against cases whose answer is known independently of it, because a wrong coefficient
// does not throw — it prints, and reads exactly like a finding.
import { logisticFit, auc, inverse, cumulativeFit } from './logistic.mjs';
import { eq, eqNear } from './metrics.mjs';

// --- inverse ---------------------------------------------------------------------------------------
const I = inverse([[4, 7], [2, 6]]);
eqNear(I[0][0], 0.6, 'inverse: known 2x2', 1e-9);
eqNear(I[0][1], -0.7, 'inverse: off-diagonal', 1e-9);
eq(inverse([[1, 2], [2, 4]]), null, 'a singular matrix returns null rather than a plausible fit');

// --- recovers a known slope ------------------------------------------------------------------------
// Data generated FROM a logistic model at beta = [-1, 2] deterministically (no sampling), so the fit has a
// right answer rather than a plausible one: each x contributes its exact expected counts as weighted rows.
const X = [], y = [];
for (let i = 0; i <= 40; i++) {
    const x = -3 + i * 0.15;
    const p = 1 / (1 + Math.exp(-(-1 + 2 * x)));
    // 200 trials per point, split at the true probability — the MLE of this table is the generating beta.
    const hits = Math.round(200 * p);
    for (let t = 0; t < 200; t++) { X.push([1, x]); y.push(t < hits ? 1 : 0); }
}
const fit = logisticFit(X, y);
eq(fit.converged, true, 'IRLS converges on a well-conditioned fit');
eqNear(fit.beta[0], -1, 'recovers the intercept it was generated from', 0.02);
eqNear(fit.beta[1], 2, 'recovers the slope it was generated from', 0.02);
eq(fit.se[1] > 0 && fit.se[1] < 0.05, true, `slope SE is finite and small: ${fit.se[1].toFixed(4)}`);

// --- a useless feature gets a coefficient near zero -------------------------------------------------
// Same labels, a column of alternating noise uncorrelated with y by construction.
const X2 = X.map((row, i) => [...row, i % 2 ? 1 : -1]);
const fit2 = logisticFit(X2, y);
eq(Math.abs(fit2.beta[2]) < 0.05, true, `an uninformative feature stays near zero: ${fit2.beta[2].toFixed(4)}`);

// --- separation stays finite ------------------------------------------------------------------------
// Perfectly separable data has no finite MLE. Without the ridge this diverges and prints an enormous
// coefficient as though it meant something; with it the fit stays finite and the size is the tell.
const sep = logisticFit([[1, -2], [1, -1], [1, 1], [1, 2]], [0, 0, 1, 1], { ridge: 1e-3 });
eq(Number.isFinite(sep.beta[1]), true, 'separable data yields a finite coefficient rather than NaN');

// --- AUC -------------------------------------------------------------------------------------------
eqNear(auc([0.1, 0.2, 0.3, 0.4], [0, 0, 1, 1]), 1, 'perfect ranking scores 1', 1e-9);
eqNear(auc([0.4, 0.3, 0.2, 0.1], [0, 0, 1, 1]), 0, 'reversed ranking scores 0', 1e-9);
eqNear(auc([1, 1, 1, 1], [0, 0, 1, 1]), 0.5, 'all-tied scores 0.5 rather than depending on sort order', 1e-9);
eq(Number.isNaN(auc([1, 2, 3], [1, 1, 1])), true, 'one class present is NaN, not a number');

console.log('ok   logistic fit recovers known coefficients, stays finite under separation, and AUC handles ties');

// --- cumulativeFit: one fit per ordinal boundary, and the boundaries are allowed to disagree -----------
// Built so the slopes CAN differ (see its header), so the check is that a label whose boundaries genuinely
// differ produces different slopes rather than one averaged one. g is ordinal on a single feature: the
// >=1 boundary is separable at x=0, the >=3 boundary is not separable at all (3s are scattered).
{
    const X = [[1, -2], [1, -1], [1, 1], [1, 2], [1, -1.5], [1, 1.5]];
    const g = [0, 0, 2, 3, 3, 0];   // >=1 tracks x; >=3 deliberately does not
    const fits = cumulativeFit(X, g, [1, 2, 3, 4]);
    eq(fits.map(f => f.cut).join(','), '1,2,3,4', 'one entry per requested cut, in order');
    eq(fits[0].pos, 3, 'the >=1 cut counts every row at or above 1');
    eq(fits[3].fit, null, 'a cut with no positives is not fitted — there is no boundary to find');
    eq(Number.isNaN(fits[3].auc), true, '...and reports NaN rather than a number nothing produced');
    eq(fits[0].auc > fits[2].auc, true, 'the separable boundary scores above the scattered one');
    // The point of separate fits: a shared slope would have to average these two.
    eq(Math.abs(fits[0].fit.beta[1]) > Math.abs(fits[2].fit.beta[1]), true,
        'boundaries carry their own slope, so a weak one cannot borrow strength from a strong one');
    console.log('ok   cumulativeFit: per-boundary fits, unfittable cuts declared, slopes independent');
}
