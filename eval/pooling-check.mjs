// pooling-check.mjs — poolEntries() must reproduce the per-entry pooling server-side: an entry scores as its BEST chunk, and that chunk's record survives.
import assert from 'node:assert';
import { poolEntries, scoreCollection, selectTopK } from '../plugin/scoring.mjs';

const chunk = (index, hash, score) => ({ collectionId: 'c1', score, metadata: { index, hash, text: `t${hash}` } });

// Entry 7's best chunk (#2) is neither the first nor the last it arrives with.
const pooled = poolEntries([
    chunk(7, 1, 0.10),
    chunk(7, 2, 0.90),
    chunk(7, 3, 0.50),
    chunk(8, 4, 0.40),
]);

assert.strictEqual(pooled.length, 2, 'one record per entry');
const e7 = pooled.find(r => r.metadata.index === 7);
assert.strictEqual(e7.score, 0.90, 'score is the max over chunks');
assert.strictEqual(e7.bm25, undefined, 'no lexical score survives stage 1');
assert.strictEqual(e7.metadata.hash, 2, 'the surviving record is the best-scoring chunk');
assert.strictEqual(e7.metadata.text, 't2', 'text follows the surviving chunk, so owners/display still resolve');

const reversed = poolEntries([chunk(7, 3, 0.50), chunk(7, 2, 0.90), chunk(7, 1, 0.10)]);
assert.deepStrictEqual(
    [reversed[0].score, reversed[0].metadata.hash],
    [0.90, 2],
    'pooling is order-independent');

assert.strictEqual(poolEntries([chunk(7, 1, 0.5, 0), { ...chunk(7, 2, 0.9, 0), collectionId: 'c2' }]).length, 2,
    'collectionId is part of the pooling key');

const orphans = poolEntries([
    { collectionId: 'c1', score: 0.5, metadata: { hash: 90 } },
    { collectionId: 'c1', score: 0.6, metadata: { hash: 91 } },
]);
assert.strictEqual(orphans.length, 2, 'orphan chunks fall back to per-hash keys');

const many = [chunk(7, 1, 0.9, 0), chunk(7, 2, 0.8, 0), chunk(7, 3, 0.7, 0),
              chunk(8, 4, 0.6, 0), chunk(8, 5, 0.5, 0), chunk(8, 6, 0.4, 0)];
assert.strictEqual(selectTopK(poolEntries(many), 2).c1.metadata.length, 2, 'pooled: topK 2 yields 2 entries');
assert.strictEqual(new Set(selectTopK(poolEntries(many), 2).c1.metadata.map(m => m.index)).size, 2,
    'pooled: both entries represented');
assert.strictEqual(new Set(selectTopK(many, 2).c1.metadata.map(m => m.index)).size, 1,
    'unpooled: topK 2 spends the whole budget inside entry 7 — the bug this fixes');

// What the cut gives up, asserted so it is a decision rather than a regression (plugin/scoring.mjs header).
const lexOnly = selectTopK(poolEntries([chunk(7, 1, 0.9), chunk(8, 2, -0.5)]), 1);
assert.deepStrictEqual(lexOnly.c1.metadata.map(m => m.index), [7],
    'topK 1 keeps the cosine winner alone — no lexical list to union');

// Ten orthogonal unit vectors against a query aligned with item 0: ten distinct cosines.
const dim = 10;
const unit = i => Array.from({ length: dim }, (_, d) => (d === i ? 1 : 0));
const autoItems = Array.from({ length: dim }, (_, i) => ({ vector: unit(i), metadata: { index: i, hash: i, text: `zz${i}` } }));
const autoLoaded = { items: autoItems, mean: Array(dim).fill(0) };
const q = Array.from({ length: dim }, (_, d) => (dim - d));   // distinct positive cosine per item
const all = scoreCollection('c1', autoLoaded, q, { centered: false });
assert.strictEqual(all.length, autoItems.length, 'every scored chunk is returned — there is no admission test left');
assert.ok(all.every(r => r.bm25 === undefined), 'no chunk carries a lexical score out of stage 1');

assert.strictEqual(scoreCollection('c1', autoLoaded, q, { centered: false }).length, autoLoaded.items.length,
    'scoreCollection returns every chunk it scored');

console.log('ok');
