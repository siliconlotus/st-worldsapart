// selection.mjs — entry selection: how many retrieved entries survive the cut. The cutoff decides the
// size of the surviving prefix of a fused ranking (count / elbow / dropoff). Pure; the cutoff settings
// are injected, so the extension and the elbow harness run the identical code (no more string-slicing).

/**
 * The cliff: how much of a ranking's head survives.
 *
 * STAGE 4, over the dynamic block of the LAYOUT ranking (see cutDynamic). It ran at stage 1 over the
 * retrieval ranking until 2026-08, which is why every measurement that once lived here is gone rather
 * than moved — they graded a different population.
 *
 * 'off' keeps the head whole and lets the caps decide. The two cliff modes cut at a drop in fused
 * score, so a scene with three strong matches admits three and one with twelve admits twelve. It takes
 * no count: a flat distribution has no cliff and survives whole, and how many of those rows ship is the
 * entry maxes' question, one cut later. They differ only in how big
 * a gap counts as a cliff:
 *   'elbow'   — relative to the MEAN gap (elbowSensitivity × mean). Adapts per query but shifts with
 *               the window, since the mean depends on what is in it.
 *   'dropoff' — a FIXED fraction of the top score (dropoffThreshold × head[0]). Comparable across
 *               queries because RRF bounds the score band, and window-independent where the mean is not.
 *
 * Both cut at the LAST significant gap, not the largest. A decaying score curve often has several
 * cliffs; the largest is usually the earliest, and cutting there discards whole clusters of near-tied
 * entries that sit below it. The largest gap only wins when it is also the last.
 *
 * The search starts at minVectorEntries: the biggest gap in a good ranking is very often the one
 * between rank 1 and rank 2, and cutting there would return a single entry every time.
 *
 * Any mode that is not a cliff mode passes through, so a stored setting that outlives a rename degrades
 * to 'off' rather than throwing.
 *
 * @param {Array<{fused: number}>} ranked Fused ranking, best first
 * @param {object} cfg Cutoff settings (from settings())
 * @param {string} cfg.mode vectorCutoff — 'off' | 'elbow' | 'dropoff'
 * @param {number} cfg.minVectorEntries Floor the cliff search starts at
 * @param {number} cfg.elbowSensitivity Cliff = elbowSensitivity × mean gap (elbow mode)
 * @param {number} cfg.dropoffThreshold Cliff = dropoffThreshold × top score (dropoff mode)
 * @returns {Array<{fused: number}>} The surviving prefix
 */
export function cutRetrieved(ranked, { mode = 'off', minVectorEntries = 1, elbowSensitivity = 1.5, dropoffThreshold = 0.06 } = {}) {
    const head = ranked.slice();

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

/**
 * Stage 4's first cut: the cliff, over the dynamic block, ahead of the budget.
 *
 * THREE CUTS AT STAGE 4, EACH ANSWERING ONE QUESTION. The cliff decides relevance; the entry maxes
 * decide how many; the token budget decides how much. The cliff therefore takes no count and runs
 * unconditionally — an irrelevant entry should not reach the prompt whether or not there was room for it,
 * and a flat ranking with no cliff survives whole for the entry maxes to bound.
 *
 * STICKY AND CONSTANT ARE NOT IN THE POPULATION. The budget may cut a constant for capacity; the cliff
 * may not cut it for relevance, because marking an entry constant is that judgement already made. They
 * also score low by ELIGIBILITY rather than by irrelevance — a constant has no vector signal and often
 * no keys — so including them would both cut them immediately and distort the mean gap the elbow reads.
 *
 * `results` must already be in retention order, so the cliff reads the order the budget walks.
 *
 * @param {object} blocks The three activation classes
 * @param {Array<{fused: number}>} blocks.sticky Armed stickies, authored order
 * @param {Array<{fused: number}>} blocks.constant Constants, authored order
 * @param {Array<{fused: number}>} blocks.results The dynamic block, retention order
 * @param {object} cfg Cutoff settings, as cutRetrieved takes them
 * @returns {{ranked: Array<object>, dropped: Array<object>}} Budget walk order, and the cliff's losers
 */
export function cutDynamic({ sticky = [], constant = [], results = [] }, cfg = {}) {
    const kept = cutRetrieved(results, cfg);
    const keptSet = new Set(kept);
    return {
        ranked: [...sticky, ...constant, ...kept],
        dropped: results.filter(item => !keptSet.has(item)),
    };
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
export async function applyBudget({ ranked, isDynamic, maxTokens, maxTotal, maxDynamic, maxVectorEntries = 0, isVector = () => false, tokensOf, capOf = () => 0, exemptIsBudgeted = true, slack = 0, slackOnce = true }) {
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
        // on isDynamic here too, not just at the increment below — isVector is provenance (retrieval
        // returned this entry), and a constant can be vectorized and still show up in that provenance,
        // so vector ⊆ dynamic has to be enforced at the block rather than assumed of the caller's predicate.
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
        // Tokens are the exception by default: they are a real resource with a real
        // consequence, so a mandatory entry's tokens still come off the top and squeeze
        // what fits below. Turning that off makes exemption total.
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
