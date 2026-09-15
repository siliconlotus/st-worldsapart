// gazetteerSource selects WHICH FIELDS the gazetteer reads (scene.mjs); field selection is asserted, tokenization is not re-derived (R22).
import { loadScene, sceneParams } from '../eval/scene.mjs';
import { eq } from '../eval/metrics.mjs';

const entry = (uid, extra) => ({ world: 'B', uid, comment: `titleword${uid}`, content: `bodyword${uid}`, key: [`keyword${uid}`], ...extra });
const S = {
    primaryBook: 'B',
    embedModel: 'check-embed',
    books: { B: { 1: entry(1), 2: entry(2, { vectorized: true }) } },
    params: {},
    grades: [], candidates: [],
};

// Blanked so loadScene's missing-collection guard does not fire; the gazetteer is built before anything reads an index.
S.books.B[2].content = '';
// denseAllEntries off: this fixture has no collection at all, and the gazetteer is what is under test.
const gazOf = source => loadScene(S, { indexFile: '(no collection)', params: sceneParams(S, { gazetteerSource: source, denseAllEntries: false }) }).gaz;
const has = (source, ...want) => {
    const g = gazOf(source);
    for (const [term, expected] of want) eq(g.has(term), expected, `${source}: ${expected ? 'reads' : 'ignores'} ${term}`);
};

has('keys+titles', ['keyword1', true], ['titleword1', true], ['bodyword1', false]);
has('keys', ['keyword1', true], ['titleword1', false], ['bodyword1', false]);
has('titles', ['keyword1', false], ['titleword1', true], ['bodyword1', false]);
has('bodies', ['keyword1', true], ['titleword1', true], ['bodyword1', true]);
eq(gazOf('none').size, 0, 'none: empty gazetteer, so buildTermWeights keeps only proper nouns');

has('keys+titles', ['keyword2', true], ['titleword2', true]);
has('keys', ['keyword2', true]);

let threw = '';
try { gazOf('titles+bodies'); } catch (e) { threw = e.message; }
eq(threw.includes('unknown gazetteerSource'), true, 'an unrecognised source fails loudly rather than silently emptying the gazetteer');

console.log('ok   gazetteerSource selects fields, keeps suppression, and rejects unknown values');
