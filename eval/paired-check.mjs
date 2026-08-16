// Self-check for the paired estimator (metrics.mjs signTest) and scene.mjs's arm-reuse guard. The scoring
// half needs a vector index so it can't run here; what CAN be pinned offline is the statistic every claim
// about a default will rest on, and the exact p-values that set the floor on what single-digit n can say.
import { eq, eqNear, signTest, gradeCredit, fbeta, RECALL_WEIGHT } from './metrics.mjs';
import { sceneParams, ndcg, dcg, nrm, wiTitle, makeGradeOf, makeKeywordScore, scoreScene, tierRecall } from './scene.mjs';
import { rowKey } from '../extension/grading.mjs';
import { fuseRanks } from '../extension/ranking.mjs';

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

// --- tierRecall: the guard that catches a selection trading a hard class for an easy one ---------------
// memory (~7% relevant here) and reference (~30%) have very different base rates, so an arm that favours
// the denser class raises every pooled metric while delivering less of what the system retrieves. This
// splits delivered recall so that shows up. Ungraded counts as not relevant, matching the `?? 0` rule the
// windows use; identity comparison, since kept holds the same row objects the population does.
const memRow = (uid, grade) => ({ uid, grade, entry: { uid, stmemorybooks: {} } });
const refRow = (uid, grade) => ({ uid, grade, entry: { uid } });
const tierPop = [memRow(1, 4), memRow(2, 3), memRow(3, 0), refRow(4, 3), refRow(5, 3), refRow(6, 1)];
const gradeOfRow = r => r.grade;
const split = tierRecall(tierPop, [tierPop[0], tierPop[3], tierPop[4], tierPop[5]], gradeOfRow);
eq(split.memory.of, 2, 'both relevant memory rows are in the memory denominator');
eq(split.memory.got, 1, '...and only the delivered one counts');
eq(split.reference.of, 2, 'the relevant reference rows are counted separately');
eq(split.reference.got, 2, '...and both were delivered — the imbalance this exists to show');
eq(tierRecall(tierPop, [], gradeOfRow).memory.got, 0, 'delivering nothing scores zero rather than throwing');
eq(tierRecall(tierPop, tierPop, () => null).memory.of, 0, 'an ungraded population has no relevant rows to recall');
// A row equal by uid but not by identity must NOT count: the kept set holds the population's own objects,
// and a uid join here would be a second rule for the same question.
eq(tierRecall(tierPop, [memRow(1, 4)], gradeOfRow).memory.got, 0, 'a copy of a kept row is not the kept row');

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

// Grade matching is token-subset, and out-of-scope titles resolve to null rather than their grade.
// null, not 0, is the whole point: a judged 0 is a verdict and an absent grade is a hole in the pool,
// and callers treat them differently (nDCG coerces with `?? 0`; a delivery rule must not).
const gradeOf = makeGradeOf(
    [{ title: 'Villa Victory Party', grade: 5 }, { title: 'Intimacy & Mechanics', grade: 4 }],
    title => nrm(title).includes('mechanics'),
);
eq(gradeOf('176 - Villa Victory Party'), 5, 'a graded title matches by token subset');
eq(gradeOf('Intimacy & Mechanics'), null, 'an excluded title has no usable verdict, not its grade');
eq(gradeOf('Something Else'), null, 'an ungraded title is null, distinct from a judged 0');
eq(makeGradeOf([{ title: 'Villa', grade: 0 }], () => false)('Villa'), 0, 'a judged 0 stays 0 and is not confused with unjudged');

// uid is authoritative when every grade carries one (every /wa-grade sample does) — the misattribution the
// title heuristic allows is "Villa" also matching "Villa Party", first-found wins.
const byUid = makeGradeOf(
    [{ title: 'Villa', grade: 5, uid: 1 }, { title: 'Villa Party', grade: 2, uid: 2 }],
    () => false,
);
eq(byUid({ uid: 2, title: 'Villa Party' }), 2, 'uid match beats the token-subset title match');
eq(byUid({ uid: 9, title: 'Villa Party Annex' }), null, 'uid-complete grades: an unknown uid is ungraded, never title-guessed');
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
eq(jaccard([rowKey({ world: 'A', uid: 1 })], [rowKey({ world: 'B', uid: 1 })]), 0,
    'same uid in different books is not shared relevance');

// --- Spearman, tie-corrected (metrics.mjs) ---
// Graded pools are half zeros, so tie handling is not a nicety: with the shortcut formula the coefficient
// depends on how the sort broke ties, i.e. on array order.
const { spearman } = await import('./metrics.mjs');
eq(spearman([1, 2, 3], [1, 2, 3]), 1, 'identical order -> +1');
eq(spearman([1, 2, 3], [3, 2, 1]), -1, 'reversed order -> -1');
eq(Number.isNaN(spearman([1, 1, 1], [1, 2, 3])), true, 'no variance -> NaN, not a fake 0');
eq(Number.isNaN(spearman([1], [1])), true, 'n<2 -> NaN');
// THE TIE PROPERTY: a tied block must not depend on input order. Same data, permuted, same answer.
const tx = [0, 0, 0, 1, 2], ty = [0, 1, 0, 2, 3];
const px = [0, 1, 0, 0, 2], py = [0, 2, 1, 0, 3];
eq(Math.abs(spearman(tx, ty) - spearman(px, py)) < 1e-12, true, 'tied blocks are order-independent (midranks)');
// A perfect monotone relation with ties on ONE side cannot reach 1, and must not exceed it.
eq(spearman([0, 0, 1, 2], [0, 1, 2, 3]) < 1, true, 'ties on one side cap the coefficient below 1');
eq(spearman([0, 0, 1, 2], [0, 1, 2, 3]) > 0.8, true, '...but still reports a strong positive');
eq(Math.abs(spearman([1, 2, 3, 4], [2, 4, 6, 8]) - 1), 0, 'monotone rescaling is still +1');

// --- keywordWeight: separable from lexicalWeight, mirroring it when unset ---
// The split exists because the two signals disagree about which books they are good on: measured optima
// were (text 0.5, keys 3), (1.5, 0) and (1.5, 1) across three scenes, and one coupled knob can reach none
// of them. Mirroring on null is what keeps an upgrade byte-identical for anyone running LEXW != 1.
const mkRows = () => [
    { key: 1, score: 0.9, textScore: 10, keywordScore: 1 },
    { key: 2, score: 0.1, textScore: 1, keywordScore: 50 },
];
const fusedWith = opts => { const r = mkRows(); fuseRanks(r, { rrfK: 20, retrievalMode: 'hybrid', weightByOrder: false, ...opts }); return r.map(x => x.fused); };
eq(JSON.stringify(fusedWith({ lexicalWeight: 1.5 })), JSON.stringify(fusedWith({ lexicalWeight: 1.5, keywordWeight: undefined })), 'undefined keywordWeight mirrors lexicalWeight');
eq(JSON.stringify(fusedWith({ lexicalWeight: 1.5 })), JSON.stringify(fusedWith({ lexicalWeight: 1.5, keywordWeight: null })), 'null keywordWeight mirrors lexicalWeight');
eq(JSON.stringify(fusedWith({ lexicalWeight: 1.5 })) === JSON.stringify(fusedWith({ lexicalWeight: 1.5, keywordWeight: 3 })), false, 'an explicit keywordWeight actually changes the fusion');
// 0 must mean "ignore keys", not "fall back to lexicalWeight" — (1.5, 0) was one of the three optima, so
// the nullish coalesce has to distinguish 0 from unset.
const keysOff = fusedWith({ lexicalWeight: 1.5, keywordWeight: 0 });
const keysOn = fusedWith({ lexicalWeight: 1.5, keywordWeight: 1.5 });
eq(keysOff[1] < keysOn[1], true, 'keywordWeight 0 suppresses the keys contribution rather than mirroring');
// PIN THE ARITHMETIC, not just the ordering. Row 2 overtakes row 1 at keywordWeight 3 by a thin margin,
// and any change to the fusion formula would flip it silently with the failure reading as "keywordWeight
// stopped working". So assert the whole expression: keyW multiplies that row's keyword-rank term in the
// numerator AND joins its eligibility denominator, which is why it no longer scales the term linearly.
// Both rows here declare no eligibility, so all three signals are present and all three are eligible.
const heavy = fusedWith({ lexicalWeight: 1.5, keywordWeight: 3 });
const near = (a, b, why) => eq(Math.abs(a - b) < 1e-12, true, why);
const expect = (vr, tr, kr, W) => (1 / (20 + vr) + 1.5 / (20 + tr) + W / (20 + kr)) / (1 + 1.5 + W);
near(heavy[0], expect(1, 1, 2, 3), 'row 1: vector 1, text 1, keyword 2, normalised by 1+LEXW+keyW');
near(heavy[1], expect(2, 2, 1, 3), 'row 2: vector 2, text 2, keyword 1, same denominator');
near(keysOff[0], expect(1, 1, 2, 0), '...and at keywordWeight 0 the keys term leaves both sides');

// ELIGIBILITY NORMALISATION — the point of the divisor. An entry is not measured against a signal it could
// never earn: top of what it was eligible for ties top of all three. Before this, a keys-only ceiling was
// keyW/(k+1) against (1+LEXW+keyW)/(k+1) — 37% at shipped weights, unreachable by any key.
//
// TEXT ELIGIBILITY IS NO LONGER "IS IT VECTORIZED". content-lexical.mjs indexes every entry's content, so a
// keyword entry with a body can earn a text rank and is divided by lexicalWeight like anything else. The
// signal-starved case that remains is an entry with NO content — keys and nothing to index.
const fuse1 = rows => { fuseRanks(rows, { rrfK: 20, retrievalMode: 'hybrid', weightByOrder: false, lexicalWeight: 1.5, keywordWeight: 1.5 }); return rows[0].fused; };
const keywordOnlyTop = fuse1([{ key: 1, keywordScore: 5, textScore: 0, vectorEligible: false, textEligible: false, keysEligible: true }]);
const everySignalTop = fuse1([{ key: 1, score: 0.9, textScore: 9, keywordScore: 5, vectorEligible: true, keysEligible: true }]);
near(everySignalTop, 1 / 21, 'an entry topping all three signals scores 1/(k+1)');
near(keywordOnlyTop / 1.25, everySignalTop, '...and normalisation alone puts a keyword-only entry level with it (tilt asserted below)');

// ELIGIBILITY, NOT PRESENCE. A vectorized entry that failed to rank on cosine or text is still divided by
// those weights — it competed and lost. Normalising by signals PRESENT would instead reward it for the
// miss, handing the weakest vector entry the same ceiling as the strongest.
const missedItsChance = fuse1([{ key: 1, score: undefined, textScore: 0, keywordScore: 5, vectorEligible: true, keysEligible: true }]);
near(missedItsChance, (1.5 / 21) / 4, 'a vectorized entry with only a keyword rank still divides by 1+LEXW+keyW');
eq(missedItsChance < keywordOnlyTop, true, '...so it ranks below a keyword-only entry that earned the same rank');

// THE TIE-BREAK. All else equal a keyword-only entry outranks a vectorized one; a STRONG vector entry still
// beats a MID keyword one. Both halves are asserted because only the pair pins the tilt's size — a large
// enough multiplier satisfies the first and breaks the second, which is the failure worth catching.
near(keywordOnlyTop, 1.25 / 21, 'a keyword-only entry takes the tilt');
// Injectable, because anything that hands a keyword-only entry a cosine takes the tilt away with it
// (scene.mjs denseAllEntries) and the two halves have to be separable to be readable.
const untilted = rows => { fuseRanks(rows, { rrfK: 20, retrievalMode: 'hybrid', weightByOrder: false, lexicalWeight: 1.5, keywordWeight: 1.5, keywordOnlyTilt: 1 }); return rows[0].fused; };
near(untilted([{ key: 1, keywordScore: 5, textScore: 0, vectorEligible: false, textEligible: false, keysEligible: true }]), 1 / 21, 'an injected tilt of 1 removes it, leaving normalisation alone');

// A NULL SCORE IS NOT A COSINE. `null !== undefined` let a caller marking "no cosine" with null enter the
// vector rank list at effectively 0 — numerator credit with no denominator term, since vectorEligible was
// false. Measured at 0.0122 mean nDCG@10 across 66 scenes, larger than the effect under test that run.
const nullScored = fuse1([{ key: 1, score: null, keywordScore: 5, textScore: 0, vectorEligible: false, textEligible: false, keysEligible: true }]);
near(nullScored, keywordOnlyTop, 'score:null fuses identically to score:undefined — no vector rank, tilt intact');

// THE SECOND SIGNAL, which is what content-lexical buys a keyword entry. Eligible for text as well as keys,
// it reaches the ceiling only by topping BOTH — winning on keys alone no longer ties an entry that won on
// everything. That is the point: one noisy signal used to decide where a keyword entry landed.
const bodiedBoth = fuse1([{ key: 1, keywordScore: 5, textScore: 9, vectorEligible: false, textEligible: true, keysEligible: true }]);
const bodiedKeysOnly = fuse1([{ key: 1, keywordScore: 5, textScore: 0, vectorEligible: false, textEligible: true, keysEligible: true }]);
near(bodiedBoth, 1.25 / 21, 'a keyword entry topping keys AND text reaches the same ceiling');
eq(bodiedKeysOnly < bodiedBoth, true, '...and one topping keys alone does not, being divided by lexicalWeight too');
eq(keywordOnlyTop > everySignalTop, true, 'all else equal, the keyword-only entry wins');
const kwAtRank = r => { const rows = [{ key: 0, keywordScore: 100, vectorEligible: false, keysEligible: true }]; for (let i = 1; i < r; i++) rows.unshift({ key: -i, keywordScore: 100 + i, vectorEligible: false, keysEligible: true }); fuseRanks(rows, { rrfK: 20, retrievalMode: 'hybrid', weightByOrder: false, lexicalWeight: 1.5, keywordWeight: 1.5 }); return rows.find(x => x.key === 0).fused; };
eq(kwAtRank(6) > everySignalTop, true, 'a keyword entry at rank 6 still clears the best vector entry');
eq(kwAtRank(7) < everySignalTop, true, '...and at rank 7 it does not: a strong vector entry beats a mid keyword one');
// Which is what lets it reorder: the same arithmetic, read as a ranking.
eq(heavy[1] > heavy[0], true, 'a high keywordWeight can promote a keys-dominant entry');
eq(keysOff[1] < keysOff[0], true, '...and suppressing keys demotes it again');
// NaN must not reach the fusion: it is neither null nor undefined, so a `??` would pass it through and
// every fused score becomes NaN — no throw, just a ranking silently left in input order.
eq(JSON.stringify(fusedWith({ lexicalWeight: 1.5 })), JSON.stringify(fusedWith({ lexicalWeight: 1.5, keywordWeight: NaN })), 'a NaN keywordWeight falls back to lexicalWeight rather than NaN-ing every score');

// --- SET METRICS. The half-credit rule and the exchange rate are two separate judgements (metrics.mjs), and
// the failure worth catching is the one that inverts an incentive rather than one that throws.
eq(gradeCredit(4), 1, 'a 4 is delivered correctly');
eq(gradeCredit(3), 1, 'a 3 is too — the bar for "should be included"');
eq(gradeCredit(2), 0.5, 'a 2 is 50/50 on inclusion, so it credits half');
eq(gradeCredit(2.5), 0.5, 'a half-grade credits by its BAND, not by interpolation');
eq(gradeCredit(1.5), 0, '...and below 2 nothing is earned');
eq(gradeCredit(1), 0, 'a 1 is filler');
eq(gradeCredit(0), 0, 'a 0 is an error');

// THE INCENTIVE, which is the whole point of the half: adding a 2 to a delivered set must not raise
// precision. Under the old `>= 2` full-credit count it did, so padding with ambiguity scored better.
const prec = grades => grades.reduce((s, x) => s + gradeCredit(x), 0) / grades.length;
eq(prec([4, 3]) === 1, true, 'two confident hits are precision 1');
eq(prec([4, 3, 2]) < prec([4, 3]), true, 'adding a 2 LOWERS precision from 1 — ambiguity is not a win');
eq(prec([2, 2, 2]), 0.5, 'a set of nothing but 2s sits at 0.5, neither rewarded nor condemned');
eq(prec([4, 3, 0]) < prec([4, 3, 2]), true, '...and a 0 still costs more than a 2');
eq(prec([1, 2]) > prec([1, 1]), true, 'a 2 beats a 1, so the bands stay ordered');

// THE FIXED POINT IS THE SEMANTIC CLAIM. Adding a 2 pulls precision toward 0.5 from either side, so a set
// already better than 50/50 is hurt by one and a set worse than 50/50 is helped. That neutral point is
// what the anchor's "50/50 on inclusion" means, expressed as arithmetic — and it is the whole difference
// between this rule and its two neighbours: full credit has its fixed point at 1.0 and so rewards padding
// with ambiguous entries at every realistic level, and a hard >=3 bar has none below 1 and so punishes a
// 2 as if it were an error. Pin it, because either neighbour is a one-character edit away.
eq(prec([4, 4, 3, 3]) > prec([4, 4, 3, 3, 2, 2]), true, 'a 2 LOWERS precision on a set above 50/50');
eq(prec([3, 1, 0, 0]) < prec([3, 1, 0, 0, 2, 2]), true, '...and RAISES it on a set below');
eqNear(prec([4, 3, 1, 0]), prec([4, 3, 1, 0, 2, 2]), 'and does nothing at exactly 50/50 — the fixed point');

// F-beta at the stated exchange rate. beta=2 makes recall count 4x precision in the harmonic weighting,
// so an arm trading precision for recall reads positive — asserted against hand-computed values.
eq(RECALL_WEIGHT, 2, 'a lost relevant entry is held to cost at least twice a gained irrelevant one');
eqNear(fbeta(1, 1, 2), 1, 'perfect on both is 1');
eqNear(fbeta(0.5, 1, 2), (5 * 0.5) / (4 * 0.5 + 1), 'F2 formula matches the closed form it replaced');
eq(fbeta(0.5, 1, 2) > fbeta(1, 0.5, 2), true, 'at beta=2, high recall beats the mirrored high precision');
eq(fbeta(0.5, 1, 1) === fbeta(1, 0.5, 1), true, '...and at beta=1 the two are symmetric, which is what beta buys');
eq(fbeta(0, 0, 2), 0, 'no signal either way is 0, not NaN');
eq(fbeta(0, 1, 2), 0, 'zero precision cannot be rescued by recall');
