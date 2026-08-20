// normalize-grades-check.mjs — the attribution rules, which are the only part of the migration that can
// be wrong in a way nothing later detects.
//
// A verdict attributed to the wrong pass is indistinguishable from one that pass actually gave, and it is
// read as evidence: pass-vs-pass agreement, a model comparison, a rubric's effect. Absent attribution is
// merely unknown. So every case here is about refusing to guess, and about the ONE trap the first draft
// fell into — that `by`, on a row or on a bundle, names the pass that touched it LAST.
import { eq } from './metrics.mjs';
import { attributionOf, normalizeBundle, passFromNotes } from './synthetic-data/normalize-grades.mjs';

const NOTES = { notes: 'SYNTHETIC super-grade: captured offline. Graded by claude-fable-5 (LLM judge, 0-4).', at: '2026-07-31' };

eq(passFromNotes(NOTES), 'wa-super-grade-synthetic/claude-fable-5', 'the model is read out of the prose notes');
eq(passFromNotes({ notes: 'no model named here' }), null, 'notes that name nothing attribute nothing');

// A scalar row records one verdict, so its own `by` is that verdict's author.
eq(attributionOf({ grading: { by: 'later-pass' } }, { by: 'own-pass' }), 'own-pass', 'a row naming its pass is believed');

// One pass on the bundle and nothing to contradict it.
eq(attributionOf({ grading: { by: 'only-pass' }, grades: [] }, {}), 'only-pass', 'the bundle label is used when it is the only one');

// Several passes have touched the bundle, so its label cannot say which produced an unrecorded verdict.
{
    const b = { grading: { by: 'pass-c' }, grades: [{ llmGrades: [{ by: 'pass-a' }, { by: 'pass-b' }] }] };
    eq(attributionOf(b, {}), null, 'a bundle several passes touched attributes nothing');
}

// THE TRAP: an element with no `by` predates the field, so BOTH the row's label and the bundle's belong
// to a later pass. Reading either is how 1277 fable-5 verdicts were first filed under sonnet.
{
    const b = { grading: { by: 'scene-relevance@8460b922/claude-sonnet-5#tiebreak', ...NOTES } };
    const row = { by: 'scene-relevance@8460b922/claude-sonnet-5' };
    eq(attributionOf(b, row, false), 'wa-super-grade-synthetic/claude-fable-5', 'a bare element reads only the notes');
    eq(attributionOf(b, row, true), 'scene-relevance@8460b922/claude-sonnet-5', '...where a scalar row still reads its own label');
}

// A scalar row becomes a one-element history carrying everything the row knew.
{
    const b = { grading: { by: 'only-pass', at: '2026-07-31' }, grades: [{ world: 'W', uid: 1, llmGrade: 3, why: 'because' }] };
    const r = normalizeBundle(b);
    eq(r.lifted, 1, 'the scalar row is lifted into a history');
    eq(b.grades[0].llmGrades.length, 1, '...as a single element');
    eq(b.grades[0].llmGrades[0].llmGrade, 3, '...carrying the verdict');
    eq(b.grades[0].llmGrades[0].by, 'only-pass', '...and its pass');
    eq(b.grades[0].llmGrades[0].why, 'because', '...and the reasoning that came with it');
    eq(b.grades[0].llmGrade, 3, 'the value in force is not touched — that is a separate question');
}

// Nothing to attribute with: the history is still written, because the verdict is real and losing it to
// an unknown author would be worse. The row is counted so the run reports it.
{
    const b = { grading: {}, grades: [{ world: 'W', uid: 1, llmGrade: 2 }] };
    const r = normalizeBundle(b);
    eq(r.unattributed, 1, 'a verdict nothing can attribute is reported');
    eq(b.grades[0].llmGrades[0].llmGrade, 2, '...and kept');
    eq(b.grades[0].llmGrades[0].by, undefined, '...with no invented author');
}

// Idempotent: a second run must not re-lift or re-attribute, or a re-run would double the history.
{
    const b = { grading: { by: 'only-pass', ...NOTES }, grades: [{ world: 'W', uid: 1, llmGrade: 3 }] };
    normalizeBundle(b);
    const again = normalizeBundle(b);
    eq(again.lifted, 0, 'a second run lifts nothing');
    eq(again.attributed, 0, '...and attributes nothing');
    eq(b.grades[0].llmGrades.length, 1, '...leaving the history one element long');
}

// A human's `grade` is not this migration's business and must survive untouched beside the judge history.
{
    const b = { grading: { by: 'only-pass' }, grades: [{ world: 'W', uid: 1, grade: 4, llmGrade: 1 }] };
    normalizeBundle(b);
    eq(b.grades[0].grade, 4, 'the human verdict is untouched');
    eq(b.grades[0].llmGrades[0].llmGrade, 1, '...and the judge history is the judge\'s alone');
}

// A lone unattributed element is a lifted scalar row, not a legacy one — every legacy bare element sits
// beside an attributed sibling. The case that matters is the AMBIGUOUS bundle, where the scalar path
// refuses because several passes have touched it: reading the notes for that lifted element on a second
// run would grant what the first refused, which is a migration that decides more each time it is run.
{
    const b = {
        grading: { by: 'pass-c', ...NOTES },
        grades: [
            { world: 'W', uid: 1, llmGrade: 2 },
            { world: 'W', uid: 2, llmGrades: [{ llmGrade: 1, by: 'pass-a' }, { llmGrade: 2, by: 'pass-b' }] },
        ],
    };
    const first = normalizeBundle(b);
    eq(first.unattributed, 1, 'the ambiguous bundle attributes nothing to the lifted row');
    eq(b.grades[0].llmGrades[0].by, undefined, '...leaving it unattributed');
    const again = normalizeBundle(b);
    eq(again.attributed, 0, 'a re-run does not attribute it after all');
    eq(b.grades[0].llmGrades[0].by, undefined, '...leaving the record as the first run left it');
}

// Notes ARE the fallback when nothing structural contradicts them — a bundle with no `grading.by` at all.
{
    const b = { grading: { ...NOTES }, grades: [{ world: 'W', uid: 1, llmGrade: 2 }] };
    normalizeBundle(b);
    eq(b.grades[0].llmGrades[0].by, 'wa-super-grade-synthetic/claude-fable-5', 'the notes attribute a scalar row when nothing else can');
}

// ...while a legacy bare element beside an attributed sibling is still recovered.
{
    const b = { grading: { by: 'later-pass', ...NOTES }, grades: [{ world: 'W', uid: 1, llmGrade: 2, by: 'later-pass', llmGrades: [{ llmGrade: 1 }, { llmGrade: 2, by: 'later-pass' }] }] };
    const r = normalizeBundle(b);
    eq(r.attributed, 1, 'a bare element with siblings is attributed');
    eq(b.grades[0].llmGrades[0].by, 'wa-super-grade-synthetic/claude-fable-5', '...from the notes, not from the later pass');
}

console.log('ok');
