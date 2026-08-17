// selection.mjs — entry selection: which activated entries survive, and in what order the budget walks
// them. Pure; every setting is injected, so the extension and the harnesses run the identical code.
//
// THE CLIFF IS GONE. `cutRetrieved` and the `vectorCutoff` modes (elbow / dropoff) cut a score curve for
// relevance — first over the retrieval ranking, then, from 2026-08, over the layout ranking. Nothing ever
// graded the second placement: every figure that chose 'elbow' at 1.5 was measured on the retrieval
// ranking, where the gap between adjacent rows is one signal's spread rather than an
// eligibility-normalised fusion of three, so none of it transferred. Removed rather than left running at
// unmeasured defaults, because a relevance cut nobody can defend also confounds every measurement of the
// stage it sits in. Stage 4 now makes two decisions, not three: how many (the entry maxes) and how much
// (the token budget). The relevance decision returns when there is something to grade it with.

/**
 * The order the budget walks: constants, then armed stickies, then the dynamic block in retention order.
 *
 * CONSTANT LEADS, because constant means always. A constant should only be cut when constants ALONE
 * exceed the budget — anything else is a world rule losing its place to an entry that persists from an
 * earlier turn, which is a surprise no author asked for. The previous order put sticky first and nothing
 * argued for it; it was incidental.
 *
 * Walking both classes first is what makes every cap in applyBudget a PREFIX cut: once the dynamic count
 * is used up there is nothing but dynamic entries left to reject.
 *
 * @param {object} blocks The three activation classes
 * @param {Array<object>} blocks.sticky Armed stickies, authored order
 * @param {Array<object>} blocks.constant Constants, authored order
 * @param {Array<object>} blocks.results The dynamic block, retention order
 * @returns {Array<object>} Budget walk order
 */
export function walkOrder({ sticky = [], constant = [], results = [] }) {
    return [...constant, ...sticky, ...results];
}

/**
 * The `ignoreBudget` the AUTHOR set, which is not the one core is shown.
 *
 * WA's budget supersedes core's, and that is not a preference core can be asked to honour: core's
 * budget loop runs before WA is ever called and DROPS the entries it cuts, so a core budget smaller
 * than WA's silently caps WA's — the shipped 25% default against WA's 40% made any WA ceiling above
 * 25% inoperative. onEntriesLoaded therefore tells core every entry is exempt, so its loop never
 * cuts, and applyBudget does the cutting on the ranked layout instead.
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
 * `ranked` must walk stickies and constants first, which makes every cap a prefix cut:
 * once the dynamic count is used up there is nothing but dynamic entries left to reject.
 * Leaving maxTotal at 0 is what guarantees an always-on entry is never dropped.
 *
 * Entries marked ignoreBudget are outside the budgeted population entirely — neither
 * capped nor counted — so the entry caps read as "this many on top of the mandatory
 * ones". They do still spend tokens; see the note at the accounting.
 *
 * @param {object} args Budget arguments
 * @returns {Promise<{survivors: Set, counted: number, dropped: number, budgeted: number, inPrompt: number}>}
 */
export async function applyBudget({ ranked, isDynamic, maxTokens, maxTotal, maxDynamic, maxVectorEntries = 0, isVector = () => false, tokensOf, capOf = () => 0, exemptIsBudgeted = false, slack = 0, slackOnce = true }) {
    const survivors = new Set();
    let counted = 0;
    let dynamic = 0;
    let vector = 0;
    // Per-book quota: a ceiling on how many dynamic entries each book may contribute, so a
    // relevance flood in one book can't crowd the others out. Counts dynamic only — a book's
    // constants are always-on and not subject to it, same as maxDynamic.
    const perWorld = new Map();
    // budgeted: tokens the caps enforce against. inPrompt: tokens actually reaching the
    // prompt. They diverge when exempt entries are not budgeted, and conflating them is
    // how a cap ends up reporting a ceiling the prompt has already gone through.
    //
    // Deliberately no spend/charge/cost vocabulary here: the only thing that literally
    // costs anything is the API call, and these numbers are not that. They count World
    // Info tokens only — no chat, system prompt, persona or examples.
    let budgeted = 0;
    let inPrompt = 0;
    let slackSpent = false;
    let lastAdmitted = -1;
    let index = -1;
    const skipped = [];

    const ceiling = maxTokens > 0 ? maxTokens * (1 + slack) : 0;

    for (const item of ranked) {
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
        // Retrieval's own ceiling, inside the dynamic block. Nested rather than parallel: a vector entry
        // is a dynamic entry, so maxDynamic still binds first when it is the tighter of the two. Guarded
        // on isDynamic here too, not just at the increment below — isVector reads the entry's own
        // vectorized flag, and a constant can be vectorized, so vector ⊆ dynamic has to be enforced at
        // the block rather than assumed of the caller's predicate.
        if (maxVectorEntries > 0 && isDynamic(item) && isVector(item) && vector >= maxVectorEntries) {
            blockedBy.push({ cap: 'vector', shortfall: 1 });
        }
        const bookCap = capOf(item);
        if (bookCap > 0 && isDynamic(item) && (perWorld.get(item.entry?.world) ?? 0) >= bookCap) {
            blockedBy.push({ cap: 'book', shortfall: 1, world: item.entry?.world, limit: bookCap });
        }

        // Skip rather than stop. An entry too big for the remaining tokens shouldn't
        // bar the smaller ones behind it, and stopping early would mean an entry marked
        // ignoreBudget never gets reached — which is the one thing that flag promises.
        if (blockedBy.length && !exempt) {
            skipped.push({ item, tokens: itemTokens, blockedBy, index });
            continue;
        }

        // An entry that can't be cut isn't part of the population being budgeted, so it
        // stays out of the denominator too. Counting it would mean 10 ignoreBudget
        // entries against a cap of 10 silently returns zero retrieval results — a total
        // failure whose cause is a flag on ten unrelated entries. Not counting it means
        // you asked for 10 and got 20, which is visible and proportional.
        //
        // TOKENS FOLLOW THE SAME RULE, and the default is off for the same reason. maxTokens is a COST
        // GUARD, not a limit anything downstream enforces — nothing rejects a prompt for exceeding it. So
        // charging a mandatory entry against it means marking ten entries exempt silently collapses
        // retrieval while the cost stays flat, which is the failure the paragraph above refuses on the
        // count caps. Free means the cost rises by exactly what was marked mandatory: visible and
        // proportional. maxTokensIncludesExempt turns it back on for a book whose exempt entries could
        // overrun the context by themselves, which is the one case where a ceiling beats an honest bill.
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
                if (isVector(item)) {
                    vector += 1;
                }
                perWorld.set(item.entry?.world, (perWorld.get(item.entry?.world) ?? 0) + 1);
            }
        }

        survivors.add(item);
        lastAdmitted = index;
    }

    // Two different situations wear the same rejection. If something was admitted after
    // an entry was rejected, the budget still had usable room and that entry simply did
    // not fit — shortening it would work. If nothing after it got in, it is the tail of
    // an exhausted budget, where per-entry advice is noise and only the cap matters.
    for (const skip of skipped) {
        skip.tail = skip.index > lastAdmitted;
    }

    return { survivors, counted, skipped, dropped: ranked.length - survivors.size, budgeted, inPrompt };
}
