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
//
// The skip REASON is not asserted, only that it skipped and changed nothing: a v2 whose rows lack `tokens`
// says so in the message, and pinning the string would make that a failure rather than the note it is.
const again = await migrateManifest(m, { tokensOf: null, tokenizer: null });
check('v2 is skipped', String(again.skip).startsWith('already v2'), true);
check('v2 rows unchanged', again.m.arms[0].candidates.map(r => r.keys), [0, null, null]);

// The token backfill is the one thing a v2 may still be missing, and it CONVERGES: a pass with a counter
// fills them, and the next pass finds nothing to do. Anything else on the row stays untouched, which is
// what keeps this from becoming a second migration path wearing a smaller name.
const counted = await migrateManifest(m, { tokensOf: async c => String(c ?? '').length, tokenizer: 'test-tok' });
check('v2 missing tokens is backfilled', counted.tokensOnly, true);
check('every row gained a count', counted.m.arms[0].candidates.every(r => typeof r.tokens === 'number'), true);
check('backfill records its tokenizer', counted.m.arms[0].paramSnapshot.budget.tokenizer, 'test-tok');
check('backfill touches nothing else', counted.m.arms[0].candidates.map(r => r.keys), [0, null, null]);
const third = await migrateManifest(counted.m, { tokensOf: async () => 999, tokenizer: 'test-tok' });
check('a second backfill is a no-op', third.skip, 'already v2');

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

// A capture whose ROWS are already at v2 conventions but whose stamp is stale (the extension in the browser
// predates the BUNDLE_VERSION bump) must be restamped, never migrated. Migrating one is nearly a no-op on
// the values and still marks a full capture `population: 'survivors'`.
const v2shaped = () => ({
    bundleVersion: 1, name: 'fresh', primaryBook: 'B', gradeScale: 4, grades: [], books: bundle().books,
    arms: [{
        arm: 'shipped', scanText: 'she drew the dagger and ran',
        captureParams: { suppressVectorKeys: true, scoreVectorKeys: false },
        candidates: [{ uid: 1, world: 'B', title: 'keyed, not vectorized', cosine: 0.4, text: 1.2, keys: 0, tokens: 27, cut: false, cutBy: null, why: [] }],
    }],
});
const fresh = await migrateManifest(v2shaped(), { tokensOf: null, tokenizer: null });
check('a v2-shaped bundle with a stale stamp is restamped', fresh.restamped, true);
check('...its version is corrected', fresh.m.bundleVersion, BUNDLE_VERSION);
check('...and it is NOT labelled survivors', fresh.m.population, undefined);
check('...and no repair is claimed', [fresh.tally.textNulled, fresh.tally.keysZeroed, fresh.tally.why], [0, 0, 0]);
// The distinction is the ROWS, not the stamp: strip the v2 row fields and the same stamp migrates normally.
const stale = v2shaped();
for (const r of stale.arms[0].candidates) { delete r.tokens; delete r.cut; delete r.cutBy; delete r.why; }
const migrated = await migrateManifest(stale, { tokensOf: null, tokenizer: null });
check('a genuinely v1-shaped bundle still migrates', migrated.restamped, undefined);
check('...and is marked survivors', migrated.m.population, 'survivors');


// eval-data holds caches and prompt sets beside the samples, and `eval-data/*.json` is the obvious way to
// invoke this. Anything without grades AND candidates is not a graded sample and must come back untouched.
for (const [label, obj] of [
    ['a token cache', { 'gpt-3.5-turbo\u001fabc': 27 }],
    ['a prompt set', { prompts: [{ id: 1, text: 'hi' }] }],
    ['a bundle with grades but no candidates', { bundleVersion: 1, grades: [{ uid: 1, grade: 3 }] }],
]) {
    const r = await migrateManifest(structuredClone(obj), { tokensOf: null, tokenizer: null });
    check(`${label} is left alone`, r.skip, 'not a graded sample');
    check(`...${label} gains no bundle metadata`, [r.m.population, r.m.migratedWhy], [undefined, undefined]);
}

console.log(failures ? `\n${failures} FAILED` : 'ok');
process.exit(failures ? 1 : 0);
