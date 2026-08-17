// Self-check for grading.mjs — the /wa-grade sample assembler. The UI half can't be exercised offline, so
// this pins the part that decides what a sample CONTAINS: book fidelity, the settings mapping, the
// reference tier, and the foreign-book exclusion. A sample that silently loses a field is a graded scene
// that can't be re-run, which is the whole failure this feature exists to prevent.
import { buildSample, bundleSamples, captureParams, isDurable, mergeGrades, openBundle, rowKey, sampleFile, searchedBook, splitGraded, trimBook, unionArms } from '../extension/grading.mjs';
import { eq, gradeValue } from './metrics.mjs';
import * as ranking from '../extension/ranking.mjs';

const book = {
    1: { uid: 1, comment: 'Villa Party', key: ['villa', 'party'], keysecondary: [], vectorized: true, content: 'A'.repeat(3000), order: 100 },
    2: { uid: 2, comment: 'Mechanics', key: ['knot'], vectorized: false, constant: true, content: 'B'.repeat(2000) },
};

// --- trimBook fidelity ---
const full = trimBook(book, 'full');
eq(Object.keys(full).length, 2, 'full keeps every entry');
eq(full[1].content.length, 3000, 'full keeps entry content');

const meta = trimBook(book, 'meta');
eq(Object.keys(meta).length, 2, 'meta keeps every entry (gazetteer + keyword scan read the whole book)');
eq(meta[1].content, undefined, 'meta drops content');
eq(meta[1].comment, 'Villa Party', 'meta keeps the title — the gazetteer is mostly titles');
eq(JSON.stringify(meta[1].key), '["villa","party"]', 'meta keeps keys');
eq(meta[1].vectorized, true, 'meta keeps vectorized (drives scoreVectorKeys offline)');
eq(JSON.stringify(trimBook(book, 'none')), '{}', 'none embeds no entries');
// Size is the only reason meta exists; assert it actually pays.
eq(JSON.stringify(meta).length * 10 < JSON.stringify(full).length, true, 'meta is >10x smaller than full');
// An array of entries is accepted too (the harness holds them that way).
eq(Object.keys(trimBook(Object.values(book), 'meta')).length, 2, 'trimBook accepts an array');

// --- captureParams maps settings onto the harness's argument names ---
const s = { rrfK: 20, bm25K1: 1.2, bm25B: 0.75, lexicalWeight: 1, properNounBoost: 3, stopwordDocFreq: 0.25,  maxVectorEntries: 10, suppressVectorKeys: true, scoreVectorKeys: false, entityFilter: true, queryMode: 'messages', weightByOrder: false };
const p = captureParams(s, { caseSensitive: false, wholeWords: false, includeNames: true });
eq(p.K, 20, 'rrfK -> K');
eq(p.K1, 1.2, 'bm25K1 -> K1');
eq(p.LEXW, 1, 'lexicalWeight -> LEXW');
eq(p.stopwordDf, 0.25, 'stopwordDocFreq -> stopwordDf');
eq('threshold' in p, false, 'no admission threshold is captured — stage 1 has no gate to reproduce');
eq('vectorCutoff' in p, false, 'no cliff mode is captured — stage 4 has no relevance cut to reproduce');
eq(p.includeNames, true, 'ST world-info globals are carried, not guessed');
eq('retrievalMode' in captureParams(s, {}), false, 'the capture records no retrieval mode');
eq('commonWordWeight' in p, false, 'no general-English down-weight is captured — BM25 no longer takes one');
eq('suppressVectorKeys' in p, false, 'no key-suppression flag is captured — the takeover blanks every keyword-activating entry');

// --- reference tier: constants and CONFIGURED stickies are not relevance results ---
eq(isDurable({ block: 'constant', sticky: 0 }), true, 'constant is durable');
// ARMED, not configured: a sticky entry whose effect no turn has armed is ordinary content competing for
// selection, and `block` is where the runtime records that it armed one. The configured value says nothing
// about this turn — reading it deleted whole reference tiers from the ranked population.
eq(isDurable({ block: 'dynamic', sticky: 3 }), false, 'configured sticky with no armed effect is gradeable');
eq(isDurable({ block: 'sticky', sticky: 3 }), true, 'an ARMED sticky row is durable');
eq(isDurable({ block: 'sticky', sticky: 0 }), true, '...read off block, not the setting');
eq(isDurable({ block: 'dynamic', sticky: 0 }), false, 'a plain dynamic row is gradeable');

// --- searchedBook: which collection the harness must load ---
// The case that motivated it: the chat's bound book contributed ONE retrieved row, another book contributed
// three. Keying the sample to the chat book would declare those three out of scope (excludeTitles).
const rows = [
    { world: 'Chat', cosine: 0.9, block: 'dynamic' },
    { world: 'Lore', cosine: 0.8, block: 'dynamic' },
    { world: 'Lore', cosine: 0.7, block: 'dynamic' },
    { world: 'Lore', cosine: 0.0, block: 'dynamic' },
    { world: 'Keys', cosine: null, block: 'dynamic' },
];
eq(searchedBook(rows), 'Lore', 'the book contributing the most retrieved rows wins, not the top-ranked row');
eq(searchedBook(rows.filter(r => r.world !== 'Lore')), 'Chat', 'a single retrieved row still names its book');
// A 0.00000 cosine is a RETRIEVED row; only null means "never retrieved". Truthiness would drop it.
eq(searchedBook([{ world: 'Zero', cosine: 0 }]), 'Zero', 'a genuine 0 cosine counts as retrieved');
eq(searchedBook([{ world: 'Keys', cosine: null }]), null, 'keyword-only scene: no collection was searched');
eq(searchedBook([]), null, 'no candidates at all');
// Ties break toward the higher-ranked book, so the pick is deterministic rather than Map-order luck.
eq(searchedBook([{ world: 'B', cosine: 0.9 }, { world: 'A', cosine: 0.8 }]), 'B', 'ties break toward the higher-ranked book');

// --- buildSample ---
const sample = buildSample({
    name: 'scene9', query: 'q', scanText: 'w', depth: 5, index: 'i', chat: 'chats/c.jsonl', primaryBook: 'Main',
    params: p, snapshot: { scoring: {} }, candidates: [{ title: 'Villa Party' }],
    books: { Main: meta, Other: {} }, bookMode: 'meta', priority: [{ world: 'Main', weight: 1 }],
    grades: [
        { title: 'Villa Party', grade: 5, world: 'Main', uid: 1 },
        { title: 'Mechanics', grade: 4, world: 'Other', uid: 10 },
    ],
    cutoff: { gradingOverride: { maxVectorEntries: 10 } }, now: '2026-07-29',
});
eq(sample.query, 'q', 'query is frozen into the sample');
eq(sample.scanText, 'w', 'scan window is frozen into the sample');
// Without the chat path a sample cannot re-derive its query at another depth, so --depths is impossible.
eq(sample.chat, 'chats/c.jsonl', 'chat provenance is carried (needed by --depths)');
eq(sample.grades.length, 2, 'all grades kept');
// The interleaved-books confound: a graded entry from a book the harness cannot rank must be DECLARED,
// not dropped, or the eval scores a relevant entry as irrelevant.
eq(JSON.stringify(sample.excludeTitles), '["Mechanics"]', 'grades from a non-primary book are auto-excluded');
eq(sample.excludeTitles.includes('Villa Party'), false, 'primary-book grades are not excluded');
eq(sample.bookMode, 'meta', 'fidelity is recorded so a reader knows what was dropped');
eq(Object.keys(sample.books).length, 2, 'every attached book is recorded');

const { filename, content } = sampleFile(sample);
eq(filename, 'scene9.json', 'filename from the sample name');
eq(JSON.parse(content).name, 'scene9', 'content is valid JSON');
eq(sampleFile({ name: 'my scene/../x' }).filename, 'my-scene-..-x.json'.replace('..-', '..-'), 'name is slugged for the filesystem');
eq(sampleFile({}).filename, 'scene.json', 'missing name falls back');

// ROUND-TRIP: every field handed to buildSample must come back out. Three fields have been silently
// dropped this way (`chat`, twice, and `gradedCandidates`) because the return object is written by hand and
// a missing line is invisible — the sample just quietly lacks a field the harness later reports as absent.
// Asserting per-field caught them one at a time; this catches the next one for free.
const IN = {
    name: 'rt', notes: 'n', query: 'q', queryChat: [{ name: 'A', mes: 'm' }], scanText: 'w', depth: 20,
    chat: 'chats/c.jsonl', book: 'worlds/Main.json', index: 'i.json', primaryBook: 'Main', embedModel: 'bge-m3',
    params: { K: 20 }, snapshot: { a: 1 }, candidates: [{ uid: 1 }], books: { Main: {} }, bookMode: 'none',
    priority: [{ world: 'Main' }], grades: [{ title: 'T', grade: 3, world: 'Main', uid: 1 }],
    cutoff: { gradingOverride: { maxVectorEntries: 20 } }, gradedCandidates: 20, pluginFP: 'deadbeef', sourceFP: 'deadbeef',
    now: '2026-07-29',
};
const out = buildSample(IN);
// `params`/`snapshot`/`priority` are deliberately renamed on the way out; everything else keeps its name.
const RENAMED = { params: 'captureParams', snapshot: 'paramSnapshot', priority: 'bookPriority', now: null, notes: 'notes' };
for (const key of Object.keys(IN)) {
    const outKey = key in RENAMED ? RENAMED[key] : key;
    if (outKey === null) continue;
    eq(out[outKey] !== undefined, true, `buildSample carries "${key}" through (as "${outKey}")`);
}
eq(out.queryChat.length, 1, 'queryChat survives as an array (depth ablation reads it)');
eq(out.pluginFP, 'deadbeef', 'the deployed plugin that produced the scores is recorded');

// queryMessages is what makes a frozen sample depth-sweepable, so buildQuery must be exactly its join —
// otherwise a re-derived query silently differs from the captured one.
const CHAT = [
    { name: 'A', mes: 'one' },
    { name: '', mes: '  ' },                                     // empty: dropped before the depth count
    { name: 'B', mes: 'two\n\nstill two' },                      // blank line inside a message
    { name: 'A', mes: 'SKIPthree', extra: { fileLength: 4 } },    // attachment prefix stripped
];
eq(JSON.stringify(ranking.queryMessages(CHAT, { depth: 99 }).map(x => x.mes)),
    '["one","two\\n\\nstill two","three"]', 'queryMessages drops empties and strips attachments');
eq(ranking.queryMessages(CHAT, { depth: 2 }).map(x => x.mes).join('|'), 'two\n\nstill two|three',
    'depth takes the NEWEST n, chronologically ordered');
eq(ranking.buildQuery(CHAT, { depth: 2 }),
    ranking.queryMessages(CHAT, { depth: 2 }).map(x => (x.name ? `${x.name}: ${x.mes}` : x.mes)).join('\n\n'),
    'buildQuery is exactly the join of queryMessages');
// THE ABLATION PROPERTY: re-running buildQuery over a frozen capture reproduces any narrower depth exactly.
const frozen = ranking.queryMessages(CHAT, { depth: 99 });
for (const d of [1, 2, 3]) {
    eq(ranking.buildQuery(frozen, { depth: d }), ranking.buildQuery(CHAT, { depth: d }),
        `depth ${d} is reproducible from a wider frozen capture`);
}

// --- delta pooling (/wa-super-grade) ---
// The failure this guards: uid alone is ambiguous across books, so a same-uid entry in a DIFFERENT book must
// not be mistaken for an already-graded one and skipped.
eq(rowKey({ world: 'A', uid: 7 }) === rowKey({ world: 'B', uid: 7 }), false, 'rowKey separates same uid in different books');

const armA = {
    arm: 'shipped',
    rows: [
        { title: 'Villa', world: 'W', uid: 1, block: 'dynamic', sticky: 0, '#': 0, cosine: 0.9 },
        { title: 'Mechanics', world: 'W', uid: 2, block: 'constant', sticky: 0, '#': 1 },
        { title: 'Maren', world: 'W', uid: 3, block: 'dynamic', sticky: 0, '#': 2, cosine: 0.5 },
    ],
    entries: [{ uid: 1 }, { uid: 2 }, { uid: 3 }],
};
const armB = {
    arm: 'no-filter',
    rows: [
        { title: 'Maren', world: 'W', uid: 3, block: 'dynamic', sticky: 0, '#': 0, cosine: 0.7 },
        { title: 'Ironhold', world: 'W', uid: 4, block: 'dynamic', sticky: 0, '#': 1, cosine: 0.6 },
    ],
    entries: [{ uid: 3 }, { uid: 4 }],
};

const u = unionArms([armA, armB]);
// THE UNION IS THE COMPLETE PACKAGE. Durable rows are kept and deduped like any other — a sample records
// what the run selected, and whether a row is offered for grading is the popup's call (it renders these
// uneditable, as /wa-grade does). Dropping them here made capture a function of display intent, and left
// super-grade samples with zero constant/sticky rows where a plain /wa-grade of the same scene had them.
eq(u.rows.length, 4, 'union dedupes across arms and KEEPS durable rows');
eq(u.rows.some(r => r.uid === 2), true, 'the constant is captured, not dropped');
eq(u.rows.filter(r => r.uid === 2).length, 1, 'the constant is deduped like any other row, so N arms do not list it N times');
eq(u.rows.find(r => r.uid === 4) !== undefined, true, 'an entry only a sibling arm surfaced is pooled');
eq(JSON.stringify(u.rows.find(r => r.uid === 3).arms), '["shipped","no-filter"]', 'a shared row records every arm that surfaced it');
eq(u.rows.find(r => r.uid === 3).cosine, 0.5, 'a duplicate keeps the FIRST arm\'s signals, never a blend');
eq(u.rows.find(r => r.uid === 3).from, 'shipped', 'the row records which arm supplied its numbers');

// ABSENT-FILL, and the line it must not cross. `keys` is unmeasurable with scoreVectorKeys off, so a later
// arm that CAN measure it fills the hole and says where it came from. A signal the first arm already
// measured is never overwritten — that would be the blend this function exists to refuse.
const armKeys = {
    arm: 'keys-live',
    rows: [
        { title: 'Villa', world: 'W', uid: 1, block: 'dynamic', sticky: 0, '#': 0, cosine: 0.1, keys: 2.5 },
        { title: 'Maren', world: 'W', uid: 3, block: 'dynamic', sticky: 0, '#': 1, cosine: 0.7, keys: 1.5 },
    ],
    entries: [{ uid: 1 }, { uid: 3 }],
};
const uf = unionArms([armA, armKeys]);
const villa = uf.rows.find(r => r.uid === 1);
eq(villa.keys, 2.5, 'an absent signal is filled from an arm that could measure it');
eq(villa.filled.keys, 'keys-live', 'the fill records its source arm');
eq(villa.cosine, 0.9, 'a signal the first arm measured is NOT overwritten by a later arm');
eq(villa.filled.cosine, undefined, 'and is not marked as filled');
eq(villa.from, 'shipped', 'the base row still names its own arm');

// `why` follows the keys value it explains, from the same arm — a filled score with no visible cause
// is what the fill produced before this.
const armWhy = {
    arm: 'keys-live',
    rows: [{ title: 'Villa', world: 'W', uid: 1, block: 'dynamic', sticky: 0, '#': 0, keys: 2.5, why: [{ key: 'villa', count: 2 }] }],
    entries: [{ uid: 1 }],
};
const uw = unionArms([armA, armWhy]);
eq(uw.rows.find(r => r.uid === 1).why?.[0]?.key, 'villa', 'why travels with the keys value it explains');
eq(unionArms([armWhy, armA]).rows.find(r => r.uid === 1).why?.[0]?.key, 'villa', 'and a base row that has its own why keeps it');
// Ordered by best rank across arms: Maren reached #0 under no-filter, so it outranks the constant (#1).
eq(u.rows.map(r => r.uid).join(','), '1,3,2,4', 'union is ordered by best rank achieved across arms');
eq(u.entries.map(e => e.uid).join(','), '1,3,2,4', 'entries stay aligned with rows after dedupe + sort');

// Round 2: entries 1 and 3 were graded last round. splitGraded answers ONE question — does a prior grade
// exist — so the ungraded constant (uid 2) lands in `fresh` alongside 4. That is not a bug and must not be
// "fixed" here: the durable filter belongs to the popup, which renders those rows uneditable and counts
// only the gradeable ones. Teaching splitGraded about durable rows would put the same rule in two places.
const prior = [{ title: 'Villa', world: 'W', uid: 1, grade: 5 }, { title: 'Maren', world: 'W', uid: 3, grade: 4 }];
const split = splitGraded(u.rows, prior);
eq(split.fresh.map(r => r.uid).join(','), '2,4', 'splitGraded splits on prior grades alone, durable rows included');
eq(split.fresh.filter(r => !isDurable(r)).map(r => r.uid).join(','), '4', 'the gradeable fresh rows are what the popup counts');
eq(split.known.length, 2, 'already-judged rows are reported, not silently dropped');
eq(split.priorOf.get(rowKey({ world: 'W', uid: 3 })), 4, 'prior grades are recoverable for display');
// A retitled entry must stay matched — title drift must not trigger a regrade from zero.
eq(splitGraded([{ title: 'Villa Party (renamed)', world: 'W', uid: 1 }], prior).fresh.length, 0,
    'matching is on world+uid, so a retitled entry is still known');

const merged = mergeGrades(prior, [{ title: 'Ironhold', world: 'W', uid: 4, grade: 3 }, { title: 'Villa', world: 'W', uid: 1, grade: 2 }]);
eq(merged.length, 3, 'merge accumulates without duplicating');
eq(merged.find(g => g.uid === 1).grade, 2, 'a regrade overwrites the earlier round');
eq(merged.find(g => g.uid === 3).grade, 4, 'a prior grade this round did not revisit survives');
// The accumulation property that makes iterative pooling terminate: N rounds of deltas equal one big grading.
eq(mergeGrades(mergeGrades([], prior), [{ world: 'W', uid: 4, grade: 3 }]).length, 3, 'delta rounds compose');

// --- rater provenance: `grade` is a human's, `llmGrade` is a judge's -----------------------------------
// The distinction nothing else can recover. A judge's row and a human's are structurally identical apart
// from which field carries the number, so once they are written together at the same value there is no
// guard, filename or stamp that can tell an unreviewed row from one a human reviewed and agreed with.
eq(gradeValue({ llmGrade: 3 }), 3, 'a judge-only row grades at its llmGrade');
eq(gradeValue({ grade: 2, llmGrade: 3 }), 2, 'a reviewed row grades at the HUMAN value, not the judge s');
eq(gradeValue({ grade: 0, llmGrade: 3 }), 0, 'a human 0 is a verdict, not an absent value');
eq(Number.isNaN(gradeValue({})), true, 'an ungraded row is NaN, so a caller s || 0 or isFinite still works');
eq(gradeValue({ grade: undefined, llmGrade: 0 }), 0, 'a judge 0 survives an undefined human grade');

// mergeGrades replaces the whole object on conflict, so a row the review did NOT touch must not appear in
// `fresh` — that is what keeps its llmGrade (and its `why`) rather than restamping it as human-graded.
const judged = [{ world: 'W', uid: 7, title: 'J', llmGrade: 3, why: 'because' }];
const untouched = mergeGrades(judged, []);
eq(untouched[0].grade, undefined, 'a judge row no human edited keeps no grade field');
eq(untouched[0].why, 'because', 'and keeps the judge s reasoning');
const reviewed = mergeGrades(judged, [{ world: 'W', uid: 7, title: 'J', grade: 1 }]);
eq(reviewed[0].grade, 1, 'a human edit lands in grade');
eq(reviewed[0].llmGrade, undefined, 'and drops llmGrade, which the caller re-attaches from the manifest for IRR');

// --- multi-arm bundles (one download instead of N) ---
// The failure to guard: hoisting a per-arm field into the shared block. The summary arm has a DIFFERENT
// query and a lexical-only arm can retrieve from a different book, so a field shared by accident would make
// one arm silently score another arm's scene.
const mk = (arm, over) => ({ arm, sample: buildSample({
    name: 'sc', notes: 'n', query: `q-${arm}`, queryChat: [{ name: 'A', mes: 'm' }], scanText: `w-${arm}`, depth: 5,
    chat: 'chats/c.jsonl', book: 'worlds/Main.json', index: `i-${arm}.json`, primaryBook: 'Main', embedModel: 'bge-m3',
    params: { K: 20, ...over }, snapshot: { a: 1 }, candidates: [{ uid: 1, title: 'T', world: 'Main' }],
    books: { Main: meta }, bookMode: 'full', priority: [], grades: [{ title: 'T', grade: 4, world: 'Main', uid: 1 }],
    cutoff: { gradingOverride: { maxVectorEntries: 1 } }, gradedCandidates: 1, pluginFP: 'ab', sourceFP: 'ab', now: '2026-07-29',
}) });
const bundle = bundleSamples([mk('shipped', {}), mk('summary', { queryMode: 'summary' }), mk('depth', { messageDepth: 8 })]);

eq(bundle.arms.length, 3, 'every arm is carried');
eq(bundle.books !== undefined, true, 'the books are hoisted to the shared block');
eq(bundle.arms.every(a => a.books === undefined), true, 'the books are NOT duplicated per arm — that is the whole point');
eq(bundle.grades.length, 1, 'grades are shared across arms');
// Per-arm fields must stay per-arm or an arm scores the wrong scene.
for (const f of ['query', 'scanText', 'captureParams', 'candidates', 'cutoff', 'index', 'primaryBook', 'gradedCandidates']) {
    eq(bundle[f] === undefined && bundle.arms.every(a => a[f] !== undefined), true, `"${f}" stays per-arm`);
}
eq(bundle.arms.find(a => a.arm === 'summary').query, 'q-summary', 'each arm keeps its own query text');

// Round trip: an unpacked arm is an ordinary sample every tool can read.
const back = openBundle(bundle, 'summary');
eq(back.query, 'q-summary', 'unpacking restores the arm\'s own query');
eq(back.captureParams.queryMode, 'summary', 'unpacking restores the arm\'s own params');
eq(back.books !== undefined, true, 'unpacking re-attaches the shared books');
eq(back.grades.length, 1, 'unpacking re-attaches the shared grades');
eq(back.arms, undefined, 'the unpacked sample carries no arm list');
eq(back.name, 'sc--summary', 'the unpacked name identifies which arm it is');
eq(openBundle(bundle).arm, 'shipped', 'the default arm is "shipped" when present');
eq(openBundle({ ...bundle, arms: bundle.arms.filter(a => a.arm !== 'shipped') }).arm, 'summary', 'otherwise the first arm');
// A plain sample must pass through untouched so callers need not know which kind they hold.
eq(openBundle(sample).name, 'scene9', 'a plain sample passes through unchanged');
// Naming a missing arm must be loud: silently scoring a different configuration is the bad failure.
let bundleThrew = false;
try { openBundle(bundle, 'nope'); } catch { bundleThrew = true; }
eq(bundleThrew, true, 'an unknown arm throws rather than falling back');
