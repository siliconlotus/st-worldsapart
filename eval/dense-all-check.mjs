// Self-check for the denseAllEntries arm — a cosine for the entries the vector collection has no row for.
//
// Three claims carry it, and each fails silently rather than loudly.
//
//   THE BASELINE MUST NOT MOVE. The --all index holds every entry's chunks; loadScene keeps the vectorized
//   ones as stage 1's collection and its corpus mean. If the split leaked — extra chunks in the mean, or in
//   the candidate set — every vectorized entry's cosine would shift and the arm would be measuring itself
//   against a different baseline while reporting a parameter effect.
//
//   IT MAY NOT ACTIVATE. A dense score is stage 3. An entry no key fired for must still get no row, or the
//   arm surfaces unjudged entries and its delta becomes a pool-biased lower bound like a chunk arm's.
//
//   THE ARM MUST ACTUALLY FIRE. Pointed at an ordinary index it would score every entry at its production
//   value and report flat — the one failure that looks like a result — so that combination throws.
//
// No ollama and no real book: hand-written vectors, since none of the above is a question about embeddings.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScene, makeCandidateSet, sceneParams } from './scene.mjs';
import { eq } from './metrics.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'wa-dense-'));
const vec = { 1: [1, 0, 0], 2: [0.6, 0.8, 0], 3: [0, 0, 1], 5: [0.9, 0.1, 0.2] };
const item = uid => ({ id: `i${uid}`, metadata: { hash: uid, text: `text of entry ${uid}`, index: uid }, vector: vec[uid], norm: 1 });
const write = (name, uids) => {
    const path = join(DIR, name);
    writeFileSync(path, JSON.stringify({ version: 1, metadata_config: {}, items: uids.map(item) }));
    return path;
};

const entry = (uid, extra) => ({ world: 'B', uid, comment: `E${uid}`, content: `text of entry ${uid}`, key: [], ...extra });
const S = {
    primaryBook: 'B',
    books: {
        B: {
            1: entry(1, { vectorized: true }),
            5: entry(5, { vectorized: true }),
            2: entry(2, { key: ['spire'] }),   // keyword-only, fires below
            3: entry(3),                        // keyword-only, no key: nothing can activate it
        },
    },
    // threshold -1 admits every chunk, so admission is not what this check is varying.
    params: { threshold: -1 },
    grades: [], candidates: [],
};

const ORDINARY = write('ordinary.json', [1, 5]);
const ALL = write('all.json', [1, 5, 2, 3]);
const QV = [0.7, 0.7, 0.1];
const rowsOf = (indexFile, overrides) => {
    // The ORDINARY form has to be asked for now that production's split is the default — this check
    // contrasts the two, so neither may come from a default.
    const P = sceneParams(S, { denseAllEntries: false, ...overrides });
    const scene = loadScene(S, { indexFile, params: P });
    const rows = makeCandidateSet({ ...scene, params: P })(2, 0.75, null, QV, 'text of entry', () => ['the spire looms over the quarter']);
    return { scene, byUid: new Map(rows.map(r => [r.uid, r])) };
};

const base = rowsOf(ORDINARY, {});
const dense = rowsOf(ALL, { denseAllEntries: true });

// --- the baseline does not move --------------------------------------------------------------------
eq(dense.scene.loaded.items.length, 2, 'stage 1 keeps only the vectorized chunks of an --all index');
eq(dense.scene.loaded.extra.length, 2, 'the rest are held aside for stage 3');
eq([...dense.scene.loaded.mean].join(','), [...base.scene.loaded.mean].join(','),
    'the corpus mean is the vectorized corpus\'s, unchanged by the extra chunks');
eq(dense.byUid.get(1).score, base.byUid.get(1).score, 'a vectorized entry\'s cosine is untouched');
eq(dense.byUid.get(5).score, base.byUid.get(5).score, 'so is its sibling\'s');

// --- scoring only, never admission -----------------------------------------------------------------
eq([...base.byUid.keys()].sort().join(','), '1,2,5', 'baseline: two retrieved entries and the one whose key fired');
eq([...dense.byUid.keys()].sort().join(','), '1,2,5', 'dense-all ranks exactly the same rows — a cosine admits nothing');
eq(dense.byUid.has(3), false, 'an entry in the --all index that no key activated still gets no row');

// --- the entry that gains the signal ---------------------------------------------------------------
eq(base.byUid.get(2).score, undefined, 'baseline: a keyword-only entry has no cosine');
eq(base.byUid.get(2).vectorEligible, false, 'and is not ranked as though it lost one');
eq(Number.isFinite(dense.byUid.get(2).score), true, 'dense-all: it earns one');
eq(dense.byUid.get(2).vectorEligible, true, 'and becomes eligible, so the vector weight enters its denominator');
eq(dense.byUid.get(2).keywordScore > 0, true, 'its keys still score — the cosine is added evidence, not a replacement');

// --- the column form, which is what makes dense comparable to the learned-sparse arms ---------------
// Same cosine, fused through fuseRanks's fourth column instead of the entry's own score, so `score` stays
// absent, the entry stays outside the vector column's denominator, and it keeps the keyword-only tilt.
// Getting this wrong in either direction silently turns the replication back into denseAll=on.
const col = rowsOf(ALL, { denseAllEntries: true, denseColumn: 'nocos' });
eq(col.byUid.get(2).score, undefined, 'denseColumn leaves `score` alone');
eq(col.byUid.get(2).vectorEligible, false, '...so the entry is still not in the vector column');
eq(col.byUid.get(2).sparseScore, dense.byUid.get(2).score, '...and the fourth column holds the same cosine the other form put in `score`');
eq(col.byUid.get(1).sparseScore, undefined, "'nocos' leaves entries that already have a cosine out of the column");
eq(rowsOf(ALL, { denseAllEntries: true, denseColumn: 'cos' }).byUid.get(1).sparseScore, base.byUid.get(1).score,
    "'cos' duplicates a vectorized entry's own cosine into the column");
eq(rowsOf(ALL, { denseAllEntries: true, denseColumn: 'cos' }).byUid.get(2).sparseScore, undefined, "...and leaves the keyword-only entry out");
const all3 = rowsOf(ALL, { denseAllEntries: true, denseColumn: 'all' }).byUid;
eq(Number.isFinite(all3.get(1).sparseScore) && Number.isFinite(all3.get(2).sparseScore), true, "'all' scores both classes");

// --- the fourth-column ranking assertions are RETIRED, with fuseRanks ------------------------------
// They pinned that a negative centered cosine still entered RRF's sparse column rather than being
// dropped from it. There is no such column: E[credit] reads the signals directly, and a below-average
// cosine is simply a low value of a feature the model already weights. The column form above still
// matters — it is what puts the cosine on the row at all — so only the ranking half goes.

// --- pointed at the wrong collection ---------------------------------------------------------------
let threw = false;
try { rowsOf(ORDINARY, { denseAllEntries: true }); } catch { threw = true; }
eq(threw, true, 'denseAllEntries against an ordinary index throws rather than reporting flat');
let threwCol = false;
try { rowsOf(ORDINARY, { denseColumn: 'nocos' }); } catch { threwCol = true; }
eq(threwCol, true, 'a column population needing the extras throws without the collection that holds them');

rmSync(DIR, { recursive: true, force: true });
