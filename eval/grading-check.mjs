// Self-check for grading.mjs — the /wa-grade sample assembler. The UI half can't be exercised offline, so
// this pins the part that decides what a sample CONTAINS: book fidelity, the settings mapping, the
// scaffolding tier, and the foreign-book exclusion. A sample that silently loses a field is a graded scene
// that can't be re-run, which is the whole failure this feature exists to prevent.
import { buildSample, captureParams, isScaffolding, mergeGrades, rowKey, sampleFile, searchedBook, splitGraded, trimBook, unionArms } from '../extension/grading.mjs';
import { eq } from './metrics.mjs';
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
eq(meta[1].vectorized, true, 'meta keeps vectorized (drives suppressVectorKeys offline)');
eq(JSON.stringify(trimBook(book, 'none')), '{}', 'none embeds no entries');
// Size is the only reason meta exists; assert it actually pays.
eq(JSON.stringify(meta).length * 10 < JSON.stringify(full).length, true, 'meta is >10x smaller than full');
// An array of entries is accepted too (the harness holds them that way).
eq(Object.keys(trimBook(Object.values(book), 'meta')).length, 2, 'trimBook accepts an array');

// --- captureParams maps settings onto the harness's argument names ---
const s = { rrfK: 20, bm25K1: 1.2, bm25B: 0.75, lexicalWeight: 1, properNounBoost: 3, stopwordDocFreq: 0.25, retrievalMode: 'hybrid', scoreThreshold: 0.1, maxVectorEntries: 10, minVectorEntries: 3, suppressVectorKeys: true, scoreVectorKeys: false, entityFilter: true, queryMode: 'messages', weightByOrder: false, vectorCutoff: 'count', elbowSensitivity: 1.5, dropoffThreshold: 0.06 };
const p = captureParams(s, { caseSensitive: false, wholeWords: false, includeNames: true });
eq(p.K, 20, 'rrfK -> K');
eq(p.K1, 1.2, 'bm25K1 -> K1');
eq(p.LEXW, 1, 'lexicalWeight -> LEXW');
eq(p.stopwordDf, 0.25, 'stopwordDocFreq -> stopwordDf');
eq(p.threshold, 0.1, 'scoreThreshold -> threshold');
eq(p.includeNames, true, 'ST world-info globals are carried, not guessed');
// commonWordWeight is derived from the mode, not stored — the one value paramSnapshot computes.
eq(p.commonWordWeight, 1, 'hybrid mode -> commonWordWeight 1');
eq(captureParams({ ...s, retrievalMode: 'lexical' }, {}).commonWordWeight, 0.7, 'lexical mode -> commonWordWeight 0.7');
// suppressVectorKeys must survive: without it the harness admits 2.3x the query terms (see buildGazetteer).
eq(p.suppressVectorKeys, true, 'suppressVectorKeys is recorded');

// --- scaffolding tier: constants and CONFIGURED stickies are not relevance results ---
eq(isScaffolding({ block: 'constant', sticky: 0 }), true, 'constant is scaffolding');
eq(isScaffolding({ block: 'dynamic', sticky: 3 }), true, 'configured sticky is scaffolding even while block reads dynamic');
eq(isScaffolding({ block: 'dynamic', sticky: 0 }), false, 'a plain dynamic row is gradeable');

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
    cutoff: { mode: 'count', kept: 10 }, now: '2026-07-29',
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
    cutoff: { mode: 'elbow' }, gradedCandidates: 20, pluginFP: 'deadbeef', sourceFP: 'deadbeef',
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
eq(u.rows.length, 3, 'union dedupes across arms and drops scaffolding');
eq(u.rows.some(r => r.uid === 2), false, 'the constant is not offered for grading in any arm');
eq(u.rows.find(r => r.uid === 4) !== undefined, true, 'an entry only a sibling arm surfaced is pooled');
eq(JSON.stringify(u.rows.find(r => r.uid === 3).arms), '["shipped","no-filter"]', 'a shared row records every arm that surfaced it');
eq(u.rows.find(r => r.uid === 3).cosine, 0.5, 'a duplicate keeps the FIRST arm\'s signals, never a blend');
// Ordered by best rank across arms: Maren reached #0 under no-filter, so it outranks Ironhold (#1).
eq(u.rows.map(r => r.uid).join(','), '1,3,4', 'union is ordered by best rank achieved across arms');
eq(u.entries.map(e => e.uid).join(','), '1,3,4', 'entries stay aligned with rows after dedupe + sort');

// Round 2: entries 1 and 3 were graded last round, so only 4 needs a human.
const prior = [{ title: 'Villa', world: 'W', uid: 1, grade: 5 }, { title: 'Maren', world: 'W', uid: 3, grade: 4 }];
const split = splitGraded(u.rows, prior);
eq(split.fresh.map(r => r.uid).join(','), '4', 'only ungraded rows are surfaced for grading');
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

// --- multi-arm bundles (one download instead of N) ---
// The failure to guard: hoisting a per-arm field into the shared block. The summary arm has a DIFFERENT
// query and a lexical-only arm can retrieve from a different book, so a field shared by accident would make
// one arm silently score another arm's scene.
const mk = (arm, over) => ({ arm, sample: buildSample({
    name: 'sc', notes: 'n', query: `q-${arm}`, queryChat: [{ name: 'A', mes: 'm' }], scanText: `w-${arm}`, depth: 5,
    chat: 'chats/c.jsonl', book: 'worlds/Main.json', index: `i-${arm}.json`, primaryBook: 'Main', embedModel: 'bge-m3',
    params: { K: 20, ...over }, snapshot: { a: 1 }, candidates: [{ uid: 1, title: 'T', world: 'Main' }],
    books: { Main: meta }, bookMode: 'full', priority: [], grades: [{ title: 'T', grade: 4, world: 'Main', uid: 1 }],
    cutoff: { mode: 'count' }, gradedCandidates: 1, pluginFP: 'ab', sourceFP: 'ab', now: '2026-07-29',
}) });
const bundle = bundleSamples([mk('shipped', {}), mk('summary', { queryMode: 'summary' }), mk('lexical', { retrievalMode: 'lexical' })]);

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
