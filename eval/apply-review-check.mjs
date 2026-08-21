// Checks for apply-review.mjs's merge rule. The write half is I/O and argv; this is the part that decides
// what a review does to a scene, and the rule that matters is what it leaves ALONE.
import { eq, gradeValue } from './metrics.mjs';
const { mergeReview } = await import('./synthetic-data/apply-review.mjs');

const ME = { user: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', now: '2026-08-21' };
// An llm rater is a MODEL and a RUBRIC, two fields — never one composed string. Measured: every Ollama
// model name carries a `:` (`gemma4:31b-mlx`) and every MLX one is an HF repo id carrying a `/`, so no
// printable separator is safe. The same finding that keeps `book` + `uid` apart.
const llm = g => [{ kind: 'llm', model: 'gemma4:31b-mlx', rubric: 'scene-relevance@abc', grade: g }];
const humansIn = row => (row.grades ?? []).filter(v => v.kind === 'human');
const llmsIn = row => (row.grades ?? []).filter(v => v.kind === 'llm');
const bundle = () => [
    { book: 'W', uid: 1, grades: llm(3) },
    { book: 'W', uid: 2, grades: llm(0) },
    { book: 'W', uid: 3, grades: [...llm(3), { kind: 'human', id: ME.user, grade: 4 }] },
];

// A row the review does not mention is not a judgement about that row.
const untouched = mergeReview(bundle(), [{ book: 'W', uid: 1, grade: 2 }], ME);
eq(untouched.grades.length, 3, 'a review of one row leaves the other rows in place');
eq(gradeValue(untouched.grades.find(g => g.uid === 2)), 0, '...with their llm verdict intact');
eq(humansIn(untouched.grades.find(g => g.uid === 2)).length, 0, '...and still carrying no human verdict');
eq(untouched.changed, 1, 'the graded row counts as changed');

// A HUMAN RE-GRADING APPENDS. The llm's verdict is not replaced, edited or dropped — both are in the
// record and the reader decides which counts.
const both = mergeReview([{ book: 'W', uid: 1, grades: llm(3) }],
    [{ book: 'W', uid: 1, grade: 1, why: 'human disagreed' }], ME);
eq(llmsIn(both.grades[0]).length, 1, 'the llm verdict survives a human review');
eq(humansIn(both.grades[0]).length, 1, '...beside the human one, rather than under it');
eq(gradeValue(both.grades[0]), 1, '...and the human outranks the llm at read time');
// ONE ARRAY, IN THE ORDER PASSED — which two arrays could not express across kinds.
eq(both.grades[0].grades.map(v => v.kind).join(','), 'llm,human', 'and the two sit in one array, in the order passed');
eq(humansIn(both.grades[0])[0].id, ME.user, 'the verdict names its rater');
eq(humansIn(both.grades[0])[0].gradedAt, ME.now, '...and when it was passed');
eq(humansIn(both.grades[0])[0].why, 'human disagreed', '...and carries the reviewer\'s reasoning');

// A SECOND human verdict appends rather than overwriting the first.
const again = mergeReview(both.grades, [{ book: 'W', uid: 1, grade: 4 }], { ...ME, now: '2026-09-01' });
eq(humansIn(again.grades[0]).length, 2, 'a changed verdict from the same rater appends');
eq(gradeValue(again.grades[0]), 4, '...and the latest human verdict is the one in force');

// NOTHING IS EVER OVERWRITTEN, so the only exemption is a repeated PASS: same rater, same day.
const day1 = mergeReview([{ book: 'W', uid: 3, grades: llm(3) }], [{ book: 'W', uid: 3, grade: 4 }], ME);
const twice = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 4 }], ME);
eq(humansIn(twice.grades[0]).length, 1, 'applying the same review twice does not duplicate the verdict');
eq(twice.changed, 0, '...and reports no change');
// A different DAY is a person looking again, which is an event even at the same grade.
const day2 = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 4 }], { ...ME, now: '2026-09-01' });
eq(humansIn(day2.grades[0]).length, 2, 'the same rater on another day appends, even agreeing with themselves');
// A DIFFERENT rater agreeing is a second opinion, and that is an event too.
const other = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 4 }], { user: 'a-different-uuid', now: ME.now });
eq(humansIn(other.grades[0]).length, 2, 'a second rater agreeing still appends');
// And a disagreement never replaces what it disagrees with.
const flip = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 0 }], { ...ME, now: '2026-09-01' });
eq(humansIn(flip.grades[0]).map(v => v.grade).join(','), '4,0', 'a changed verdict joins the record rather than replacing it');
eq(llmsIn(flip.grades[0]).length, 1, '...and the llm verdict is still there under both of them');

// A row the review has never seen is added rather than dropped — pool-extend rows arrive this way.
const grew = mergeReview(bundle(), [{ book: 'W', uid: 9, grade: 3 }], ME);
eq(grew.grades.length, 4, 'a row the scene lacks is added');
eq(grew.added, 1, '...and counted as added, not changed');

// A row the review mentions with no grade is the same absence as one it never mentions.
const blank = mergeReview(bundle(), [{ book: 'W', uid: 1, why: 'looked, did not decide' }], ME);
eq(blank.changed + blank.added, 0, 'a mentioned row with no grade is not a verdict');

// book is part of the identity: uid alone collides across books.
const twoBooks = mergeReview([{ book: 'A', uid: 1, grades: llm(0) }], [{ book: 'B', uid: 1, grade: 4 }], ME);
eq(twoBooks.grades.length, 2, 'same uid in a different book is a different row');

// `entryText` travels in the review so it can be read standalone, and is dropped on the way into the
// scene — the books already hold the entry, and a duplicate on the grade row goes stale silently.
const stripped = mergeReview([{ book: 'W', uid: 1, grades: llm(1) }],
    [{ book: 'W', uid: 1, grade: 3, entryText: 'the whole entry body' }], ME);
eq(stripped.grades[0].entryText, undefined, 'entryText is not written into the scene');
eq(gradeValue(stripped.grades[0]), 3, '...but the human verdict is');
