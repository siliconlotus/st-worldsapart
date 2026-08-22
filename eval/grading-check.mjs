// Self-check for grading.mjs — the /wa-grade sample assembler. The UI half can't be exercised offline, so
// this pins the part that decides what a sample CONTAINS: book fidelity, the settings mapping, the
// reference tier, and the foreign-book exclusion. A sample that silently loses a field is a graded scene
// that can't be re-run, which is the whole failure this feature exists to prevent.
import { buildSample, bundleSamples, captureParams, hashBooks, keyByUid, stRelative, isDurable, mergeGrades, openBundle, passKey, rowKey, sampleFile, searchedBook, splitGraded, unionArms } from '../extension/grading.mjs';
import { eq, gradeValue } from './metrics.mjs';
import * as ranking from '../extension/ranking.mjs';

const book = {
    1: { uid: 1, comment: 'Villa Party', key: ['villa', 'party'], keysecondary: [], vectorized: true, content: 'A'.repeat(3000), order: 100 },
    2: { uid: 2, comment: 'Mechanics', key: ['knot'], vectorized: false, constant: true, content: 'B'.repeat(2000) },
};

// --- keyByUid ---
const full = keyByUid(book);
eq(Object.keys(full).length, 2, 'every entry is kept — the gazetteer and the keyword scan read the whole book');
eq(full[1].content.length, 3000, 'entries are verbatim; a bundle that drops content is malformed');
eq(Object.keys(keyByUid(Object.values(book))).length, 2, 'an array of entries is accepted too');

// --- captureParams maps settings onto the harness's argument names ---
const s = { rrfK: 20, bm25K1: 1.2, bm25B: 0.75, lexicalWeight: 1, properNounBoost: 3, stopwordDocFreq: 0.25,  maxVectorEntries: 10, suppressVectorKeys: true, scoreVectorKeys: false, entityFilter: true, queryMode: 'messages', weightByOrder: false };
const p = captureParams(s, { caseSensitive: false, wholeWords: false, includeNames: true, allowWIScan: true });
eq(p.K, 20, 'rrfK -> K');
eq(p.K1, 1.2, 'bm25K1 -> K1');
eq(p.LEXW, 1, 'lexicalWeight -> LEXW');
eq(p.stopwordDf, 0.25, 'stopwordDocFreq -> stopwordDf');
eq('threshold' in p, false, 'no admission threshold is captured — stage 1 has no gate to reproduce');
eq('vectorCutoff' in p, false, 'no cliff mode is captured — stage 4 has no relevance cut to reproduce');
eq(p.includeNames, true, 'ST world-info globals are carried, not guessed');
eq('retrievalMode' in captureParams(s, {}), false, 'the capture records no retrieval mode');
// "Include in World Info Scanning" changes what the haystack CONTAINS — with it on, the Author's Note and
// the character's depth prompt enter the scan through the inject buffer, the latter for EVERY entry rather
// than only those setting `matchCharacterDepthPrompt`. An ST global like the other three, so it is recorded
// beside them: two captures of one scene under different settings of it activate differently.
eq(p.allowWIScan, true, 'whether the Author\'s Note is in the scan is recorded, not assumed off');
eq(captureParams(s, {}).allowWIScan, undefined, 'and an injector that does not say leaves it absent rather than guessing');
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
    { book: 'Chat', cosine: 0.9, block: 'dynamic' },
    { book: 'Lore', cosine: 0.8, block: 'dynamic' },
    { book: 'Lore', cosine: 0.7, block: 'dynamic' },
    { book: 'Lore', cosine: 0.0, block: 'dynamic' },
    { book: 'Keys', cosine: null, block: 'dynamic' },
];
eq(searchedBook(rows), 'Lore', 'the book contributing the most retrieved rows wins, not the top-ranked row');
eq(searchedBook(rows.filter(r => r.book !== 'Lore')), 'Chat', 'a single retrieved row still names its book');
// A 0.00000 cosine is a RETRIEVED row; only null means "never retrieved". Truthiness would drop it.
eq(searchedBook([{ book: 'Zero', cosine: 0 }]), 'Zero', 'a genuine 0 cosine counts as retrieved');
eq(searchedBook([{ book: 'Keys', cosine: null }]), null, 'keyword-only scene: no collection was searched');
eq(searchedBook([]), null, 'no candidates at all');
// Ties break toward the higher-ranked book, so the pick is deterministic rather than Map-order luck.
eq(searchedBook([{ book: 'B', cosine: 0.9 }, { book: 'A', cosine: 0.8 }]), 'B', 'ties break toward the higher-ranked book');

// --- buildSample ---
const sample = buildSample({
    name: 'scene9', query: 'q', scanChat: [{ name: 'A', mes: 'w' }], depth: 5, index: 'i', chat: 'chats/c.jsonl', primaryBook: 'Main',
    params: p, snapshot: { scoring: {} }, candidates: [{ title: 'Villa Party' }],
    books: { Main: full, Other: {} }, priority: [{ book: 'Main', weight: 1 }],
    grades: [
        { title: 'Villa Party', grade: 5, book: 'Main', uid: 1 },
        { title: 'Mechanics', grade: 4, book: 'Other', uid: 10 },
    ],
    cutoff: { gradingOverride: { maxVectorEntries: 10 } }, now: '2026-07-29',
});
eq(sample.query, 'q', 'query is frozen into the sample');
eq(sample.scanChat[0].mes, 'w', 'the scan MESSAGES are frozen into the sample, as queryChat freezes the query s');
// Without the chat path a sample cannot re-derive its query at another depth, so --depths is impossible.
eq(sample.chat, 'chats/c.jsonl', 'chat provenance is carried (needed by --depths)');
eq(sample.grades.length, 2, 'all grades kept');
// The interleaved-books confound: a graded entry from a book the harness cannot rank must be DECLARED,
// not dropped, or the eval scores a relevant entry as irrelevant.
eq(JSON.stringify(sample.excludeTitles), '["Mechanics"]', 'grades from a non-primary book are auto-excluded');
eq(sample.excludeTitles.includes('Villa Party'), false, 'primary-book grades are not excluded');
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
    name: 'rt', notes: 'n', query: 'q', queryChat: [{ name: 'A', mes: 'm' }], scanChat: [{ name: 'A', mes: 'w' }], depth: 20,
    chat: 'chats/c.jsonl', book: 'worlds/Main.json', index: 'i.json', primaryBook: 'Main', embedModel: 'bge-m3',
    params: { K: 20 }, snapshot: { a: 1 }, candidates: [{ uid: 1 }], books: { Main: {} },
    priority: [{ book: 'Main' }], grades: [{ title: 'T', grade: 3, book: 'Main', uid: 1 }],
    cutoff: { gradingOverride: { maxVectorEntries: 20 } }, gradedCandidates: 20, pluginFP: 'deadbeef', sourceFP: 'deadbeef',
    now: '2026-07-29',
};
const out = buildSample(IN);
// `params`/`snapshot`/`priority` are deliberately renamed on the way out; everything else keeps its name.
const RENAMED = { snapshot: 'paramSnapshot', priority: 'bookPriority', now: null, notes: 'notes' };
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
eq(rowKey({ book: 'A', uid: 7 }) === rowKey({ book: 'B', uid: 7 }), false, 'rowKey separates same uid in different books');

const armA = {
    arm: 'shipped',
    rows: [
        { title: 'Villa', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.9 } },
        { title: 'Mechanics', book: 'W', uid: 2, block: 'constant', sticky: 0, index: 1 },
        { title: 'Maren', book: 'W', uid: 3, block: 'dynamic', sticky: 0, index: 2, scores: { cosine: 0.5 } },
    ],
    entries: [{ uid: 1 }, { uid: 2 }, { uid: 3 }],
};
const armB = {
    arm: 'no-filter',
    rows: [
        { title: 'Maren', book: 'W', uid: 3, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.7 } },
        { title: 'Ironhold', book: 'W', uid: 4, block: 'dynamic', sticky: 0, index: 1, scores: { cosine: 0.6 } },
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
eq(u.rows.find(r => r.uid === 3).scores.cosine, 0.5, 'a duplicate keeps the FIRST arm\'s signals, never a blend');
eq(u.rows.find(r => r.uid === 3).from, 'shipped', 'the row records which arm supplied its numbers');

// ABSENT-FILL, and the line it must not cross. `keys` is unmeasurable with scoreVectorKeys off, so a later
// arm that CAN measure it fills the hole and says where it came from. A signal the first arm already
// measured is never overwritten — that would be the blend this function exists to refuse.
const armKeys = {
    arm: 'keys-live',
    rows: [
        { title: 'Villa', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.1, keys: 2.5 } },
        { title: 'Maren', book: 'W', uid: 3, block: 'dynamic', sticky: 0, index: 1, scores: { cosine: 0.7, keys: 1.5 } },
    ],
    entries: [{ uid: 1 }, { uid: 3 }],
};
const uf = unionArms([armA, armKeys]);
const villa = uf.rows.find(r => r.uid === 1);
eq(villa.scores.keys, 2.5, 'an absent signal is filled from an arm that could measure it');
eq(villa.filled.keys, 'keys-live', 'the fill records its source arm');
eq(villa.scores.cosine, 0.9, 'a signal the first arm measured is NOT overwritten by a later arm');
eq(villa.filled.cosine, undefined, 'and is not marked as filled');
eq(villa.from, 'shipped', 'the base row still names its own arm');

// `why` follows the keys value it explains, from the same arm — a filled score with no visible cause
// is what the fill produced before this.
const armWhy = {
    arm: 'keys-live',
    rows: [{ title: 'Villa', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { keys: 2.5 }, why: [{ key: 'villa', count: 2 }] }],
    entries: [{ uid: 1 }],
};
const uw = unionArms([armA, armWhy]);
eq(uw.rows.find(r => r.uid === 1).why?.[0]?.key, 'villa', 'why travels with the keys value it explains');
eq(unionArms([armWhy, armA]).rows.find(r => r.uid === 1).why?.[0]?.key, 'villa', 'and a base row that has its own why keeps it');
// THE UNION SPEAKS THE SCHEMA'S SHAPE. A row read back out of a bundle carries its signals under
// `scores` (grading.mjs toCandidate), and /wa-super-eval renders those columns straight off the union —
// so a union that only understands the flat runtime shape shows an empty table against every stored
// bundle while the live path looks fine. Both the display and the cross-arm fill are asserted on the
// stored shape for that reason.
const armStored = {
    arm: 'shipped',
    rows: [{ title: 'Villa', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.9, text: 12.5, keys: null } }],
    entries: [{ uid: 1 }],
};
const armStoredKeys = {
    arm: 'keys-live',
    rows: [{ title: 'Villa', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.1, text: 9, keys: 2.5 } }],
    entries: [{ uid: 1 }],
};
const us = unionArms([armStored, armStoredKeys]).rows[0];
eq(us.scores.cosine, 0.9, 'a stored row keeps the first arm\'s measured signal');
eq(us.scores.keys, 2.5, 'an absent stored signal is filled from an arm that could measure it');
eq(us.filled.keys, 'keys-live', 'the stored fill records its source arm');
eq(us.filled.cosine, undefined, 'a stored signal the first arm measured is not marked filled');

// Ordered by best rank across arms: Maren reached #0 under no-filter, so it outranks the constant (#1).
eq(u.rows.map(r => r.uid).join(','), '1,3,2,4', 'union is ordered by best rank achieved across arms');
eq(u.entries.map(e => e.uid).join(','), '1,3,2,4', 'entries stay aligned with rows after dedupe + sort');

// Round 2: entries 1 and 3 were graded last round. splitGraded answers ONE question — does a prior grade
// exist — so the ungraded constant (uid 2) lands in `fresh` alongside 4. That is not a bug and must not be
// "fixed" here: the durable filter belongs to the popup, which renders those rows uneditable and counts
// only the gradeable ones. Teaching splitGraded about durable rows would put the same rule in two places.
const prior = [{ title: 'Villa', book: 'W', uid: 1, grade: 5 }, { title: 'Maren', book: 'W', uid: 3, grade: 4 }];
const split = splitGraded(u.rows, prior);
eq(split.fresh.map(r => r.uid).join(','), '2,4', 'splitGraded splits on prior grades alone, durable rows included');
eq(split.fresh.filter(r => !isDurable(r)).map(r => r.uid).join(','), '4', 'the gradeable fresh rows are what the popup counts');
eq(split.known.length, 2, 'already-judged rows are reported, not silently dropped');
eq(split.priorOf.get(rowKey({ book: 'W', uid: 3 })), 4, 'prior grades are recoverable for display');
// A retitled entry must stay matched — title drift must not trigger a regrade from zero.
eq(splitGraded([{ title: 'Villa Party (renamed)', book: 'W', uid: 1 }], prior).fresh.length, 0,
    'matching is on book+uid, so a retitled entry is still known');

const ROUND1 = { user: 'me@host', now: '2026-07-01' };
const ROUND2 = { user: 'me@host', now: '2026-07-02' };
const first = mergeGrades([], prior, ROUND1);
const merged = mergeGrades(first, [{ title: 'Ironhold', book: 'W', uid: 4, grade: 3 }, { title: 'Villa', book: 'W', uid: 1, grade: 2 }], ROUND2);
eq(merged.length, 3, 'merge accumulates without duplicating rows');
// NOTHING IS EVER OVERWRITTEN. A regrade joins the record beside the verdict it disagrees with — that
// comparison is the only thing that says whether a rater moved, and last-writer-wins deleted it.
eq(merged.find(g => g.uid === 1).grades.map(v => v.grade).join(','), '5,2', 'a regrade appends beside the earlier round');
eq(gradeValue(merged.find(g => g.uid === 1)), 2, '...and the later verdict is the one in force');
eq(gradeValue(merged.find(g => g.uid === 3)), 4, 'a prior grade this round did not revisit survives');
// A second Save of the same table is the same sitting, not a second verdict.
eq(mergeGrades(first, [{ book: 'W', uid: 1, grade: 5 }], ROUND1).find(g => g.uid === 1).grades.length, 1,
    'the same rater on the same day is one pass, so re-saving stacks nothing');
// The accumulation property that makes iterative pooling terminate: N rounds of deltas equal one big grading.
eq(mergeGrades(first, [{ book: 'W', uid: 4, grade: 3 }], ROUND2).length, 3, 'delta rounds compose');

// --- rater provenance: WHICH RATER A VERDICT NAMES -------------------------------------------------------
// The distinction nothing else can recover. An llm-graded row and a human-graded one are structurally
// identical apart from the rater named, so once they are written without one there is no guard, filename
// or stamp that can tell an unreviewed row from one a human reviewed and agreed with.
const H = g => ({ kind: 'human', id: 'u1', grade: g });
const L = g => ({ kind: 'llm', model: 'gemma4:31b-mlx', rubric: 'r', grade: g });
eq(gradeValue({ grades: [L(3)] }), 3, 'an llm-only row grades at its llm verdict');
eq(gradeValue({ grades: [L(3), H(2)] }), 2, 'a reviewed row grades at the HUMAN value, not the llm s');
eq(gradeValue({ grades: [L(3), H(0)] }), 0, 'a human 0 is a verdict, not an absent value');
eq(Number.isNaN(gradeValue({})), true, 'an ungraded row is NaN, so a caller s || 0 or isFinite still works');
eq(gradeValue({ grades: [L(0)] }), 0, 'an llm 0 is a measurement, not an absence');
// AMONG LLM VERDICTS, THE MEDIAN once three exist — a later pass is not a better one, and latest-wins
// silently resolves noise in favour of whichever pass ran last.
eq(gradeValue({ grades: [L(0), L(4), L(3)] }), 3, 'three llm verdicts resolve to their median');
eq(gradeValue({ grades: [L(0), L(4)] }), 4, 'two that disagree cannot be resolved, so the latest stands');
// A BARE `grade` IS A FRESHLY TYPED HUMAN VERDICT — the value a grading UI holds before it becomes a
// verdict in `grades`. It is the live path, not a legacy one.
eq(gradeValue({ grade: 2 }), 2, 'a bare grade reads as the value in force');
// The superseded scalar has NO path. Nothing on disk predates v3, so a reader that still honoured
// `llmGrade` would be resolving a field no writer emits — and silently outranking a real verdict.
eq(Number.isNaN(gradeValue({ llmGrade: 3 })), true, 'a v2 llmGrade scalar is not read at all');
eq(gradeValue({ grade: 2, llmGrade: 3 }), 2, '...and cannot displace the value that is');

// A row the review did NOT touch gains no human verdict — that is what keeps "no human has looked at
// this" readable, and it keeps the llm's reasoning where the llm put it.
const judged = [{ book: 'W', uid: 7, title: 'J', grades: [{ ...L(3), why: 'because' }] }];
const untouched2 = mergeGrades(judged, [], ROUND1);
eq((untouched2[0].grades ?? []).some(v => v.kind === 'human'), false, 'a row no human edited carries no human verdict');
eq(untouched2[0].grades[0].why, 'because', 'and keeps the llm s reasoning');
const reviewed = mergeGrades(judged, [{ book: 'W', uid: 7, title: 'J', grade: 1 }], ROUND1);
eq(gradeValue(reviewed[0]), 1, 'a human edit becomes the verdict in force');
// A PASS IS THE RATER PLUS ITS KNOBS PLUS THE DAY — not the rater alone. Re-sampling one model at another
// seed is the SAME rater giving a second verdict, which is how a third vote for the median is reached; if
// the knobs were folded into the rater id that would read as consulting a different model, and if they
// were left out of the dedup key the second verdict would be dropped as a repeat.
const P = (t, params, g) => ({ kind: 'llm', id: 'm\u001fr', params, grade: g, gradedAt: t });
const T1 = '2026-08-21T14:03:02.481Z', T2 = '2026-08-21T18:41:55.002Z';
eq(passKey(P(T1, { seed: 7 }, 3)) === passKey(P(T1, { seed: 7 }, 4)), true, 'one rater at one instant is one pass, whatever it graded');
eq(passKey(P(T1, { seed: 7 }, 3)) === passKey(P(T2, { seed: 7 }, 3)), false, 'a later pass is another pass, so it appends rather than colliding');
// PARAMS ARE NOT IN THE KEY. Dedup runs over one entry's verdicts and a pass grades each row once, so two
// verdicts on a row always came from two dispatches and differ by their stamp. Keying on params would make
// identity depend on how completely a writer recorded the knobs.
eq(passKey(P(T1, { seed: 7 }, 3)) === passKey(P(T1, { seed: 8, effort: 'high' }, 3)), true,
    'recording more knobs does not make an old verdict stop matching its own re-merge');
// A HOSTED PASS HAS NO PARAMS AT ALL, so the timestamp is the whole of what separates two of them. At day
// granularity a second adjudication pass over the same rows would read as the first merged twice and be
// dropped — which is the case a second pass exists for.
const hosted = t => ({ kind: 'llm', id: 'claude-sonnet-5\u001fr', gradedAt: t });
eq(passKey(hosted('2026-08-21T14:03:02Z')) === passKey(hosted('2026-08-21T18:41:55Z')), false,
    'two hosted passes on one day are two passes, because the stamp carries the time');
eq(passKey(hosted('2026-08-21T14:03:02Z')) === passKey(hosted('2026-08-21T14:03:02Z')), true,
    '...and re-merging one of them is still idempotent');

eq(reviewed[0].grades.filter(v => v.kind === 'llm').length, 1, 'and the llm verdict is still there underneath it, which is what IRR reads');

// --- multi-arm bundles (one download instead of N) ---
// The failure to guard: hoisting a per-arm field into the shared block. The summary arm has a DIFFERENT
// query and a lexical-only arm can retrieve from a different book, so a field shared by accident would make
// one arm silently score another arm's scene.
// ANY extension that injects with `scan: true`, not just the Author's Note — the capture iterates every
// extension prompt rather than naming known ones, so Summarize ('1_memory') and anything else a user
// installs are carried the same way. Both position classes are represented: Summarize offers "In-chat @
// Depth" as well as the ambient placements, so both branches of the depth rule arise in practice.
const INJECTS = [
    { key: 'NOTE', text: 'a note', ambient: false, depth: 2 },
    { key: '1_memory', text: 'a running summary', ambient: true, depth: 0 },
];
const mk = (arm, over) => ({ arm, sample: buildSample({
    name: 'sc', notes: 'n', query: `q-${arm}`, queryChat: [{ name: 'A', mes: 'm' }], scanChat: [{ name: 'A', mes: 'w' }], depth: 5,
    chat: 'chats/c.jsonl', book: 'worlds/Main.json', index: `i-${arm}.json`, primaryBook: 'Main', embedModel: 'bge-m3',
    params: { K: 20, ...over }, snapshot: { a: 1 }, candidates: [{ uid: 1, title: 'T', book: 'Main' }],
    injects: INJECTS,
    books: { Main: full }, priority: [], grades: [{ title: 'T', grade: 4, book: 'Main', uid: 1 }],
    cutoff: { gradingOverride: { maxVectorEntries: 1 } }, gradedCandidates: 1, pluginFP: 'ab', sourceFP: 'ab', now: '2026-07-29',
}) });
const bundle = await bundleSamples(
    [mk('shipped', {}), mk('summary', { queryMode: 'summary' }), mk('depth', { messageDepth: 8 })],
    { start: 90, end: 100, user: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', captureId: 'cap-test' },
);
const scene0 = bundle.scenes[0];

eq(bundle.schemaVersion, 3, 'the document stamps its schema version');
eq(bundle.scenes.length, 1, 'one scene is a one-element list, not a special shape');
// A SCENE IS THE GRADED MOMENT, so its id names the message it ends at — not the span, which is what an
// arm chose to read and varies between arms of one scene.
eq(scene0.id, 'c-msg-100', 'the scene id is composed from the chat and the moment it ends at');
eq(scene0.sceneChat, 'chats/c.jsonl', 'and names the chat it was taken from');
eq(scene0.arms, undefined, 'a scene carries no arms — an arm is a configuration and spans scenes');
eq(bundle.arms.length, 3, 'every arm is carried, at document level');
eq(bundle.arms.every(a => a.scenes[scene0.id]), true, '...each with its capture of this scene');
eq(bundle.captureId, 'cap-test', 'the document carries an id that survives a rename');

// FIELD ORDER IS PART OF THE SCHEMA: the bulk goes last so everything ahead of it is reachable with head.
const order = Object.keys(bundle);
eq(order.slice(order.indexOf('sceneChats')).join(','), 'sceneChats,sceneInjects,books',
    'the haystack inputs and the books are the trailing block, books last as the largest');
eq(order.indexOf('scenes') < order.indexOf('sceneChats'), true, 'and every scene precedes them');

eq(bundle.books !== undefined, true, 'the books are hoisted to the document');
eq(bundle.arms.every(a => a.books === undefined), true, 'the books are NOT duplicated per arm — that is the whole point');
// THE MESSAGES, not a window: a window is fixed at one depth, matchWindow and includeNames, and cannot be
// narrowed. These rebuild any of them, so arms reading one moment at different depths share one input.
eq(JSON.stringify(bundle.sceneChats[scene0.id]), '[{"name":"A","mes":"w"}]',
    'the scan MESSAGES are hoisted out of the scene, keyed by its id');
eq(bundle.arms.every(a => a.scenes[scene0.id].scanChat === undefined), true, 'so no capture carries a copy of them');
// THE INPUTS, NOT THE PRODUCT. Injects are stored beside the chat half rather than joined into it, so a
// reader admits them per depth and rebuilds the window — a joined blob cannot be taken apart again. Once
// per scene, because every arm of a capture scans the same injects.
eq(JSON.stringify(bundle.sceneInjects[scene0.id]), JSON.stringify(INJECTS), 'the injects are hoisted beside it, unjoined');
eq(bundle.arms.every(a => a.scenes[scene0.id].injects === undefined), true, 'and no capture carries a copy of those either');
eq(JSON.stringify(bundle.sceneChats[scene0.id]).includes('a note'), false, 'the messages do not contain the inject text');

// THE RECORD, NOT A RESOLUTION. A typed grade becomes a human verdict naming its rater; no scalar is
// stored beside it, because a stored resolution is indistinguishable from a verdict someone gave.
eq(scene0.entries.length, 1, 'one entry per candidate carrying verdicts');
eq(JSON.stringify(scene0.entries[0]),
    '{"book":"Main","uid":1,"title":"T","grades":[{"rater":0,"grade":4,"gradedAt":"2026-07-29"}]}',
    'a typed grade becomes a verdict naming its rater by index, with a date and no reduced scalar');
eq(scene0.entries[0].grade === undefined && scene0.entries[0].llmGrade === undefined, true,
    'and nothing writes the value in force into the file');
// A UUID says two verdicts are different people and nothing else, so the label rides ONCE per document,
// keyed by the id. Never on the verdict: a label is not an identity, and a reader joins on the id.
// WHO THE INDEX NAMES, once per document. A rater is whoever passed a verdict; `kind` is [human, llm] and
// `id` is ONE canonical field either way, so grouping raters is a plain key comparison.
eq(JSON.stringify(bundle.raters), '[{"rater":0,"kind":"human","id":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}]',
    'a rater is spelled out once, in a table the verdicts index into');
eq('id' in scene0.entries[0].grades[0], false, '...and never repeated on the verdict itself');

// Identity is book + uid as TWO fields — no printable separator is safe to join lorebook names with.
eq(scene0.entries[0].book, 'Main', 'identity carries the book as its own field');
eq(bundle.arms[0].scenes[scene0.id].candidates[0].book, 'Main', 'and so does a candidate');

// Per-arm fields must stay per-arm or an arm scores the wrong scene.
// WHAT VARIES WITH BOTH COORDINATES IS ON THE CELL; what varies with the configuration alone is on the arm.
for (const f of ['query', 'candidates', 'cutoff', 'index', 'primaryBook', 'gradedCandidates', 'sceneStart', 'depth']) {
    eq(bundle[f] === undefined && bundle.arms.every(a => a.scenes[scene0.id][f] !== undefined), true, `"${f}" is on the cell`);
}
eq(bundle.arms.every(a => a.params !== undefined && a.scenes[scene0.id].params === undefined), true, '"params" is on the arm');
eq(bundle.arms.find(a => a.name === 'summary').scenes[scene0.id].query, 'q-summary', 'each arm keeps its own query text');
// The span is the ARM's: it is what that configuration chose to read back from the graded moment.
eq(scene0.sceneStart, undefined, 'a scene records no span');
eq(bundle.arms[0].scenes[scene0.id].sceneStart, 90, '...the arm that read it does');

// Round trip: an unpacked arm is an ordinary sample every tool can read.
const back = openBundle(bundle, 'summary');
eq(back.query, 'q-summary', 'unpacking restores the arm\'s own query');
eq(back.params.queryMode, 'summary', 'unpacking restores the arm\'s own params');
// `depth` is the CELL's, not the arm's params: it is what this configuration read of THIS scene, and the
// view hands it back as its own field beside them.
eq(back.params.depth, undefined, 'depth is not among the arm\'s params');
eq(back.depth, 5, '...it is the cell\'s, and the view returns it as a field of its own');
eq(back.sceneStart, 90, 'and so is the span it read back from the moment');
eq(back.scanChat[0].mes, 'w', 'unpacking re-attaches the scene\'s messages');
eq(back.injects[0].depth, 2, '...and the injects, with the depth that decides which windows admit them');
eq(back.injects.map(i => i.key).join(','), 'NOTE,1_memory',
    '...every extension that injects with scan on, named, not just the Author\'s Note');
eq(back.books !== undefined, true, 'unpacking re-attaches the shared books');
eq(back.entries.length, 1, 'unpacking re-attaches the scene\'s verdicts');
// Dereferencing is lossless: a reader gets whole identities back, so nothing downstream handles indices.
eq(back.entries[0].grades[0].id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'the reader gets the id back, not the index');
eq(back.entries[0].grades[0].kind, 'human', '...with the kind that says how to read it');
eq('rater' in back.entries[0].grades[0], false, '...and the index gone, since only the file is indexed');
eq(gradeValue(back.entries[0]), 4, '...so the verdict in force resolves');
eq(back.entries[0].book, 'Main', 'under the schema\'s own name for the book');
eq(back.scenes, undefined, 'the view carries no scene list');
eq(back.name, 'sc', 'the view carries the DOCUMENT\'s name, verbatim');
eq(back.arm, 'summary', '...and the arm\'s name beside it, so a label is composed rather than baked in');
eq(openBundle(bundle).arm, 'shipped', 'the default arm is "shipped" when present');
eq(openBundle({ ...bundle, arms: bundle.arms.filter(a => a.name !== 'shipped') }).arm, 'summary',
    'otherwise the first arm that captured the scene');
// Something that is not a graded-scene document is REFUSED. Reading one as though it were would silently
// give a reader no entries and no candidates rather than an error.
let oldThrew = false;
try { openBundle({ name: 'not one', arms: [] }); } catch { oldThrew = true; }
eq(oldThrew, true, 'a document with no scenes is refused rather than read as empty');
// Naming a missing arm must be loud: silently scoring a different configuration is the bad failure.
let bundleThrew = false;
try { openBundle(bundle, 'nope'); } catch { bundleThrew = true; }
eq(bundleThrew, true, 'an unknown arm throws rather than falling back');
let sceneThrew = false;
try { openBundle(bundle, null, 'nope'); } catch { sceneThrew = true; }
eq(sceneThrew, true, 'and so does naming a missing scene');
// THE HAYSTACK IS THE SCENE. Two arms covering different spans are two scenes — they belong in `scenes`
// as two elements, each with its own id and verdicts — so packing them as one scene's arms is refused
// rather than hoisted over. Both halves of "the span" say it: the window itself, and the depth that
// produced it.
// ARMS MAY NOW READ THE SAME MOMENT AT DIFFERENT DEPTHS. The guard that refused them is gone, because
// what is hoisted is the MESSAGES: each arm's window is rebuilt from them at its own depth, so there is
// no first-arm window for a second to silently inherit.
const twoDepths = await bundleSamples([mk('a', {}), { arm: 'b', sample: { ...mk('b', {}).sample, depth: 20 } }], { start: 0, end: 1 });
eq(twoDepths.arms.map(a => a.scenes['c-msg-1'].depth).join(','), '5,20', 'two arms may read one moment at different depths');
eq(Object.keys(twoDepths.sceneChats).length, 1, '...sharing one stored set of messages between them');

// splitGraded pre-fills from the value IN FORCE. Reading a human verdict alone made /wa-super-eval blind
// to every llm-graded row — which is nearly the whole corpus.
{
    // Prior rows arrive from `openBundle().entries`, so they carry verdict arrays rather than scalars.
    const L = g => ({ kind: 'llm', id: 'm\u001fr', grade: g });
    const rows = [{ book: 'W', uid: 1 }, { book: 'W', uid: 2 }, { book: 'W', uid: 3 }];
    const split = splitGraded(rows, [
        { book: 'W', uid: 1, grades: [L(2), { kind: 'human', id: 'u1', grade: 4 }] },
        { book: 'W', uid: 2, grades: [L(0)] },
    ]);
    eq(split.known.length, 2, 'a judge-only row counts as judged, not as never-graded');
    eq(split.priorOf.get(rowKey({ book: 'W', uid: 1 })), 4, 'a human grade outranks the judge on the same row');
    eq(split.priorOf.get(rowKey({ book: 'W', uid: 2 })), 0, 'a judge 0 pre-fills as 0, not as blank');
    eq(split.fresh.length === 1 && split.fresh[0].uid === 3, true, 'only the ungraded row is fresh');
}

// --- book content identity ------------------------------------------------------------------------------
// The field answers "did these two captures grade the same book" ACROSS INSTALLS, so the two things that
// must hold are that irrelevant serialisation differences do not move it and relevant content differences do.
{
    const entry = { uid: 1, comment: 'A', content: 'text', keys: ['k'] };
    const reordered = { keys: ['k'], content: 'text', comment: 'A', uid: 1 };
    const [a, b] = await Promise.all([hashBooks({ W: { 1: entry } }), hashBooks({ W: { 1: reordered } })]);
    eq(a.W, b.W, 'key order does not move a book hash — two installs need not agree on it');

    const renamed = await hashBooks({ Other: { 1: entry } });
    eq(renamed.Other, a.W, 'the hash is of the CONTENT, so renaming the book does not move it');

    const trimmed = await hashBooks({ W: { 1: { uid: 1, comment: 'A' } } });
    eq(trimmed.W === a.W, false, 'a book missing an entry\'s fields is not the same stored book');

    const edited = await hashBooks({ W: { 1: { ...entry, content: 'text.' } } });
    eq(edited.W === a.W, false, 'a one-character content edit moves the hash');

    // ST sets `entry.world` on some paths and not others, and it only ever restates the book name that
    // already keys the map. Left in, the same lorebook hashed two ways depending on how it was captured.
    const located = await hashBooks({ W: { 1: { ...entry, world: 'W' } } });
    eq(located.W, a.W, 'ST\'s entry.world back-pointer is location, not content, so it does not move the hash');

    eq(/^[0-9a-f]{64}$/.test(a.W), true, 'lowercase hex SHA-256, the same shape a digest rater id carries');
    eq(Object.keys(await hashBooks(undefined)).length, 0, 'no books is an empty map, not a throw');
}


// --- stRelative: a stored path names the install, never the machine -------------------------------------
// An absolute path is the author's home directory. No reader can use it — scene.mjs skips a stored `index`
// that is not local and derives its own — and every reader can be identified by it.
{
    const B = String.fromCharCode(92);
    eq(stRelative('/Users/someone/SillyTavern-launcher/SillyTavern/data/default-user/chats/A/x.jsonl'),
        'data/default-user/chats/A/x.jsonl', 'a chat path is cut at ST\'s data/');
    eq(stRelative('/Users/other/ST/public/scripts/extensions/third-party/WorldsApart/eval/eval-data/indexes/a/index.json'),
        'public/scripts/extensions/third-party/WorldsApart/eval/eval-data/indexes/a/index.json', '...and an index path at public/');
    eq(stRelative(`C:${B}Users${B}bob${B}SillyTavern${B}data${B}default-user${B}chats${B}x.jsonl`),
        'data/default-user/chats/x.jsonl', 'a Windows path relativises and normalises its separators');

    eq(stRelative('data/default-user/chats/x.jsonl'), 'data/default-user/chats/x.jsonl', 'an already-relative path is unchanged');
    // FIRST match, not last: a chat or a book may itself be named `data`, and the install's is leftmost.
    eq(stRelative('/Users/x/ST/data/default-user/chats/data/session.jsonl'), 'data/default-user/chats/data/session.jsonl',
        'a chat folder named "data" does not move the cut');
    // Nothing to anchor on is left alone rather than mangled into a wrong relative path.
    eq(stRelative('/Users/x/elsewhere/file.json'), '/Users/x/elsewhere/file.json', 'a path naming no ST directory is untouched');
    eq(stRelative(undefined), undefined, 'an absent path is not a throw');

    // The choke point is buildSample, so no writer has to remember.
    const withPaths = buildSample({
        name: 'p', query: 'q', scanChat: [{ name: 'A', mes: 'm' }], primaryBook: 'B', books: { B: {} },
        candidates: [], grades: [], params: {}, snapshot: {}, now: '2026-01-01T00:00:00.000Z',
        chat: '/Users/someone/ST/data/default-user/chats/A/x.jsonl',
        index: '/Users/someone/ST/public/scripts/x/index.json',
        book: '/Users/someone/ST/data/default-user/worlds/B.json',
    });
    eq(withPaths.chat, 'data/default-user/chats/A/x.jsonl', 'buildSample relativises the chat path');
    eq(withPaths.index, 'public/scripts/x/index.json', '...the index path');
    eq(withPaths.book, 'data/default-user/worlds/B.json', '...and the book path, so no writer has to remember');
}
