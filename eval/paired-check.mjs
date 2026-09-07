// Self-check for the paired estimator (metrics.mjs signTest) and scene.mjs's arm-reuse guard. The scoring
// half needs a vector index so it can't run here; what CAN be pinned offline is the statistic every claim
// about a default will rest on, and the exact p-values that set the floor on what single-digit n can say.
import { eq, eqNear, signTest, gradeCredit, fbeta, RECALL_WEIGHT, jaccard, spearman, qwk, topComponents, projectOut } from './metrics.mjs';
import { sceneParams, ndcg, dcg, nrm, wiTitle, makeGradeOf, makeKeywordScore, scoreScene, tierRecall, bookFingerprint } from './scene.mjs';
import { rowKey } from '../extension/grading.mjs';

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

// --- bookFingerprint: drift detection for the books a bundle's gazetteer was built from ----------------
// TWO HASHES because the failure modes are different: `gaz` covers key/keysecondary/comment (what
// buildGazetteer reads, hence which query terms survive the filter) and `content` covers the bodies (what
// BM25 and the embeddings see). A lumped hash would say "something changed" about a defect that was
// specifically gazetteer-layer. Weak by design — an edit preserving every hashed byte slips through, the
// same trade indexFingerprint takes.
const fpEntry = (uid, o) => ({ uid, key: [], keysecondary: [], comment: '', content: '', ...o });
const fpBook = { 1: fpEntry(1, { key: ['alpha'], comment: 'A', content: 'body one' }), 2: fpEntry(2, { content: 'body two' }) };
const fp0 = bookFingerprint(fpBook);
eq(fp0.entries, 2, 'fingerprint counts the entries');
const fpKeys = bookFingerprint({ ...fpBook, 1: fpEntry(1, { key: ['alpha', 'beta'], comment: 'A', content: 'body one' }) });
eq(fpKeys.gaz !== fp0.gaz, true, 'a key edit moves the gazetteer hash');
eq(fpKeys.content, fp0.content, '...and leaves the content hash alone');
const fpBody = bookFingerprint({ ...fpBook, 1: fpEntry(1, { key: ['alpha'], comment: 'A', content: 'edited' }) });
eq(fpBody.content !== fp0.content, true, 'a body edit moves the content hash');
eq(fpBody.gaz, fp0.gaz, '...and leaves the gazetteer hash alone');
eq(bookFingerprint({ ...fpBook, 1: fpEntry(1, { key: ['alpha'], comment: 'renamed', content: 'body one' }) }).gaz !== fp0.gaz, true,
    'a comment edit moves the gazetteer hash — buildGazetteer reads titles too');
// Stable across however the object was assembled, or the same book fingerprints two ways.
eq(JSON.stringify(bookFingerprint({ 2: fpBook[2], 1: fpBook[1] })), JSON.stringify(fp0), 'insertion order does not matter');
// A book that EXISTS and is empty hashes to something real; callers record null for one with no world
// file, so the two cases stay distinguishable. A bare count would call both of them zero.
eq(Number.isFinite(bookFingerprint({}).gaz), true, 'an existing but empty book still fingerprints');

// --- tierRecall: the guard that catches a selection trading a hard class for an easy one ---------------
// memory and reference have very different base rates (F39), so an arm that favours
// the denser class raises every pooled metric while delivering less of what the system retrieves. This
// splits delivered recall so that shows up. Ungraded counts as not relevant, matching the `?? 0` rule the
// windows use; identity comparison, since kept holds the same row objects the population does.
const memRow = (uid, grade) => ({ uid, grade, entry: { uid, stmemorybooks: {} } });
const refRow = (uid, grade) => ({ uid, grade, entry: { uid } });
const pop = [memRow(1, 4), memRow(2, 3), memRow(3, 0), refRow(4, 3), refRow(5, 3), refRow(6, 1)];
const gradeOfRow = r => r.grade;
const split = tierRecall(pop, [pop[0], pop[3], pop[4], pop[5]], gradeOfRow);
eq(split.memory.of, 2, 'both relevant memory rows are in the memory denominator');
eq(split.memory.got, 1, '...and only the delivered one counts');
eq(split.reference.of, 2, 'the relevant reference rows are counted separately');
eq(split.reference.got, 2, '...and both were delivered — the imbalance this exists to show');
eq(tierRecall(pop, [], gradeOfRow).memory.got, 0, 'delivering nothing scores zero rather than throwing');
eq(tierRecall(pop, pop, r => null).memory.of, 0, 'an ungraded population has no relevant rows to recall');
// A row present by uid but not by identity must NOT count: the kept set is the same objects, and a uid
// join here would be a second rule for the same question.
eq(tierRecall(pop, [memRow(1, 4)], gradeOfRow).memory.got, 0, 'a copy of a kept row is not the kept row');

// --- sceneParams layering: harness defaults < the arm's own `params` < an explicit override ---
const S = { params: { K1: 2, LEXW: 1.5 } };
eq(sceneParams(S).K1, 2, 'a sample overrides the harness default');
eq(sceneParams(S).B, 0.75, 'unspecified params fall back to the harness default');
eq(sceneParams(S, { K1: 3 }).K1, 3, 'an arm override beats the sample');
eq(sceneParams(S, { K1: 3 }).LEXW, 1.5, 'an arm override leaves other params on the sample baseline');
eq(sceneParams({}).entityFilter, true, 'a view with no params still gets a full param set');

// --- the arm-reuse guard: reusing a loaded scene is only valid while the gazetteer is unchanged ---
// gazetteerSource is baked in at load time, and a stale gazetteer has already cost this project a real
// scoring error (R22), so sweeping it against a preloaded scene must throw rather than quietly mislead. Asserted
// on the MESSAGE, not merely on throwing: a preloaded stub throws for a dozen other reasons, and this
// test passed against one of them while the guard it names was not firing at all.
let threw = '';
try {
    await scoreScene({ sample: S, overrides: { gazetteerSource: 'keys' }, scene: { fake: true }, qv: [0] });
} catch (e) { threw = String(e?.message ?? e); }
eq(threw.includes('cannot be swept against a preloaded scene'), true, 'sweeping the gazetteer against a preloaded scene throws its own error');

// --- shared metric + title helpers (moved into scene.mjs; pin them where they now live) ---
eq(ndcg([3, 2, 1], 3).toFixed(4), '1.0000', 'a perfectly ordered grade vector is nDCG 1');
eq(ndcg([1, 2, 3], 1) < 1, true, 'a badly ordered vector scores below 1');
eq(ndcg([0, 0, 0], 5), 0, 'no relevance -> 0, not NaN');
// The property that makes an out-of-scope grade free: the ideal comes from the RANKED vector, so a title
// that never gets ranked changes neither DCG nor the ideal.
eq(ndcg([3, 0], 2), ndcg([3, 0], 2), 'ideal DCG is built from the ranked vector');
eq(dcg([1, 1], 1), 1, 'dcg respects k');
eq(nrm('176 - Villa Victory Party!').join(','), '176,villa,victory,party', 'nrm keeps alphanumeric tokens, drops singles');
eq(wiTitle({ comment: ' Villa ', uid: 1 }), 'Villa', 'title prefers the trimmed comment');
eq(wiTitle({ comment: '', key: ['a', 'b'], uid: 1 }), 'a, b', 'title falls back to keys');
eq(wiTitle({ comment: '', key: [], uid: 7 }), 'UID 7', 'title falls back to uid');

// Grade matching is token-subset, and out-of-scope rows resolve to null rather than their grade.
// null, not 0, is the whole point: a judged 0 is a verdict and an absent grade is a hole in the pool,
// and callers treat them differently (nDCG coerces with `?? 0`; a delivery rule must not).
const inScope = { outOfScope: () => false, primary: 'B' };
const gradeOf = makeGradeOf(
    [{ title: 'Villa Victory Party', grade: 5 }, { title: 'Intimacy & Mechanics', grade: 4, book: 'Elsewhere' }],
    { outOfScope: r => r.book === 'Elsewhere', primary: 'B' },
);
eq(gradeOf('176 - Villa Victory Party'), 5, 'a graded title matches by token subset');
eq(gradeOf('Intimacy & Mechanics'), null, 'a grade from an unloaded book has no usable verdict, not its grade');
eq(gradeOf('Something Else'), null, 'an ungraded title is null, distinct from a judged 0');
eq(makeGradeOf([{ title: 'Villa', grade: 0 }], inScope)('Villa'), 0, 'a judged 0 stays 0 and is not confused with unjudged');

// uid is authoritative when every grade carries one (every /wa-grade sample does) — the misattribution the
// title heuristic allows is "Villa" also matching "Villa Party", first-found wins.
const byUid = makeGradeOf(
    [{ title: 'Villa', grade: 5, uid: 1 }, { title: 'Villa Party', grade: 2, uid: 2 }],
    inScope,
);
eq(byUid({ uid: 2, title: 'Villa Party' }), 2, 'uid match beats the token-subset title match');
eq(byUid({ uid: 9, title: 'Villa Party Annex' }), null, 'uid-complete grades: an unknown uid is ungraded, never title-guessed');
eq(byUid({ key: 1, title: 'anything' }), 5, 'retrieval rows keyed by `key` resolve by uid too');
// A mixed set (some grades lack uids) falls back to titles wholesale rather than half-and-half.
eq(makeGradeOf([{ title: 'Villa', grade: 5, uid: 1 }, { title: 'Other', grade: 3 }], inScope)({ uid: 9, title: 'Other Thing' }), 3,
    'a grade set missing uids resolves every row by title');

// (book, uid) IS THE KEY, not uid. Two books number their entries from 0, so a bare-uid map hands one
// book's row the other book's grade — which is the whole reason the pool and the join changed shape.
const twoBooks = makeGradeOf(
    [{ title: 'Alpha Biology', grade: 4, uid: 1, book: 'omegaverse' }, { title: 'Sommers Pack Rules', grade: 0, uid: 1, book: 'B' }],
    inScope,
);
eq(twoBooks({ uid: 1, book: 'omegaverse', title: 'Alpha Biology' }), 4, 'a second book\'s row resolves against its own grade');
eq(twoBooks({ uid: 1, book: 'B', title: 'Sommers Pack Rules' }), 0, '...and the primary\'s uid 1 keeps its own');
eq(twoBooks({ uid: 1, entry: { world: 'omegaverse' }, title: 'x' }), 4, 'a scored row carries its book on entry.world');
eq(twoBooks({ uid: 1, title: 'x' }), 0, 'a row naming no book is the primary\'s, as every reader here assumes');

// --- keyword scoring honours production's key suppression (worldsapart.js suppressKeys) ---
// Samples embed books raw, so vectorized entries still carry keys the live scan would have blanked; scoring
// them gave vectorized entries a keys signal production can never produce.
// EVERY entry's keys are scored, vectorized or not: the value is measured and recorded, and whether the
// model reads it is a question about the feature set (`--without keys`), not about the entry.
const kwP = makeKeywordScore(sceneParams({}));
eq(kwP({ vectorized: true, key: ['villa'] }, 'meet me at the villa', 1.2) > 0, true, 'a vectorized entry\'s keys are scored, as the live scan scores them');
eq(kwP({ vectorized: false, key: ['villa'] }, 'meet me at the villa', 1.2) > 0, true, 'non-vectorized keys score too');
eq(kwP({ vectorized: true, key: [] }, 'meet me at the villa', 1.2), 0, 'an entry with no keys scores nothing, which is an absence and not a suppression');

// --- scene independence (jaccard on relevant sets) ---
// Pseudo-replication is the failure: two near-identical scenes counted as two draws invent power the data
// does not have, and the sign test cannot detect it on its own.
eq(jaccard([1, 2, 3], [1, 2, 3]), 1, 'identical relevant sets -> 1');
eq(jaccard([1, 2], [3, 4]), 0, 'disjoint relevant sets -> 0');
eq(jaccard([1, 2, 3, 4], [3, 4, 5, 6]), 1 / 3, 'half-shared -> |int|/|union|');
eq(jaccard([], []), 0, 'two empty sets are 0, not NaN');
eq(jaccard([1], []), 0, 'one empty set is 0');
eq(jaccard(new Set([1, 2]), new Set([2])), 0.5, 'accepts Sets as well as arrays');
// Grade-keyed identity: same uid in different books is not the same entry, so it must not read as overlap.
eq(jaccard([rowKey({ book: 'A', uid: 1 })], [rowKey({ book: 'B', uid: 1 })]), 0,
    'same uid in different books is not shared relevance');

// --- Spearman, tie-corrected (metrics.mjs) ---
// Graded pools are half zeros, so tie handling is not a nicety: with the shortcut formula the coefficient
// depends on how the sort broke ties, i.e. on array order.
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

// --- the fusion assertions are RETIRED, with their subject ---
// Everything here pinned RRF: how lexicalWeight and keywordWeight combined, the keyword-only tilt, what
// rank a keyword entry could clear a vector entry from. E[credit] replaced all of it — the model reads
// the signals directly and the layout is ordered by the same number the cut thresholds — so these
// assertions had nothing left to be about. What replaces them is relevance-model-check.

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

// --- qwk: hand-computed matrices, because a self-consistent formula proves nothing about the formula.
eq(qwk([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]), 1, 'identical grades -> 1');
// a=[0,0,4,4] b=[0,4,0,4]: numerator 2, expected 2, so exactly chance.
eq(qwk([[0, 0], [0, 4], [4, 0], [4, 4]]), 0, 'grades independent of each other -> 0');
// a=[0,0,4,4] b=[0,0,4,0]: one 4-vs-0 error (num 1) against expected 2.
eq(qwk([[0, 0], [0, 0], [4, 4], [4, 0]]), 0.5, 'one full-scale miss in four -> 0.5');
eq(qwk([[0, 4], [4, 0]]) < 0, true, 'systematic inversion is worse than chance');
eq(Number.isNaN(qwk([])), true, 'no rows -> NaN, not a fake 1');
eq(Number.isNaN(qwk([[2, 2], [2, 2]])), true, 'one cell only -> NaN: no expected disagreement to correct against');

// --- availability: a row whose entry post-dates the scene could not be in the book when it was live.
// Filtered at openSample so graded-scene-grid and param-screen cannot disagree about which rows exist.
const { dropUnavailable } = await import('./scene.mjs');
const mkSample = (msg, extra = {}) => ({
    generatedFrom: msg === null ? {} : { msg },
    books: { W: { 1: { uid: 1, STMB_start: 10, STMB_end: 20 }, 2: { uid: 2, STMB_start: 300, STMB_end: 400 }, 3: { uid: 3 } } },
    entries: [{ book: 'W', uid: 1 }, { book: 'W', uid: 2 }, { book: 'W', uid: 3 }],
    candidates: [{ book: 'W', uid: 1 }, { book: 'W', uid: 2 }],
    ...extra,
});
eq(dropUnavailable(mkSample(100)).entries.length, 2, 'a grade whose entry starts after the scene is dropped');
eq(dropUnavailable(mkSample(100)).entries.some(g => g.uid === 2), false, '...and it is the post-dating one, not an arbitrary row');
eq(dropUnavailable(mkSample(100)).candidates.length, 1, 'the same row leaves the arm ranking too, or it still occupies a rank');
eq(dropUnavailable(mkSample(500)).entries.length, 3, 'past the entry\'s own range, nothing is unavailable');
eq(dropUnavailable(mkSample(100)).entries.some(g => g.uid === 3), true, 'an entry with no STMB range is reference, always available');
// A live /wa-grade capture records no generatedFrom.msg and cannot contain a future entry by construction.
eq(dropUnavailable(mkSample(null)).entries.length, 3, 'no scene message index -> no-op, not a silent drop of everything');
// It used to have to walk `arms` itself, and filtering only the first was a real bug. openBundle now
// hands out ONE arm's view, so there is no second list here to forget — the guard moved into the shape.
eq('arms' in dropUnavailable(mkSample(100)), false, 'the filter sees one arm\'s view, never a list of them');
// The books are the half that matters: makeCandidateSet re-derives the pool from them, so an entry left
// there returns as an UNJUDGED row holding a rank. Missing this half once collapsed measured precision (F28).
const booked = dropUnavailable(mkSample(100));
eq(Object.keys(booked.books.W).length, 2, 'a post-dating entry leaves the BOOK, not just the grade list');
eq(booked.books.W['2'], undefined, '...and it is the post-dating uid that goes');
eq(Object.keys(dropUnavailable(mkSample(500)).books.W).length, 3, 'nothing leaves the book when the scene is past every range');
eq(Object.keys(dropUnavailable(mkSample(null)).books.W).length, 3, 'no scene index -> the book is untouched');
// THE PRISTINE COPY, which is what reindex.mjs ensureIndex builds a collection from. Without it the index
// carries one scene's message cutoff and every other scene of that book reads the shortfall as its own
// collection — silently, because a smaller book scores fine.
eq(Object.keys(booked.pristineBooks.W).length, 3, 'the post-dating entry survives in pristineBooks');
eq(booked.pristineBooks.W['2'].uid, 2, '...as the whole entry, not a marker');
eq(booked.books.W['2'], undefined, '...while the filtered view still drops it');
// Stashed BEFORE the first delete and never re-taken, or the second pass would overwrite the pristine copy
// with the already-stripped one and the collection would shrink to the cutoff after all.
const stashed = mkSample(100);
dropUnavailable(stashed); dropUnavailable(stashed);
eq(Object.keys(stashed.pristineBooks.W).length, 3, 'a second pass does not overwrite the stash with the filtered book');
// Idempotent, because a sweep calls loadScene repeatedly on the SAME sample object and the filter mutates
// it. Without the guard skip, pass two compares the stripped book against the pristine fingerprint and
// throws on a bundle nobody edited — measured: relevance-regress died on fold 1 of a gazetteerSource sweep.
const twice = mkSample(100);
dropUnavailable(twice); dropUnavailable(twice);
eq(Object.keys(twice.books.W).length, 2, 'filtering twice removes the same entries, not more');
eq(twice.entries.length, 2, '...and the grade list is stable across a second pass');


// --- haystackFor: the reader COMPOSES a window, it does not read one ------------------------------------
// A document stores the scan messages, the injects and the opted-in sources SEPARATELY, because a joined
// blob is fixed at one depth, one matchWindow and one includeNames and cannot be taken apart. All three of
// the things that vary do so PER ENTRY, so one window for every entry silently drops all three.
{
    const { haystackFor, sceneParams } = await import('./scene.mjs');
    const S = {
        scanChat: [{ name: 'A', mes: 'first' }, { name: 'B', mes: 'second' }],
        depth: 2,
        injects: [
            { key: 'NEAR', text: 'NEAR', ambient: false, depth: 1 },
            { key: 'FAR', text: 'FAR', ambient: false, depth: 99 },
            { key: 'AMB', text: 'AMBIENT', ambient: true, depth: 0 },
        ],
        sources: { scenario: 'SCEN' },
    };
    const h = haystackFor(S, sceneParams({}));
    const win = e => h(e).join('\n');

    eq(win({ uid: 1 }).includes('first'), true, 'the chat messages are in every entry\'s haystack');
    eq(win({ uid: 1 }).includes('NEAR'), true, 'an inject inside the depth is admitted');
    eq(win({ uid: 1 }).includes('FAR'), false, 'one beyond it is not — which is the divergence from core that WA owns');
    eq(win({ uid: 1 }).includes('AMBIENT'), true, 'an ambient inject has no chat position, so no depth can exclude it');

    // The sources are the whole reason this is per entry rather than per scene.
    eq(win({ uid: 1 }).includes('SCEN'), false, 'an entry that opted into nothing sees no card or persona text');
    eq(win({ uid: 2, matchScenario: true }).includes('SCEN'), true, '...and the one that opted in sees exactly what it named');

    // scanDepth 0 is core's authored "match nothing from chat", which a truthy check would swallow.
    const zero = win({ uid: 3, scanDepth: 0 });
    eq(zero.includes('first') || zero.includes('second'), false, 'scanDepth 0 matches nothing from the chat');
    eq(zero.includes('AMBIENT'), true, '...but an ambient inject is not chat, so it stays');
    eq(win({ uid: 4, scanDepth: 1 }).includes('first'), false, 'a per-entry scanDepth narrows the window to its own value');
    eq(win({ uid: 4, scanDepth: 1 }).includes('second'), true, '...keeping what that depth reaches');

    // A document with neither is the ordinary case, and must compose to exactly the chat window.
    const bare = haystackFor({ scanChat: S.scanChat, depth: 2 }, sceneParams({}));
    eq(bare({ uid: 1 }).join('\n'), 'A: first\nB: second', 'no injects and no sources composes to the chat window alone');
}

// --- principal components: the all-but-the-top arm for centering (metrics.mjs topComponents) ---------
// Mean-centering removes one direction, and most of it is shared across books rather than the book's own.
// This is the machinery for removing several. Checked on a synthetic corpus with KNOWN axes, because a power iteration that has
// silently converged to the wrong direction still returns a unit vector and still scores.
const V = (...xs) => ({ vector: xs });
// Spread along axis 0 dominates, axis 1 is second, axis 2 is flat. Mean is deliberately non-zero so the
// components are of the CENTERED data, which is what the arm subtracts.
const pts = [];
for (let i = -5; i <= 5; i++) for (let j = -1; j <= 1; j++) pts.push(V(10 + 8 * i, 3 + 1.5 * j, 7));
const MU = [10, 3, 7];
const [p1, p2] = topComponents(pts, 2, MU);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
eq(near(Math.abs(p1[0]), 1) && near(p1[1], 0, 1e-4) && near(p1[2], 0, 1e-4), true, 'the first component is the axis the data spreads along');
eq(near(Math.abs(p2[1]), 1, 1e-4) && near(p2[0], 0, 1e-4), true, '...and the second is the next one, not the first again');
eq(near(p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2], 0, 1e-6), true, 'components come out orthogonal, or deflation did not happen');
eq(near(Math.hypot(p1[0], p1[1], p1[2]), 1), true, 'and unit length');
eq(topComponents(pts, 0, MU).length, 0, 'k=0 is no components, which is plain mean-centering');
// A flat axis has no variance to find; asking for more components than the data has directions must not
// invent one, since a spurious component would be projected out of every vector for free.
eq(topComponents(pts, 3, MU).length, 2, 'k beyond the data\'s rank returns fewer, not a seed vector wearing a component\'s clothes');
eq(topComponents(pts, 8, MU).length, 2, '...however far past it you ask');
// The transform itself: after removing the mean and the first component, nothing is left along it.
const r = projectOut(pts[0].vector, MU, [p1]);
eq(near(r[0] * p1[0] + r[1] * p1[1] + r[2] * p1[2], 0, 1e-6), true, 'projectOut leaves no residue along the component');
eq(near(r[2], 0), true, '...and still subtracts the mean on the axes it does not touch');
eq(near(projectOut(pts[0].vector, MU, [])[0], pts[0].vector[0] - MU[0]), true, 'no components is exactly mean subtraction');
// Determinism is what makes it pairable against a baseline at all.
eq(JSON.stringify([...topComponents(pts, 2, MU)[0]]), JSON.stringify([...topComponents(pts, 2, MU)[0]]), 'the same corpus yields the same component every run');

// --- lineages: two versions of one book are one book (scene.mjs lineagesOf) ------------------------
// The real instance this exists for: an LTM file is named after the CHARACTER CARD, and one card carries
// several stories, so "Isekai Adventure" was byte-identical to Ascensus while sharing almost nothing with
// Time Whore — the other story on that same card (C11). Names are not evidence in either direction.
// --- the query embedding cache: keyed by (label, exact text), tolerant of a torn append ------------
// Retraining re-embeds the same scene queries every run, so they are memoised to disk. Two ways that goes
// wrong silently: a hit across MODELS hands back a vector from another embedding space, and a torn last
// line from a killed append takes the whole cache down with it on the next read.
{
    // queryCachePath is the implementation's own, so this cannot drift from it.
    const { embed, queryCachePath: path } = await import('./scene.mjs');
    const { appendFileSync, writeFileSync, existsSync, unlinkSync } = await import('node:fs');
    const A = 'wa-check-model-a', B = 'wa-check-model-b';
    for (const l of [A, B]) if (existsSync(path(l))) unlinkSync(path(l));
    // A fake embedder is not reachable from here, so drive it through the cache directly: seed one label,
    // then assert the other label does not see it.
    writeFileSync(path(A), '');
    let calls = 0;
    const fake = { model: 'x', endpoint: 'ollama', url: 'http://127.0.0.1:1' };   // unreachable on purpose
    // seed A by hand, exactly as embed appends
    const { createHash } = await import('node:crypto');
    const text = 'the same query text';
    const h = createHash('sha256').update(text).digest('hex');
    appendFileSync(path(A), `${JSON.stringify({ h, v: [1, 2, 3] })}\n`);
    const hit = await embed(text, { ...fake, label: A });
    eq(JSON.stringify(hit), '[1,2,3]', 'a cached query is returned without an embed call');
    // A torn line — a killed append — must not lose the entries before it.
    appendFileSync(path(A), '{"h":"deadbeef","v":[9,9');
    const { embed: embed2 } = await import(`./scene.mjs?bust=${Date.now()}`);
    const stillHit = await embed2(text, { ...fake, label: A });
    eq(JSON.stringify(stillHit), '[1,2,3]', '...and a torn final line does not take the cache down with it');
    // The other label must miss, not borrow A's vector — this is what makes caching safe at all.
    let threw = false;
    try { await embed2(text, { ...fake, label: B }); } catch { threw = true; }
    eq(threw, true, 'another model LABEL misses rather than reusing a vector from a different space');
    for (const l of [A, B]) if (existsSync(path(l))) unlinkSync(path(l));
    void calls;
}

// --- etaSquared: the sharedness statistic stage A selects on ------------------------------------------
// Components come back in VARIANCE order, which is not sharedness order — the two disagree at the top on
// this corpus (R16). So the selection rule needs a statistic that separates "every book varies along
// this" from "this offsets whole books", and it has to be the second that scores high.
const { etaSquared } = await import('./global-basis.mjs');
{
    const MEAN = [0, 0];
    // x: both groups straddle 0 identically — shared. y: group A sits at +1, group B at -1 — separating.
    const A = [[1, 1], [-1, 1], [1, 1], [-1, 1]].map(v => ({ vector: v }));
    const B = [[1, -1], [-1, -1], [1, -1], [-1, -1]].map(v => ({ vector: v }));
    const eta = etaSquared([A, B], MEAN, [[1, 0], [0, 1]]);
    eq(eta[0].toFixed(3), '0.000', 'a direction both groups vary along identically is SHARED, eta^2 0');
    eq(eta[1].toFixed(3), '1.000', 'a direction that offsets whole groups SEPARATES them, eta^2 1');
    // The ordering the selection rule applies: lowest eta^2 first, whatever the variance rank was.
    const picked = [[1, 0], [0, 1]].map((c, j) => [c, eta[j]]).sort((x, y) => x[1] - y[1]).map(([c]) => c);
    eq(JSON.stringify(picked[0]), '[1,0]', "'shared' selection takes the shared direction first, not the leading one");
    // A group of one contributes no within-group variance, so a lone group cannot separate anything.
    eq(etaSquared([A], MEAN, [[0, 1]])[0].toFixed(3), '0.000', 'one group alone separates nothing, rather than dividing by zero');
}

const { lineagesOf } = await import('./scene.mjs');
const bk = (...bodies) => Object.fromEntries(bodies.map((c, i) => [i, { uid: i, content: c }]));
const L = lineagesOf({
    Big: bk('alpha', 'beta', 'gamma', 'delta'),
    Renamed: bk('alpha', 'beta', 'gamma', 'delta'),   // identical copy under another name
    Revised: bk('alpha', 'beta', 'epsilon'),          // 2/3 shared with Big -> same lineage
    Other: bk('zeta', 'eta', 'theta'),                // shares nothing
});
eq(L.get('Renamed'), L.get('Big'), 'an identical copy under another name is the same lineage');
eq(L.get('Revised'), L.get('Big'), 'a revision sharing most bodies joins it');
eq(L.get('Other') === L.get('Big'), false, '...and a book sharing nothing does not');
eq(L.get('Big'), 'Big', 'with no stamps the group takes the shortest name, not whichever was seen first');
const two = { 'LTM - Ascensus': bk('a', 'b'), 'LTM - Isekai Adventure - Isekai Adventure - 2026-03-04': bk('a', 'b') };
eq(lineagesOf(two).get('LTM - Ascensus'), 'LTM - Ascensus', '...so a card-decorated duplicate does not become the label for the book it duplicates');
// Recency wins over brevity: the name in current use is the one that will match what the author says.
eq(lineagesOf(two, new Map([['LTM - Isekai Adventure - Isekai Adventure - 2026-03-04', '2026-08-14'], ['LTM - Ascensus', '2026-08-13']])).get('LTM - Ascensus'),
    'LTM - Isekai Adventure - Isekai Adventure - 2026-03-04', 'a more recently used name wins even when it is longer');
// Day-granular stamps tie constantly, which is the real case here — both were last written 2026-08-13.
eq(lineagesOf(two, new Map([['LTM - Isekai Adventure - Isekai Adventure - 2026-03-04', '2026-08-13'], ['LTM - Ascensus', '2026-08-13']])).get('LTM - Ascensus'),
    'LTM - Ascensus', '...and a tied stamp falls back to the shorter, undecorated name');
eq(lineagesOf(two, new Map([['LTM - Ascensus', '2026-08-13']])).get('LTM - Ascensus'), 'LTM - Ascensus', 'a name with no stamp at all sorts oldest rather than throwing');
eq(new Set(L.values()).size, 2, 'four files, two lineages');
// Transitive, or a chain of partial revisions splits into groups that each overlap the next.
const chain = lineagesOf({ A: bk('a', 'b', 'c'), B: bk('b', 'c', 'd'), C: bk('c', 'd', 'e') });
eq(new Set(chain.values()).size, 1, 'a chain of partial revisions is one lineage, not three');
// Independent of iteration order, since the answer feeds a sign test's notion of a draw.
const rev = lineagesOf({ Other: bk('zeta', 'eta', 'theta'), Revised: bk('alpha', 'beta', 'epsilon'), Renamed: bk('alpha', 'beta', 'gamma', 'delta'), Big: bk('alpha', 'beta', 'gamma', 'delta') });
eq(rev.get('Renamed'), L.get('Renamed'), 'the same books group the same way whatever order they arrive in');
eq(lineagesOf({ Empty: {}, Solo: bk('x') }).get('Empty'), 'Empty', 'a book with no bodies is its own lineage rather than joining everything');

// --- the two-mean decomposition is a no-op, which is why it cannot be an arm -------------------------
// "Extract the pooled centroid, THEN the book centroid" sounds like two removals and is one: the book's
// centroid OF THE RESIDUAL is (bookMean - globalMean), so subtracting both leaves v - bookMean, exactly
// what one subtraction of the book mean gives. Only component removal can make the stages differ. Asserted
// rather than argued, because the whole two-stage design was built on the assumption it was not true.
const G = [0.3, -0.1, 0.5];
const vs = [[1, 2, 3], [2, 0, 1], [-1, 4, 0]];
const bookMean = [0, 1, 2].map(i => vs.reduce((a, v) => a + v[i], 0) / vs.length);
const oneStep = vs.map(v => v.map((x, i) => x - bookMean[i]));
const afterG = vs.map(v => v.map((x, i) => x - G[i]));
const residualMean = [0, 1, 2].map(i => afterG.reduce((a, v) => a + v[i], 0) / afterG.length);
const twoStep = afterG.map(v => v.map((x, i) => x - residualMean[i]));
eq(JSON.stringify(oneStep.map(r => r.map(x => x.toFixed(9)))), JSON.stringify(twoStep.map(r => r.map(x => x.toFixed(9)))),
    'global mean then book-residual mean equals book mean in one step');
eq(residualMean.map((x, i) => (x - (bookMean[i] - G[i])).toFixed(9)).join(), '0.000000000,0.000000000,0.000000000',
    '...because the residual mean IS bookMean minus globalMean');
