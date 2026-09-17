// plugin-vector-check.mjs — the plugin's vector math refuses to NaN: misshapen rows are skipped, and the pooling keys
// cannot collide or pollute. server.js needs ST to import, so the shipped math is checked here, through the same modules.
import { corpusMean, centeredCosineScores } from '../plugin/vector.mjs';
import { poolEntries, selectTopK } from '../plugin/scoring.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const row = (dim, fill = 1) => ({ vector: Array.from({ length: dim }, () => fill) });

// --- corpusMean: one misshapen row must not NaN the corpus
{
    const mean = corpusMean([row(3, 1), row(3, 2), { vector: [1, 2] }, { vector: [] }, { vector: 'nope' }, {}]);
    eq(mean.length, 3, 'the mean keeps the first valid row\'s dimension');
    eq([...mean].every(x => Number.isFinite(x) && x === 1.5), true, 'the mean is of the valid rows only, and finite');
    eq(corpusMean([{ vector: [] }, {}]).length, 0, 'an all-invalid corpus yields an empty mean, not NaN');
    eq(corpusMean([{ vector: [1, 2] }, row(3)]).length, 2, 'the first valid row defines the dimension, later ones skip');
    const typed = corpusMean([{ vector: Float64Array.from([2, 4, 6]) }]);
    eq([...typed].join(','), '2,4,6', 'a typed-array vector counts as a vector');
}

// --- centeredCosineScores: a foreign-dimension row scores 0; a foreign-dimension query throws
{
    const items = [row(3, 1), { vector: [1, 2] }, row(3, 2)];
    const mean = corpusMean([row(3, 1.5)]);
    const scores = centeredCosineScores(items, [1, 1, 1], mean, true);
    eq(scores.length, 3, 'scores stay aligned with the items');
    eq(Number.isFinite(scores[0]) && Number.isFinite(scores[2]), true, 'valid rows score finitely');
    eq(scores[1], 0, 'a misshapen row scores 0, never NaN');
    let threw = false;
    try { centeredCosineScores(items, [1, 2], mean, true); } catch { threw = true; }
    eq(threw, true, 'a query of another dimension is the caller\'s failure, thrown not NaN-ed');
    eq(centeredCosineScores(items, [1, 1, 1], [], true).length, 3, 'an empty corpus scores zero-length, as it always has');
}

// --- poolEntries: the pooling key cannot collide across a collection-id boundary
{
    const a = { collectionId: 'wa_a', score: 1, metadata: { index: 12 } };
    const b = { collectionId: 'wa_a1', score: 0.5, metadata: { index: 2 } };
    eq(poolEntries([a, b]).length, 2, 'wa_a#12 and wa_a1#2 pool apart — US separator, not concatenation');
}

// --- selectTopK: a hashless chunk is dropped, and a collectionId named like the prototype pools as a plain key
{
    const grouped = selectTopK([
        { collectionId: 'wa_a', score: 1, metadata: { hash: 7 } },
        { collectionId: 'wa_b', score: 0.9 },
        { collectionId: '__proto__', score: 0.8, metadata: { hash: 9 } },
    ], 10);
    eq(grouped.wa_a.hashes.length, 1, 'a chunk without metadata cannot reach the client');
    eq(Object.keys(grouped).includes('__proto__'), true, 'a collectionId named like the prototype pools as a plain key');
    eq({}.x, undefined, 'and Object.prototype is untouched');
}

if (process.exitCode !== 1) console.log('plugin-vector-check: ok');
