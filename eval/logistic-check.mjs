// The fit is checked against cases whose answer is known independently of it, because a wrong coefficient
// does not throw — it prints, and reads exactly like a finding.
import { logisticFit, auc, inverse, cumulativeFit, prCurve, reliability, sigmoid } from './logistic.mjs';
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
// Built so the slopes CAN differ (see its header): a label whose boundaries genuinely differ must produce
// different slopes rather than one averaged one.
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

// --- prCurve: the operational readout, which AUC is not ------------------------------------------------
{
    // A perfect ranking: both positives first. AP 1, and full recall at full precision.
    const perfect = prCurve([9, 8, 2, 1], [1, 1, 0, 0]);
    eq(perfect.ap, 1, 'a perfect ranking has AP 1');
    eq(perfect.at[0.5].precision, 1, '...and reaches half its recall at precision 1');
    eq(perfect.at[0.9].admitted, 2, '...admitting exactly the positives');
    // One positive buried under three negatives: AP is 1/4, and AUC would read 0.5-ish on the same rows.
    const buried = prCurve([9, 8, 7, 1], [0, 0, 0, 1]);
    eq(buried.ap, 0.25, 'a positive at rank 4 scores AP 1/4');
    // The point of having it: a rare class can look excellent on AUC and poor on AP.
    const rare = Array.from({ length: 100 }, (_, i) => i);          // scores 0..99
    const ry = rare.map(i => (i === 99 || i === 50 ? 1 : 0));       // one at the top, one mid-pack
    const a = auc(rare, ry), p = prCurve(rare, ry);
    eq(a > 0.7, true, 'AUC reads well when one of two positives is ranked top');
    eq(p.ap < a, true, '...and AP reads the cost of the other one, which AUC discounts');
    eq(Number.isNaN(prCurve([1, 2], [0, 0]).ap), true, 'no positives means no curve, reported as NaN');
    console.log('ok   prCurve: AP and precision-at-recall, and AP is the harsher of the two');
}

// --- reliability -------------------------------------------------------------------------------------
// Calibration is checked against constructions whose right answer is arithmetic, because the failure it
// exists to catch — a model that ranks well and reports wrong numbers — is invisible in AUC and AP.
{
    // A predictor saying 0.5 everywhere on a half-positive set is perfectly calibrated and completely
    // uninformative — the whole reason calibration is a separate readout: AUC here is undefined-by-tie,
    // ECE is 0, and both are correct.
    const flat = reliability(Array(100).fill(0.5), Array.from({ length: 100 }, (_, i) => i % 2));
    eqNear(flat.ece, 0, 'a constant 0.5 on a 50% base rate is perfectly calibrated', 1e-12);
    eq(flat.bins.length, 1, '...in one bin, because ties are never split across bins');

    // Systematically overconfident: the truth is a coin, the model claims 0.9.
    const over = reliability(Array(100).fill(0.9), Array.from({ length: 100 }, (_, i) => i % 2));
    eqNear(over.ece, 0.4, 'a 0.9 prediction on a 50% outcome is off by 0.4', 1e-12);
    eqNear(over.mce, 0.4, '...and with one bin the worst bin is the average one', 1e-12);

    // Perfectly calibrated ACROSS bins, deliberately built so the global mean would hide a fault if the
    // readout were only a mean: two groups, each right on its own, is ECE 0 — and inverting the labels
    // between them keeps the global mean identical while making every bin wrong.
    const p = [...Array(50).fill(0.2), ...Array(50).fill(0.8)];
    const good = [...Array(50).fill(0).map((_, i) => (i < 10 ? 1 : 0)), ...Array(50).fill(0).map((_, i) => (i < 40 ? 1 : 0))];
    const swapped = [...Array(50).fill(0).map((_, i) => (i < 40 ? 1 : 0)), ...Array(50).fill(0).map((_, i) => (i < 10 ? 1 : 0))];
    eqNear(reliability(p, good, { bins: 2 }).ece, 0, 'each bin right on its own is ECE 0', 1e-12);
    eqNear(reliability(p, swapped, { bins: 2 }).ece, 0.6, '...the same global mean with both bins wrong is not', 1e-12);
    eqNear(reliability(p, swapped, { bins: 2 }).meanP, reliability(p, good, { bins: 2 }).meanP, 'the two differ in no global statistic', 1e-12);

    // The in-sample identity the doc comment rests on: a logistic fit with an intercept forces
    // sum(p) == sum(y), so global calibration is zero by construction and only the bins can disagree.
    const X = Array.from({ length: 200 }, (_, i) => [1, (i % 20) / 10 - 1]);
    const yy = X.map(([, x], i) => (x + (i % 7) / 14 > 0.5 ? 1 : 0));
    const fit = logisticFit(X, yy);
    const ps = X.map(row => sigmoid(row.reduce((s, v, j) => s + v * fit.beta[j], 0)));
    const inSample = reliability(ps, yy);
    eqNear(inSample.meanP, inSample.observed, 'in-sample, mean predicted equals the base rate — a score equation, not a finding', 1e-6);
}

// --- the calibrated-model null -------------------------------------------------------------------
// The null is what makes an ECE readable, so it is checked against the one case where the answer is
// known by construction: labels drawn FROM the model's own probabilities are perfectly calibrated in
// expectation, so the observed ECE should sit in the body of the null and not in its tail.
{
    let st = 7;
    const rnd = () => { st = (st * 1103515245 + 12345) % 2147483648; return st / 2147483648; };
    const ps = Array.from({ length: 400 }, () => 0.02 + 0.9 * rnd());

    const honest = reliability(ps, ps.map(v => (rnd() < v ? 1 : 0)), { nullSamples: 300, seed: 3 });
    eq(honest.ece > 0, true, 'even a perfectly calibrated predictor scores a positive ECE — binomial scatter');
    eq(honest.eceP > 0.05, true, '...and the null says so: the observed value is unremarkable against it');
    eq(Math.abs(honest.ece - honest.eceNull) < 0.02, true, '...sitting near the null mean rather than above it');

    // A predictor that is genuinely off, at the same n, must clear the same floor.
    const skewed = reliability(ps.map(v => Math.min(0.999, v + 0.15)), ps.map(v => (rnd() < v ? 1 : 0)),
        { nullSamples: 300, seed: 3 });
    eq(skewed.ece > skewed.eceNull * 2, true, 'a 0.15 bias is well clear of the noise floor');
    eq(skewed.eceP < 0.01, true, '...and the null rejects it');

    // The size effect the null exists to absorb: the same calibrated predictor on a tenth of the rows
    // scores a visibly worse ECE, and the null rises with it rather than staying put.
    const small = reliability(ps.slice(0, 40), ps.slice(0, 40).map(v => (rnd() < v ? 1 : 0)), { nullSamples: 300, seed: 3 });
    eq(small.eceNull > honest.eceNull, true, 'a smaller sample has a higher noise floor, which raw ECE would read as a worse model');

    const labels = ps.map(v => (rnd() < v ? 1 : 0));
    eq(Number.isNaN(reliability(ps, labels).eceNull), true, 'no null is computed unless asked');
    // Seeded, or the check could not fail: two runs of the same inputs must agree exactly.
    eq(reliability(ps, labels, { nullSamples: 50, seed: 11 }).eceNull,
       reliability(ps, labels, { nullSamples: 50, seed: 11 }).eceNull, 'the same seed gives the same null');
    eq(reliability(ps, labels, { nullSamples: 50, seed: 11 }).eceNull
       !== reliability(ps, labels, { nullSamples: 50, seed: 12 }).eceNull, true, '...and a different one does not');
}
