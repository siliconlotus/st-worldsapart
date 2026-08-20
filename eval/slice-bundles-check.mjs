// slice-bundles-check.mjs — what a sliced bundle must still be for /wa-super-eval to open it.
//
// The slice is the input to a HUMAN grading pass, so a row silently missing from it is a row nobody
// adjudicates and nobody notices — the reviewer shows what it is given and says nothing about what it
// was not. Every assertion here is about that: the shortlist's rows survive, everything else is gone,
// and the shape the reviewer tests for (arms, grades, a dynamic candidate, entry text) is intact.
import assert from 'node:assert';
import { sliceBundle } from './synthetic-data/slice-bundles.mjs';

const K = (w, u) => `${w}${u}`;
const bundle = () => ({
    name: 'demo', grades: [{ world: 'W', uid: 1, llmGrade: 3 }, { world: 'W', uid: 9, llmGrade: 0 }],
    books: { W: { 1: { uid: 1, content: 'kept' }, 2: { uid: 2, content: 'also kept' }, 9: { uid: 9, content: 'dropped' } } },
    arms: [
        { arm: 'a', query: 'q', candidates: [
            { world: 'W', uid: 1, block: 'dynamic' }, { world: 'W', uid: 9, block: 'dynamic' },
        ] },
        { arm: 'b', query: 'q', candidates: [
            { world: 'W', uid: 1, block: 'dynamic' }, { world: 'W', uid: 2, block: 'dynamic' },
        ] },
    ],
});

// The shortlist's rows survive in every arm that carried them, and nothing else does.
{
    const { sliced, dyn, lost } = sliceBundle(bundle(), new Set([K('W', 1), K('W', 2)]));
    assert.deepStrictEqual([...dyn].sort(), [K('W', 1), K('W', 2)]);
    assert.deepStrictEqual(lost, []);
    assert.deepStrictEqual(sliced.arms.map(a => a.candidates.map(c => c.uid)), [[1], [1, 2]]);
    // The reviewer's own admission test, asserted here so a slice can never fail it silently.
    assert.ok(Array.isArray(sliced.arms) && Array.isArray(sliced.grades));
    assert.ok(sliced.arms.some(a => a.candidates.some(c => c.block === 'dynamic')));
}

// Books are cut to the kept rows — the whole reason a pack of eleven scenes is small — but every kept
// row keeps its entry, since that is where the reviewer reads the text it is grading.
{
    const { sliced } = sliceBundle(bundle(), new Set([K('W', 1)]));
    assert.deepStrictEqual(Object.keys(sliced.books.W), ['1']);
    assert.strictEqual(sliced.books.W[1].content, 'kept');
}

// Grades are copied whole: they pre-fill the reviewer with what the judges said, and a row's prior
// verdict is the thing being adjudicated.
{
    const { sliced } = sliceBundle(bundle(), new Set([K('W', 1)]));
    assert.strictEqual(sliced.grades.length, 2);
}

// A constant row is not gradeable, so it is reported lost rather than packed — a section built from one
// alone would be refused by the reviewer with nothing said about why.
{
    const b = bundle();
    b.arms[0].candidates[0].block = 'constant';
    b.arms[1].candidates[0].block = 'constant';
    const { dyn, lost } = sliceBundle(b, new Set([K('W', 1)]));
    assert.strictEqual(dyn.size, 0);
    assert.deepStrictEqual(lost, [K('W', 1)]);
}

// The unbundled shape — a bare sample with `candidates` and no `arms` — cuts the same way.
{
    const flat = { name: 'flat', grades: [], books: { W: { 1: { uid: 1 }, 2: { uid: 2 } } },
        candidates: [{ world: 'W', uid: 1, block: 'dynamic' }, { world: 'W', uid: 2, block: 'dynamic' }] };
    const { sliced, dyn } = sliceBundle(flat, new Set([K('W', 2)]));
    assert.deepStrictEqual(sliced.candidates.map(c => c.uid), [2]);
    assert.deepStrictEqual([...dyn], [K('W', 2)]);
    assert.deepStrictEqual(Object.keys(sliced.books.W), ['2']);
}

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
    assert.strictEqual(b.arms[0].candidates.length, 2);
    assert.strictEqual(Object.keys(b.books.W).length, 3);
}

console.log('ok');
