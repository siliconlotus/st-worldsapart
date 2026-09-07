// layout.mjs — stage 3's product: the layout order. Classifies activated rows into the four blocks the
// budget walks and orders each. Pure: settings and resolved book names arrive as parameters
// (eval/layout-check.mjs).
import { SORT_FNS, normPresentation, reconcileTiers, tierRank } from './sort.mjs';

/** Stage 4's E[credit]; an unscored row sorts below every scored one, then by authored order. */
export const layoutScore = it => (Number.isFinite(it.eCredit) ? it.eCredit : -1);

/**
 * The four blocks the budget walks, each ordered. Classification is by what an entry is: a constant
 * that also matched keywords is a constant. Durable blocks sort by authored order alone; promoted takes
 * the dynamic comparator, since the declaration says the row belongs, not where it sits. `sequential`
 * makes book tier the primary key; `interleaved` scales the score by book weight.
 *
 * @param {object[]} items Activated rows `{ entry, eCredit? }`
 * @param {Array<{name: string, weight?: number, offset?: number, cap?: number}>} cfg.priorityList
 *        Saved order; names already resolved by the caller
 * @param {'sequential'|'interleaved'} cfg.priorityMode
 * @returns {{sticky: object[], constant: object[], promoted: object[], results: object[], compare: Function, bookTierOf: Function}}
 */
export function layoutOrder(items, { isArmedSticky, isPromoted, priorityList = [], priorityMode, presentationOrder, presentationTiered = false, tierCfg }) {
    const sticky = [], constant = [], promoted = [], results = [];
    for (const item of items ?? []) {
        // Durable first: a promoted constant is a constant.
        if (isArmedSticky?.(item.entry)) sticky.push(item);
        else if (item.entry?.constant) constant.push(item);
        else if (isPromoted?.(item.entry)) promoted.push(item);
        else results.push(item);
    }

    // The tier index is scoped to the books in this scan.
    const scanWorlds = new Set(items?.map(it => it.entry?.world));
    const cfgByName = new Map(priorityList.filter(w => w?.name).map(w => [w.name, w]));
    const cfgOf = name => cfgByName.get(name) ?? { weight: 1, offset: 0, cap: 0 };
    const priorityOrder = [...cfgByName.keys()].filter(name => scanWorlds.has(name));
    const bookTierOf = world => { const i = priorityOrder.indexOf(world); return i < 0 ? priorityOrder.length : i; };

    // Interleaved mode's per-book offset rides on authored order; sequential groups by tier instead.
    const orderOf = it => it.entry.waOriginalOrder + (priorityMode === 'sequential' ? 0 : (cfgOf(it.entry.world).offset ?? 0));
    const authored = (a, b) => orderOf(a) - orderOf(b);

    // Insertion order from the shared sort vocabulary; ties fall back to authored order.
    const orderKey = normPresentation(presentationOrder);
    const baseCompare =
        orderKey === 'order-asc' ? authored :
        orderKey === 'order-desc' ? (a, b) => -authored(a, b) :
        orderKey === 'best-first' ? (a, b) => (layoutScore(b) - layoutScore(a)) || authored(a, b) :
        orderKey === 'best-last' ? (a, b) => (layoutScore(a) - layoutScore(b)) || authored(a, b) :
        SORT_FNS[orderKey] ? (a, b) => SORT_FNS[orderKey](a.entry, b.entry) || authored(a, b) :
        authored;

    const cfg = reconcileTiers(tierCfg);
    const compare = presentationTiered
        ? (a, b) => (tierRank(a.entry, cfg) - tierRank(b.entry, cfg)) || baseCompare(a, b)
        : baseCompare;

    // One comparator for both scored blocks, so a promoted row's place depends on the entry, not the exemption.
    const byRelevance = priorityMode === 'sequential'
        ? (a, b) => (bookTierOf(a.entry.world) - bookTierOf(b.entry.world)) || (layoutScore(b) - layoutScore(a)) || authored(a, b)
        : (a, b) => (layoutScore(b) * (cfgOf(b.entry.world).weight ?? 1) - layoutScore(a) * (cfgOf(a.entry.world).weight ?? 1)) || authored(a, b);
    results.sort(byRelevance);
    promoted.sort(byRelevance);
    sticky.sort(authored);
    constant.sort(authored);
    return { sticky, constant, promoted, results, compare, bookTierOf };
}
