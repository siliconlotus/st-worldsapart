// Guards the keyword classifier + ranker: buildKeyPruneScan / buildKeySuggest live in the pure,
// node-importable keyword-core.mjs, so this imports the real shipped code and runs it on a tiny
// synthetic book — a botched refactor or an edit that changes a verdict fails here instead of
// silently drifting the prune popup, the suggest popup, and Lorebook Studio.
// Run: node eval/keyword-extract-check.mjs
import assert from 'node:assert';
import { buildKeyPruneScan, buildKeySuggest, KEY_TOO_COMMON, KEY_MIN_LENGTH, KEY_MIN_COMMON_ENTRIES } from '../extension/keyword-core.mjs';

// --- buildKeyPruneScan ---------------------------------------------------------------------------
// Four entries so df ratios are meaningful (the classify priority is english-common -> dead ->
// df-too-common -> short, so a short key must stay under the too-common ratio to reach the short
// check). Entry 0 lists: "Quillfeather" (a real findable name, in only 1/4 -> not flagged),
// "zzzznope" (dead, in no text), "home" (common English), "aX" (short, in only 1/4 -> not too-common).
const pruneBook = { entries: {
    0: { uid: 0, key: ['Quillfeather', 'zzzznope', 'home', 'aX'], content: 'The Quillfeather accord met at home. aX aX.', comment: 'One' },
    1: { uid: 1, key: ['Marrowford'], content: 'Marrowford lay past the home road today.', comment: 'Two' },
    2: { uid: 2, key: [], content: 'A quiet home evening, nothing of note.', comment: 'Three' },
    3: { uid: 3, key: [], content: 'Rain on the home, an ordinary night.', comment: 'Four' },
} };
const pruneOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: false,
    pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, stickySkipCommon: true,
    tooCommon: KEY_TOO_COMMON, minLength: KEY_MIN_LENGTH };
const ps = buildKeyPruneScan(pruneBook, pruneOpts, new Set());
assert.strictEqual(ps.entries.length, 4, 'all keyword entries scanned');
const flagsOf = uid => Object.fromEntries(ps.classifyEntry(pruneBook.entries[uid]).map(r => [r.key, r.flag]));
const f0 = flagsOf(0);
assert.strictEqual(f0.zzzznope, 'unattested', 'a key in no entry text is unattested');
assert.strictEqual(f0.home, 'too common', 'a common English word is flagged too-common');
assert.strictEqual(f0.aX, 'short', 'a sub-minLength key is flagged short');
assert.ok(!('Quillfeather' in f0), 'a real findable name is not flagged');
// The ignore whitelist skips a key entirely.
assert.ok(!('zzzznope' in flagsOfIgnored()), 'a whitelisted key is skipped');
function flagsOfIgnored() {
    const p = buildKeyPruneScan(pruneBook, pruneOpts, new Set(['zzzznope']));
    return Object.fromEntries(p.classifyEntry(pruneBook.entries[0]).map(r => [r.key, r.flag]));
}

// Min-entries gate: the df-based lorebook-common flag only fires once the corpus is big enough
// (>= KEY_MIN_COMMON_ENTRIES). "widgetron" is non-English-common and appears in >37.5% of entries.
const mkBook = (n, hits, key) => ({ entries: Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [i, { uid: i, key: i === 0 ? [key] : [], content: i < hits ? `A ${key} appears here.` : 'Nothing notable here.' }])) });
const gateFlag = (n, hits) => { const p = buildKeyPruneScan(mkBook(n, hits, 'widgetron'), pruneOpts, new Set()); return Object.fromEntries(p.classifyEntry(p.entries[0]).map(r => [r.key, r.flag])).widgetron; };
assert.strictEqual(gateFlag(4, 3), undefined, `lorebook-common suppressed below ${KEY_MIN_COMMON_ENTRIES} entries`);
assert.strictEqual(gateFlag(10, 6), 'too common', `lorebook-common fires at/above ${KEY_MIN_COMMON_ENTRIES} entries`);

// --- buildKeySuggest -----------------------------------------------------------------------------
// A distinctive multi-word phrase repeated within one entry (tf>=2) but rare across the book should
// surface; a generic common word should not. Needs >=5 entries so a term in a single entry stays
// under the isFunc >30%-df cut (which otherwise strips it from the n-grams as a "function word").
const suggestBook = { entries: {
    0: { uid: 0, key: [], content: 'The brass orrery turned. The brass orrery hummed. The brass orrery gleamed by the home.', comment: 'A' },
    1: { uid: 1, key: [], content: 'A quiet street at home, nothing of note happened here at all today.', comment: 'B' },
    2: { uid: 2, key: [], content: 'Rain fell on the home and the street, a dull ordinary evening.', comment: 'C' },
    3: { uid: 3, key: [], content: 'The home stood by the street where children played after school.', comment: 'D' },
    4: { uid: 4, key: [], content: 'Down the street, past the home, a market sold bread and fish.', comment: 'E' },
} };
const ss = buildKeySuggest(suggestBook, { dfCeil: 0.5, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: true, cap: 8 });
const entry0 = ss.perEntry.find(pe => pe.entry.uid === 0);
assert.ok(entry0, 'the entry with a distinctive repeated phrase has suggestions');
const terms0 = entry0.newRows.map(r => r.term);
assert.ok(terms0.some(t => t.includes('brass orrery')), `"brass orrery" suggested (got: ${terms0.join(', ')})`);
assert.ok(!terms0.includes('home'), '"home" (common + book-wide) is not suggested');
// canon / dfSubstr / avoid are handed back for the ✨ path + inline edits.
assert.strictEqual(ss.canon("Brass Orrery's"), 'brass orrery', 'canon folds case + possessive');
assert.strictEqual(ss.dfSubstr('home'), 5, 'dfSubstr counts entries whose text contains the term');
assert.ok(Array.isArray(ss.avoid), 'avoid list returned for the LLM prompt');

// Over-shared keys: flagged on how many entries LIST the key, independent of how often it appears in
// their TEXT. "astronaut" sits in one entry's prose but is keyed on all 12, so the content-frequency
// flags can't see it. Needs >= KEY_MIN_COMMON_ENTRIES entries for the ratio to mean anything.
const sharedBook = { entries: Object.fromEntries([...Array(12)].map((_, i) => [i, {
    uid: i,
    key: i === 0 ? ['astronaut', 'moonwalk'] : ['astronaut'],
    content: i === 0 ? 'The astronaut walked. A moonwalk followed. Astronaut again.' : 'Unrelated prose about weather and bread.',
}])) };
const sharedOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: false, pruneCommon: true, pruneShort: false, pruneShared: true, ignoreProper: false, stickySkipCommon: true, tooCommon: KEY_TOO_COMMON, minLength: KEY_MIN_LENGTH, sharedKeys: 0.75 };
{
    const s = buildKeyPruneScan(sharedBook, sharedOpts, new Set());
    const row = s.classifyEntry(sharedBook.entries[5]).find(r => r.key === 'astronaut');
    assert.ok(row, '"astronaut" flagged though it appears in only one entry\'s text');
    assert.strictEqual(row.flag, 'shared', 'flagged as shared, not as frequent');
    assert.strictEqual(row.dk, 12, 'dk counts entries that LIST the key');
    assert.strictEqual(s.reasonOf(row).text, 'shared (100%)', 'reason reports the share percentage');
    // 100% >= threshold -> red, same banding as the frequency flag.
    assert.strictEqual(s.reasonOf(row).color, s.reasonOf({ flag: 'too common', dc: 12 }).color, 'severity banding matches frequent');
    // The one-entry key is untouched by the shared flag.
    assert.ok(!s.classifyEntry(sharedBook.entries[0]).some(r => r.key === 'moonwalk' && r.flag === 'shared'), 'a key on one entry is not over-shared');
}
{
    const off = buildKeyPruneScan(sharedBook, { ...sharedOpts, pruneShared: false }, new Set());
    assert.ok(!off.classifyEntry(sharedBook.entries[5]).length, 'the flag is disableable');
}
{
    // Between 0.75x and 1x the threshold is the yellow danger zone; below 0.75x nothing fires.
    const hi = buildKeyPruneScan(sharedBook, { ...sharedOpts, sharedKeys: 1 }, new Set());
    assert.strictEqual(hi.reasonOf(hi.classifyEntry(sharedBook.entries[5])[0]).color, '#e06c6c', '100% share at threshold 100% is red');
    const tiny = { entries: Object.fromEntries([...Array(9)].map((_, i) => [i, { uid: i, key: ['astronaut'], content: 'x' }])) };
    const small = buildKeyPruneScan(tiny, sharedOpts, new Set());
    assert.ok(!small.classifyEntry(tiny.entries[0]).some(r => r.flag === 'shared'), 'skipped below KEY_MIN_COMMON_ENTRIES');
}

// classifyEntry must honour the scan's entry-class scope, not just the returned `entries` list —
// the Studio explorer iterates its OWN list and asks per entry, so a scope-blind classifier keeps
// flagging classes the user just told it to skip.
const scopeBook = { entries: {
    0: { uid: 0, key: ['zzzdead'], content: 'nothing', constant: true },
    1: { uid: 1, key: ['zzzdead'], content: 'nothing', vectorized: true },
    2: { uid: 2, key: ['zzzdead'], content: 'nothing' },
    3: { uid: 3, key: ['zzzdead'], content: 'nothing', disable: true },
} };
const scopeOpts = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, ignoreProper: false, stickySkipCommon: true, tooCommon: 0.5, minLength: 4 };
const scoped = (over) => {
    const s = buildKeyPruneScan(scopeBook, { ...scopeOpts, ...over }, new Set());
    return Object.values(scopeBook.entries).filter(e => s.classifyEntry(e).length).map(e => e.uid);
};
assert.deepStrictEqual(scoped({}), [0, 1, 2, 3], 'all classes flagged when all are in scope');
assert.deepStrictEqual(scoped({ scanConstant: false }), [1, 2, 3], 'constants drop out when unscanned');
assert.deepStrictEqual(scoped({ scanVectorized: false }), [0, 2, 3], 'vectorized drop out when unscanned');
// uid 3 is disabled AND keyword-class (disable is orthogonal to class), so scanKeyword off drops it too.
assert.deepStrictEqual(scoped({ scanKeyword: false }), [0, 1], 'keyword entries drop out when unscanned');
assert.deepStrictEqual(scoped({ includeInactive: false }), [0, 1, 2], 'disabled drop out when inactive excluded');

console.log('keyword-extract-check: ok');

// --- looksLikeFragment: the clause-fragment flag -------------------------------------------------
// Machine-written keys are lifted verbatim from an entry's own prose, so they sit in that entry's text
// (df 1, not "dead"), appear nowhere else (not too-common, not shared) and are long (not short) — every
// other category misses them. What is decidable from the key alone is COHERENCE, not specificity.
import { looksLikeFragment, FUNCTION_WORDS } from '../extension/keyword-core.mjs';

// Fires: real auto-generated keys that name nothing.
for (const k of ['naked for morale', 'try stuff and see', 'web not spoke wheel', 'the soft stuff',
    'claiming the first wave', 'the morning is mine', 'apology to his son', 'stop parenting me',
    'listening at night', 'queer at forty-seven']) {
    assert.equal(looksLikeFragment(k), true, `fragment: "${k}"`);
}

// SPARED, and these are the ones that matter — a key can be hyper-specific and still legitimate,
// because it NAMES something concrete and might recur. Specificity is not the defect; incoherence is.
for (const k of ['dick flag towels', 'epsom salts', 'empty buildings', 'naked house flag', 'Pride flag',
    'occupying space', 'waterproof mattress pad', 'No Contact Order', 'Randy Miller']) {
    assert.equal(looksLikeFragment(k), false, `not a fragment: "${k}"`);
}

// NON-ENGLISH NAMED ENTITIES MUST SURVIVE. The test is English function words specifically, so a Spanish
// or French determiner inside a proper name does not trip it. This is the case that would break first if
// anyone "improved" the predicate by adding a generic stopword list.
for (const k of ['Dia de los Muertos', 'Cirque du Soleil', 'Coup de Grace']) {
    assert.equal(looksLikeFragment(k), false, `named entity spared: "${k}"`);
}

// A single word is never a fragment — it is a name, or the English-common flag catches it.
for (const k of ['the', 'and', 'Marjorie', 'Grindr']) {
    assert.equal(looksLikeFragment(k), false, `single word: "${k}"`);
}
assert.equal(looksLikeFragment(''), false, 'empty key');
assert.equal(looksLikeFragment(null), false, 'null key');
assert.equal(looksLikeFragment('   '), false, 'whitespace key');
// Punctuation and possessives must not fabricate a second word.
assert.equal(looksLikeFragment("Kyle's heat"), false, 'possessive is not a function word');
assert.equal(looksLikeFragment('Sommers, Teddy'), false, 'comma-separated name');
// The suggester and the audit share one list, so they cannot disagree about what junk looks like.
assert.equal(FUNCTION_WORDS.has('and') && FUNCTION_WORDS.has('the') && FUNCTION_WORDS.has('not'), true, 'FUNCTION_WORDS is populated');
assert.equal(FUNCTION_WORDS.has('de') || FUNCTION_WORDS.has('los'), false, 'no non-English determiners in the list');
console.log('ok   looksLikeFragment: fires on clause fragments, spares concrete names and non-English entities');
