// Guards planUidReindex — the pure planner behind Lorebook Studio's advanced reorder (shift-click
// Renumber), which rebuilds data.entries with new UIDs. It's the one destructive path in Studio, so a
// botched index/collision check here would clobber entries. Slices the function straight out of
// studio.mjs source (that module imports ST + DOM, so it only loads in a browser) and runs it on tiny
// synthetic books. ponytail: string-slice, not an import — promote planUidReindex to a pure module if
// a second harness ever needs it.
// Run: node bulk-reorder-check.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../extension/studio.mjs', import.meta.url), 'utf8');
const slice = name => { const i = src.indexOf(`function ${name}`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const planUidReindex = new Function(slice('planUidReindex') + '; return planUidReindex;')();

// A 5-entry book at uids 0..4; select uids [1,3,4] (already in on-screen/ascending order).
const entries = Object.fromEntries([0, 1, 2, 3, 4].map(u => [u, { uid: u }]));

// Ascending into a free block [10,12]: top (uid 1) -> 10, then 11, 12. No collision.
const asc = planUidReindex(entries, [1, 3, 4], 10, false);
assert.deepStrictEqual(asc.moves, [[1, 10], [3, 11], [4, 12]], 'ascending fills [start, start+N-1] top-down');

// Descending: top gets the highest value in the block.
const desc = planUidReindex(entries, [1, 3, 4], 10, true);
assert.deepStrictEqual(desc.moves, [[1, 12], [3, 11], [4, 10]], 'descending puts the block max on top');

// Selecting a block onto its own current uids is a no-op-safe identity (each target is a selected uid).
const selfBlock = planUidReindex(entries, [2, 3, 4], 2, false);
assert.deepStrictEqual(selfBlock.moves, [[2, 2], [3, 3], [4, 4]], 'targets that are themselves selected are not conflicts');

// Collision: target range [2,4] includes uid 2, which is unselected -> abort, no moves.
const clash = planUidReindex(entries, [1, 3], 2, false);
assert.strictEqual(clash.conflict, 2, 'a target uid held by an unselected entry is reported as a conflict');
assert.ok(!clash.moves, 'a conflict returns no move plan (caller aborts, nothing mutated)');

// Collision at uid 0 must still trip (0 is falsy — guards against a `!conflict` style bug in callers).
const clashZero = planUidReindex(entries, [1], 0, false);
assert.strictEqual(clashZero.conflict, 0, 'uid 0 collision is detected, not swallowed by falsiness');

console.log('bulk-reorder-check: ok');
