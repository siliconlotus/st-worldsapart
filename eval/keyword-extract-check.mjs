// Guards the Phase-0 extraction: buildKeyPruneScan / buildKeySuggest were lifted out of
// keywordScoresReport / keywordSuggestReport so the prune popup, the suggest popup, and Lorebook
// Studio share one classifier + one ranker. This slices those functions (and countKey) straight
// out of worldsapart.js source and runs them on a tiny synthetic book, so a botched extraction or
// a future edit that changes a verdict fails here instead of silently drifting the two callers.
// Run: node keyword-extract-check.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { COMMON_WORDS } from '../plugin/commonwords.js';

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const src = readFileSync(new URL('../worldsapart.js', import.meta.url), 'utf8');
// Pull a top-level `function NAME` out by source slice (worldsapart.js only loads in a browser).
const slice = name => { const i = src.indexOf(`function ${name}`); return src.slice(i, src.indexOf('\n}\n', i) + 2); };

const countKey = new Function('escapeRegex', slice('countKey') + '; return countKey;')(escapeRegex);
const isDateLike = new Function('MONTH_RE', slice('isDateLike') + '; return isDateLike;')(
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/);

// Mirror the module constants (same literals as worldsapart.js).
const KEY_TOO_COMMON = 0.5, KEY_MIN_LENGTH = 4;
const COMMON_HEAD = new Set([...COMMON_WORDS].slice(0, 1000));

const KEY_MIN_COMMON_ENTRIES = 10;
const buildKeyPruneScan = new Function(
    'countKey', 'escapeRegex', 'COMMON_WORDS', 'COMMON_HEAD', 'KEY_TOO_COMMON', 'KEY_MIN_COMMON_ENTRIES', 'KEY_MIN_LENGTH',
    'world_info_case_sensitive', 'world_info_match_whole_words',
    slice('buildKeyPruneScan') + '; return buildKeyPruneScan;',
)(countKey, escapeRegex, COMMON_WORDS, COMMON_HEAD, KEY_TOO_COMMON, KEY_MIN_COMMON_ENTRIES, KEY_MIN_LENGTH, false, false);

const buildKeySuggest = new Function(
    'COMMON_WORDS', 'KEY_TOO_COMMON', 'isDateLike', 'KEY_GOOD_EXAMPLES', 'KEY_BAD_EXAMPLES',
    slice('buildKeySuggest') + '; return buildKeySuggest;',
)(COMMON_WORDS, KEY_TOO_COMMON, isDateLike, ['Thaddeus Wexler'], ['kyle confesses']);

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
    pruneDead: true, pruneCommon: true, pruneShort: true, ignoreProper: false, stickySkipCommon: true,
    tooCommon: KEY_TOO_COMMON, minLength: KEY_MIN_LENGTH };
const ps = buildKeyPruneScan(pruneBook, pruneOpts, new Set());
assert.strictEqual(ps.entries.length, 4, 'all keyword entries scanned');
const flagsOf = uid => Object.fromEntries(ps.classifyEntry(pruneBook.entries[uid]).map(r => [r.key, r.flag]));
const f0 = flagsOf(0);
assert.strictEqual(f0.zzzznope, 'dead', 'a key in no entry text is dead');
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

console.log('keyword-extract-check: ok');
