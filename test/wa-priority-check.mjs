// Re-implements the chat-sentinel invariant of worldsapart.js ensureWorldConfigs/resolvedName, which import ST: the chat slot is stored as the sentinel 'chat', not by name, so a branch binding a different chat book keeps the order.
import assert from 'node:assert';

const resolvedName = (entry, chatBook) => (entry.world === 'chat' ? chatBook : entry.world);

function ensure(list, attached, chatBook) {
    const known = new Set(list.map(w => resolvedName(w, chatBook)).filter(Boolean));
    for (const w of attached) {
        if (w == null || known.has(w)) continue;
        list.push({ world: w === chatBook ? 'chat' : w, weight: 1, offset: 0, cap: 0 });
    }
    return list;
}

const orderNames = (list, chatBook) => list.map(w => resolvedName(w, chatBook)).filter(Boolean);

// --- Branch A: character opened in a chat bound to "storyA" ---
const list = [];
ensure(list, ['global1', 'charBook', 'storyA'], 'storyA');
assert.deepStrictEqual(orderNames(list, 'storyA'), ['global1', 'charBook', 'storyA']);
assert.ok(list.some(w => w.world === 'chat'), 'chat book stored as sentinel, not by name');
assert.ok(!list.some(w => w.world === 'storyA'), 'chat book never stored by its real name');

// --- Branch B: same character, new branch bound to a DIFFERENT book "storyB" ---
const before = JSON.stringify(list);
ensure(list, ['global1', 'charBook', 'storyB'], 'storyB');
assert.strictEqual(JSON.stringify(list), before, 'a different chat book must NOT append a row');
assert.deepStrictEqual(orderNames(list, 'storyB'), ['global1', 'charBook', 'storyB'],
    'order is identical across branches, chat slot follows the live book');

[list[0], list[2]] = [list[2], list[0]]; // move chat slot to the front
assert.deepStrictEqual(orderNames(list, 'storyA'), ['storyA', 'charBook', 'global1']);
assert.deepStrictEqual(orderNames(list, 'storyB'), ['storyB', 'charBook', 'global1']);

console.log('wa-priority-check: OK');
