/**
 * Mirrors the chat-sentinel logic from worldsapart.js (charPriority/ensureWorldConfigs/
 * resolvedName). The real functions depend on ST globals, so this re-implements just the
 * pure invariant: the per-character order is stable across branches that bind a DIFFERENT
 * chat book, because the chat slot is stored as the sentinel 'chat', not by name.
 *
 * Run: node wa-priority-check.mjs
 */
import assert from 'node:assert';

const resolvedName = (entry, chatBook) => (entry.world === 'chat' ? chatBook : entry.world);

// The insertion half of ensureWorldConfigs: add attached books not already present, storing
// whichever equals the current chat book as the 'chat' sentinel.
function ensure(list, attached, chatBook) {
    const known = new Set(list.map(w => resolvedName(w, chatBook)).filter(Boolean));
    for (const w of attached) {
        if (w == null || known.has(w)) continue;
        list.push({ world: w === chatBook ? 'chat' : w, weight: 1, offset: 0, cap: 0 });
    }
    return list;
}

// The engine's resolved order for a given chat book (chat sentinel → live book).
const orderNames = (list, chatBook) => list.map(w => resolvedName(w, chatBook)).filter(Boolean);

// --- Branch A: character opened in a chat bound to "storyA" ---
const list = [];
ensure(list, ['global1', 'charBook', 'storyA'], 'storyA');
assert.deepStrictEqual(orderNames(list, 'storyA'), ['global1', 'charBook', 'storyA']);
assert.ok(list.some(w => w.world === 'chat'), 'chat book stored as sentinel, not by name');
assert.ok(!list.some(w => w.world === 'storyA'), 'chat book never stored by its real name');

// --- Branch B: same character, new branch bound to a DIFFERENT book "storyB" ---
// Same stored list (per-character, survives the branch). No new row appended; the chat slot
// simply resolves to storyB now.
const before = JSON.stringify(list);
ensure(list, ['global1', 'charBook', 'storyB'], 'storyB');
assert.strictEqual(JSON.stringify(list), before, 'a different chat book must NOT append a row');
assert.deepStrictEqual(orderNames(list, 'storyB'), ['global1', 'charBook', 'storyB'],
    'order is identical across branches, chat slot follows the live book');

// --- A hand-reorder is preserved across branches too ---
[list[0], list[2]] = [list[2], list[0]]; // move chat slot to the front
assert.deepStrictEqual(orderNames(list, 'storyA'), ['storyA', 'charBook', 'global1']);
assert.deepStrictEqual(orderNames(list, 'storyB'), ['storyB', 'charBook', 'global1']);

console.log('wa-priority-check: OK');
