// pooling-check.mjs — poolEntries() must reproduce, server-side and exactly, the per-entry pooling the
// client used to do over a truncated chunk list. An entry scores as its BEST chunk, and the record that
// survives is that chunk, because its hash and text are what `owners` and the Studio resolve. Getting
// either wrong is silent — the ranking just shifts.
//
// It used to pool INDEPENDENTLY PER SIGNAL, an entry's bm25 coming from a different chunk than its score.
// Stage 1 is cosine-only now (plugin/scoring.mjs), so there is one maximum and the cases below are about
// order-independence and identity rather than about two signals disagreeing.
//
// Run bare: prints `ok` or throws.
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

// Order must not matter: the best chunk arriving in the middle is the case that breaks a naive fold.
const reversed = poolEntries([chunk(7, 3, 0.50), chunk(7, 2, 0.90), chunk(7, 1, 0.10)]);
assert.deepStrictEqual(
    [reversed[0].score, reversed[0].metadata.hash],
    [0.90, 2],
    'pooling is order-independent');

// Entries in different collections with the same index are different entries.
assert.strictEqual(poolEntries([chunk(7, 1, 0.5, 0), { ...chunk(7, 2, 0.9, 0), collectionId: 'c2' }]).length, 2,
    'collectionId is part of the pooling key');

// A chunk with no owning entry pools as itself rather than colliding with every other orphan.
const orphans = poolEntries([
    { collectionId: 'c1', score: 0.5, metadata: { hash: 90 } },
    { collectionId: 'c1', score: 0.6, metadata: { hash: 91 } },
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

// WHAT THE CUT GIVES UP, asserted so it is a decision rather than a regression. selectTopK used to union
// the top-K by cosine with the top-K by BM25, so an entry only the lexical signal liked still reached the
// client. Stage 1 is cosine-only now: at topK 1 the lexically-strong, semantically-weak entry is gone.
// plugin/scoring.mjs's header carries why, and why no book here can reach the bound where it matters.
const lexOnly = selectTopK(poolEntries([chunk(7, 1, 0.9), chunk(8, 2, -0.5)]), 1);
assert.deepStrictEqual(lexOnly.c1.metadata.map(m => m.index), [7],
    'topK 1 keeps the cosine winner alone — no lexical list to union');

// scoreCollection ADMITS EVERYTHING now. Ten orthogonal unit vectors against a query aligned with item 0
// give ten distinct cosines and, formerly, ten different admission verdicts; every one of them is kept.
const dim = 10;
const unit = i => Array.from({ length: dim }, (_, d) => (d === i ? 1 : 0));
const autoItems = Array.from({ length: dim }, (_, i) => ({ vector: unit(i), metadata: { index: i, hash: i, text: `zz${i}` } }));
const autoLoaded = { items: autoItems, mean: Array(dim).fill(0) };
const q = Array.from({ length: dim }, (_, d) => (dim - d));   // distinct positive cosine per item
const all = scoreCollection('c1', autoLoaded, q, { centered: false });
assert.strictEqual(all.length, autoItems.length, 'every scored chunk is returned — there is no admission test left');
assert.ok(all.every(r => r.bm25 === undefined), 'no chunk carries a lexical score out of stage 1');

// The wrong-book gate is the ONE thing that still drops a chunk, and it reads RAW cosine per entry.
// Cosines here run 0.510 down to 0.051, so a 0.35 bar keeps the top four and drops the rest.
// NOTHING DROPS A CHUNK. The raw-cosine wrong-book gate that used to live here is gone (plugin/scoring.mjs
// carries why), so stage 1 returns every chunk it scored and admission is unconditional.
assert.strictEqual(scoreCollection('c1', autoLoaded, q, { centered: false }).length, autoLoaded.items.length,
    'scoreCollection returns every chunk it scored');

console.log('ok');
