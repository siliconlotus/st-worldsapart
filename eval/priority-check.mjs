// Locks the two lorebook-priority retention comparators from rankActivated.
// The sorts live inline in a browser-only async function, so we mirror the exact
// comparator expressions here and assert the motivating cases.
const eq = (got, want, label) => console.log(`${got === want ? 'ok  ' : 'FAIL'} ${label}: ${got}${got === want ? '' : ` (want ${want})`}`);

const cfg = { book1: { weight: 2, offset: 0 }, book2: { weight: 1, offset: 0 } };
const rank = { book1: 0, book2: 1 };
const mk = (world, fused, order = 0) => ({ fused, entry: { world, waOriginalOrder: order } });

const worldRankOf = it => rank[it.entry.world] ?? 99;
const worldWeight = it => cfg[it.entry.world].weight;
const authored = (a, b) => a.entry.waOriginalOrder - b.entry.waOriginalOrder;

const sequential = (a, b) => (worldRankOf(a) - worldRankOf(b)) || (b.fused - a.fused) || authored(a, b);
const interleaved = (a, b) => (b.fused * worldWeight(b) - a.fused * worldWeight(a)) || authored(a, b);

// Sequential: a weak book1 entry outranks a strong book2 entry, always.
let sorted = [mk('book2', 0.9), mk('book1', 0.01)].sort(sequential);
eq(sorted[0].entry.world, 'book1', 'sequential: weak book1 beats strong book2');

// Interleaved: book1 ×2 lifts 0.05 to 0.10, beating book2's 0.09...
sorted = [mk('book2', 0.09), mk('book1', 0.05)].sort(interleaved);
eq(sorted[0].entry.world, 'book1', 'interleaved: weighted book1 beats mid book2');

// ...but a genuinely strong book2 entry (0.15) still wins over that same book1.
sorted = [mk('book1', 0.05), mk('book2', 0.15)].sort(interleaved);
eq(sorted[0].entry.world, 'book2', 'interleaved: strong book2 still outranks weighted book1');

// Weight 1 on both = plain relevance order (interleaved degenerates to no priority).
const flat = { book1: { weight: 1 }, book2: { weight: 1 } };
const flatWeight = it => flat[it.entry.world].weight;
sorted = [mk('book1', 0.05), mk('book2', 0.15)].sort((a, b) => (b.fused * flatWeight(b) - a.fused * flatWeight(a)) || authored(a, b));
eq(sorted[0].entry.world, 'book2', 'interleaved with equal weights = relevance order');
