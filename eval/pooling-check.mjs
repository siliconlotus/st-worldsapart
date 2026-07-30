// pooling-check.mjs — poolEntries() must reproduce, server-side and exactly, the per-entry pooling the
// client used to do over a truncated chunk list. The property that matters is that pooling is INDEPENDENT
// per signal: an entry's score comes from its best-vector chunk and its bm25 from its best-lexical chunk,
// which need not be the same chunk. Getting that wrong is silent — the ranking just shifts.
//
// Run bare: prints `ok` or throws.
import assert from 'node:assert';
import { poolEntries, selectTopK } from '../plugin/scoring.mjs';

const chunk = (index, hash, score, bm25) => ({ collectionId: 'c1', score, bm25, metadata: { index, hash, text: `t${hash}` } });

// Entry 7's best vector chunk (#2) is NOT its best lexical chunk (#3).
const pooled = poolEntries([
    chunk(7, 1, 0.10, 0.0),
    chunk(7, 2, 0.90, 0.1),
    chunk(7, 3, 0.50, 9.9),
    chunk(8, 4, 0.40, 1.0),
]);

assert.strictEqual(pooled.length, 2, 'one record per entry');
const e7 = pooled.find(r => r.metadata.index === 7);
assert.strictEqual(e7.score, 0.90, 'score is the max over chunks');
assert.strictEqual(e7.bm25, 9.9, 'bm25 pools independently of score');
assert.strictEqual(e7.metadata.hash, 2, 'the surviving record is the best-VECTOR chunk');
assert.strictEqual(e7.metadata.text, 't2', 'text follows the surviving chunk, so owners/display still resolve');

// Order must not matter: the best-lexical chunk arriving before the best-vector one is the case that breaks
// a naive single-pass max.
const reversed = poolEntries([chunk(7, 3, 0.50, 9.9), chunk(7, 2, 0.90, 0.1), chunk(7, 1, 0.10, 0.0)]);
assert.deepStrictEqual(
    [reversed[0].score, reversed[0].bm25, reversed[0].metadata.hash],
    [0.90, 9.9, 2],
    'pooling is order-independent');

// Entries in different collections with the same index are different entries.
assert.strictEqual(poolEntries([chunk(7, 1, 0.5, 0), { ...chunk(7, 2, 0.9, 0), collectionId: 'c2' }]).length, 2,
    'collectionId is part of the pooling key');

// A chunk with no owning entry pools as itself rather than colliding with every other orphan.
const orphans = poolEntries([
    { collectionId: 'c1', score: 0.5, bm25: 0, metadata: { hash: 90 } },
    { collectionId: 'c1', score: 0.6, bm25: 0, metadata: { hash: 91 } },
]);
assert.strictEqual(orphans.length, 2, 'orphan chunks fall back to per-hash keys');

// THE POINT OF THE CHANGE: topK now counts entries. Two entries of 3 chunks each, topK 2, must return both
// entries — the old chunk-side cut would have spent its budget inside one entry.
const many = [chunk(7, 1, 0.9, 0), chunk(7, 2, 0.8, 0), chunk(7, 3, 0.7, 0),
              chunk(8, 4, 0.6, 0), chunk(8, 5, 0.5, 0), chunk(8, 6, 0.4, 0)];
assert.strictEqual(selectTopK(poolEntries(many), 2).c1.metadata.length, 2, 'pooled: topK 2 yields 2 entries');
assert.strictEqual(new Set(selectTopK(poolEntries(many), 2).c1.metadata.map(m => m.index)).size, 2,
    'pooled: both entries represented');
assert.strictEqual(new Set(selectTopK(many, 2).c1.metadata.map(m => m.index)).size, 1,
    'unpooled: topK 2 spends the whole budget inside entry 7 — the bug this fixes');

// selectTopK's independent-signal union must survive pooling: an entry that only BM25 likes still reaches
// the client, which is what lets it win on fusion.
const lexOnly = selectTopK(poolEntries([chunk(7, 1, 0.9, 0), chunk(8, 2, -0.5, 5.0)]), 1);
assert.strictEqual(new Set(lexOnly.c1.metadata.map(m => m.index)).size, 2,
    'the lexical-only entry survives a topK of 1 via the union');

console.log('ok');
