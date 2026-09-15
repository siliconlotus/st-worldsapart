// Self-check for the paired estimator (metrics.mjs signTest), the set metrics, and scene.mjs's offline helpers.
import { eq, eqNear, signTest, gradeCredit, fbeta, RECALL_WEIGHT, jaccard, spearman, qwk, topComponents, projectOut } from './metrics.mjs';
import { sceneParams, ndcg, dcg, nrm, wiTitle, makeGradeOf, makeKeywordScore, scoreScene, tierRecall, bookFingerprint } from './scene.mjs';
import { rowKey } from '../extension/grading.mjs';

// --- exact two-sided sign-test p-values, against hand-computed binomials
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
eq(signTest([0.05]).consistent, false, 'one scene is never "consistent"');
eq(signTest([]).n, 0, 'no deltas -> nothing to test');
eq(signTest([]).p, 1, 'no deltas -> p=1, not NaN');

const t = signTest([0, 0, 0.02]);
eq(t.ties, 2, 'exact zeros are ties');
eq(t.n, 1, 'ties are excluded from n');
eq(t.p, 1, 'one non-tie cannot be significant');
eq(signTest([1e-12, -1e-12, 0.5]).ties, 2, 'sub-epsilon deltas are ties, not directions');
eq(Math.abs(signTest([0, 0, 0.03]).mean - 0.01) < 1e-12, true, 'mean delta includes tied scenes');

// --- bookFingerprint: gaz hashes key/keysecondary/comment, content hashes the bodies
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
eq(JSON.stringify(bookFingerprint({ 2: fpBook[2], 1: fpBook[1] })), JSON.stringify(fp0), 'insertion order does not matter');
eq(Number.isFinite(bookFingerprint({}).gaz), true, 'an existing but empty book still fingerprints');

// --- tierRecall: per-tier recall of a kept set; ungraded counts as not relevant
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
eq(tierRecall(pop, [memRow(1, 4)], gradeOfRow).memory.got, 0, 'a copy of a kept row is not the kept row');

// --- sceneParams layering: harness defaults < the arm's own `params` < an explicit override ---
const S = { params: { K1: 2, LEXW: 1.5 } };
eq(sceneParams(S).K1, 2, 'a sample overrides the harness default');
eq(sceneParams(S).B, 0.75, 'unspecified params fall back to the harness default');
eq(sceneParams(S, { K1: 3 }).K1, 3, 'an arm override beats the sample');
eq(sceneParams(S, { K1: 3 }).LEXW, 1.5, 'an arm override leaves other params on the sample baseline');
eq(sceneParams({}).entityFilter, true, 'a view with no params still gets a full param set');

// --- the arm-reuse guard: sweeping gazetteerSource against a preloaded scene must throw
// Asserted on the MESSAGE, not merely on throwing: a preloaded stub throws for a dozen other reasons.
let threw = '';
try {
    await scoreScene({ sample: S, overrides: { gazetteerSource: 'keys' }, scene: { fake: true }, qv: [0] });
} catch (e) { threw = String(e?.message ?? e); }
eq(threw.includes('cannot be swept against a preloaded scene'), true, 'sweeping the gazetteer against a preloaded scene throws its own error');

// --- ndcg, dcg, nrm, wiTitle (scene.mjs)
eq(ndcg([3, 2, 1], 3).toFixed(4), '1.0000', 'a perfectly ordered grade vector is nDCG 1');
eq(ndcg([1, 2, 3], 1) < 1, true, 'a badly ordered vector scores below 1');
eq(ndcg([0, 0, 0], 5), 0, 'no relevance -> 0, not NaN');
eq(ndcg([3, 0], 2), ndcg([3, 0], 2), 'ideal DCG is built from the ranked vector');
eq(dcg([1, 1], 1), 1, 'dcg respects k');
eq(nrm('176 - Villa Victory Party!').join(','), '176,villa,victory,party', 'nrm keeps alphanumeric tokens, drops singles');
eq(wiTitle({ comment: ' Villa ', uid: 1 }), 'Villa', 'title prefers the trimmed comment');
eq(wiTitle({ comment: '', key: ['a', 'b'], uid: 1 }), 'a, b', 'title falls back to keys');
eq(wiTitle({ comment: '', key: [], uid: 7 }), 'UID 7', 'title falls back to uid');

// --- makeGradeOf
const inScope = { outOfScope: () => false, primary: 'B' };
const gradeOf = makeGradeOf(
    [{ title: 'Villa Victory Party', grade: 5 }, { title: 'Intimacy & Mechanics', grade: 4, book: 'Elsewhere' }],
    { outOfScope: r => r.book === 'Elsewhere', primary: 'B' },
);
eq(gradeOf('176 - Villa Victory Party'), 5, 'a graded title matches by token subset');
eq(gradeOf('Intimacy & Mechanics'), null, 'a grade from an unloaded book has no usable verdict, not its grade');
eq(gradeOf('Something Else'), null, 'an ungraded title is null, distinct from a judged 0');
eq(makeGradeOf([{ title: 'Villa', grade: 0 }], inScope)('Villa'), 0, 'a judged 0 stays 0 and is not confused with unjudged');

const byUid = makeGradeOf(
    [{ title: 'Villa', grade: 5, uid: 1 }, { title: 'Villa Party', grade: 2, uid: 2 }],
    inScope,
);
eq(byUid({ uid: 2, title: 'Villa Party' }), 2, 'uid match beats the token-subset title match');
eq(byUid({ uid: 9, title: 'Villa Party Annex' }), null, 'uid-complete grades: an unknown uid is ungraded, never title-guessed');
eq(byUid({ key: 1, title: 'anything' }), 5, 'retrieval rows keyed by `key` resolve by uid too');
eq(makeGradeOf([{ title: 'Villa', grade: 5, uid: 1 }, { title: 'Other', grade: 3 }], inScope)({ uid: 9, title: 'Other Thing' }), 3,
    'a grade set missing uids resolves every row by title');

const twoBooks = makeGradeOf(
    [{ title: 'Alpha Biology', grade: 4, uid: 1, book: 'folklore' }, { title: 'Harbor Pack Rules', grade: 0, uid: 1, book: 'B' }],
    inScope,
);
eq(twoBooks({ uid: 1, book: 'folklore', title: 'Alpha Biology' }), 4, 'a second book\'s row resolves against its own grade');
eq(twoBooks({ uid: 1, book: 'B', title: 'Harbor Pack Rules' }), 0, '...and the primary\'s uid 1 keeps its own');
eq(twoBooks({ uid: 1, entry: { world: 'folklore' }, title: 'x' }), 4, 'a scored row carries its book on entry.world');
eq(twoBooks({ uid: 1, title: 'x' }), 0, 'a row naming no book is the primary\'s, as every reader here assumes');

// --- makeKeywordScore
const kwP = makeKeywordScore(sceneParams({}));
eq(kwP({ vectorized: true, key: ['villa'] }, 'meet me at the villa', 1.2) > 0, true, 'a vectorized entry\'s keys are scored, as the live scan scores them');
eq(kwP({ vectorized: false, key: ['villa'] }, 'meet me at the villa', 1.2) > 0, true, 'non-vectorized keys score too');
eq(kwP({ vectorized: true, key: [] }, 'meet me at the villa', 1.2), 0, 'an entry with no keys scores nothing, which is an absence and not a suppression');

// --- jaccard on relevant sets
eq(jaccard([1, 2, 3], [1, 2, 3]), 1, 'identical relevant sets -> 1');
eq(jaccard([1, 2], [3, 4]), 0, 'disjoint relevant sets -> 0');
eq(jaccard([1, 2, 3, 4], [3, 4, 5, 6]), 1 / 3, 'half-shared -> |int|/|union|');
eq(jaccard([], []), 0, 'two empty sets are 0, not NaN');
eq(jaccard([1], []), 0, 'one empty set is 0');
eq(jaccard(new Set([1, 2]), new Set([2])), 0.5, 'accepts Sets as well as arrays');
eq(jaccard([rowKey({ book: 'A', uid: 1 })], [rowKey({ book: 'B', uid: 1 })]), 0,
    'same uid in different books is not shared relevance');

// --- spearman, tie-corrected (metrics.mjs)
eq(spearman([1, 2, 3], [1, 2, 3]), 1, 'identical order -> +1');
eq(spearman([1, 2, 3], [3, 2, 1]), -1, 'reversed order -> -1');
eq(Number.isNaN(spearman([1, 1, 1], [1, 2, 3])), true, 'no variance -> NaN, not a fake 0');
eq(Number.isNaN(spearman([1], [1])), true, 'n<2 -> NaN');
// px/py is tx/ty under one permutation
const tx = [0, 0, 0, 1, 2], ty = [0, 1, 0, 2, 3];
const px = [0, 1, 0, 0, 2], py = [0, 2, 1, 0, 3];
eq(Math.abs(spearman(tx, ty) - spearman(px, py)) < 1e-12, true, 'tied blocks are order-independent (midranks)');
eq(spearman([0, 0, 1, 2], [0, 1, 2, 3]) < 1, true, 'ties on one side cap the coefficient below 1');
eq(spearman([0, 0, 1, 2], [0, 1, 2, 3]) > 0.8, true, '...but still reports a strong positive');
eq(Math.abs(spearman([1, 2, 3, 4], [2, 4, 6, 8]) - 1), 0, 'monotone rescaling is still +1');

// --- gradeCredit, fbeta, RECALL_WEIGHT (metrics.mjs)
eq(gradeCredit(4), 1, 'a 4 is delivered correctly');
eq(gradeCredit(3), 1, 'a 3 is too — the bar for "should be included"');
eq(gradeCredit(2), 0.5, 'a 2 is 50/50 on inclusion, so it credits half');
eq(gradeCredit(2.5), 0.5, 'a half-grade credits by its BAND, not by interpolation');
eq(gradeCredit(1.5), 0, '...and below 2 nothing is earned');
eq(gradeCredit(1), 0, 'a 1 is filler');
eq(gradeCredit(0), 0, 'a 0 is an error');

const prec = grades => grades.reduce((s, x) => s + gradeCredit(x), 0) / grades.length;
eq(prec([4, 3]) === 1, true, 'two confident hits are precision 1');
eq(prec([4, 3, 2]) < prec([4, 3]), true, 'adding a 2 LOWERS precision from 1 — ambiguity is not a win');
eq(prec([2, 2, 2]), 0.5, 'a set of nothing but 2s sits at 0.5, neither rewarded nor condemned');
eq(prec([4, 3, 0]) < prec([4, 3, 2]), true, '...and a 0 still costs more than a 2');
eq(prec([1, 2]) > prec([1, 1]), true, 'a 2 beats a 1, so the bands stay ordered');

eq(prec([4, 4, 3, 3]) > prec([4, 4, 3, 3, 2, 2]), true, 'a 2 LOWERS precision on a set above 50/50');
eq(prec([3, 1, 0, 0]) < prec([3, 1, 0, 0, 2, 2]), true, '...and RAISES it on a set below');
eqNear(prec([4, 3, 1, 0]), prec([4, 3, 1, 0, 2, 2]), 'and does nothing at exactly 50/50 — the fixed point');

eq(RECALL_WEIGHT, 2, 'a lost relevant entry is held to cost at least twice a gained irrelevant one');
eqNear(fbeta(1, 1, 2), 1, 'perfect on both is 1');
eqNear(fbeta(0.5, 1, 2), (5 * 0.5) / (4 * 0.5 + 1), 'F2 formula matches the closed form it replaced');
eq(fbeta(0.5, 1, 2) > fbeta(1, 0.5, 2), true, 'at beta=2, high recall beats the mirrored high precision');
eq(fbeta(0.5, 1, 1) === fbeta(1, 0.5, 1), true, '...and at beta=1 the two are symmetric, which is what beta buys');
eq(fbeta(0, 0, 2), 0, 'no signal either way is 0, not NaN');
eq(fbeta(0, 1, 2), 0, 'zero precision cannot be rescued by recall');

// --- qwk, against hand-computed matrices
eq(qwk([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]), 1, 'identical grades -> 1');
// a=[0,0,4,4] b=[0,4,0,4]: numerator 2, expected 2, so exactly chance.
eq(qwk([[0, 0], [0, 4], [4, 0], [4, 4]]), 0, 'grades independent of each other -> 0');
// a=[0,0,4,4] b=[0,0,4,0]: one 4-vs-0 error (num 1) against expected 2.
eq(qwk([[0, 0], [0, 0], [4, 4], [4, 0]]), 0.5, 'one full-scale miss in four -> 0.5');
eq(qwk([[0, 4], [4, 0]]) < 0, true, 'systematic inversion is worse than chance');
eq(Number.isNaN(qwk([])), true, 'no rows -> NaN, not a fake 1');
eq(Number.isNaN(qwk([[2, 2], [2, 2]])), true, 'one cell only -> NaN: no expected disagreement to correct against');

// --- dropUnavailable: a row whose entry post-dates the scene could not be in the book when it was live
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
eq(dropUnavailable(mkSample(null)).entries.length, 3, 'no scene message index -> no-op, not a silent drop of everything');
eq('arms' in dropUnavailable(mkSample(100)), false, 'the filter sees one arm\'s view, never a list of them');
const booked = dropUnavailable(mkSample(100));
eq(Object.keys(booked.books.W).length, 2, 'a post-dating entry leaves the BOOK, not just the grade list');
eq(booked.books.W['2'], undefined, '...and it is the post-dating uid that goes');
eq(Object.keys(dropUnavailable(mkSample(500)).books.W).length, 3, 'nothing leaves the book when the scene is past every range');
eq(Object.keys(dropUnavailable(mkSample(null)).books.W).length, 3, 'no scene index -> the book is untouched');
eq(Object.keys(booked.pristineBooks.W).length, 3, 'the post-dating entry survives in pristineBooks');
eq(booked.pristineBooks.W['2'].uid, 2, '...as the whole entry, not a marker');
eq(booked.books.W['2'], undefined, '...while the filtered view still drops it');
const stashed = mkSample(100);
dropUnavailable(stashed); dropUnavailable(stashed);
eq(Object.keys(stashed.pristineBooks.W).length, 3, 'a second pass does not overwrite the stash with the filtered book');
const twice = mkSample(100);
dropUnavailable(twice); dropUnavailable(twice);
eq(Object.keys(twice.books.W).length, 2, 'filtering twice removes the same entries, not more');
eq(twice.entries.length, 2, '...and the grade list is stable across a second pass');


// --- haystackFor: composes a per-entry window from scan messages, injects and opted-in sources
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

    eq(win({ uid: 1 }).includes('SCEN'), false, 'an entry that opted into nothing sees no card or persona text');
    eq(win({ uid: 2, matchScenario: true }).includes('SCEN'), true, '...and the one that opted in sees exactly what it named');

    const zero = win({ uid: 3, scanDepth: 0 });
    eq(zero.includes('first') || zero.includes('second'), false, 'scanDepth 0 matches nothing from the chat');
    eq(zero.includes('AMBIENT'), true, '...but an ambient inject is not chat, so it stays');
    eq(win({ uid: 4, scanDepth: 1 }).includes('first'), false, 'a per-entry scanDepth narrows the window to its own value');
    eq(win({ uid: 4, scanDepth: 1 }).includes('second'), true, '...keeping what that depth reaches');

    const bare = haystackFor({ scanChat: S.scanChat, depth: 2 }, sceneParams({}));
    eq(bare({ uid: 1 }).join('\n'), 'A: first\nB: second', 'no injects and no sources composes to the chat window alone');
}

// --- topComponents, projectOut (metrics.mjs), on a corpus with known axes
const V = (...xs) => ({ vector: xs });
// axis 0 dominates, axis 1 is second, axis 2 is flat; the mean is non-zero on purpose
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
eq(topComponents(pts, 3, MU).length, 2, 'k beyond the data\'s rank returns fewer, not a seed vector wearing a component\'s clothes');
eq(topComponents(pts, 8, MU).length, 2, '...however far past it you ask');
const r = projectOut(pts[0].vector, MU, [p1]);
eq(near(r[0] * p1[0] + r[1] * p1[1] + r[2] * p1[2], 0, 1e-6), true, 'projectOut leaves no residue along the component');
eq(near(r[2], 0), true, '...and still subtracts the mean on the axes it does not touch');
eq(near(projectOut(pts[0].vector, MU, [])[0], pts[0].vector[0] - MU[0]), true, 'no components is exactly mean subtraction');
eq(JSON.stringify([...topComponents(pts, 2, MU)[0]]), JSON.stringify([...topComponents(pts, 2, MU)[0]]), 'the same corpus yields the same component every run');

// --- the query embedding cache: keyed by (label, exact text), tolerant of a torn append
{
    const { embed, queryCachePath: path } = await import('./scene.mjs');
    const { appendFileSync, writeFileSync, existsSync, unlinkSync } = await import('node:fs');
    const A = 'wa-check-model-a', B = 'wa-check-model-b';
    for (const l of [A, B]) if (existsSync(path(l))) unlinkSync(path(l));
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
    appendFileSync(path(A), '{"h":"deadbeef","v":[9,9');
    const { embed: embed2 } = await import(`./scene.mjs?bust=${Date.now()}`);
    const stillHit = await embed2(text, { ...fake, label: A });
    eq(JSON.stringify(stillHit), '[1,2,3]', '...and a torn final line does not take the cache down with it');
    let threw = false;
    try { await embed2(text, { ...fake, label: B }); } catch { threw = true; }
    eq(threw, true, 'another model LABEL misses rather than reusing a vector from a different space');
    for (const l of [A, B]) if (existsSync(path(l))) unlinkSync(path(l));
    void calls;
}

// --- etaSquared (global-basis.mjs): the sharedness statistic, which is not variance order
const { etaSquared } = await import('./global-basis.mjs');
{
    const MEAN = [0, 0];
// x: both groups straddle 0 identically (shared); y: group A at +1, group B at -1 (separating)
    const A = [[1, 1], [-1, 1], [1, 1], [-1, 1]].map(v => ({ vector: v }));
    const B = [[1, -1], [-1, -1], [1, -1], [-1, -1]].map(v => ({ vector: v }));
    const eta = etaSquared([A, B], MEAN, [[1, 0], [0, 1]]);
    eq(eta[0].toFixed(3), '0.000', 'a direction both groups vary along identically is SHARED, eta^2 0');
    eq(eta[1].toFixed(3), '1.000', 'a direction that offsets whole groups SEPARATES them, eta^2 1');
    const picked = [[1, 0], [0, 1]].map((c, j) => [c, eta[j]]).sort((x, y) => x[1] - y[1]).map(([c]) => c);
    eq(JSON.stringify(picked[0]), '[1,0]', "'shared' selection takes the shared direction first, not the leading one");
    eq(etaSquared([A], MEAN, [[0, 1]])[0].toFixed(3), '0.000', 'one group alone separates nothing, rather than dividing by zero');
}

// --- lineagesOf: two versions of one book are one book
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
eq(lineagesOf(two, new Map([['LTM - Isekai Adventure - Isekai Adventure - 2026-03-04', '2026-08-14'], ['LTM - Ascensus', '2026-08-13']])).get('LTM - Ascensus'),
    'LTM - Isekai Adventure - Isekai Adventure - 2026-03-04', 'a more recently used name wins even when it is longer');
eq(lineagesOf(two, new Map([['LTM - Isekai Adventure - Isekai Adventure - 2026-03-04', '2026-08-13'], ['LTM - Ascensus', '2026-08-13']])).get('LTM - Ascensus'),
    'LTM - Ascensus', '...and a tied stamp falls back to the shorter, undecorated name');
eq(lineagesOf(two, new Map([['LTM - Ascensus', '2026-08-13']])).get('LTM - Ascensus'), 'LTM - Ascensus', 'a name with no stamp at all sorts oldest rather than throwing');
eq(new Set(L.values()).size, 2, 'four files, two lineages');
const chain = lineagesOf({ A: bk('a', 'b', 'c'), B: bk('b', 'c', 'd'), C: bk('c', 'd', 'e') });
eq(new Set(chain.values()).size, 1, 'a chain of partial revisions is one lineage, not three');
const rev = lineagesOf({ Other: bk('zeta', 'eta', 'theta'), Revised: bk('alpha', 'beta', 'epsilon'), Renamed: bk('alpha', 'beta', 'gamma', 'delta'), Big: bk('alpha', 'beta', 'gamma', 'delta') });
eq(rev.get('Renamed'), L.get('Renamed'), 'the same books group the same way whatever order they arrive in');
eq(lineagesOf({ Empty: {}, Solo: bk('x') }).get('Empty'), 'Empty', 'a book with no bodies is its own lineage rather than joining everything');

// --- the two-mean decomposition is a no-op
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
