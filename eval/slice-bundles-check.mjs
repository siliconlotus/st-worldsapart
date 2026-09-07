// slice-bundles-check.mjs — what a sliced bundle must still be for /wa-super-eval to open it.
//
// The slice is the input to a HUMAN grading pass, so a row silently missing from it is a row nobody
// adjudicates and nobody notices. Every assertion here is about that: the shortlist's rows survive,
// everything else is gone, and the shape the reviewer tests for is intact.
import assert from 'node:assert';
import { sliceBundle } from './synthetic-data/slice-bundles.mjs';

/** Unit Separator — the same key slice-bundles builds. Joining with nothing makes `W`+`11` and `W1`+`1`
 *  one shortlist entry. */
const US = String.fromCharCode(31);
const K = (w, u) => `${w}${US}${u}`;
const cand = (uid) => ({ book: 'W', uid, block: 'dynamic' });
const bundle = () => ({
    schemaVersion: 3, name: 'demo',
    scenes: [{
        id: 'c-msg-99', sceneChat: 'c.jsonl', sceneEnd: 99,
        entries: [
            { book: 'W', uid: 1, grades: [{ rater: 0, grade: 3 }] },
            { book: 'W', uid: 9, grades: [{ rater: 0, grade: 0 }] },
        ],
    }],
    raters: [{ rater: 0, kind: 'llm', id: 'm\u001fr' }],
    arms: [
        { name: 'a', params: {}, scenes: { 'c-msg-99': { sceneStart: 90, query: 'q', candidates: [cand(1), cand(9)] } } },
        { name: 'b', params: {}, scenes: { 'c-msg-99': { sceneStart: 90, query: 'q', candidates: [cand(1), cand(2)] } } },
    ],
    books: { W: { 1: { uid: 1, content: 'kept' }, 2: { uid: 2, content: 'also kept' }, 9: { uid: 9, content: 'dropped' } } },
});
const armsOf = d => (d.arms ?? []).map(a => a.scenes['c-msg-99']);

// The shortlist's rows survive in every arm that carried them, and nothing else does.
{
    const { sliced, dyn, lost } = sliceBundle(bundle(), new Set([K('W', 1), K('W', 2)]));
    assert.deepStrictEqual([...dyn].sort(), [K('W', 1), K('W', 2)]);
    assert.deepStrictEqual(lost, []);
    assert.deepStrictEqual(armsOf(sliced).map(a => a.candidates.map(c => c.uid)), [[1], [1, 2]]);
    // The reviewer's own admission test, asserted here so a slice can never fail it silently.
    assert.ok(Array.isArray(sliced.arms) && Array.isArray(sliced.scenes[0].entries));
    assert.ok(armsOf(sliced).some(a => a.candidates.some(c => c.block === 'dynamic')));
}

// Books are cut to the kept rows — the whole reason a pack of eleven scenes is small — but every kept
// row keeps its entry, since that is where the reviewer reads the text it is grading.
{
    const { sliced } = sliceBundle(bundle(), new Set([K('W', 1)]));
    assert.deepStrictEqual(Object.keys(sliced.books.W), ['1']);
    assert.strictEqual(sliced.books.W[1].content, 'kept');
}

// Verdicts are copied whole: they pre-fill the reviewer with what the judges said, and a row's prior
// verdict is the thing being adjudicated.
{
    const { sliced } = sliceBundle(bundle(), new Set([K('W', 1)]));
    assert.strictEqual(sliced.scenes[0].entries.length, 2);
}

// A constant row is not gradeable, so it is reported lost rather than packed — a section built from one
// alone would be refused by the reviewer with nothing said about why.
{
    const b = bundle();
    armsOf(b)[0].candidates[0].block = 'constant';
    armsOf(b)[1].candidates[0].block = 'constant';
    const { dyn, lost } = sliceBundle(b, new Set([K('W', 1)]));
    assert.strictEqual(dyn.size, 0);
    assert.deepStrictEqual(lost, [K('W', 1)]);
}

// Something that is not a graded-scene document is refused rather than half-sliced: a slice that found
// no candidates would produce an empty review section instead of an error.
assert.throws(() => sliceBundle({ name: 'not one', arms: [{ candidates: [] }] }, new Set()), /graded-scene document/);

// A shortlist naming a row the bundle does not carry is reported, not silently absorbed: it means the
// shortlist and the bundle disagree about what was captured.
{
    const { dyn, lost } = sliceBundle(bundle(), new Set([K('W', 1), K('W', 77)]));
    assert.deepStrictEqual([...dyn], [K('W', 1)]);
    assert.deepStrictEqual(lost, [K('W', 77)]);
}

// The source bundle is not mutated — the CLI slices bundles read straight from eval-data.
{
    const b = bundle();
    sliceBundle(b, new Set([K('W', 1)]));
    assert.strictEqual(armsOf(b)[0].candidates.length, 2);
    assert.strictEqual(Object.keys(b.books.W).length, 3);
}

// A pack's books are a SUBSET of the capture's, so carrying its content hashes forward would assert an
// identity the pack does not hold. Dropped rather than recomputed — a shortlist is not a capture.
{
    const src = { ...bundle(), bookHashes: { W: 'f'.repeat(64) } };
    const { sliced } = sliceBundle(src, new Set([K('W', 1)]));
    assert.strictEqual('bookHashes' in sliced, false, 'the pack drops the capture book hashes');
    assert.strictEqual('bookHashes' in src, true, 'and does not strip them from the source document');
}

console.log('ok');
