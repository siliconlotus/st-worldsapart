// Self-check for grading.mjs, the /wa-grade sample assembler: what a sample CONTAINS — book fidelity, the settings
// mapping, the durable tier, the multi-arm bundle and its round trip.
import { buildSample, bundleSamples, captureParams, hashBooks, keyByUid, stRelative, isDurable, mergeGrades, openBundle, passKey, rowKey, sampleFile, sceneDiff, searchedBook, setGrades, splitGraded, unionArms } from '../extension/grading.mjs';
import { eq, gradeValue } from '../eval/lib/metrics.mjs';
import * as query from '../extension/query.mjs';

const book = {
    1: { uid: 1, comment: 'Launch Day', key: ['launch', 'day'], keysecondary: [], vectorized: true, content: 'A'.repeat(3000), order: 100 },
    2: { uid: 2, comment: 'Mechanics', key: ['knot'], vectorized: false, constant: true, content: 'B'.repeat(2000) },
};

// --- keyByUid ---
const full = keyByUid(book);
eq(Object.keys(full).length, 2, 'every entry is kept — the gazetteer and the keyword scan read the whole book');
eq(full[1].content.length, 3000, 'entries are verbatim; a bundle that drops content is malformed');
eq(Object.keys(keyByUid(Object.values(book))).length, 2, 'an array of entries is accepted too');

// --- captureParams maps settings onto the harness's argument names ---
const s = { bm25K1: 1.2, bm25B: 0.75, properNounBoost: 3, stopwordDocFreq: 0.25,  maxVectorEntries: 10, suppressVectorKeys: true, entityFilter: true };
const p = captureParams(s, { caseSensitive: false, wholeWords: false, includeNames: true, allowWIScan: true });
eq(p.K1, 1.2, 'bm25K1 -> K1');
eq('K' in p || 'LEXW' in p || 'KEYW' in p || 'weightByOrder' in p, false,
    'a capture records no fusion parameters, because there is no fusion');
eq(p.stopwordDf, 0.25, 'stopwordDocFreq -> stopwordDf');
eq('threshold' in p, false, 'no admission threshold is captured — stage 1 has no gate to reproduce');
eq('vectorCutoff' in p, false, 'no cliff mode is captured — the relevance cut reads the relevanceCutoff setting, which the settings dump already carries');
eq(p.includeNames, true, 'ST world-info globals are carried, not guessed');
eq('retrievalMode' in captureParams(s, {}), false, 'the capture records no retrieval mode');
eq(p.allowWIScan, true, 'whether the Author\'s Note is in the scan is recorded, not assumed off');
eq(captureParams(s, {}).allowWIScan, undefined, 'and an injector that does not say leaves it absent rather than guessing');
eq(captureParams(s, {}).recursive, undefined, 'a capture predating the recursion fields leaves them absent; scene.mjs reads absent as off');
eq('commonWordWeight' in p, false, 'no general-English down-weight is captured — BM25 no longer takes one');
eq('suppressVectorKeys' in p, false, 'no key-suppression flag is captured — the takeover blanks every keyword-activating entry');

// --- isDurable ---
eq(isDurable({ block: 'constant', sticky: 0 }), true, 'constant is durable');
eq(isDurable({ block: 'dynamic', sticky: 3 }), false, 'configured sticky with no armed effect is gradeable');
eq(isDurable({ block: 'sticky', sticky: 3 }), true, 'an ARMED sticky row is durable');
eq(isDurable({ block: 'sticky', sticky: 0 }), true, '...read off block, not the setting');
eq(isDurable({ block: 'dynamic', sticky: 0 }), false, 'a plain dynamic row is gradeable');
eq(isDurable({ block: 'promoted', sticky: 0 }), false, 'a promoted row is gradeable — it is exempt from the cut, not from judgement');
eq(isDurable({ block: 'promoted', sticky: 3 }), false, '...and a configured sticky value does not change that');

// --- searchedBook: which collection the harness must load ---
const rows = [
    { book: 'Chat', cosine: 0.9, block: 'dynamic' },
    { book: 'Lore', cosine: 0.8, block: 'dynamic' },
    { book: 'Lore', cosine: 0.7, block: 'dynamic' },
    { book: 'Lore', cosine: 0.0, block: 'dynamic' },
    { book: 'Keys', cosine: null, block: 'dynamic' },
];
eq(searchedBook(rows), 'Lore', 'the book contributing the most retrieved rows wins, not the top-ranked row');
eq(searchedBook(rows.filter(r => r.book !== 'Lore')), 'Chat', 'a single retrieved row still names its book');
eq(searchedBook([{ book: 'Zero', cosine: 0 }]), 'Zero', 'a genuine 0 cosine counts as retrieved');
eq(searchedBook([{ book: 'Keys', cosine: null }]), null, 'keyword-only scene: no collection was searched');
eq(searchedBook([]), null, 'no candidates at all');
eq(searchedBook([{ book: 'B', cosine: 0.9 }, { book: 'A', cosine: 0.8 }]), 'B', 'ties break toward the higher-ranked book');

// --- buildSample ---
const sample = buildSample({
    name: 'scene9', query: 'q', scanChat: [{ name: 'A', mes: 'w' }], depth: 5, index: 'i', chat: 'chats/c.jsonl', primaryBook: 'Main',
    params: p, snapshot: { scoring: {} }, candidates: [{ title: 'Launch Day' }],
    books: { Main: full, Other: {} }, priority: [{ book: 'Main', weight: 1 }],
    grades: [
        { title: 'Launch Day', grade: 5, book: 'Main', uid: 1 },
        { title: 'Mechanics', grade: 4, book: 'Other', uid: 10 },
    ],
    cutoff: { gradingOverride: { maxVectorEntries: 10 } }, now: '2026-07-29',
});
eq(sample.query, 'q', 'query is frozen into the sample');
eq(sample.scanChat[0].mes, 'w', 'the scan MESSAGES are frozen into the sample, as queryChat freezes the query s');
eq(sample.chat, 'chats/c.jsonl', 'chat provenance is carried (needed by --depths)');
eq(sample.grades.length, 2, 'all grades kept');
eq(sample.grades.some(g => g.book === 'Other'), true, 'a second book\'s grade is an ordinary grade, not an excluded one');
eq('excludeTitles' in sample, false, 'nothing is declared out of scope by title');
eq(Object.keys(sample.books).length, 2, 'every attached book is recorded');

const { filename, content } = sampleFile(sample);
eq(filename, 'scene9.json', 'filename from the sample name');
eq(JSON.parse(content).name, 'scene9', 'content is valid JSON');
eq(sampleFile({ name: 'my scene/../x' }).filename, 'my-scene-..-x.json'.replace('..-', '..-'), 'name is slugged for the filesystem');
eq(sampleFile({}).filename, 'scene.json', 'missing name falls back');

// Round trip: every field handed to buildSample must come back out.
const IN = {
    name: 'rt', notes: 'n', query: 'q', queryChat: [{ name: 'A', mes: 'm' }], scanChat: [{ name: 'A', mes: 'w' }], depth: 20,
    chat: 'chats/c.jsonl', book: 'worlds/Main.json', index: 'i.json', primaryBook: 'Main', embedModel: 'bge-m3',
    params: { K: 20 }, snapshot: { a: 1 }, candidates: [{ uid: 1 }], books: { Main: {} },
    priority: [{ book: 'Main' }], grades: [{ title: 'T', grade: 3, book: 'Main', uid: 1 }],
    cutoff: { gradingOverride: { maxVectorEntries: 20 } }, gradedCandidates: 20, pluginFP: 'deadbeef', sourceFP: 'deadbeef',
    now: '2026-07-29',
};
const out = buildSample(IN);
const RENAMED = { snapshot: 'paramSnapshot', priority: 'bookPriority', now: null, notes: 'notes' };
for (const key of Object.keys(IN)) {
    const outKey = key in RENAMED ? RENAMED[key] : key;
    if (outKey === null) continue;
    eq(out[outKey] !== undefined, true, `buildSample carries "${key}" through (as "${outKey}")`);
}
eq(out.queryChat.length, 1, 'queryChat survives as an array (depth ablation reads it)');
eq(out.pluginFP, 'deadbeef', 'the deployed plugin that produced the scores is recorded');

const CHAT = [
    { name: 'A', mes: 'one' },
    { name: '', mes: '  ' },                                     // empty: dropped before the depth count
    { name: 'B', mes: 'two\n\nstill two' },                      // blank line inside a message
    { name: 'A', mes: 'SKIPthree', extra: { fileLength: 4 } },    // attachment prefix stripped
];
eq(JSON.stringify(query.queryMessages(CHAT, { depth: 99 }).map(x => x.mes)),
    '["one","two\\n\\nstill two","three"]', 'queryMessages drops empties and strips attachments');
eq(query.queryMessages(CHAT, { depth: 2 }).map(x => x.mes).join('|'), 'two\n\nstill two|three',
    'depth takes the NEWEST n, chronologically ordered');
eq(query.buildQuery(CHAT, { depth: 2 }),
    query.queryMessages(CHAT, { depth: 2 }).map(x => (x.name ? `${x.name}: ${x.mes}` : x.mes)).join('\n\n'),
    'buildQuery is exactly the join of queryMessages');
const frozen = query.queryMessages(CHAT, { depth: 99 });
for (const d of [1, 2, 3]) {
    eq(query.buildQuery(frozen, { depth: d }), query.buildQuery(CHAT, { depth: d }),
        `depth ${d} is reproducible from a wider frozen capture`);
}

// --- delta pooling (/wa-super-grade) ---
eq(rowKey({ book: 'A', uid: 7 }) === rowKey({ book: 'B', uid: 7 }), false, 'rowKey separates same uid in different books');

// --- the scene guard (sceneDiff) -------------------------------------------------------------------
const SCENE = { query: 'q', scanChat: [{ name: 'N', mes: 'Ketheric raised his glass' }], depth: 2 };
eq(sceneDiff(SCENE, { ...SCENE }).join(','), '', 'the same scene differs in nothing');
eq(sceneDiff(SCENE, { ...SCENE, scanChat: [{ name: 'N', mes: 'a different turn entirely' }] }).join(','), 'scanChat',
    'two scenes of ONE book are told apart by their messages — the case book+uid cannot see');
eq(sceneDiff(SCENE, { ...SCENE, query: 'other' }).join(','), 'query', 'a different query is a different scene');
eq(sceneDiff(SCENE, { ...SCENE, depth: 5 }).join(','), 'depth', 'the same messages read at another depth are another window, so another scene');
const WS = { ...SCENE, scanChat: [{ name: 'N', mes: 'Ketheric raised his glass   ' }] };
eq(sceneDiff(SCENE, WS).join(','), 'scanChat', 'trailing whitespace is a difference by default');
eq(sceneDiff(SCENE, WS, { ignoreTrailingWhitespace: true }).join(','), '', '...and only the explicit escape forgives it');

const armA = {
    arm: 'shipped',
    rows: [
        { title: 'Launch', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.9 } },
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
eq(u.rows.length, 4, 'union dedupes across arms and KEEPS durable rows');
eq(u.rows.some(r => r.uid === 2), true, 'the constant is captured, not dropped');
eq(u.rows.filter(r => r.uid === 2).length, 1, 'the constant is deduped like any other row, so N arms do not list it N times');
eq(u.rows.find(r => r.uid === 4) !== undefined, true, 'an entry only a sibling arm surfaced is pooled');
eq(JSON.stringify(u.rows.find(r => r.uid === 3).arms), '["shipped","no-filter"]', 'a shared row records every arm that surfaced it');
eq(u.rows.find(r => r.uid === 3).scores.cosine, 0.5, 'a duplicate keeps the FIRST arm\'s signals, never a blend');
eq(u.rows.find(r => r.uid === 3).from, 'shipped', 'the row records which arm supplied its numbers');

const armKeys = {
    arm: 'keys-live',
    rows: [
        { title: 'Launch', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.1, keys: 2.5 } },
        { title: 'Maren', book: 'W', uid: 3, block: 'dynamic', sticky: 0, index: 1, scores: { cosine: 0.7, keys: 1.5 } },
    ],
    entries: [{ uid: 1 }, { uid: 3 }],
};
const uf = unionArms([armA, armKeys]);
const launch = uf.rows.find(r => r.uid === 1);
eq(launch.scores.keys, 2.5, 'an absent signal is filled from an arm that could measure it');
eq(launch.filled.keys, 'keys-live', 'the fill records its source arm');
eq(launch.scores.cosine, 0.9, 'a signal the first arm measured is NOT overwritten by a later arm');
eq(launch.filled.cosine, undefined, 'and is not marked as filled');
eq(launch.from, 'shipped', 'the base row still names its own arm');

const armWhy = {
    arm: 'keys-live',
    rows: [{ title: 'Launch', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { keys: 2.5 }, why: [{ key: 'launch', count: 2 }] }],
    entries: [{ uid: 1 }],
};
const uw = unionArms([armA, armWhy]);
eq(uw.rows.find(r => r.uid === 1).why?.[0]?.key, 'launch', 'why travels with the keys value it explains');
eq(unionArms([armWhy, armA]).rows.find(r => r.uid === 1).why?.[0]?.key, 'launch', 'and a base row that has its own why keeps it');
const armStored = {
    arm: 'shipped',
    rows: [{ title: 'Launch', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.9, text: 12.5, keys: null } }],
    entries: [{ uid: 1 }],
};
const armStoredKeys = {
    arm: 'keys-live',
    rows: [{ title: 'Launch', book: 'W', uid: 1, block: 'dynamic', sticky: 0, index: 0, scores: { cosine: 0.1, text: 9, keys: 2.5 } }],
    entries: [{ uid: 1 }],
};
const us = unionArms([armStored, armStoredKeys]).rows[0];
eq(us.scores.cosine, 0.9, 'a stored row keeps the first arm\'s measured signal');
eq(us.scores.keys, 2.5, 'an absent stored signal is filled from an arm that could measure it');
eq(us.filled.keys, 'keys-live', 'the stored fill records its source arm');
eq(us.filled.cosine, undefined, 'a stored signal the first arm measured is not marked filled');

eq(u.rows.map(r => r.uid).join(','), '1,3,2,4', 'union is ordered by best rank achieved across arms');
eq(u.entries.map(e => e.uid).join(','), '1,3,2,4', 'entries stay aligned with rows after dedupe + sort');

const prior = [{ title: 'Launch', book: 'W', uid: 1, grade: 5 }, { title: 'Maren', book: 'W', uid: 3, grade: 4 }];
const split = splitGraded(u.rows, prior);
eq(split.fresh.map(r => r.uid).join(','), '2,4', 'splitGraded splits on prior grades alone, durable rows included');
eq(split.fresh.filter(r => !isDurable(r)).map(r => r.uid).join(','), '4', 'the gradeable fresh rows are what the popup counts');
eq(split.known.length, 2, 'already-judged rows are reported, not silently dropped');
eq(split.priorOf.get(rowKey({ book: 'W', uid: 3 })), 4, 'prior grades are recoverable for display');
eq(splitGraded([{ title: 'Launch Day (renamed)', book: 'W', uid: 1 }], prior).fresh.length, 0,
    'matching is on book+uid, so a retitled entry is still known');

const ROUND1 = { user: 'me@host', now: '2026-07-01' };
const ROUND2 = { user: 'me@host', now: '2026-07-02' };
const first = mergeGrades([], prior, ROUND1);
const merged = mergeGrades(first, [{ title: 'Ironhold', book: 'W', uid: 4, grade: 3 }, { title: 'Launch', book: 'W', uid: 1, grade: 2 }], ROUND2);
eq(merged.length, 3, 'merge accumulates without duplicating rows');
eq(merged.find(g => g.uid === 1).grades.map(v => v.grade).join(','), '5,2', 'a regrade appends beside the earlier round');
eq(gradeValue(merged.find(g => g.uid === 1)), 2, '...and the later verdict is the one in force');
eq(gradeValue(merged.find(g => g.uid === 3)), 4, 'a prior grade this round did not revisit survives');
eq(mergeGrades(first, [{ book: 'W', uid: 1, grade: 5 }], ROUND1).find(g => g.uid === 1).grades.length, 1,
    'the same rater on the same day is one pass, so re-saving stacks nothing');
eq(mergeGrades(first, [{ book: 'W', uid: 4, grade: 3 }], ROUND2).length, 3, 'delta rounds compose');

// --- rater provenance: which rater a verdict names -------------------------------------------------------
const H = g => ({ kind: 'human', id: 'u1', grade: g });
const L = g => ({ kind: 'llm', model: 'gemma4:31b-mlx', rubric: 'r', grade: g });
eq(gradeValue({ grades: [L(3)] }), 3, 'an llm-only row grades at its llm verdict');
eq(gradeValue({ grades: [L(3), H(2)] }), 2, 'a reviewed row grades at the HUMAN value, not the llm s');
eq(gradeValue({ grades: [L(3), H(0)] }), 0, 'a human 0 is a verdict, not an absent value');
eq(Number.isNaN(gradeValue({})), true, 'an ungraded row is NaN, so a caller s || 0 or isFinite still works');
eq(gradeValue({ grades: [L(0)] }), 0, 'an llm 0 is a measurement, not an absence');
eq(gradeValue({ grades: [L(0), L(4), L(3)] }), 3, 'three llm verdicts resolve to their median');
eq(gradeValue({ grades: [L(0), L(4)] }), 4, 'two that disagree cannot be resolved, so the latest stands');
eq(gradeValue({ grade: 2 }), 2, 'a bare grade reads as the value in force');
eq(Number.isNaN(gradeValue({ llmGrade: 3 })), true, 'a v2 llmGrade scalar is not read at all');
eq(gradeValue({ grade: 2, llmGrade: 3 }), 2, '...and cannot displace the value that is');

const judged = [{ book: 'W', uid: 7, title: 'J', grades: [{ ...L(3), why: 'because' }] }];
const untouched2 = mergeGrades(judged, [], ROUND1);
eq((untouched2[0].grades ?? []).some(v => v.kind === 'human'), false, 'a row no human edited carries no human verdict');
eq(untouched2[0].grades[0].why, 'because', 'and keeps the llm s reasoning');
const reviewed = mergeGrades(judged, [{ book: 'W', uid: 7, title: 'J', grade: 1 }], ROUND1);
eq(gradeValue(reviewed[0]), 1, 'a human edit becomes the verdict in force');
const P = (t, params, g) => ({ kind: 'llm', id: 'm\u001fr', params, grade: g, gradedAt: t });
const T1 = '2026-08-21T14:03:02.481Z', T2 = '2026-08-21T18:41:55.002Z';
eq(passKey(P(T1, { seed: 7 }, 3)) === passKey(P(T1, { seed: 7 }, 4)), true, 'one rater at one instant is one pass, whatever it graded');
eq(passKey(P(T1, { seed: 7 }, 3)) === passKey(P(T2, { seed: 7 }, 3)), false, 'a later pass is another pass, so it appends rather than colliding');
eq(passKey(P(T1, { seed: 7 }, 3)) === passKey(P(T1, { seed: 8, effort: 'high' }, 3)), true,
    'recording more knobs does not make an old verdict stop matching its own re-merge');
const hosted = t => ({ kind: 'llm', id: 'claude-sonnet-5\u001fr', gradedAt: t });
eq(passKey(hosted('2026-08-21T14:03:02Z')) === passKey(hosted('2026-08-21T18:41:55Z')), false,
    'two hosted passes on one day are two passes, because the stamp carries the time');
eq(passKey(hosted('2026-08-21T14:03:02Z')) === passKey(hosted('2026-08-21T14:03:02Z')), true,
    '...and re-merging one of them is still idempotent');

eq(reviewed[0].grades.filter(v => v.kind === 'llm').length, 1, 'and the llm verdict is still there underneath it, which is what IRR reads');

// --- multi-arm bundles (one download instead of N) ---
// INJECTS carries both position classes, ambient and in-chat at depth; keep both.
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
    [mk('shipped', {}), mk('no-filter', { entityFilter: false }), mk('depth', { messageDepth: 8 })],
    { start: 90, end: 100, user: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', captureId: 'cap-test' },
);
const scene0 = bundle.scenes[0];

eq(bundle.schemaVersion, 3, 'the document stamps its schema version');
eq(bundle.scenes.length, 1, 'one scene is a one-element list, not a special shape');
eq(scene0.id, 'c-msg-100', 'the scene id is composed from the chat and the moment it ends at');
eq(scene0.sceneChat, 'chats/c.jsonl', 'and names the chat it was taken from');
eq(scene0.arms, undefined, 'a scene carries no arms — an arm is a configuration and spans scenes');
eq(bundle.arms.length, 3, 'every arm is carried, at document level');
eq(bundle.arms.every(a => a.scenes[scene0.id]), true, '...each with its capture of this scene');
eq(bundle.captureId, 'cap-test', 'the document carries an id that survives a rename');

const order = Object.keys(bundle);
eq(order.slice(order.indexOf('sceneChats')).join(','), 'sceneChats,sceneInjects,books',
    'the haystack inputs and the books are the trailing block, books last as the largest');
eq(order.indexOf('scenes') < order.indexOf('sceneChats'), true, 'and every scene precedes them');

eq(bundle.books !== undefined, true, 'the books are hoisted to the document');
eq(bundle.arms.every(a => a.books === undefined), true, 'the books are NOT duplicated per arm — that is the whole point');
eq(JSON.stringify(bundle.sceneChats[scene0.id]), '[{"name":"A","mes":"w"}]',
    'the scan MESSAGES are hoisted out of the scene, keyed by its id');
eq(bundle.arms.every(a => a.scenes[scene0.id].scanChat === undefined), true, 'so no capture carries a copy of them');
eq(JSON.stringify(bundle.sceneInjects[scene0.id]), JSON.stringify(INJECTS), 'the injects are hoisted beside it, unjoined');
eq(bundle.arms.every(a => a.scenes[scene0.id].injects === undefined), true, 'and no capture carries a copy of those either');
eq(JSON.stringify(bundle.sceneChats[scene0.id]).includes('a note'), false, 'the messages do not contain the inject text');

eq(scene0.entries.length, 1, 'one entry per candidate carrying verdicts');
eq(JSON.stringify(scene0.entries[0]),
    '{"book":"Main","uid":1,"title":"T","grades":[{"rater":0,"grade":4,"gradedAt":"2026-07-29"}]}',
    'a typed grade becomes a verdict naming its rater by index, with a date and no reduced scalar');
eq(scene0.entries[0].grade === undefined && scene0.entries[0].llmGrade === undefined, true,
    'and nothing writes the value in force into the file');
eq(JSON.stringify(bundle.raters), '[{"rater":0,"kind":"human","id":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}]',
    'a rater is spelled out once, in a table the verdicts index into');
eq('id' in scene0.entries[0].grades[0], false, '...and never repeated on the verdict itself');

eq(scene0.entries[0].book, 'Main', 'identity carries the book as its own field');
eq(bundle.arms[0].scenes[scene0.id].candidates[0].book, 'Main', 'and so does a candidate');

for (const f of ['query', 'candidates', 'cutoff', 'index', 'primaryBook', 'gradedCandidates', 'sceneStart', 'depth']) {
    eq(bundle[f] === undefined && bundle.arms.every(a => a.scenes[scene0.id][f] !== undefined), true, `"${f}" is on the cell`);
}
eq(bundle.arms.every(a => a.params !== undefined && a.scenes[scene0.id].params === undefined), true, '"params" is on the arm');
eq(bundle.arms.find(a => a.name === 'no-filter').scenes[scene0.id].query, 'q-no-filter', 'each arm keeps its own query text');
eq(scene0.sceneStart, undefined, 'a scene records no span');
eq(bundle.arms[0].scenes[scene0.id].sceneStart, 90, '...the arm that read it does');

const back = openBundle(bundle, 'no-filter');
eq(back.query, 'q-no-filter', 'unpacking restores the arm\'s own query');
eq(back.params.entityFilter, false, 'unpacking restores the arm\'s own params');
eq(back.params.depth, undefined, 'depth is not among the arm\'s params');
eq(back.depth, 5, '...it is the cell\'s, and the view returns it as a field of its own');
eq(back.sceneStart, 90, 'and so is the span it read back from the moment');
eq(back.scanChat[0].mes, 'w', 'unpacking re-attaches the scene\'s messages');
eq(back.injects[0].depth, 2, '...and the injects, with the depth that decides which windows admit them');
eq(back.injects.map(i => i.key).join(','), 'NOTE,1_memory',
    '...every extension that injects with scan on, named, not just the Author\'s Note');
eq(back.books !== undefined, true, 'unpacking re-attaches the shared books');
eq(back.entries.length, 1, 'unpacking re-attaches the scene\'s verdicts');
eq(back.entries[0].grades[0].id, 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'the reader gets the id back, not the index');
eq(back.entries[0].grades[0].kind, 'human', '...with the kind that says how to read it');
eq('rater' in back.entries[0].grades[0], false, '...and the index gone, since only the file is indexed');
eq(gradeValue(back.entries[0]), 4, '...so the verdict in force resolves');
eq(back.entries[0].book, 'Main', 'under the schema\'s own name for the book');
eq(back.scenes, undefined, 'the view carries no scene list');
eq(back.name, 'sc', 'the view carries the DOCUMENT\'s name, verbatim');
eq(back.arm, 'no-filter', '...and the arm\'s name beside it, so a label is composed rather than baked in');
eq(openBundle(bundle).arm, 'shipped', 'the default arm is "shipped" when present');
eq(openBundle({ ...bundle, arms: bundle.arms.filter(a => a.name !== 'shipped') }).arm, 'no-filter',
    'otherwise the first arm that captured the scene');
let oldThrew = false;
try { openBundle({ name: 'not one', arms: [] }); } catch { oldThrew = true; }
eq(oldThrew, true, 'a document with no scenes is refused rather than read as empty');
let bundleThrew = false;
try { openBundle(bundle, 'nope'); } catch { bundleThrew = true; }
eq(bundleThrew, true, 'an unknown arm throws rather than falling back');
let sceneThrew = false;
try { openBundle(bundle, null, 'nope'); } catch { sceneThrew = true; }
eq(sceneThrew, true, 'and so does naming a missing scene');
const twoDepths = await bundleSamples([mk('a', {}), { arm: 'b', sample: { ...mk('b', {}).sample, depth: 20 } }], { start: 0, end: 1 });
eq(twoDepths.arms.map(a => a.scenes['c-msg-1'].depth).join(','), '5,20', 'two arms may read one moment at different depths');
eq(Object.keys(twoDepths.sceneChats).length, 1, '...sharing one stored set of messages between them');

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

    const located = await hashBooks({ W: { 1: { ...entry, world: 'W' } } });
    eq(located.W, a.W, 'ST\'s entry.world back-pointer is location, not content, so it does not move the hash');

    eq(/^[0-9a-f]{64}$/.test(a.W), true, 'lowercase hex SHA-256, the same shape a digest rater id carries');
    eq(Object.keys(await hashBooks(undefined)).length, 0, 'no books is an empty map, not a throw');
}


// --- stRelative: a stored path names the install, never the machine -------------------------------------
{
    const B = String.fromCharCode(92);
    eq(stRelative('/Users/someone/SillyTavern-launcher/SillyTavern/data/default-user/chats/A/x.jsonl'),
        'data/default-user/chats/A/x.jsonl', 'a chat path is cut at ST\'s data/');
    eq(stRelative('/Users/other/ST/public/scripts/extensions/third-party/WorldsApart/eval/eval-data/indexes/a/index.json'),
        'public/scripts/extensions/third-party/WorldsApart/eval/eval-data/indexes/a/index.json', '...and an index path at public/');
    eq(stRelative(`C:${B}Users${B}bob${B}SillyTavern${B}data${B}default-user${B}chats${B}x.jsonl`),
        'data/default-user/chats/x.jsonl', 'a Windows path relativises and normalises its separators');

    eq(stRelative('data/default-user/chats/x.jsonl'), 'data/default-user/chats/x.jsonl', 'an already-relative path is unchanged');
    eq(stRelative('/Users/x/ST/data/default-user/chats/data/session.jsonl'), 'data/default-user/chats/data/session.jsonl',
        'a chat folder named "data" does not move the cut');
    eq(stRelative('/Users/x/elsewhere/file.json'), '/Users/x/elsewhere/file.json', 'a path naming no ST directory is untouched');
    eq(stRelative(undefined), undefined, 'an absent path is not a throw');

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

// --- the writer against the schema: structural keys are closed ---------------------------------------
const { bundleSamples: bundleForSchema } = await import('../extension/grading.mjs');
const schemaFixture = {
    name: 'n', notes: 'x', createdAt: '2026-08-24', createdBy: 'me', bookPriority: [], gradeScale: {},
    embedModel: 'bge-m3', budget: { maxTokens: '—' }, pluginFP: 'a', sourceFP: 'b',
    chat: 'c.jsonl', scanChat: [], injects: [], sources: {},
    params: { k: 1 }, paramSnapshot: { settings: { chunkSize: 1750 } }, scoredBy: 'x',
    waVersion: '1', stVersion: '2', depth: 4,
    primaryBook: 'B', book: 'p', index: 'i', books: { B: {} },
    grades: [], cutoff: {}, gradedCandidates: 5,
    candidates: [{ book: 'B', uid: 1, tokens: 10 }],
    query: 'q', queryChat: [], invalidConfiguration: null,
};
const built = await bundleForSchema([{ arm: 'shipped', sample: schemaFixture }], { start: 0, end: 10, user: 'u' });
const keys = o => Object.keys(o).sort().join(',');
eq(keys(built),
    'arms,bookHashes,bookPriority,books,budget,createdAt,createdBy,embedModel,gradeScale,name,notes,pluginFP,sceneChats,scenes,schemaVersion,sourceFP',
    'document keys are the schema\'s');
eq(keys(built.scenes[0]), 'entries,id,query,queryChat,sceneChat,sceneEnd', 'scene keys are the schema\'s — query and queryChat hoisted, the arms all agreeing');
eq(keys(built.arms[0]), 'name,paramSnapshot,params,scenes,stVersion,waVersion', 'arm keys are the schema\'s — paramSnapshot among them, not in the cell');
// schemaFixture sets every emitted-when-present field, so these key sets are exact; a capture omitting one is still conformant (G8).
const bare = { ...schemaFixture };
for (const k of ['waVersion', 'stVersion', 'paramSnapshot', 'book', 'gradedCandidates', 'queryChat', 'gradeScale', 'invalidConfiguration']) delete bare[k];
const thin = await bundleForSchema([{ arm: 'shipped', sample: bare }], { start: 0, end: 10, user: 'u' });
eq(keys(thin.arms[0]), 'name,params,scenes', 'an arm omitting every optional field carries no stray key');
eq(keys(Object.values(thin.arms[0].scenes)[0]), 'candidates,cutoff,depth,index,primaryBook,sceneStart', '...and neither does its cell');

// --- the round-trip invariant: openBundle -> setGrades must reproduce the rater table -----------------
{
    const withLlm = await bundleForSchema([{
        arm: 'shipped',
        sample: {
            ...schemaFixture,
            grades: [{ book: 'B', uid: 1, title: 'T', grades: [
                { kind: 'llm', modelName: 'claude-sonnet-5', rubric: 'scene-relevance@b49449ef', grade: 3, gradedAt: '2026-08-15' },
                { kind: 'human', id: 'u1', grade: 4, gradedAt: '2026-08-15' },
            ] }],
        },
    }], { start: 0, end: 10, user: 'u' });
    const table = JSON.stringify(withLlm.raters);
    eq(table.includes('scene-relevance@b49449ef'), true, 'an llm rater\'s id carries the rubric it graded under');
    const reread = openBundle(structuredClone(withLlm));
    const rewritten = setGrades(structuredClone(withLlm), reread.entries);
    eq(JSON.stringify(rewritten.raters), table, 'reading a document and writing it back reproduces the rater table exactly');
    const llmVerdict = reread.entries[0].grades.find(v => v.kind === 'llm');
    eq(llmVerdict.rubric, 'scene-relevance@b49449ef', 'a reader gets the rubric back as a field, not only inside the id');
    eq(llmVerdict.modelDigest, undefined, '...and a model NAME is not handed back as a digest');
}
eq(keys(Object.values(built.arms[0].scenes)[0]),
    'book,candidates,cutoff,depth,gradedCandidates,index,invalidConfiguration,primaryBook,sceneStart',
    'cell keys are the schema\'s');

// --- the two hoists: bulk out of the cell, and a reader that cannot tell -----------------------------
{
    const withWhy = await bundleForSchema([{
        arm: 'shipped',
        sample: { ...schemaFixture, candidates: [
            { book: 'B', uid: 1, tokens: 10, why: [{ key: 'launch', excerpt: 'the launch' }] },
            { book: 'B', uid: 2, tokens: 10 },
        ] },
    }], { start: 0, end: 10, user: 'u' });
    eq(Object.values(withWhy.arms[0].scenes)[0].candidates.every(c => !('why' in c)), true,
        'no candidate in the arms block carries its excerpts');
    eq(withWhy.candidateWhy.shipped[withWhy.scenes[0].id][0][0].key, 'launch',
        '...they are in the trailing block, positionally aligned');
    const ord = Object.keys(withWhy);
    eq(ord.indexOf('candidateWhy') > ord.indexOf('arms') && ord.indexOf('candidateWhy') < ord.indexOf('sceneChats'), true,
        '...which is behind every field the order exists to keep reachable with head');
    const back = openBundle(structuredClone(withWhy));
    eq(back.candidates[0].why[0].excerpt, 'the launch', 'openBundle puts them back on the row they came off');
    eq('why' in back.candidates[1], false, '...and invents none for a row that had none');
    const again = await bundleForSchema([{ arm: 'shipped', sample: { ...schemaFixture, candidates: back.candidates } }],
        { start: 0, end: 10, user: 'u' });
    eq(openBundle(structuredClone(again)).candidates[0].why[0].key, 'launch', 'and a round trip through both is stable');
}
{
    const split = await bundleForSchema([
        { arm: 'shipped', sample: schemaFixture },
        { arm: 'summary', sample: { ...schemaFixture, query: 'a summary' } },
    ], { start: 0, end: 10, user: 'u' });
    eq('query' in split.scenes[0], false, 'a query that varies by arm does not hoist');
    eq(openBundle(structuredClone(split), 'summary').query, 'a summary', '...and each arm reads back its own');
    eq(openBundle(structuredClone(built), 'shipped').query, 'q', 'a hoisted query still reaches the arm view');
}
