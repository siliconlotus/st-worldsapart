// Guards stage 3's product, the layout order (extension/layout.mjs), on literal rows with no ST and no corpus.
import { layoutOrder, layoutScore, weightedCredit } from '../extension/layout.mjs';
import { relevanceCut } from '../extension/selection.mjs';
import { eqDeep as eq } from '../eval/lib/metrics.mjs';


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

// --- term weights: E[credit]'s odds times the author's weight, so an unweighted row is exactly its E[credit]
{
    const odds = p => p / (1 - p);
    eq(weightedCredit({ eCredit: 0.3 }), 0.3, 'no weights: the score is E[credit] itself');
    eq(Number((odds(weightedCredit({ eCredit: 0.3, logWeight: Math.log(2) })) / odds(0.3)).toFixed(9)), 2, '::2 doubles the odds');
    eq(Number(weightedCredit({ eCredit: 0.3, logWeight: Math.log(0.5) }).toFixed(9)), Number((0.15 / 0.85).toFixed(9)), '...and ::0.5 halves them');
    eq(weightedCredit({ eCredit: 1, logWeight: Math.log(9) }), 1, 'a certainty stays one, never past it');
    eq(Number.isNaN(weightedCredit({ eCredit: NaN, logWeight: Math.log(2) })), true, 'an unscored row stays unscored');

    // Two near-identical entries; the author weighted the detail the second one is about.
    const picard = row(1, { eCredit: 0.30 }), janeway = { ...row(2, { eCredit: 0.26 }), logWeight: Math.log(2) };
    eq(uids(layoutOrder([picard, janeway], BASE).results), [2, 1], 'the weighted entry overtakes a higher-credit one in the layout order');
    eq(uids(layoutOrder([picard, row(2, { eCredit: 0.26 })], BASE).results), [1, 2], '...which the unweighted pair keeps in credit order');
    const cut = rows => uids(relevanceCut(rows, { scoreOf: weightedCredit, cutoffOf: () => 0.10 }).kept);
    eq(cut([{ ...row(3, { eCredit: 0.07 }), logWeight: Math.log(2) }]), [3], 'and a weight carries an entry across the cutoff');
    eq(cut([row(3, { eCredit: 0.07 })]), [], '...that the same entry unweighted does not clear');
}

// --- classification -------------------------------------------------------------------------------
{
    const items = [row(1), row(2, { constant: true }), row(3)];
    const armed = new Set([3]);
    const { sticky, constant, results } = layoutOrder(items, { ...BASE, isArmedSticky: e => armed.has(e.uid) });
    eq([uids(constant), uids(sticky), uids(results)], [[2], [3], [1]], 'each row lands in exactly one block');
}
{
    const { constant, results } = layoutOrder([row(1, { constant: true, eCredit: 0.9 })], BASE);
    eq([uids(constant), uids(results)], [[1], []], 'a constant is durable however it activated');
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
    const items = [row(1), row(2, { eCredit: 0.2 }), row(3)];
    eq(uids(layoutOrder(items, BASE).results), [2, 1, 3], 'unscored rows sort last, authored order among them');
}
{
    const items = [row(1, { world: 'B', eCredit: 0.9 }), row(2, { world: 'A', eCredit: 0.1 })];
    const priorityList = [{ name: 'A' }, { name: 'B' }];
    eq(uids(layoutOrder(items, { ...BASE, priorityMode: 'sequential', priorityList }).results), [2, 1],
        'sequential puts the higher book first regardless of score');
    eq(uids(layoutOrder(items, { ...BASE, priorityList }).results), [1, 2],
        '...where interleaved lets the stronger entry win across books');
}
{
    const items = [row(1, { world: 'B', eCredit: 0.5 }), row(2, { world: 'A', eCredit: 0.4 })];
    const priorityList = [{ name: 'A', weight: 2 }, { name: 'B', weight: 1 }];
    eq(uids(layoutOrder(items, { ...BASE, priorityList }).results), [2, 1], 'a book weight scales the layout score');
}
{
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
    const { sticky, constant, promoted, results } = layoutOrder([], BASE);
    eq([sticky.length, constant.length, promoted.length, results.length], [0, 0, 0, 0], 'no rows is four empty blocks, not a throw');
    eq(layoutOrder(undefined, BASE).results.length, 0, 'undefined rows is empty too');
}


// --- the promoted block ---------------------------------------------------------------------------
{
    const P = { ...BASE, isPromoted: e => e.uid >= 10 };
    const rows = [row(1, { eCredit: 0.9 }), row(10, { eCredit: 0.1 }), row(11, { eCredit: 0.5 }), row(2, { eCredit: 0.2 })];
    const out = layoutOrder(rows, P);
    eq(uids(out.promoted), [11, 10], 'promoted rows form their own block, ordered by layout score like the dynamic one');
    eq(uids(out.results), [1, 2], '...and leave the dynamic block, which is what exempts them from the cut');

    const dur = layoutOrder([row(10, { constant: true }), row(11, {})], { ...P, isPromoted: () => true });
    eq(uids(dur.constant), [10], 'a promoted constant stays a constant');
    eq(uids(dur.promoted), [11], '...and only the non-durable row is promoted');

    const st = layoutOrder([row(10, {}), row(11, {})], { ...P, isArmedSticky: e => e.uid === 10, isPromoted: () => true });
    eq(uids(st.sticky), [10], 'an armed sticky outranks promotion');
    eq(uids(st.promoted), [11], '...and the rest promote');

    const none = layoutOrder(rows, BASE);
    eq(uids(none.promoted), [], 'no isPromoted means no promoted block');
    eq(uids(none.results), [1, 11, 2, 10], '...and every non-durable row stays dynamic, in score order');
}

if (process.exitCode !== 1) console.log('\nlayout-check: ok');
