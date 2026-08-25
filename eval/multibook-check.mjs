// Self-check for ranking every attached book at once — what `scoreEntriesUnsafe` and the plugin's
// /query-multi loop do, and what this harness did not do until now.
//
// Five claims, each of which fails as a plausible number rather than as an error.
//
//   UIDS DO NOT COLLIDE. Books number their entries from 0, so uid 1 exists in both. A bare-uid map —
//   the candidate set, the pool, the grade join, the token lookup — silently hands one book's row the
//   other's entry, grade or cosine, and the ranking still prints.
//
//   BOTH BOOKS COMPETE IN ONE RANKING. `poolEntries` keys on (collection, uid) and `selectTopK` sorts
//   across collections; a per-book top-K instead would let a weak book's best chunk in ahead of a strong
//   book's second.
//
//   EACH BOOK IS CENTERED ON ITS OWN CORPUS, which is the plugin's per-collection mean. Sharing one mean
//   across books would move every cosine in both, and nothing downstream could tell.
//
//   A SECOND BOOK'S GRADE IS IN SCOPE. It used to be dropped by `excludeTitles` — a title list whose
//   predicate was "not the primary book". Scope is now whether the book was embedded, so a stale
//   `excludeTitles` naming a book that IS here must no longer remove anything.
//
//   THE PER-BOOK CAP FIRES. `applyBudget`'s `capOf` had no offline caller at all while one book was
//   ranked, so nothing said whether the harness wires it to `entry.world`.
//
// No ollama and no real book: hand-written vectors, since none of the above is a question about
// embeddings. The second book's collection is placed where `indexPath` derives it (vectors dir, hashed
// book name) rather than passed in — there is one indexFile and N books, so that resolution IS the thing
// under test for every book but the primary.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { getStringHash, loadScene, makeCandidateSet, makeGradeOf, sceneParams, scoreScene } from './scene.mjs';
import { eq } from './metrics.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'wa-multibook-'));
// A's chunks sit near [1,0,0], B's near [0,1,0]. Centering subtracts each book's own centroid, so what a
// cosine means is only comparable across the two because each was taken against its own.
const VEC = {
    A: { 1: [1, 0, 0], 2: [0.8, 0.6, 0] },
    B: { 1: [0, 1, 0], 2: [0.2, 0.9, 0.3] },
};
const write = (book) => {
    // Exactly indexPath's derived layout: <vectors>/wa_<hash(book)>/<model>/index.json.
    const path = join(DIR, `wa_${getStringHash(book)}`, 'bge-m3', 'index.json');
    mkdirSync(dirname(path), { recursive: true });
    const items = Object.entries(VEC[book]).map(([uid, vector]) => ({ id: `${book}${uid}`, metadata: { hash: `${book}${uid}`, text: `text ${book}${uid}`, index: Number(uid) }, vector, norm: 1 }));
    writeFileSync(path, JSON.stringify({ version: 1, metadata_config: {}, items }));
    return path;
};
const A_INDEX = write('A');
write('B');

// The same uid in both books, with different titles and different content — which is the collision.
const entry = (uid, book, extra) => ({ uid, comment: `${book}-${uid}`, content: `text ${book}${uid}`, key: [], vectorized: true, ...extra });
const sample = () => ({
    primaryBook: 'A',
    books: {
        A: { 1: entry(1, 'A'), 2: entry(2, 'A') },
        B: { 1: entry(1, 'B'), 2: entry(2, 'B') },
    },
    query: 'text B1',
    scanChat: [],
    // In `params`, not in an override: both are read when the collection is split, so scoreScene refuses
    // to sweep them against a preloaded scene. denseAllEntries off keeps this fixture to the ordinary
    // vectorized-only collections it writes.
    params: { denseAllEntries: false, centroidPopulation: 'vectorized' },
    // Graded rows in BOTH books, at uids the other one also has, and disagreeing — so a uid-keyed join
    // resolves to the wrong verdict rather than to none.
    entries: [
        { title: 'B-1', book: 'B', uid: 1, grades: [{ kind: 'human', grade: 4, user: 'x', at: '2026-01-01' }] },
        { title: 'A-1', book: 'A', uid: 1, grades: [{ kind: 'human', grade: 0, user: 'x', at: '2026-01-01' }] },
    ],
    candidates: [{ title: 'B-1', book: 'B', uid: 1 }, { title: 'A-1', book: 'A', uid: 1 }],
    // Stale: this named the rows a single-book harness could not rank. Both books are here now.
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
// A's centroid leans x, B's leans y. One shared mean would put both at the same vector.
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
// The query points at B1, so B's entries should score high — but A's must be present and ordered against
// them, not held in a separate list.
const QV = [0.1, 0.95, 0.15];
const rows = makeCandidateSet({ ...scene, params: P })(P.K1, P.B, null, QV, 'text B1', () => ['']);
eq(rows.length, 4, 'every entry of every book is a candidate');
eq(rows.map(r => `${r.book}.${r.uid}`).sort().join(' '), 'A.1 A.2 B.1 B.2', 'each row names its own book');
eq(rows.every(r => r.book === r.entry.world), true, 'a row\'s book is its entry\'s world, which is what capOf reads');
// One pooled top-K, so a small K cuts across books rather than per book.
const top2 = makeCandidateSet({ ...scene, params: P, topK: 2 })(P.K1, P.B, null, QV, 'text B1', () => ['']);
eq(top2.length, 2, 'topK counts entries across every collection, not per collection');

// --- stage 4's per-book quota ------------------------------------------------------------------------
// No capture records a cap (it lives on the live world priority list), so it is a param. Without the
// wiring this returns all four rows and reads as "the cap does nothing".
const delivered = async (overrides) => {
    const r = await scoreScene({ sample: sample(), overrides: { budgetTokens: 100000, ...overrides }, scene, qv: QV });
    return r.atBudget.n;
};
eq(await delivered({}), 4, 'no cap: the budget alone delivers every row');
eq(await delivered({ bookCaps: { B: 1 } }), 3, 'a cap of 1 on B drops one of B\'s two rows and neither of A\'s');
eq(await delivered({ bookCaps: { A: 1, B: 1 } }), 2, '...and capping both leaves one of each');

rmSync(DIR, { recursive: true, force: true });
