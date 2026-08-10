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
export async function applyBudget({ ranked, isDynamic, maxTokens, maxTotal, maxDynamic, tokensOf, capOf = () => 0, exemptIsBudgeted = true, slack = 0, slackOnce = true }) {
    const survivors = new Set();
    let counted = 0;
    let dynamic = 0;
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
