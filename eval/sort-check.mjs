// sort-check — the canonical grading-table order, pinned.
//
// gradeOrder decides what a human is shown first in /wa-grade and /wa-super-grade, which decides which
// rows get graded carefully and which get graded tired. It lived inside worldsapart.js, where nothing
// could reach it: the ST-coupled half can't be imported under node, so the only way to check it was a
// re-derived copy, which CLAUDE.md rules out as a slice rather than a test of shipped code. It is in
// sort.mjs — pure, no imports — so this exercises the function the graders actually call.
import { gradeOrder } from '../extension/sort.mjs';
import { eq } from './metrics.mjs';

// One row per class, deliberately in the order onScanDone hands them over: the budget walk hoists
// always-on entries to the front, so capture order puts the two rows a grader least needs FIRST.
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

// A sticky scoring 0.90 outranks every dynamic row on score alone. It still sorts BELOW them, because the
// block is decided before the rank — which is the whole reason this is not a plain sort.
eq(byScore.findIndex(x => x.row.t === 'stickyOld') > byScore.findIndex(x => x.row.t === 'dynLow'), true,
    'block beats rank: a high-scoring persisting sticky still sits under the weakest gradeable row');

// An unscored gradeable row sinks WITHIN its block rather than leaving it. Absent is not a low score, but
// it is also not a reason to promote a row a grader cannot rank.
eq(byScore.map(x => x.row.t).indexOf('dynNull'), 2, 'a null score sinks inside its own block, not out of it');

// The index is the capture index, not the display position. Every data-i in both grading tables indexes
// back into the capture-ordered rows/entries arrays, so returning display positions would misattribute
// every grade to the wrong entry — silently, and in a way no green suite would catch.
eq(byScore.map(x => x.i).join(','), '3,2,4,1,0', 'pairs carry the original capture index');
eq(byScore.every(x => rows[x.i] === x.row), true, 'the carried index still resolves to its own row');

// Degenerate inputs: the graders call this before checking whether there is anything to show.
eq(gradeOrder([], () => 0).length, 0, 'no rows sorts to no rows');
eq(gradeOrder(undefined, () => 0).length, 0, 'a missing row list is empty, not a throw');
// An unknown block sorts as gradeable rather than vanishing — a row whose class the capture didn't record
// is still a row somebody has to look at.
eq(gradeOrder([{ block: undefined, score: 1 }], r => -(r.score ?? 0))[0].i, 0, 'an unclassified row sorts with the gradeable block');

// A PROMOTED ROW SORTS WITH THE DYNAMIC ONES, not with the scaffolding. Both are this turn's
// activations and both are graded (`isDurable`), so a grader should meet them interleaved by score
// rather than find them parked below the constants where the rows nobody grades sit.
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
