// Ranking every attached book at once, as scoreEntriesUnsafe and /query-multi do: (book, uid) identity, one pooled ranking, per-book centering, scope, the per-book cap. Hand-written vectors; B's collection sits where indexPath derives it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { getStringHash, loadScene, makeCandidateSet, makeGradeOf, sceneParams, scoreScene } from './scene.mjs';
import { eq } from './metrics.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'wa-multibook-'));
const VEC = {
    A: { 1: [1, 0, 0], 2: [0.8, 0.6, 0] },
    B: { 1: [0, 1, 0], 2: [0.2, 0.9, 0.3] },
};
const write = (book) => {
    // Exactly indexPath's derived layout: <vectors>/wa_<hash(book)>/<model>/index.json.
    const path = join(DIR, `wa_${getStringHash(book)}`, 'check-embed', 'index.json');
    mkdirSync(dirname(path), { recursive: true });
    const items = Object.entries(VEC[book]).map(([uid, vector]) => ({ id: `${book}${uid}`, metadata: { hash: `${book}${uid}`, text: `text ${book}${uid}`, index: Number(uid) }, vector, norm: 1 }));
    writeFileSync(path, JSON.stringify({ version: 1, metadata_config: {}, items }));
    return path;
};
const A_INDEX = write('A');
write('B');

const entry = (uid, book, extra) => ({ uid, comment: `${book}-${uid}`, content: `text ${book}${uid}`, key: [], vectorized: true, ...extra });
const sample = () => ({
    primaryBook: 'A',
    embedModel: 'check-embed',
    books: {
        A: { 1: entry(1, 'A'), 2: entry(2, 'A') },
        B: { 1: entry(1, 'B'), 2: entry(2, 'B') },
    },
    query: 'text B1',
    scanChat: [],
    // In `params`, not an override: scoreScene refuses to sweep these against a preloaded scene.
    params: { denseAllEntries: false, centroidPopulation: 'vectorized' },
    entries: [
        { title: 'B-1', book: 'B', uid: 1, grades: [{ kind: 'human', grade: 4, user: 'x', at: '2026-01-01' }] },
        { title: 'A-1', book: 'A', uid: 1, grades: [{ kind: 'human', grade: 0, user: 'x', at: '2026-01-01' }] },
    ],
    candidates: [{ title: 'B-1', book: 'B', uid: 1 }, { title: 'A-1', book: 'A', uid: 1 }],
    // Deliberately stale: both books are embedded, so this must remove nothing.
    excludeTitles: ['B-1'],
});

const P = sceneParams(sample());
const load = () => loadScene(sample(), { indexFile: A_INDEX, indexOpts: { vectors: DIR }, params: P });
const scene = load();

// --- both collections load, each with its own mean ---------------------------------------------------
eq(scene.books.join(','), 'A,B', 'every embedded book is loaded, primary first');
eq(scene.loaded.length, 2, 'one collection per book, not one concatenated index');
eq(scene.loaded.map(L => L.book).join(','), 'A,B', '...in the same order');
eq(scene.loaded.map(L => L.items.length).join(','), '2,2', 'each holds only its own chunks');
eq([...scene.loaded[0].mean].map(x => x.toFixed(2)).join(','), '0.90,0.30,0.00', "A is centered on A's chunks");
eq([...scene.loaded[1].mean].map(x => x.toFixed(2)).join(','), '0.10,0.95,0.15', "...and B on B's, which is the plugin's per-collection mean");
eq(scene.entries.length, 4, 'the entry list spans both books');
eq(scene.entries.every(e => e.world), true, 'every entry carries a world, stamped when the bundle omitted it');

// --- (book, uid) is the identity -------------------------------------------------------------------
eq([...scene.byKey.keys()].sort().join(' '), 'A.1 A.2 B.1 B.2', 'entries are keyed by book and uid, so two books\' uid 1 are two rows');
eq(scene.byKey.get('B.1').comment, 'B-1', '...and each resolves to its own entry');
eq([...scene.POOL].sort().join(' '), 'A.1 B.1', 'the pool keys the same way');
eq([...scene.OWN].sort().join(' '), 'A.1 B.1', 'and so does the capture\'s own set');
eq(scene.outOfScope({ book: 'B', uid: 1 }), false, 'a grade from an embedded book is in scope, whatever excludeTitles says');
eq(scene.outOfScope({ book: 'Absent', uid: 1 }), true, '...and one from a book nothing embedded is not');

const gradeOf = makeGradeOf(sample().entries, scene);
eq(gradeOf({ book: 'B', uid: 1 }), 4, 'a second book\'s row resolves to its own grade');
eq(gradeOf({ book: 'A', uid: 1 }), 0, '...and the primary\'s uid 1 keeps the disagreeing one');

// --- one ranking, both books ------------------------------------------------------------------------
const QV = [0.1, 0.95, 0.15];
const rows = makeCandidateSet({ ...scene, params: P })(P.K1, P.B, null, QV, 'text B1', () => ['']);
eq(rows.length, 4, 'every entry of every book is a candidate');
eq(rows.map(r => `${r.book}.${r.uid}`).sort().join(' '), 'A.1 A.2 B.1 B.2', 'each row names its own book');
eq(rows.every(r => r.book === r.entry.world), true, 'a row\'s book is its entry\'s world, which is what capOf reads');
const top2 = makeCandidateSet({ ...scene, params: P, topK: 2 })(P.K1, P.B, null, QV, 'text B1', () => ['']);
eq(top2.length, 2, 'topK counts entries across every collection, not per collection');

// --- stage 4's per-book quota ------------------------------------------------------------------------
// relevanceFit is named because check-embed has no fit and modelsFor refuses to borrow; which fit is arbitrary.
const delivered = async (overrides) => {
    const r = await scoreScene({ sample: sample(), overrides: { budgetTokens: 100000, relevanceFit: 'bge-m3', ...overrides }, scene, qv: QV });
    return r.atBudget.n;
};
eq(await delivered({}), 4, 'no cap: the budget alone delivers every row');
eq(await delivered({ bookCaps: { B: 1 } }), 3, 'a cap of 1 on B drops one of B\'s two rows and neither of A\'s');
eq(await delivered({ bookCaps: { A: 1, B: 1 } }), 2, '...and capping both leaves one of each');

rmSync(DIR, { recursive: true, force: true });
