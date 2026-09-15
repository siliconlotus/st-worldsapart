// Guards planUidReindex, the planner behind Lorebook Studio's Renumber and its one destructive path.
import assert from 'node:assert';
import { planUidReindex } from '../extension/keyedit.mjs';

const entries = Object.fromEntries([0, 1, 2, 3, 4].map(u => [u, { uid: u }]));

const asc = planUidReindex(entries, [1, 3, 4], 10, false);
assert.deepStrictEqual(asc.moves, [[1, 10], [3, 11], [4, 12]], 'ascending fills [start, start+N-1] top-down');

const desc = planUidReindex(entries, [1, 3, 4], 10, true);
assert.deepStrictEqual(desc.moves, [[1, 12], [3, 11], [4, 10]], 'descending puts the block max on top');

const selfBlock = planUidReindex(entries, [2, 3, 4], 2, false);
assert.deepStrictEqual(selfBlock.moves, [[2, 2], [3, 3], [4, 4]], 'targets that are themselves selected are not conflicts');

const clash = planUidReindex(entries, [1, 3], 2, false);
assert.strictEqual(clash.conflict, 2, 'a target uid held by an unselected entry is reported as a conflict');
assert.ok(!clash.moves, 'a conflict returns no move plan (caller aborts, nothing mutated)');

const clashZero = planUidReindex(entries, [1], 0, false);
assert.strictEqual(clashZero.conflict, 0, 'uid 0 collision is detected, not swallowed by falsiness');

console.log('bulk-reorder-check: ok');
