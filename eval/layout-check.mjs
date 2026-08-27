// Guards STAGE 3's product, the layout order (extension/layout.mjs). Every input is a parameter, so
// this runs on literal rows with no ST and no corpus — which is the point of the module existing: the
// ordering lived inside rankActivated and could not be checked at all.
// Run: node layout-check.mjs
import { layoutOrder, layoutScore } from '../extension/layout.mjs';

let fails = 0;
const eq = (got, want, what) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fails++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? `: ${JSON.stringify(got)}` : `: ${JSON.stringify(got)} (want ${JSON.stringify(want)})`}`);
};

const row = (uid, over = {}) => ({
    eCredit: over.eCredit,
    entry: { uid, world: over.world ?? 'A', waOriginalOrder: over.order ?? uid, constant: !!over.constant, ...over.entry },
});
const uids = xs => xs.map(x => x.entry.uid);
const BASE = { isArmedSticky: () => false, priorityMode: 'interleaved', presentationOrder: 'order-asc', tierCfg: {} };

// --- the score ------------------------------------------------------------------------------------
eq(layoutScore({ eCredit: 0.4 }), 0.4, 'the layout score is E[credit]');
eq(layoutScore({}), -1, 'an unscored row sorts below every scored one, not beside them at 0');
eq(layoutScore({ eCredit: 0 }), 0, '...and a genuine 0 is not treated as unscored');

// --- classification -------------------------------------------------------------------------------
{
    const items = [row(1), row(2, { constant: true }), row(3)];
    const armed = new Set([3]);
    const { sticky, constant, results } = layoutOrder(items, { ...BASE, isArmedSticky: e => armed.has(e.uid) });
    eq([uids(constant), uids(sticky), uids(results)], [[2], [3], [1]], 'each row lands in exactly one block');
}
{
    // A constant that also matched keywords is a durable row, not a retrieval result.
    const { constant, results } = layoutOrder([row(1, { constant: true, eCredit: 0.9 })], BASE);
    eq([uids(constant), uids(results)], [[1], []], 'a constant is durable however it activated');
    // Armed sticky wins over constant: it is checked first, as the runtime checks it first.
    const both = layoutOrder([row(1, { constant: true })], { ...BASE, isArmedSticky: () => true });
    eq([uids(both.sticky), uids(both.constant)], [[1], []], 'an armed sticky classifies as sticky, not constant');
}

// --- the dynamic block's order --------------------------------------------------------------------
{
    const items = [row(1, { eCredit: 0.1 }), row(2, { eCredit: 0.9 }), row(3, { eCredit: 0.5 })];
    const { results } = layoutOrder(items, BASE);
    eq(uids(results), [2, 3, 1], 'interleaved orders the dynamic block by layout score, best first');
}
{
    // Unscored rows go last, and hold authored order among themselves.
    const items = [row(1), row(2, { eCredit: 0.2 }), row(3)];
    eq(uids(layoutOrder(items, BASE).results), [2, 1, 3], 'unscored rows sort last, authored order among them');
}
{
    // Sequential: book tier is the primary key, so a weak entry in a higher book outranks a strong one below.
    const items = [row(1, { world: 'B', eCredit: 0.9 }), row(2, { world: 'A', eCredit: 0.1 })];
    const priorityList = [{ name: 'A' }, { name: 'B' }];
    eq(uids(layoutOrder(items, { ...BASE, priorityMode: 'sequential', priorityList }).results), [2, 1],
        'sequential puts the higher book first regardless of score');
    eq(uids(layoutOrder(items, { ...BASE, priorityList }).results), [1, 2],
        '...where interleaved lets the stronger entry win across books');
}
{
    // Interleaved weights scale the score, so a weight can reverse a modest gap.
    const items = [row(1, { world: 'B', eCredit: 0.5 }), row(2, { world: 'A', eCredit: 0.4 })];
    const priorityList = [{ name: 'A', weight: 2 }, { name: 'B', weight: 1 }];
    eq(uids(layoutOrder(items, { ...BASE, priorityList }).results), [2, 1], 'a book weight scales the layout score');
}
{
    // A book not in this scan cannot occupy a tier or shift the ones present.
    const items = [row(1, { world: 'B' }), row(2, { world: 'C' })];
    const priorityList = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
    eq(uids(layoutOrder(items, { ...BASE, priorityMode: 'sequential', priorityList }).results), [1, 2],
        'an absent book neither occupies a tier nor shifts the present ones');
}

// --- durable blocks are authored-ordered, never scored ---------------------------------------------
{
    const items = [row(1, { constant: true, order: 20, eCredit: 0.9 }), row(2, { constant: true, order: 10, eCredit: 0.1 })];
    eq(uids(layoutOrder(items, BASE).constant), [2, 1], 'constants order by authored order, not by score');
}

// --- offsets ---------------------------------------------------------------------------------------
{
    const items = [row(1, { world: 'A', order: 10 }), row(2, { world: 'B', order: 20 })];
    const priorityList = [{ name: 'A', offset: 100 }, { name: 'B', offset: 0 }];
    const { compare } = layoutOrder(items, { ...BASE, priorityList });
    eq(uids([...items].sort(compare)), [2, 1], 'interleaved applies the per-book offset to authored order');
    const seq = layoutOrder(items, { ...BASE, priorityMode: 'sequential', priorityList });
    eq(uids([...items].sort(seq.compare)), [1, 2], '...and sequential ignores the offset');
}

// --- empties -----------------------------------------------------------------------------------------
{
    const { sticky, constant, results } = layoutOrder([], BASE);
    eq([sticky.length, constant.length, results.length], [0, 0, 0], 'no rows is three empty blocks, not a throw');
    eq(layoutOrder(undefined, BASE).results.length, 0, 'undefined rows is empty too');
}

console.log(fails ? `\n${fails} FAILED` : '\nlayout-check: ok');
process.exit(fails ? 1 : 0);
