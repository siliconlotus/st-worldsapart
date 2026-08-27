// selection.mjs — STAGE 4: does this entry belong. One question, one answer, over the dynamic block
// alone. What FITS once the set is chosen is delivery.mjs, and the two are separate because they judge
// differently: this stage tests each row against a threshold on its own, where stage 5 takes a prefix
// of an order and judges nothing.
//
// Pure; every setting is injected, so the extension and the harnesses run the identical code.

/**
 * Stage 4's relevance cut: the dynamic rows whose predicted relevance clears their tier's cutoff.
 *
 * THE ONLY RELEVANCE DECISION WA MAKES. Every other cut here answers "how many" or "how much"; this one
 * answers "does it belong", which is what makes the delivered set something other than everything
 * activated. Until it existed the score of record was invariant to every layout parameter, because the
 * set never changed.
 *
 * DYNAMIC ONLY. Constants and armed stickies are in the prompt by intent rather than because relevance
 * chose them, and they never reach this list — `onScanDone` classifies them out before the walk. That
 * is also why the cut cannot break `applyBudget`'s prefix property: it removes rows from the block the
 * caps were already going to walk last.
 *
 * PER TIER, because each tier's cutoff was chosen on its own fit and its own delivered set — memory's
 * against reference's are not the same number and do not mean the same thing.
 *
 * A ROW NOTHING SCORED IS KEPT. An absent score means no fitted model covers the row, or the file did
 * not load — neither of which is the claim "predicted irrelevant", and silently dropping on a missing
 * number is how an outage becomes a content change. `ignoreBudget` does NOT exempt: it is an author
 * declaration about the BUDGET, and the per-entry escape from relevance is `promote`, which does not
 * exist yet.
 *
 * @param {object[]} results The dynamic block
 * @param {(item: object) => number} scoreOf Predicted relevance, NaN when unscored
 * @param {(item: object) => number} cutoffOf That row's tier cutoff, NaN when the tier has no fit
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
