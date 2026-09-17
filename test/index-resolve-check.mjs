// index-resolve-check.mjs — where a scene looks for its vector collection, and what a missing one means: the CWD is not an input, and a book with nothing to index legitimately has none.
import { chdir, cwd } from 'node:process';
import { indexPath, loadScene, sceneParams, stInstall } from '../eval/lib/scene.mjs';
import { dirname, isAbsolute } from 'node:path';
import { eq, throws } from '../eval/lib/metrics.mjs';


/** Smallest sample loadScene will accept. `vectorized` is the only field these cases turn on. */
const sample = (vectorized, extra = {}) => ({
    primaryBook: 'Check Book',
    embedModel: 'check-embed',
    books: { 'Check Book': { 1: { uid: 1, comment: 'One', content: 'alpha beta', key: ['alpha'], vectorized } } },
    entries: [], params: {},
    query: 'alpha', scanText: 'alpha',
    ...extra,
});

// denseAllEntries off: index RESOLUTION is under test, and the split would only add a precondition.
const load = S => loadScene(S, { indexFile: indexPath(S), params: sceneParams(S, { denseAllEntries: false }) });

eq(indexPath(sample(true), { index: '/explicit/path.json' }), '/explicit/path.json',
    'an explicit index wins over every candidate');

// Both candidates are absent for this made-up book, so resolution lands on the rebuild cache from anywhere.
const here = cwd();
const fromRoot = indexPath(sample(true));
const stHere = stInstall();
chdir(dirname(here));
const fromElsewhere = indexPath(sample(true));
const stThere = stInstall();
chdir(here);
eq(fromElsewhere, fromRoot, 'resolution does not move with the working directory');
if (stHere && stThere) {
    eq(stThere.resolve('data/default-user/vectors/x'), stHere.resolve('data/default-user/vectors/x'),
        "a sample's recorded data/ path resolves to one place regardless of the working directory");
    eq(isAbsolute(stHere.resolve('data/default-user/vectors/x')), true,
        'and resolves absolutely, so existsSync is asking about the install rather than the CWD');
}
eq(fromRoot.includes('/eval-data/indexes/'), true,
    'with no local collection, resolution names the rebuildable path rather than an author-machine one');

// --- what a missing collection means ----------------------------------------------------------------
throws(() => load(sample(true)),
    'a book with vectorized entries and no collection fails, and says how to build one', 'reindex.mjs');

eq(load(sample(false)).items.length, 0,
    'a book with nothing to index scores without a collection — no vectors is a configuration, not a fault');

eq(load(sample(true, { books: { 'Check Book': { 1: { uid: 1, comment: 'One', content: 'alpha', vectorized: true, disable: true } } } })).items.length, 0,
    'a disabled vectorized entry does not demand a collection');
eq(load(sample(true, { books: { 'Check Book': { 1: { uid: 1, comment: 'One', content: '', vectorized: true } } } })).items.length, 0,
    'an empty vectorized entry does not demand a collection');

// --- the bundle disagreeing with itself ---------------------------------------------------------------
throws(() => load(sample(false, { primaryBook: 'Renamed Away' })),
    'a primaryBook naming no embedded book says so, rather than dying inside Object.values', 'not among its embedded books');

if (process.exitCode !== 1) console.log('index-resolve-check: ok');
