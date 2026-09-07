// selection.mjs — stage 4: does this entry belong. One question, one answer, over the dynamic block
// alone. What fits once the set is chosen is delivery.mjs, and the two are separate because they judge
// differently: this stage tests each row against a threshold on its own, where stage 5 takes a prefix
// of an order and judges nothing.
//
// Pure; every setting is injected, so the extension and the harnesses run the identical code.

/**
 * Stage 4's relevance cut: the dynamic rows whose predicted relevance clears their tier's cutoff.
 *
 * The only relevance decision WA makes: every other cut answers "how many" or "how much", and this one
 * answers "does it belong", which is what makes the delivered set something other than everything
 * activated.
 *
 * Dynamic only. Constants and armed stickies are in the prompt by intent rather than because relevance
 * chose them, and never reach this list — `onScanDone` classifies them out before the walk. That is also
 * why the cut cannot break `applyBudget`'s prefix property: it removes rows from the block the caps were
 * going to walk last.
 *
 * Per tier, because each tier's cutoff was chosen on its own fit and its own delivered set.
 *
 * A row nothing scored is kept: an absent score means no fitted model covers the row, or the file did
 * not load, neither of which is the claim "predicted irrelevant". `ignoreBudget` does not exempt, being
 * an author declaration about the budget; the per-entry escape from relevance is `@@promote`, which
 * needs no condition here because `layoutOrder` gives a promoted row its own block.
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
