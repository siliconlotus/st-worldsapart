// index-resolve-check.mjs — where a scene looks for its vector collection, and what it does when there
// isn't one.
//
// Both of these were silent, and both reported a number instead of a failure. A sample's `index` and the
// hash-derived path are recorded with ST's `data/` prefix, so testing them against the CWD asks a question
// whose answer moves with the directory the tool was launched from: the same scene read 10/10 judged from
// the ST root and 0/0 one level down. And a book whose collection is simply absent — the state every
// exported bundle is in on someone else's machine — scored keyword-and-BM25-only and looked plausible.
//
// The keyword-only case must stay silent, though: a book with nothing to index legitimately has no
// collection (Foxbridge), so the guard keys on the same gate reindex.mjs buildItems does rather than on
// whether a file happens to exist.
import { chdir, cwd } from 'node:process';
import { indexPath, loadScene, sceneParams, stInstall } from './scene.mjs';
import { dirname, isAbsolute } from 'node:path';

let bad = 0;
const eq = (got, want, msg) => { if (got !== want) { console.log(`FAIL ${msg}\n  got  ${got}\n  want ${want}`); bad++; } else console.log(`ok   ${msg}`); };
const throws = (fn, match, msg) => {
    try { fn(); console.log(`FAIL ${msg} — did not throw`); bad++; }
    catch (e) { if (e.message.includes(match)) console.log(`ok   ${msg}`); else { console.log(`FAIL ${msg}\n  message lacks "${match}": ${e.message}`); bad++; } }
};

/** Smallest sample loadScene will accept. `vectorized` is the only field these cases turn on. */
const sample = (vectorized, extra = {}) => ({
    primaryBook: 'Check Book',
    books: { 'Check Book': { 1: { uid: 1, comment: 'One', content: 'alpha beta', key: ['alpha'], vectorized } } },
    entries: [], excludeTitles: [], params: {},
    query: 'alpha', scanText: 'alpha',
    ...extra,
});

const load = S => loadScene(S, { indexFile: indexPath(S), params: sceneParams(S) });

// --- resolution -------------------------------------------------------------------------------------
eq(indexPath(sample(true), { index: '/explicit/path.json' }), '/explicit/path.json',
    'an explicit index wins over every candidate');

// The CWD must not be an input. Both candidates are absent for this made-up book, so resolution lands on
// the rebuild cache — the point is that it lands on the SAME place from anywhere.
const here = cwd();
const fromRoot = indexPath(sample(true));
const stHere = stInstall();
chdir(dirname(here));
const fromElsewhere = indexPath(sample(true));
const stThere = stInstall();
chdir(here);
eq(fromElsewhere, fromRoot, 'resolution does not move with the working directory');
// The candidate paths themselves, which is the half that actually moved: a sample's `index` carries ST's
// `data/` prefix, and testing it raw resolves against the CWD. Skipped where no install is reachable.
if (stHere && stThere) {
    eq(stThere.resolve('data/default-user/vectors/x'), stHere.resolve('data/default-user/vectors/x'),
        "a sample's recorded data/ path resolves to one place regardless of the working directory");
    eq(isAbsolute(stHere.resolve('data/default-user/vectors/x')), true,
        'and resolves absolutely, so existsSync is asking about the install rather than the CWD');
}
eq(fromRoot.includes('/eval-data/indexes/'), true,
    'with no local collection, resolution names the rebuildable path rather than an author-machine one');

// --- what a missing collection means ----------------------------------------------------------------
throws(() => load(sample(true)), 'reindex.mjs',
    'a book with vectorized entries and no collection fails, and says how to build one');

eq(load(sample(false)).items.length, 0,
    'a book with nothing to index scores without a collection — no vectors is a configuration, not a fault');

// A disabled or empty entry is not indexed either (reindex.mjs buildItems), so it cannot demand a collection.
eq(load(sample(true, { books: { 'Check Book': { 1: { uid: 1, comment: 'One', content: 'alpha', vectorized: true, disable: true } } } })).items.length, 0,
    'a disabled vectorized entry does not demand a collection');
eq(load(sample(true, { books: { 'Check Book': { 1: { uid: 1, comment: 'One', content: '', vectorized: true } } } })).items.length, 0,
    'an empty vectorized entry does not demand a collection');

// --- the bundle disagreeing with itself ---------------------------------------------------------------
throws(() => load(sample(false, { primaryBook: 'Renamed Away' })), 'not among its embedded books',
    'a primaryBook naming no embedded book says so, rather than dying inside Object.values');

process.exit(bad ? 1 : 0);
