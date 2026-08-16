// gazetteerSource selects WHICH FIELDS the gazetteer reads (scene.mjs). It is the one place where an arm
// can silently widen or narrow the BM25 term set without changing anything visible in a run's output, and
// that failure has already cost this project one 74% BM25 error — so the field selection is asserted rather
// than eyeballed. Tokenization is not re-derived here: every arm goes through buildGazetteer, so a change to
// the fold moves all five together and this check stays about selection.
import { loadScene, sceneParams } from './scene.mjs';
import { eq } from './metrics.mjs';

const entry = (uid, extra) => ({ world: 'B', uid, comment: `titleword${uid}`, content: `bodyword${uid}`, key: [`keyword${uid}`], ...extra });
const S = {
    primaryBook: 'B',
    // Entry 2 is vectorized, so production blanks its keys before the gazetteer sees them — the arms must
    // agree with each other about that, or a field comparison is also a suppression comparison.
    books: { B: { 1: entry(1), 2: entry(2, { vectorized: true }) } },
    captureParams: {},
    grades: [], candidates: [],
};

// No vectorized entry has content here, so loadScene's missing-collection guard does not fire and no index
// is needed; the gazetteer is built before anything reads one.
S.books.B[2].content = '';
const gazOf = source => loadScene(S, { indexFile: '(no collection)', params: sceneParams(S, { gazetteerSource: source }) }).gaz;
const has = (source, ...want) => {
    const g = gazOf(source);
    for (const [term, expected] of want) eq(g.has(term), expected, `${source}: ${expected ? 'reads' : 'ignores'} ${term}`);
};

has('keys+titles', ['keyword1', true], ['titleword1', true], ['bodyword1', false]);
has('keys', ['keyword1', true], ['titleword1', false], ['bodyword1', false]);
has('titles', ['keyword1', false], ['titleword1', true], ['bodyword1', false]);
has('bodies', ['keyword1', true], ['titleword1', true], ['bodyword1', true]);
eq(gazOf('none').size, 0, 'none: empty gazetteer, so buildTermWeights keeps only proper nouns');

// Suppression still runs underneath the selection, on every source that reads keys at all.
has('keys+titles', ['keyword2', false], ['titleword2', true]);
has('keys', ['keyword2', false]);

let threw = '';
try { gazOf('titles+bodies'); } catch (e) { threw = e.message; }
eq(threw.includes('unknown gazetteerSource'), true, 'an unrecognised source fails loudly rather than silently emptying the gazetteer');

console.log('ok   gazetteerSource selects fields, keeps suppression, and rejects unknown values');
