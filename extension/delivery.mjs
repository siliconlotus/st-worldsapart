// delivery.mjs — stage 5: what fits, and in what order the budget walks. Pure; every setting is injected.

/** The budget's walk order: constants, armed stickies, promoted, then the dynamic block — durable first is what makes every cap in applyBudget a prefix cut. */
export function walkOrder({ sticky = [], constant = [], promoted = [], results = [] }) {
    return [...constant, ...sticky, ...promoted, ...results];
}

/** The `ignoreBudget` the author set. `??`, not `||`: a stashed `false` must beat the `true` onEntriesLoaded hands core. */
export const authorIgnoreBudget = entry => Boolean(entry?.waIgnoreBudget ?? entry?.ignoreBudget);

/**
 * Applies the entry caps and the token budget to `walk`, which must lead with the durable blocks. The populations
 * nest (vector ⊆ capped ⊆ all, plus per-book); any cap at 0 is off; ignoreBudget entries are neither capped nor counted.
 * @returns {Promise<{survivors: Set, counted: number, dynamic: number, vector: number, skipped: object[], dropped: number, budgeted: number, inPrompt: number}>}
 */
export async function applyBudget({ walk, isDynamic, isCapped = isDynamic, maxTokens, maxTotal, maxDynamic, maxVectorEntries = 0, isVector = () => false, tokensOf, capOf = () => 0, exemptIsBudgeted = false, slack = 0, slackOnce = true }) {
    const survivors = new Set();
    let counted = 0;
    let dynamic = 0;
    let vector = 0;
    const perWorld = new Map();
    // `budgeted` is what the caps enforce against, `inPrompt` what reaches the prompt; they diverge when exempt entries are not budgeted.
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

        const pastBudget = maxTokens > 0 && budgeted + itemTokens > maxTokens;
        const rescuable = pastBudget
            && slack > 0
            && budgeted + itemTokens <= ceiling
            && !(slackOnce && slackSpent);

        const blockedBy = [];

        if (pastBudget && !rescuable) {
            blockedBy.push({
                cap: 'tokens',
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
        // `isCapped`, never `isDynamic`: the two differ by exactly the promoted block, and a constant can be vectorized.
        if (maxVectorEntries > 0 && isCapped(item) && isVector(item) && vector >= maxVectorEntries) {
            blockedBy.push({ cap: 'vector', shortfall: 1 });
        }
        const bookCap = capOf(item);
        if (bookCap > 0 && isCapped(item) && (perWorld.get(item.entry?.world) ?? 0) >= bookCap) {
            blockedBy.push({ cap: 'book', shortfall: 1, world: item.entry?.world, limit: bookCap });
        }

        // Skip rather than stop, or an ignoreBudget entry behind an oversized one is never reached.
        if (blockedBy.length && !exempt) {
            skipped.push({ item, tokens: itemTokens, blockedBy, index });
            continue;
        }

        // Only a row that charges the budget can spend the slack; an exempt one adds nothing to `budgeted` to be rescued from.
        if (rescuable && (!exempt || exemptIsBudgeted)) {
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

    // `tail`: nothing was admitted after it, so it is the end of an exhausted budget rather than one oversized entry.
    for (const skip of skipped) {
        skip.tail = skip.index > lastAdmitted;
    }

    return { survivors, counted, dynamic, vector, skipped, dropped: walk.length - survivors.size, budgeted, inPrompt };
}
