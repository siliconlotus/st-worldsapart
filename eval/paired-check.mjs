// Self-check for the paired estimator (metrics.mjs signTest) and scene.mjs's arm-reuse guard. The scoring
// half needs a vector index so it can't run here; what CAN be pinned offline is the statistic every claim
// about a default will rest on, and the exact p-values that set the floor on what single-digit n can say.
import { signTest } from './metrics.mjs';
import { sceneParams, ndcg, dcg, nrm, wiTitle, makeGradeOf, makeKeywordScore, scoreScene } from './scene.mjs';
import { eq } from './metrics.mjs';

// --- exact two-sided sign-test p-values. These are the numbers that decide whether a screening hit is
// reportable, so they are asserted against hand-computed binomials rather than trusted.
eq(signTest([1, 1, 1, 1, 1, 1]).p, 0.03125, '6/6 one direction -> p=0.03125 (2/64)');
eq(signTest([-1, -1, -1, -1, -1]).p, 0.0625, '5/5 one direction -> p=0.0625 (2/32)');
eq(signTest([1, 1, 1, 1]).p, 0.125, '4/4 -> p=0.125');
eq(signTest([1, 1, 1]).p, 0.25, '3/3 -> p=0.25, which is NOT significance');
eq(signTest([1, 1, 1, 1, 1, -1]).p, 0.21875, '5-1 of 6 -> p=0.21875 (14/64)');
eq(signTest([1, 1, -1, -1]).p, 1, 'an even split is capped at p=1, never above');

// Direction bookkeeping.
const s6 = signTest([0.01, 0.02, 0.005, 0.03, 0.01, 0.02]);
eq(s6.plus, 6, 'every positive delta counted');
eq(s6.consistent, true, 'all-one-way is flagged consistent');
eq(signTest([0.01, -0.01, 0.02]).consistent, false, 'a mixed direction is not consistent');
// A single scene cannot be consistent with itself — pairing needs pairs, and 1/1 would otherwise read as a
// clean sweep at p=1.0, which invites exactly the overclaim this whole tool exists to prevent.
eq(signTest([0.05]).consistent, false, 'one scene is never "consistent"');
eq(signTest([]).n, 0, 'no deltas -> nothing to test');
eq(signTest([]).p, 1, 'no deltas -> p=1, not NaN');

// Ties are dropped, which SHRINKS n (conservative). A parameter that changes nothing on most scenes must not
// borrow significance from the one scene it moved.
const t = signTest([0, 0, 0.02]);
eq(t.ties, 2, 'exact zeros are ties');
eq(t.n, 1, 'ties are excluded from n');
eq(t.p, 1, 'one non-tie cannot be significant');
eq(signTest([1e-12, -1e-12, 0.5]).ties, 2, 'sub-epsilon deltas are ties, not directions');
// mean is over ALL scenes including ties: the effect size has to reflect the flat ones, or a parameter that
// helps once and does nothing five times reports as a large effect.
eq(Math.abs(signTest([0, 0, 0.03]).mean - 0.01) < 1e-12, true, 'mean delta includes tied scenes');

// --- sceneParams layering: harness defaults < the sample's captureParams < the arm's override ---
const S = { captureParams: { K1: 2, LEXW: 1.5 } };
eq(sceneParams(S).K1, 2, 'a sample overrides the harness default');
eq(sceneParams(S).B, 0.75, 'unspecified params fall back to the harness default');
eq(sceneParams(S, { K1: 3 }).K1, 3, 'an arm override beats the sample');
eq(sceneParams(S, { K1: 3 }).LEXW, 1.5, 'an arm override leaves other params on the sample baseline');
eq(sceneParams({}).entityFilter, true, 'a sample with no captureParams still gets a full param set');

// --- the arm-reuse guard: reusing a loaded scene is only valid while the gazetteer is unchanged ---
// suppressVectorKeys is baked in at load time, and a stale gazetteer has already cost this project a 74%
// BM25 error, so sweeping it against a preloaded scene must throw rather than quietly mislead.
let threw = false;
try {
    await scoreScene({ sample: S, overrides: { suppressVectorKeys: false }, scene: { fake: true }, qv: [0] });
} catch { threw = true; }
eq(threw, true, 'sweeping suppressVectorKeys against a preloaded scene throws');

// --- shared metric + title helpers (moved into scene.mjs; pin them where they now live) ---
eq(ndcg([3, 2, 1], 3).toFixed(4), '1.0000', 'a perfectly ordered grade vector is nDCG 1');
eq(ndcg([1, 2, 3], 1) < 1, true, 'a badly ordered vector scores below 1');
eq(ndcg([0, 0, 0], 5), 0, 'no relevance -> 0, not NaN');
// The property that makes excludeTitles free: the ideal comes from the RANKED vector, so a title that never
// gets ranked changes neither DCG nor the ideal.
eq(ndcg([3, 0], 2), ndcg([3, 0], 2), 'ideal DCG is built from the ranked vector');
eq(dcg([1, 1], 1), 1, 'dcg respects k');
eq(nrm('176 - Villa Victory Party!').join(','), '176,villa,victory,party', 'nrm keeps alphanumeric tokens, drops singles');
eq(wiTitle({ comment: ' Villa ', uid: 1 }), 'Villa', 'title prefers the trimmed comment');
eq(wiTitle({ comment: '', key: ['a', 'b'], uid: 1 }), 'a, b', 'title falls back to keys');
eq(wiTitle({ comment: '', key: [], uid: 7 }), 'UID 7', 'title falls back to uid');

// Grade matching is token-subset, and out-of-scope titles resolve to 0 rather than their grade.
const gradeOf = makeGradeOf(
    [{ title: 'Villa Victory Party', grade: 5 }, { title: 'Intimacy & Mechanics', grade: 4 }],
    title => nrm(title).includes('mechanics'),
);
eq(gradeOf('176 - Villa Victory Party'), 5, 'a graded title matches by token subset');
eq(gradeOf('Intimacy & Mechanics'), 0, 'an excluded title scores 0, not its grade');
eq(gradeOf('Something Else'), 0, 'an ungraded title scores 0');

// uid is authoritative when every grade carries one (every /wa-grade sample does) — the misattribution the
// title heuristic allows is "Villa" also matching "Villa Party", first-found wins.
const byUid = makeGradeOf(
    [{ title: 'Villa', grade: 5, uid: 1 }, { title: 'Villa Party', grade: 2, uid: 2 }],
    () => false,
);
eq(byUid({ uid: 2, title: 'Villa Party' }), 2, 'uid match beats the token-subset title match');
eq(byUid({ uid: 9, title: 'Villa Party Annex' }), 0, 'uid-complete grades: an unknown uid is ungraded, never title-guessed');
eq(byUid({ key: 1, title: 'anything' }), 5, 'retrieval rows keyed by `key` resolve by uid too');
// A mixed set (some grades lack uids) falls back to titles wholesale rather than half-and-half.
eq(makeGradeOf([{ title: 'Villa', grade: 5, uid: 1 }, { title: 'Other', grade: 3 }], () => false)({ uid: 9, title: 'Other Thing' }), 3,
    'a grade set missing uids resolves every row by title');

// --- keyword scoring honours production's key suppression (worldsapart.js suppressKeys) ---
// Samples embed books raw, so vectorized entries still carry keys the live scan would have blanked; scoring
// them gave vectorized entries a keys signal production can never produce.
const kwP = makeKeywordScore(sceneParams({}));   // suppressVectorKeys true, scoreVectorKeys false — the defaults
eq(kwP({ vectorized: true, key: ['villa'] }, 'meet me at the villa', 1.2), 0, 'vectorized keys are suppressed, as the live scan sees them');
eq(kwP({ vectorized: false, key: ['villa'] }, 'meet me at the villa', 1.2) > 0, true, 'non-vectorized keys still score');
eq(makeKeywordScore(sceneParams({ captureParams: { scoreVectorKeys: true } }))({ vectorized: true, key: ['villa'] }, 'meet me at the villa', 1.2) > 0,
    true, 'scoreVectorKeys re-admits the originals, as production scores waKeys');

// --- scene independence (jaccard on relevant sets) ---
// Pseudo-replication is the failure: two near-identical scenes counted as two draws invent power the data
// does not have, and the sign test cannot detect it on its own.
const { jaccard } = await import('./metrics.mjs');
eq(jaccard([1, 2, 3], [1, 2, 3]), 1, 'identical relevant sets -> 1');
eq(jaccard([1, 2], [3, 4]), 0, 'disjoint relevant sets -> 0');
eq(jaccard([1, 2, 3, 4], [3, 4, 5, 6]), 1 / 3, 'half-shared -> |int|/|union|');
eq(jaccard([], []), 0, 'two empty sets are 0, not NaN');
eq(jaccard([1], []), 0, 'one empty set is 0');
eq(jaccard(new Set([1, 2]), new Set([2])), 0.5, 'accepts Sets as well as arrays');
// Grade-keyed identity: same uid in different books is not the same entry, so it must not read as overlap.
const { rowKey } = await import('../extension/grading.mjs');
eq(jaccard([rowKey({ world: 'A', uid: 1 })], [rowKey({ world: 'B', uid: 1 })]), 0,
    'same uid in different books is not shared relevance');
