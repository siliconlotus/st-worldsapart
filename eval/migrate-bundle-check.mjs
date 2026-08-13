// migrate-bundle-check.mjs — the v1 -> v2 lift, on a hand-built bundle whose every correct answer is
// written down here. Run bare: prints ok/FAIL, exits non-zero on any failure.
//
// The cases that matter are the two whose MEANING changed, because both look like a value edit and are not:
// an eligible row's null was a measured zero and must become one, an ineligible row's must stay null, and a
// row that never had chunks must lose its confident zero. Getting either backwards would silently restate a
// convention change as a signal change, which is the whole reason the migration exists.
import { migrateManifest } from './migrate-bundle.mjs';
import { BUNDLE_VERSION } from '../extension/grading.mjs';

let failures = 0;
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) { console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); failures++; }
    return ok;
};

/** A v1 bundle: two arms over one book, covering every repair path. */
const bundle = () => ({
    bundleVersion: 1,
    name: 'check',
    primaryBook: 'B',
    books: {
        B: {
            1: { uid: 1, comment: 'keyed, not vectorized', key: ['dagger'], content: 'A dagger sits on the table.' },
            2: { uid: 2, comment: 'keyed, vectorized', key: ['harbour'], vectorized: true, content: 'The harbour at dawn.' },
            3: { uid: 3, comment: 'no keys at all', key: [], vectorized: true, content: 'Unkeyed reference material.' },
        },
    },
    grades: [{ world: 'B', uid: 1, grade: 3 }],
    gradeScale: 4,
    arms: [
        {
            arm: 'shipped',
            scanText: 'she drew the dagger and ran',
            // suppressVectorKeys on: entry 2's keys are blanked, so its null is an ABSENCE.
            captureParams: { suppressVectorKeys: true, scoreVectorKeys: false, wholeWords: false, caseSensitive: false },
            paramSnapshot: { budget: { maxTokens: 0 }, summary: { llmProfile: 'withdrawn' } },
            candidates: [
                // eligible (has keys, not vectorized) + null -> a measured 0
                { uid: 1, world: 'B', title: 'keyed, not vectorized', cosine: 0.4, text: 1.2, keys: null },
                // ineligible (vectorized, suppressed) + a stored value -> absence
                { uid: 2, world: 'B', title: 'keyed, vectorized', cosine: 0.3, text: 0.8, keys: 0 },
                // no cosine: never in the collection, so text's 0 was a default
                { uid: 3, world: 'B', title: 'no keys at all', cosine: null, text: 0, keys: null },
            ],
        },
        {
            arm: 'summary',
            scanText: 'she drew the dagger and ran',
            captureParams: { suppressVectorKeys: true, scoreVectorKeys: false },
            candidates: [{ uid: 1, world: 'B', title: 'keyed, not vectorized', cosine: 0.4, text: 1.2, keys: null }],
        },
    ],
});

const { m, tally } = await migrateManifest(bundle(), { tokensOf: null, tokenizer: null });
const rows = m.arms[0].candidates;

check('version bumped', m.bundleVersion, BUNDLE_VERSION);
check('summary arm dropped', m.arms.map(a => a.arm), ['shipped']);
check('paramSnapshot.summary dropped', m.arms[0].paramSnapshot.summary, undefined);
check('population marked as survivors', m.population, 'survivors');
check('migratedFrom records the old version', m.migratedFrom, 1);

check('eligible null -> measured 0', rows[0].keys, 0);
check('ineligible value -> null', rows[1].keys, null);
check('no-cosine text -> null', rows[2].text, null);
check('text with cosine untouched', rows[0].text, 1.2);
check('cosine never touched', [rows[0].cosine, rows[1].cosine, rows[2].cosine], [0.4, 0.3, null]);
check('grades never touched', m.grades, [{ world: 'B', uid: 1, grade: 3 }]);
check('tally counts the repairs', [tally.keysZeroed, tally.keysNulled, tally.textNulled], [1, 1, 1]);

// `why` is recomputed from the frozen scan text through the shared matcher, so a key that fires is
// localised and one that cannot is absent — the arm's suppress gate decides which.
check('why: fired key on an eligible entry', rows[0].why.map(w => [w.key, w.count]), [['dagger', 1]]);
check('why: suppressed entry has no hits', rows[1].why, []);
check('why: entry with no keys has no hits', rows[2].why, []);
check('why excerpt marks the match', typeof rows[0].why[0].excerpt?.text, 'string');

// Idempotence: a v2 is left alone. Without this the second run of a --write pass would restamp and, worse,
// re-null every measured zero the first run just recovered.
const again = await migrateManifest(m, { tokensOf: null, tokenizer: null });
check('v2 is skipped', again.skip, 'already v2');
check('v2 rows unchanged', again.m.arms[0].candidates.map(r => r.keys), [0, null, null]);

// A flat single-arm sample (no `arms`, no version) is the third shape on disk and takes the same path.
const flat = {
    name: 'flat', primaryBook: 'B', gradeScale: 4, grades: [],
    books: bundle().books,
    scanText: 'she drew the dagger and ran',
    captureParams: { suppressVectorKeys: true, scoreVectorKeys: false },
    candidates: [{ uid: 1, world: 'B', title: 'keyed, not vectorized', cosine: 0.4, text: 1.2, keys: null }],
};
const flatOut = await migrateManifest(flat, { tokensOf: null, tokenizer: null });
check('flat sample lifts too', [flatOut.m.bundleVersion, flatOut.m.candidates[0].keys], [BUNDLE_VERSION, 0]);
check('flat sample records it had no version', flatOut.m.migratedFrom, 'flat-sample');

// tokensOf is injected, and only fills a row that has none.
const withTokens = await migrateManifest(bundle(), { tokensOf: async c => String(c).length, tokenizer: 'test' });
check('tokens backfilled from the injected counter', withTokens.m.arms[0].candidates.map(r => r.tokens), [27, 20, 27]);
check('tokenizer recorded beside the counts', withTokens.m.arms[0].paramSnapshot.budget.tokenizer, 'test');

// cut/cutBy are the live budget's verdict and are never invented.
check('cut not fabricated', rows.map(r => r.cut), [undefined, undefined, undefined]);
check('cutBy not fabricated', rows.map(r => r.cutBy), [undefined, undefined, undefined]);

console.log(failures ? `\n${failures} FAILED` : 'ok');
process.exit(failures ? 1 : 0);
