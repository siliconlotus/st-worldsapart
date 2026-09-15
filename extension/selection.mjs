// selection.mjs — stage 4: does this entry belong. Pure; every setting is injected.

/**
 * The dynamic rows whose predicted relevance clears their tier's cutoff.
 *
 * A row with no finite score or cutoff is kept: no verdict is not a negative one. Durable and promoted
 * rows never reach this list, since layoutOrder gives them their own blocks, and `ignoreBudget` is about
 * the budget and does not exempt here.
 *
 * @param {(item: object) => number} scoreOf Predicted relevance, NaN when unscored
 * @param {(item: object) => number} cutoffOf The row's tier cutoff, NaN when the tier has no fit
 * @returns {{kept: object[], cut: object[]}}
 */
export function relevanceCut(results, { scoreOf, cutoffOf }) {
    const kept = [], cut = [];
    for (const item of results ?? []) {
        const score = scoreOf(item);
        const cutoff = cutoffOf(item);
        (!Number.isFinite(score) || !Number.isFinite(cutoff) || score >= cutoff ? kept : cut).push(item);
    }
    return { kept, cut };
}
