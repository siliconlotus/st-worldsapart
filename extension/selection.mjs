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
