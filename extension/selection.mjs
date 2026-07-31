// selection.mjs — entry selection: how many retrieved entries survive the cut. The cutoff decides the
// size of the surviving prefix of a fused ranking (count / elbow / dropoff). Pure; the cutoff settings
// are injected, so the extension and the elbow harness run the identical code (no more string-slicing).

/**
 * Decides how many retrieved entries survive.
 *
 * 'count' takes a fixed number. The two cliff modes cut at a drop in fused score, so a
 * scene with three strong matches admits three and one with twelve admits twelve — still
 * bounded by maxVectorEntries, because a flat distribution has no meaningful cliff and
 * would otherwise admit the lot. They differ only in how big a gap counts as a cliff:
 *   'elbow'   — relative to the MEAN gap (elbowSensitivity × mean). Adapts per query but
 *               shifts with the window, since the mean depends on what's in it.
 *   'dropoff' — a FIXED fraction of the top score (dropoffThreshold × head[0]). Comparable
 *               across queries because RRF bounds the score band, and window-independent.
 *
 * MEASURED, 3 graded scenes (eval/graded-scene-grid.mjs, F1 over grade>=3 as a % of the best possible
 * prefix cut of the same ranking — "%oracle"). The cliff modes were given each sample's own
 * maxVectorEntries as the cap; capping a cliff search below the candidate list makes it structurally
 * unable to find an inflection further down, and an earlier run that hardcoded 10 wrongly concluded the
 * elbow was inert:
 *
 *   mode                sommers   time-whore   isekai   mean   worst
 *   count max=10           72%        96%        80%     83%    72%   (was the default)
 *   count max=20           87%        84%        60%     77%    60%
 *   elbow 1.2 / 1.5        96%        96%        92%     95%    92%   <- ships
 *   elbow 2.0              96%        96%        67%     86%    67%
 *   elbow 2.5              62%        96%        67%     75%    62%
 *   dropoff 0.06           62%        96%        67%     75%    62%
 *
 * elbow at 1.2-1.5 is the only setting that never drops below 92%, and it adapts as intended — it kept
 * 14 / 10 / 8 where the ideal cuts were 16 / 6 / 7. It ships on the strength of that, having survived every
 * population, metric and pooling change the harness was rebuilt through — the one tuning result here that
 * did. Sensitivity sits on a plateau that ENDS at 2.0 (isekai falls to 67% there), so 1.5 is well placed but
 * has less headroom above it than below.
 *
 * ELBOW HAS A MINIMUM RETRIEVAL DEPTH, and it is not obvious from this file. elbowSensitivity is a multiple
 * of the MEAN gap over the retrieved list, so a short list yields a coarse mean and the cliff fires early.
 * Server-side entry pooling initially shipped with topK = 2x the cap (20 entries), which starved it: the
 * elbow collapsed to keeping 4 on isekai and the table above reversed, making 'count' look better. It needs
 * >=60 entries and is flat from there to 4000; worldsapart.js floors topK at 100 for this reason, with the
 * measurement. Anything that narrows retrieval must re-check this table, not just the recall.
 *
 * The comparison also has a trap worth knowing: %oracle is NOT comparable across retrieval depths, because
 * the oracle improves as the candidate list deepens. Compare absolute F1 when topK changes.
 *
 * dropoff is the one to distrust: it is bimodal, jumping from 4 to 20 kept with nothing in between
 * (sommers), because a fixed fraction of the top fused score doesn't track where the gap actually is.
 * The mean gap does, which is why elbow finds inflections dropoff walks past.
 *
 * Both cut at the LAST significant gap, not the largest. A decaying score curve often has
 * several cliffs; the largest is usually the earliest, and cutting there discards whole
 * clusters of near-tied entries that sit below it. Keeping through to the final cliff
 * before the tail is what a cliff cut should mean — the largest gap only wins when it is
 * also the last, which is the single-cliff case.
 *
 * The search starts at minVectorEntries: the biggest gap in a good ranking is very
 * often the one between rank 1 and rank 2, and cutting there would return a single
 * entry every time.
 *
 * @param {Array<{fused: number}>} ranked Fused ranking, best first
 * @param {object} cfg Cutoff settings (from settings())
 * @param {string} cfg.mode vectorCutoff — 'count' | 'elbow' | 'dropoff'
 * @param {number} cfg.maxVectorEntries Hard cap on survivors
 * @param {number} cfg.minVectorEntries Floor the cliff search starts at
 * @param {number} cfg.elbowSensitivity Cliff = elbowSensitivity × mean gap (elbow mode)
 * @param {number} cfg.dropoffThreshold Cliff = dropoffThreshold × top score (dropoff mode)
 * @returns {Array<{fused: number}>} The surviving prefix
 */
export function cutRetrieved(ranked, { mode = 'count', maxVectorEntries = 20, minVectorEntries = 1, elbowSensitivity = 1.5, dropoffThreshold = 0.06 } = {}) {
    const head = ranked.slice(0, Math.max(1, maxVectorEntries));

    if ((mode !== 'elbow' && mode !== 'dropoff') || head.length <= 1) {
        return head;
    }

    const floor = Math.min(Math.max(1, minVectorEntries), head.length);
    const gaps = [];

    for (let i = floor; i < head.length; i++) {
        gaps.push(head[i - 1].fused - head[i].fused);
    }

    if (!gaps.length) {
        return head;
    }

    // The gap size that counts as a cliff. Elbow reads it off the mean (relative to this
    // ranking's own spread); dropoff off the top score (a fixed slice of the RRF band).
    const threshold = mode === 'dropoff'
        ? head[0].fused * (Number(dropoffThreshold) || 0.06)
        : (gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length) * (Number(elbowSensitivity) || 1.5);

    // Cut at the LAST cliff, so clusters below an earlier, larger drop are kept, not discarded.
    let cutAt = -1;

    for (let i = 0; i < gaps.length; i++) {
        if (gaps[i] > threshold) {
            cutAt = i;
        }
    }

    return cutAt < 0 ? head : head.slice(0, floor + cutAt);
}
