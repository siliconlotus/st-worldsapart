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
    // Entry 2 is vectorized. That no longer changes what the gazetteer reads: production restores the
    // takeover's stash before building it, so the vocabulary is the AUTHORED one either way.
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

// A vectorized entry contributes exactly as any other does — the gazetteer reads what the author wrote,
// not what the scan's blanking happened to leave in place when it was asked.
has('keys+titles', ['keyword2', true], ['titleword2', true]);
has('keys', ['keyword2', true]);

let threw = '';
try { gazOf('titles+bodies'); } catch (e) { threw = e.message; }
eq(threw.includes('unknown gazetteerSource'), true, 'an unrecognised source fails loudly rather than silently emptying the gazetteer');

console.log('ok   gazetteerSource selects fields, keeps suppression, and rejects unknown values');
