// sort-check — the canonical grading-table order (sort.mjs gradeOrder), what /wa-grade and /wa-super-grade show first.
import { gradeOrder, reconcileTiers, sortTiered } from '../extension/sort.mjs';
import { eq } from '../eval/lib/metrics.mjs';

// One row per class, in the order onScanDone hands them over; do not reorder this fixture.
const rows = [
    { t: 'const',     block: 'constant', score: null, bestRank: 0 },
    { t: 'stickyOld', block: 'sticky',   score: 0.90, bestRank: 1 },
    { t: 'dynLow',    block: 'dynamic',  score: 0.10, bestRank: 5 },
    { t: 'dynHigh',   block: 'dynamic',  score: 0.80, bestRank: 2 },
    { t: 'dynNull',   block: 'dynamic',  score: null, bestRank: 9 },
];

const byScore = gradeOrder(rows, r => -(r.score ?? -Infinity));
const byRank = gradeOrder(rows, r => r.bestRank ?? Infinity);

eq(byScore.map(x => x.row.t).join(','), 'dynHigh,dynLow,dynNull,stickyOld,const',
    '/wa-grade order: gradeable block first by fused score, then sticky, then constant');
eq(byRank.map(x => x.row.t).join(','), 'dynHigh,dynLow,dynNull,stickyOld,const',
    '/wa-super-grade order: same blocks, ranked on bestRank because fused scores are not cross-arm comparable');

eq(byScore.findIndex(x => x.row.t === 'stickyOld') > byScore.findIndex(x => x.row.t === 'dynLow'), true,
    'block beats rank: a high-scoring persisting sticky still sits under the weakest gradeable row');

eq(byScore.map(x => x.row.t).indexOf('dynNull'), 2, 'a null score sinks inside its own block, not out of it');

eq(byScore.map(x => x.i).join(','), '3,2,4,1,0', 'pairs carry the original capture index');
eq(byScore.every(x => rows[x.i] === x.row), true, 'the carried index still resolves to its own row');

eq(gradeOrder([], () => 0).length, 0, 'no rows sorts to no rows');
eq(gradeOrder(undefined, () => 0).length, 0, 'a missing row list is empty, not a throw');
eq(gradeOrder([{ block: undefined, score: 1 }], r => -(r.score ?? 0))[0].i, 0, 'an unclassified row sorts with the gradeable block');

{
    const withProm = [
        { t: 'const',   block: 'constant', score: null },
        { t: 'promHi',  block: 'promoted', score: 0.95 },
        { t: 'dynMid',  block: 'dynamic',  score: 0.50 },
        { t: 'promLo',  block: 'promoted', score: 0.20 },
        { t: 'sticky',  block: 'sticky',   score: 0.99 },
    ];
    eq(gradeOrder(withProm, r => -(r.score ?? -Infinity)).map(x => x.row.t).join(','),
        'promHi,dynMid,promLo,sticky,const',
        'promoted rows interleave with dynamic ones by score; only the durable blocks trail');
}

// --- sortTiered: the Explorer's display order, base sort then tier buckets
const cfg = reconcileTiers([]);   // constant, sticky, keyword, vector, disabled
const ent = (uid, order, o = {}) => ({ uid, order, ...o });
const list = [
    ent(1, 10),                          // keyword
    ent(2, 30, { constant: true }),      // constant
    ent(3, 20, { disable: true }),       // disabled
    ent(4, 40, { sticky: 3 }),           // sticky
    ent(5, 50),                          // keyword
];
eq(sortTiered(list, { sortKey: 'order-asc' }).map(e => e.uid).join(','), '1,3,2,4,5',
    'untiered is the base sort alone');
eq(sortTiered(list, { sortKey: 'order-asc', tiered: true, tierCfg: cfg }).map(e => e.uid).join(','), '2,4,1,5,3',
    'tiered buckets by tierRank, base order kept within each bucket');
eq(sortTiered(list, { sortKey: 'authored', tiered: true, tierCfg: cfg }).map(e => e.uid).join(','), '2,4,1,5,3',
    'a legacy presentation alias resolves through normPresentation');
eq(sortTiered(list, { sortKey: 'best-first', tiered: true, tierCfg: cfg }).map(e => e.uid).join(','), '2,4,1,5,3',
    'a relevance key has no rest-state score and degrades to order-asc');
// Turning a tier off removes its rank, so the entries that would have filled it fall to the next bucket.
const noSticky = cfg.map(t => (t.id === 'sticky' ? { ...t, on: false } : t));
eq(sortTiered(list, { sortKey: 'order-asc', tiered: true, tierCfg: noSticky }).map(e => e.uid).join(','), '2,1,4,5,3',
    'a disabled tier leaves no bucket and its entries sort into the next one that tests');
eq(sortTiered([ent(9, 1, { vectorized: true })], { sortKey: 'order-asc', tiered: true, tierCfg: cfg }).map(e => e.uid).join(','), '9',
    'empty ranks below an occupied one are sparse holes, which flat() skips');
const src = [ent(1, 2), ent(2, 1)];
sortTiered(src, { sortKey: 'order-asc' });
eq(src.map(e => e.uid).join(','), '1,2', 'the caller’s list is not sorted in place');
