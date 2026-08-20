// Checks for apply-review.mjs's merge rule. The write half is I/O and argv; this is the part that decides
// what a review does to a bundle, and the rule that matters is what it leaves ALONE.
import { eq } from './metrics.mjs';
const { mergeReview } = await import('./synthetic-data/apply-review.mjs');

const bundle = [
    { world: 'W', uid: 1, llmGrade: 3, by: 'judge' },
    { world: 'W', uid: 2, llmGrade: 0, by: 'judge' },
    { world: 'W', uid: 3, grade: 4, llmGrade: 3 },
];

// A row the review does not mention is not a judgement about that row.
const untouched = mergeReview(bundle, [{ world: 'W', uid: 1, grade: 2, llmGrade: 3 }]);
eq(untouched.grades.length, 3, 'a review of one row leaves the other rows in place');
eq(untouched.grades.find(g => g.uid === 2).llmGrade, 0, '...with their judge verdict intact');
eq(untouched.grades.find(g => g.uid === 2).grade, undefined, '...and still carrying no human grade');
eq(untouched.changed, 1, 'the graded row counts as changed');

// The reviewer had the whole row, so its version wins wholesale rather than field-merging a stale `why`.
const replaced = mergeReview([{ world: 'W', uid: 1, llmGrade: 3, why: 'judge said so' }],
    [{ world: 'W', uid: 1, grade: 1, llmGrade: 3, why: 'human disagreed' }]);
eq(replaced.grades[0].why, 'human disagreed', 'a reviewed row replaces its counterpart, stale fields included');
eq(replaced.grades[0].llmGrade, 3, '...and the judge verdict rides along, because the review file carries it');

// Re-applying the same review is a no-op, so a double-run cannot inflate the counts.
const once = mergeReview(bundle, [{ world: 'W', uid: 3, grade: 4, llmGrade: 3 }]);
eq(once.changed, 0, 'a review agreeing with what is already there changes nothing');
const twice = mergeReview(once.grades, [{ world: 'W', uid: 3, grade: 4, llmGrade: 3 }]);
eq(twice.grades.length, 3, 'applying the same review twice does not duplicate rows');
eq(twice.changed, 0, '...and still reports no change');

// A row the bundle has never seen is added rather than dropped — pool-extend rows arrive this way.
const grew = mergeReview(bundle, [{ world: 'W', uid: 9, grade: 3 }]);
eq(grew.grades.length, 4, 'a row the bundle lacks is added');
eq(grew.added, 1, '...and counted as added, not changed');

// world is part of the identity: uid alone collides across books.
const twoBooks = mergeReview([{ world: 'A', uid: 1, llmGrade: 0 }], [{ world: 'B', uid: 1, grade: 4 }]);
eq(twoBooks.grades.length, 2, 'same uid in a different world is a different row');

// `entryText` travels in the review so it can be read standalone, and is dropped on the way into the
// bundle — the books already hold the entry, and a duplicate on the grade row goes stale silently.
const stripped = mergeReview([{ world: 'W', uid: 1, llmGrade: 1 }],
    [{ world: 'W', uid: 1, grade: 3, why: 'human', entryText: 'the whole entry body' }]);
eq(stripped.grades[0].entryText, undefined, 'entryText is not written into the bundle');
eq(stripped.grades[0].grade, 3, '...but the human grade is');
eq(stripped.grades[0].why, 'human', '...and so is the rest of the row');
