// layout.mjs — STAGE 3's product: the LAYOUT ORDER. Classifies every activated row into the three
// blocks the budget walks (constant, armed sticky, dynamic) and orders each one.
//
// POSITION MEANS SOMETHING HERE, which is why this is an order and not merely a list: stage 5 takes a
// PREFIX of it, so a row's place decides whether it survives the caps. Whether a row BELONGS is stage 4
// (selection.mjs); what FITS is stage 5 (delivery.mjs). This file judges neither — it only arranges.
//
// EVERY INPUT IS A PARAMETER. The signals are already on the rows, and everything else arrives as plain
// data: the caller resolves ST's chat-sentinel book names and reads the settings, so this runs under
// node against literal rows. It was 70 lines inside onScanDone with no check of its own.
import { SORT_FNS, normPresentation, reconcileTiers, tierRank } from './sort.mjs';

/**
 * The quantity the layout is ordered by: stage 4's `E[credit]`.
 *
 * AN UNSCORED ROW SORTS BELOW EVERY SCORED ONE rather than beside them at 0. A missing score means the
 * model file did not load or the row is not in a fitted tier, which is not the claim "predicted
 * irrelevant" — and authored order is what remains to order those by.
 */
export const layoutScore = it => (Number.isFinite(it.eCredit) ? it.eCredit : -1);

/**
 * The three blocks the budget walks, each ordered.
 *
 * CLASSIFICATION IS BY WHAT AN ENTRY IS, not by how it got here: a constant that also matched keywords
 * is a durable row, not a retrieval result. Constants and armed stickies are in the prompt by intent,
 * so they are ordered by authored order alone and never by relevance.
 *
 * THE DYNAMIC BLOCK'S ORDER IS THE PRIORITY MODE'S. `sequential` makes book tier the primary key, so a
 * lower book only gets the slots higher books leave; `interleaved` scales the layout score by each
 * book's weight, so a strong entry in a low book can still outrank a weak one in a high book. Both
 * fall back to authored order, which is what keeps ties deterministic.
 *
 * @param {object[]} items Activated rows, each `{ entry, eCredit? }`
 * @param {object} cfg
 * @param {(entry: object) => boolean} cfg.isArmedSticky Whether ST's timed effect is armed for this entry
 * @param {Array<{name: string, weight?: number, offset?: number, cap?: number}>} cfg.priorityList
 *        Book priority in saved order, names ALREADY RESOLVED by the caller (the chat sentinel is ST's)
 * @param {'sequential'|'interleaved'} cfg.priorityMode
 * @param {string} cfg.presentationOrder Insertion-order key, from the shared sort vocabulary
 * @param {boolean} cfg.presentationTiered Group by tier before the base order
 * @param {object} cfg.tierCfg Tier configuration, reconciled by the caller or here
 * @returns {{sticky: object[], constant: object[], results: object[], compare: Function, bookTierOf: Function}}
 */
export function layoutOrder(items, { isArmedSticky, priorityList = [], priorityMode, presentationOrder, presentationTiered = false, tierCfg }) {
    const sticky = [], constant = [], results = [];
    for (const item of items ?? []) {
        if (isArmedSticky?.(item.entry)) sticky.push(item);
        else if (item.entry?.constant) constant.push(item);
        else results.push(item);
    }

    // Books contributing rows to THIS scan. A book left over from another chat can neither occupy a
    // tier nor shift the ones actually present, so the tier index is scoped to what is here.
    const scanWorlds = new Set(items?.map(it => it.entry?.world));
    const cfgByName = new Map(priorityList.filter(w => w?.name).map(w => [w.name, w]));
    const cfgOf = name => cfgByName.get(name) ?? { weight: 1, offset: 0, cap: 0 };
    const priorityOrder = [...cfgByName.keys()].filter(name => scanWorlds.has(name));
    // The book's tier INDEX in the scan-scoped priority order — a rank, since a lower index outranks a
    // higher one. Named apart from sort.mjs `tierRank`, which tiers an ENTRY, not a book.
    const bookTierOf = world => { const i = priorityOrder.indexOf(world); return i < 0 ? priorityOrder.length : i; };

    // Interleaved mode's per-book offset rides on the authored order, so it threads through every
    // comparator consistently. Sequential ignores the offset — it groups by book tier instead.
    const orderOf = it => it.entry.waOriginalOrder + (priorityMode === 'sequential' ? 0 : (cfgOf(it.entry.world).offset ?? 0));
    const authored = (a, b) => orderOf(a) - orderOf(b);

    // Insertion order draws from the shared sort vocabulary, same as the Studio. Order asc/desc keep the
    // offset-aware `authored` rather than plain SORT_FNS['order-*']; relevance (best-first/last) reads
    // the layout score; everything else adapts SORT_FNS over the entry, falling back to authored within
    // equal keys so ties stay deterministic.
    const orderKey = normPresentation(presentationOrder);
    const baseCompare =
        orderKey === 'order-asc' ? authored :
        orderKey === 'order-desc' ? (a, b) => -authored(a, b) :
        orderKey === 'best-first' ? (a, b) => (layoutScore(b) - layoutScore(a)) || authored(a, b) :
        orderKey === 'best-last' ? (a, b) => (layoutScore(a) - layoutScore(b)) || authored(a, b) :
        SORT_FNS[orderKey] ? (a, b) => SORT_FNS[orderKey](a.entry, b.entry) || authored(a, b) :
        authored;

    // Optional tiered grouping: tier first, base order within. Disabled entries never activate, so that
    // tier is inert here.
    const cfg = reconcileTiers(tierCfg);
    const compare = presentationTiered
        ? (a, b) => (tierRank(a.entry, cfg) - tierRank(b.entry, cfg)) || baseCompare(a, b)
        : baseCompare;

    if (priorityMode === 'sequential') {
        results.sort((a, b) => (bookTierOf(a.entry.world) - bookTierOf(b.entry.world)) || (layoutScore(b) - layoutScore(a)) || authored(a, b));
    } else {
        results.sort((a, b) => (layoutScore(b) * (cfgOf(b.entry.world).weight ?? 1) - layoutScore(a) * (cfgOf(a.entry.world).weight ?? 1)) || authored(a, b));
    }
    sticky.sort(authored);
    constant.sort(authored);
    // `compare` and `bookTierOf` ride out because the PROMPT order — a third ordering, the user's sort
    // over whatever survived — is built from the same comparators after stage 5 has cut.
    return { sticky, constant, results, compare, bookTierOf };
}
