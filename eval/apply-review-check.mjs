// Checks for apply-review.mjs's merge rule (mergeReview) and section resolution (resolveSections).
import { eq, gradeValue } from './metrics.mjs';
const { mergeReview, resolveSections } = await import('./synthetic-data/apply-review.mjs');
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const ME = { user: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', now: '2026-08-21' };
// An llm rater is two fields, model and rubric, never one composed string (G8).
const llm = g => [{ kind: 'llm', model: 'gemma4:31b-mlx', rubric: 'scene-relevance@abc', grade: g }];
const humansIn = row => (row.grades ?? []).filter(v => v.kind === 'human');
const llmsIn = row => (row.grades ?? []).filter(v => v.kind === 'llm');
const bundle = () => [
    { book: 'W', uid: 1, grades: llm(3) },
    { book: 'W', uid: 2, grades: llm(0) },
    { book: 'W', uid: 3, grades: [...llm(3), { kind: 'human', id: ME.user, grade: 4 }] },
];

const untouched = mergeReview(bundle(), [{ book: 'W', uid: 1, grade: 2 }], ME);
eq(untouched.grades.length, 3, 'a review of one row leaves the other rows in place');
eq(gradeValue(untouched.grades.find(g => g.uid === 2)), 0, '...with their llm verdict intact');
eq(humansIn(untouched.grades.find(g => g.uid === 2)).length, 0, '...and still carrying no human verdict');
eq(untouched.changed, 1, 'the graded row counts as changed');

const both = mergeReview([{ book: 'W', uid: 1, grades: llm(3) }],
    [{ book: 'W', uid: 1, grade: 1, why: 'human disagreed' }], ME);
eq(llmsIn(both.grades[0]).length, 1, 'the llm verdict survives a human review');
eq(humansIn(both.grades[0]).length, 1, '...beside the human one, rather than under it');
eq(gradeValue(both.grades[0]), 1, '...and the human outranks the llm at read time');
eq(both.grades[0].grades.map(v => v.kind).join(','), 'llm,human', 'and the two sit in one array, in the order passed');
eq(humansIn(both.grades[0])[0].id, ME.user, 'the verdict names its rater');
eq(humansIn(both.grades[0])[0].gradedAt, ME.now, '...and when it was passed');
eq(humansIn(both.grades[0])[0].why, 'human disagreed', '...and carries the reviewer\'s reasoning');

const again = mergeReview(both.grades, [{ book: 'W', uid: 1, grade: 4 }], { ...ME, now: '2026-09-01' });
eq(humansIn(again.grades[0]).length, 2, 'a changed verdict from the same rater appends');
eq(gradeValue(again.grades[0]), 4, '...and the latest human verdict is the one in force');

const day1 = mergeReview([{ book: 'W', uid: 3, grades: llm(3) }], [{ book: 'W', uid: 3, grade: 4 }], ME);
const twice = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 4 }], ME);
eq(humansIn(twice.grades[0]).length, 1, 'applying the same review twice does not duplicate the verdict');
eq(twice.changed, 0, '...and reports no change');
const day2 = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 4 }], { ...ME, now: '2026-09-01' });
eq(humansIn(day2.grades[0]).length, 2, 'the same rater on another day appends, even agreeing with themselves');
const other = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 4 }], { user: 'a-different-uuid', now: ME.now });
eq(humansIn(other.grades[0]).length, 2, 'a second rater agreeing still appends');
const flip = mergeReview(day1.grades, [{ book: 'W', uid: 3, grade: 0 }], { ...ME, now: '2026-09-01' });
eq(humansIn(flip.grades[0]).map(v => v.grade).join(','), '4,0', 'a changed verdict joins the record rather than replacing it');
eq(llmsIn(flip.grades[0]).length, 1, '...and the llm verdict is still there under both of them');

const grew = mergeReview(bundle(), [{ book: 'W', uid: 9, grade: 3 }], ME);
eq(grew.grades.length, 4, 'a row the scene lacks is added');
eq(grew.added, 1, '...and counted as added, not changed');

const blank = mergeReview(bundle(), [{ book: 'W', uid: 1, why: 'looked, did not decide' }], ME);
eq(blank.changed + blank.added, 0, 'a mentioned row with no grade is not a verdict');

const twoBooks = mergeReview([{ book: 'A', uid: 1, grades: llm(0) }], [{ book: 'B', uid: 1, grade: 4 }], ME);
eq(twoBooks.grades.length, 2, 'same uid in a different book is a different row');

const stripped = mergeReview([{ book: 'W', uid: 1, grades: llm(1) }],
    [{ book: 'W', uid: 1, grade: 3, entryText: 'the whole entry body' }], ME);
eq(stripped.grades[0].entryText, undefined, 'entryText is not written into the scene');
eq(gradeValue(stripped.grades[0]), 3, '...but the human verdict is');


// --- resolving a section to its bundle: by id, with no fallback to the name ----------------------------
{
    const dir = mkdtempSync(join(tmpdir(), 'wa-resolve-'));
    const put = (f, doc) => writeFileSync(join(dir, f), JSON.stringify(doc, null, 1));
    put('renamed-by-a-user.json', { schemaVersion: 3, captureId: 'cap-A' });
    put('decoy.json', { schemaVersion: 3, captureId: 'cap-B' });
    put('no-id.json', { schemaVersion: 3 });

    const at = s => resolveSections([s], dir).get(s);

    const moved = at({ captureId: 'cap-A', file: 'what-it-was-called.json' });
    eq(moved.path, join(dir, 'renamed-by-a-user.json'), 'a renamed bundle is still found, by id');
    eq(moved.renamedFrom, 'what-it-was-called.json', '...and the run reports the name it no longer answers to');

    const still = at({ captureId: 'cap-B', file: 'decoy.json' });
    eq(still.path, join(dir, 'decoy.json'), 'an unrenamed bundle resolves by id too, not by luck');
    eq(still.renamedFrom, undefined, '...and says nothing, because nothing moved');

    eq(at({ captureId: 'cap-A', file: 'decoy.json' }).path, join(dir, 'renamed-by-a-user.json'),
        'the id decides, never the name beside it');

    eq(Boolean(at({ captureId: 'cap-GONE', file: 'decoy.json' }).error), true,
        'an id nothing carries REFUSES — it does not fall back to a name that happens to resolve');
    eq(at({ captureId: 'cap-GONE', file: 'decoy.json' }).path, undefined, '...and offers no path to write to');

    eq(Boolean(at({ file: 'no-id.json' }).error), true, 'a section with no id refuses, since nothing else identifies a bundle');
    eq(Boolean(at({ captureId: 'cap-A', file: 'no-id.json' }).path), true, 'a document carrying no id is never a match for a section that has one');

    put('a-copy.json', { schemaVersion: 3, captureId: 'cap-A' });
    const ambiguous = at({ captureId: 'cap-A', file: 'decoy.json' });
    eq(Boolean(ambiguous.error), true, 'an id in two files refuses rather than picking one');
    eq(ambiguous.path, undefined, '...and offers no path to write to');

    put('padded.json', { schemaVersion: 3, captureId: 'cap-PAD', books: {} });
    eq(at({ captureId: 'cap-PAD', file: 'padded.json' }).path, join(dir, 'padded.json'),
        'the id is the second key, so a head read finds it whatever follows');

    put('review-of-them.json', { user: 'u', reviewed: [{ captureId: 'cap-PAD', file: 'padded.json' }] });
    put('padded-pending.json', { pending: [], forScene: 'x', primaryBook: 'W' });
    eq(at({ captureId: 'cap-PAD', file: 'padded.json' }).path, join(dir, 'padded.json'),
        'a review naming an id is not a document carrying one');

    rmSync(dir, { recursive: true, force: true });
}
