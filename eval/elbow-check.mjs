// Self-test for the shared cutoff. Imports the real selection.mjs (no more string-slicing worldsapart.js)
// and maps each test's cfg into the injected settings.
import { cutRetrieved as cut } from '../extension/selection.mjs';
import { admitCeiling } from '../plugin/scoring.mjs';   // stage-1 bound; lives beside poolEntries, which is what makes K mean entries or chunks
let cfg;
const cutRetrieved = (ranked) => cut(ranked, {
    mode: cfg.vectorCutoff,
    minVectorEntries: cfg.minVectorEntries,
    elbowSensitivity: cfg.elbowSensitivity,
    dropoffThreshold: cfg.dropoffThreshold,
});
const mk = (...f) => f.map(fused => ({ fused }));
const n = r => r.length;
import { eq } from './metrics.mjs';

cfg = { vectorCutoff: 'off', minVectorEntries: 3, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,8,7,6,5,4,3,2,1,0.5,0.4,0.3))), 12, 'off mode keeps the whole list — bounding it is the entry maxes job');
eq(n(cutRetrieved(mk(9,8))), 2, 'off mode on a short list');
// 'count' retired: maxVectorEntries IS the count now, and it is enforced at stage 4 by the entry maxes.
// An unknown mode must behave as 'off' rather than throwing — a stored setting outlives a rename.
cfg = { vectorCutoff: 'count', minVectorEntries: 3, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,8.9,8.8,8.7,1,0.9,0.8))), 7, 'a retired or unknown mode falls through to no cut');

cfg = { vectorCutoff: 'elbow', minVectorEntries: 3, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,8.9,8.8,8.7,1,0.9,0.8,0.7,0.6,0.5))), 4, 'cuts at the cliff');
eq(n(cutRetrieved(mk(9,1,0.9,0.8,0.7,0.6))), 6, 'cliff before the floor is ignored, flat tail kept whole');
eq(n(cutRetrieved(mk(9,8.9,8.8,8.7,8.6,8.5,1,0.9,0.8,0.7))), 6, 'cliff deep in the list');
eq(n(cutRetrieved(mk(9,8,7))), 3, 'candidates == floor, no loop, keeps all');
eq(n(cutRetrieved(mk(9,8))), 2, 'candidates below floor');
eq(n(cutRetrieved(mk(9))), 1, 'single candidate');
eq(n(cutRetrieved([])), 0, 'empty');

cfg = { vectorCutoff: 'elbow', minVectorEntries: 1, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,1,0.9,0.8))), 1, 'floor 1 does cut at rank 1-2');

// The cliff is PURELY relevance. It takes no count, so a flat ranking survives it whole and the entry
// maxes — a separate cut — decide how many of those rows ship.
cfg = { vectorCutoff: 'elbow', minVectorEntries: 3, elbowSensitivity: 1.5 };
eq(n(cutRetrieved(mk(9,8,7,6,5,4,3,2,1,0,-1,-2))), 12, 'an evenly-spaced ranking has no elbow and is kept whole');
eq(n(cutRetrieved(mk(9,8.9,8.8,8.7,1,0.9,0.8,0.7,0.6,0.5,0.4,0.3))), 4, 'a cliff deep in a long list still cuts at the cliff');
eq(n(cutRetrieved(mk(...Array.from({ length: 200 }, (_, i) => 100 - i)))), 200, 'no arbitrary ceiling: 200 evenly-spaced rows all survive');

// --- last-significant-gap: two cliffs, keep the cluster between them ---
// Large drop after pos2, a plateau, then a second drop after pos7. Largest gap is the
// first; cutting there discards the plateau. Last significant gap keeps it.
cfg = { vectorCutoff: 'elbow', minVectorEntries: 3, elbowSensitivity: 1.5 };
const twoCliff = mk(0.0952, 0.0909, 0.0805, 0.0713, 0.0694, 0.0690, 0.0686, 0.0678, 0.0610, 0.0577);
eq(n(cutRetrieved(twoCliff)), 8, 'two cliffs: keeps through the plateau to the last cliff (real Villa query)');

// Sensitivity raises the bar: at a high enough multiple only the biggest cliff qualifies,
// so it reverts to the early aggressive cut.
cfg = { ...cfg, elbowSensitivity: 2.5 };
eq(n(cutRetrieved(twoCliff)), 3, 'high sensitivity: only the largest cliff counts, cuts early');
cfg = { ...cfg, elbowSensitivity: 1.5 };

// --- dropoff: cut at a gap larger than a fixed fraction of the top score ---
cfg = { vectorCutoff: 'dropoff', minVectorEntries: 3, dropoffThreshold: 0.1 };
// top=1.0 so threshold=0.1; only the 0.15 drop after pos6 clears it.
eq(n(cutRetrieved(mk(1.0, 0.98, 0.96, 0.94, 0.92, 0.90, 0.75, 0.73, 0.71, 0.69))), 6, 'dropoff: cuts where a gap exceeds 0.1 x top');
eq(n(cutRetrieved(mk(1.0, 0.98, 0.96, 0.94, 0.92, 0.90, 0.88, 0.86, 0.84, 0.82))), 10, 'dropoff: no gap clears the bar, keeps whole');

// The two real RRF rankings, fused = 1/(20+vRank) + 1/(20+kRank) from /wa-debug.
const K = 20;
const fused = pairs => pairs.map(([v, k]) => 1 / (K + v) + 1 / (K + k));
const oe = [[1,3],[3,1],[4,2],[2,5],[5,6],[9,4],[6,10],[7,11],[12,7],[8,12],[11,9],[14,8],[10,13],[18,14],[19,16],[15,23],[17,21],[13,28],[20,19],[16,25]];
const vg = [[4,3],[2,13],[5,8],[16,1],[1,18],[8,7],[3,15],[17,4],[9,12],[32,2],[15,9],[12,20],[52,5],[7,41],[55,6],[10,39],[14,29],[45,10],[6,85],[50,11]];
cfg = { vectorCutoff: 'dropoff', minVectorEntries: 3, dropoffThreshold: 0.06 };
eq(n(cutRetrieved(mk(...fused(oe)))), 13, 'dropoff: Orient-Express cuts at the rank 13->14 cliff');
eq(n(cutRetrieved(mk(...fused(vg)))), 11, 'dropoff: Vegas cuts at the real rank 11->12 cliff the elbow missed');

// --- admitCeiling: stage 1's bound, which counts a different thing on each retrieval path ------------
eq(admitCeiling(true), 1000, 'plugin path: K counts ENTRIES, because poolEntries ran server-side');
eq(admitCeiling(false), 10000, 'fallback path: K counts CHUNKS, so it must cover each entry s best one');
eq(admitCeiling(undefined), 10000, 'unknown pooling is treated as unpooled — the safe direction is more chunks');
eq(admitCeiling(true) < admitCeiling(false), true, 'the chunk ceiling is the larger of the two');
// A SANITY BOUND, NOT A CUT. At 100 entries this fired on ordinary scenes and cost 23 of 672 graded-relevant
// entries; the largest book in the graded corpus holds 208 vectorized entries. If either number ever drops
// near a real book's size again, it has stopped being a safety limit.
eq(admitCeiling(true) > 4 * 208, true, 'the entry ceiling clears the largest measured book several times over');
