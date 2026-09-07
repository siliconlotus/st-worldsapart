// delivery.mjs — stage 5: what fits, and in what order the budget walks. The entry maxes (how many),
// the token budget (how much), and the walk order the caps take a prefix of. Whether an entry belongs
// was settled at stage 4 (selection.mjs).
//
// Nothing here judges an entry. A row this file drops cleared stage 4 and lost to space, which is why
// every cut is a prefix of the layout order rather than a test against a threshold.
//
// Pure; every setting is injected, so the extension and the harnesses run the identical code.

/**
 * The order the budget walks: constants, armed stickies, promoted rows, then the dynamic block.
 *
 * Constant leads, because constant means always: a constant should only be cut when constants alone
 * exceed the budget, anything else being a world rule losing its place to an entry that persists from an
 * earlier turn.
 *
 * Promoted sits behind both durable blocks and ahead of dynamic: an author declaring activation
 * sufficient outranks relevance choosing a row, and does not outrank always-on.
 *
 * Walking the first three classes ahead of dynamic is what makes every cap in applyBudget a prefix cut:
 * once the dynamic count is used up there is nothing but dynamic entries left to reject.
 *
 * @param {object} blocks The four activation classes
 * @param {Array<object>} blocks.sticky Armed stickies, authored order
 * @param {Array<object>} blocks.constant Constants, authored order
 * @param {Array<object>} blocks.promoted Author-declared rows, layout order
 * @param {Array<object>} blocks.results The dynamic block, retention order
 * @returns {Array<object>} Budget walk order
 */
export function walkOrder({ sticky = [], constant = [], promoted = [], results = [] }) {
    return [...constant, ...sticky, ...promoted, ...results];
}

/**
 * The `ignoreBudget` the author set, which is not the one core is shown.
 *
 * WA's budget supersedes core's, and that is not a preference core can be asked to honour: core's budget
 * loop runs before WA is called and drops the entries it cuts, so a core budget smaller than WA's
 * silently caps WA's. onEntriesLoaded therefore tells core every entry is exempt, so its loop never
 * cuts, and applyBudget does the cutting on the layout order instead.
 *
 * `??`, not `||`: a stashed `false` must beat the `true` core was handed. The fallback fires only for
 * entries WA never processed — a dry run, or WA disabled — where the field is still the author's own.
 */
export const authorIgnoreBudget = entry => Boolean(entry?.waIgnoreBudget ?? entry?.ignoreBudget);

/**
 * Applies the entry and token caps.
 *
 * The populations are nested — vector ⊆ dynamic ⊆ all — so these are three constraints
 * on one walk rather than three competing policies, and none of them changes what
 * another means. Any cap at 0 is off.
 *
 *   maxVectorEntries  caps the retrieved entries within that, so retrieval cannot flood the block
 *   maxDynamic  caps keyword and vector entries; constants and stickies are unaffected
 *   maxTotal    caps everything, so constants consume it before the dynamic entries
 *   maxTokens   caps context usage, which is only meaningful over everything
 *
 * `walk` must lead with stickies and constants, which makes every cap a prefix cut:
 * once the dynamic count is used up there is nothing but dynamic entries left to reject.
 * Leaving maxTotal at 0 is what guarantees an always-on entry is never dropped.
 *
 * Entries marked ignoreBudget are outside the budgeted population entirely — neither
 * capped nor counted — so the entry caps read as "this many on top of the mandatory
 * ones". They do still spend tokens; see the note at the accounting.
 *
 * @param {object} args Budget arguments
 * @returns {Promise<{survivors: Set, counted: number, dynamic: number, vector: number, dropped: number, budgeted: number, inPrompt: number}>}
 */
export async function applyBudget({ walk, isDynamic, isCapped = isDynamic, maxTokens, maxTotal, maxDynamic, maxVectorEntries = 0, isVector = () => false, tokensOf, capOf = () => 0, exemptIsBudgeted = false, slack = 0, slackOnce = true }) {
    const survivors = new Set();
    let counted = 0;
    let dynamic = 0;
    let vector = 0;
    // Per-book quota: a ceiling on how many dynamic entries each book may contribute, so a
    // relevance flood in one book can't crowd the others out. Counts dynamic only — a book's
    // constants are always-on and not subject to it, same as maxDynamic.
    const perWorld = new Map();
    // budgeted: tokens the caps enforce against. inPrompt: tokens actually reaching the prompt. They
    // diverge when exempt entries are not budgeted, and conflating them is how a cap ends up reporting a
    // ceiling the prompt has already gone through. Both count World Info tokens only — no chat, system
    // prompt, persona or examples.
    let budgeted = 0;
    let inPrompt = 0;
    let slackSpent = false;
    let lastAdmitted = -1;
    let index = -1;
    const skipped = [];

    const ceiling = maxTokens > 0 ? maxTokens * (1 + slack) : 0;

    for (const item of walk) {
        index += 1;
        const itemTokens = await tokensOf(item);
        const exempt = authorIgnoreBudget(item.entry);

        // An entry over the budget but within the slack is admitted anyway, so the
        // entry genuinely next in line keeps the last slot instead of yielding it to
        // whatever happens to be small enough to squeeze in.
        const pastBudget = maxTokens > 0 && budgeted + itemTokens > maxTokens;
        const rescuable = pastBudget
            && slack > 0
            && budgeted + itemTokens <= ceiling
            && !(slackOnce && slackSpent);

        // Every cap that would reject this entry, not just the first — an entry blocked
        // by two caps needs both raised, and reporting one sends the user round twice.
        const blockedBy = [];

        if (pastBudget && !rescuable) {
            blockedBy.push({
                cap: 'tokens',
                // What it would take to admit this entry: the extra budget, or the slack
                // percentage that would have covered the overhang.
                shortfall: budgeted + itemTokens - maxTokens,
                slackNeeded: Math.ceil(((budgeted + itemTokens) / maxTokens - 1) * 100),
                slackSpent: slackSpent && slack > 0,
                remaining: Math.max(0, maxTokens - budgeted),
            });
        }
        if (maxTotal > 0 && counted >= maxTotal) {
            blockedBy.push({ cap: 'total', shortfall: 1 });
        }
        if (maxDynamic > 0 && isDynamic(item) && dynamic >= maxDynamic) {
            blockedBy.push({ cap: 'dynamic', shortfall: 1 });
        }
        // Retrieval's own ceiling. Guarded on a population here, not just at the increment below —
        // isVector reads the entry's own vectorized flag and a constant can be vectorized, so the block
        // must be enforced rather than assumed of the caller's predicate.
        //
        // `isCapped`, never `isDynamic`: the two differ by exactly the promoted block. maxDynamic bounds
        // relevance-selected material; these bound capacity, which a promoted row consumes like any
        // other. Defaults to `isDynamic`, so a caller with no promoted block is unchanged.
        if (maxVectorEntries > 0 && isCapped(item) && isVector(item) && vector >= maxVectorEntries) {
            blockedBy.push({ cap: 'vector', shortfall: 1 });
        }
        const bookCap = capOf(item);
        if (bookCap > 0 && isCapped(item) && (perWorld.get(item.entry?.world) ?? 0) >= bookCap) {
            blockedBy.push({ cap: 'book', shortfall: 1, world: item.entry?.world, limit: bookCap });
        }

        // Skip rather than stop. An entry too big for the remaining tokens shouldn't
        // bar the smaller ones behind it, and stopping early would mean an entry marked
        // ignoreBudget never gets reached — which is the one thing that flag promises.
        if (blockedBy.length && !exempt) {
            skipped.push({ item, tokens: itemTokens, blockedBy, index });
            continue;
        }

        // An entry that can't be cut isn't part of the population being budgeted, so it stays out of the
        // denominator too: counting it would mean 10 ignoreBudget entries against a cap of 10 silently
        // returns zero retrieval results, where not counting it means you asked for 10 and got 20 —
        // visible and proportional.
        //
        // Tokens follow the same rule, and the default is off for the same reason: maxTokens is a cost
        // guard, not a limit anything downstream enforces, so charging a mandatory entry against it
        // collapses retrieval while the cost stays flat. maxTokensIncludesExempt turns it back on for a
        // book whose exempt entries could overrun the context by themselves.
        if (rescuable) {
            slackSpent = true;
        }

        if (!exempt || exemptIsBudgeted) {
            budgeted += itemTokens;
        }

        inPrompt += itemTokens;

        if (!exempt) {
            counted += 1;
            if (isDynamic(item)) {
                dynamic += 1;
            }
            // The capacity counters, on the wider population — see the caps above.
            if (isCapped(item)) {
                if (isVector(item)) {
                    vector += 1;
                }
                perWorld.set(item.entry?.world, (perWorld.get(item.entry?.world) ?? 0) + 1);
            }
        }

        survivors.add(item);
        lastAdmitted = index;
    }

    // Two different situations wear the same rejection. If something was admitted after an entry was
    // rejected, the budget still had usable room and shortening that entry would work; if nothing after
    // it got in, it is the tail of an exhausted budget and only the cap matters.
    for (const skip of skipped) {
        skip.tail = skip.index > lastAdmitted;
    }

    return { survivors, counted, dynamic, vector, skipped, dropped: walk.length - survivors.size, budgeted, inPrompt };
}
