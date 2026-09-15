// Self-check for the denseAllEntries arm: a cosine for entries the vector collection has no row for, without moving the baseline or admitting anything. Hand-written vectors.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadScene, makeCandidateSet, sceneParams } from '../eval/scene.mjs';
import { eq } from '../eval/metrics.mjs';

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
    embedModel: 'check-embed',
    books: {
        B: {
            1: entry(1, { vectorized: true }),
            5: entry(5, { vectorized: true }),
            2: entry(2, { key: ['spire'] }),   // keyword-only, matches below
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
    // Neither form may come from a default; centroidPopulation is pinned because this book has no STMB markers, so 'memory' would fall back to the whole collection.
    const P = sceneParams(S, { denseAllEntries: false, centroidPopulation: 'vectorized', ...overrides });
    const scene = loadScene(S, { indexFile, params: P });
    const rows = makeCandidateSet({ ...scene, params: P })(2, 0.75, null, QV, 'text of entry', () => ['the spire looms over the quarter']);
    return { scene, byUid: new Map(rows.map(r => [r.uid, r])) };
};

const base = rowsOf(ORDINARY, {});
const dense = rowsOf(ALL, { denseAllEntries: true });

// --- the baseline does not move --------------------------------------------------------------------
eq(dense.scene.loaded[0].items.length, 2, 'stage 1 keeps only the vectorized chunks of an --all index');
eq(dense.scene.loaded[0].extra.length, 2, 'the rest are held aside for stage 3');
eq([...dense.scene.loaded[0].mean].join(','), [...base.scene.loaded[0].mean].join(','),
    'the corpus mean is the vectorized corpus\'s, unchanged by the extra chunks');
eq(dense.byUid.get(1).score, base.byUid.get(1).score, 'a vectorized entry\'s cosine is untouched');
eq(dense.byUid.get(5).score, base.byUid.get(5).score, 'so is its sibling\'s');

// --- scoring only, never admission -----------------------------------------------------------------
eq([...base.byUid.keys()].sort().join(','), '1,2,5', 'baseline: two retrieved entries and the one whose key matched');
eq([...dense.byUid.keys()].sort().join(','), '1,2,5', 'dense-all ranks exactly the same rows — a cosine admits nothing');
eq(dense.byUid.has(3), false, 'an entry in the --all index that no key activated still gets no row');

// --- the entry that gains the signal ---------------------------------------------------------------
eq(base.byUid.get(2).score, undefined, 'baseline: a keyword-only entry has no cosine');
eq(base.byUid.get(2).vectorEligible, false, 'and is not ranked as though it lost one');
eq(Number.isFinite(dense.byUid.get(2).score), true, 'dense-all: it earns one');
eq(dense.byUid.get(2).vectorEligible, true, 'and becomes eligible, so the vector weight enters its denominator');
eq(dense.byUid.get(2).keywordScore > 0, true, 'its keys still score — the cosine is added evidence, not a replacement');

// --- pointed at the wrong collection ---------------------------------------------------------------
let threw = false;
try { rowsOf(ORDINARY, { denseAllEntries: true }); } catch { threw = true; }
eq(threw, true, 'denseAllEntries against an ordinary index throws rather than reporting flat');

rmSync(DIR, { recursive: true, force: true });
