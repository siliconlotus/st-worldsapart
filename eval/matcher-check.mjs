// Verifies WA's keyword matcher tracks core's world-info.js matchKeys semantics.
// countKey/keywordScore live in matcher.mjs, which is isomorphic — imported directly.
import { countKey, keyExcerpt, keywordScore as rankKeywordScore } from '../extension/matcher.mjs';
import { eq } from './metrics.mjs';

// keywordScore with the production defaults injected. Guards the scoreVectorKeys path —
// that a caller can score against an explicit key list (waKeys) instead of entry.key.
const keywordScore = (e, t, k) => rankKeywordScore(e, t, k, { k1: 2, caseSensitiveDefault: false, wholeWordsDefault: false });
const scored = (e, t, k) => keywordScore(e, t, k).score > 0;

// Secondary keys gate the SCORE, not only activation: an entry is not credited for a primary its
// author said does not count alone. Truth table mirrors core's matchSecondaryKeys (world-info.js).
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const e = logic => ({ key: ['cosmonaut'], keysecondary: ['apollo', 'soyuz'], selectiveLogic: logic });
    const T = { none: 'the cosmonaut waited', one: 'the cosmonaut boarded apollo', all: 'cosmonaut apollo soyuz' };
    const on = (logic, t) => keywordScore(e(logic), T[t], undefined, cfg).score > 0;
    //                       none   one    all
    const table = { 0: [false, true,  true ],   // AND_ANY
                    1: [true,  true,  false],   // NOT_ALL
                    2: [true,  false, false],   // NOT_ANY
                    3: [false, false, true ] }; // AND_ALL
    const names = { 0: 'AND_ANY', 1: 'NOT_ALL', 2: 'NOT_ANY', 3: 'AND_ALL' };
    for (const [logic, want] of Object.entries(table)) {
        ['none', 'one', 'all'].forEach((t, i) =>
            eq(on(Number(logic), t), want[i], `${names[logic]}: ${t} secondary present`));
    }
    eq(keywordScore({ key: ['cosmonaut'] }, T.none, undefined, cfg).score > 0, true, 'no secondary keys: ungated');
    eq(keywordScore(e(0), T.none, undefined, cfg).hits.length, 0, 'a gated entry reports no hits either');
}
eq(scored({ key: ['zzz'] }, 'alpha beta', ['alpha']), true, 'keywordScore honors explicit keys over entry.key');
eq(scored({ key: ['alpha'] }, 'alpha beta', ['zzz']), false, 'explicit keys with no hit score zero even when entry.key would match');
eq(scored({ key: ['alpha'] }, 'alpha beta'), true, 'defaults to entry.key when no list passed');
eq(scored({ key: ['alpha'] }, 'alpha beta', []), false, 'empty key list (blanked 🔗, option off) scores zero');

// The regression that started this: core substring-matches when whole-word is off.
eq(countKey('Jubilee', 'the Jubilees arrived', false, false), 1, 'substring: Jubilee inside Jubilees (whole-word off)');
eq(countKey('Jubilee', 'the Jubilees arrived', false, true), 0, 'whole-word on: not inside a larger word');
eq(countKey('Jubilee', 'Jubilee met Jubilee', false, true), 2, 'whole-word counts standalone occurrences');
eq(countKey('cat', 'cat cats scatter', false, false), 3, 'substring counts every occurrence');
eq(countKey('cat', 'cat cats scatter', false, true), 1, 'whole-word counts only the standalone');
eq(countKey('v2', 'the v2 model', false, true), 1, 'single token with a digit, whole-word');
// Whole-word boundaries are Unicode, not \w. With \w every non-ASCII letter reads as a boundary, so
// whole-word matching silently degraded to substring for every script but English.
eq(countKey('caf', 'the caf\u00e9 was busy', false, true), 0, 'whole-word: ASCII prefix does not match into an accented word');
eq(countKey('caf\u00e9', 'the caf\u00e9 was busy', false, true), 1, 'whole-word: the accented word itself still matches');
eq(countKey('\u041c\u0430\u0440\u0438', '\u0432\u0441\u0442\u0440\u0435\u0442\u0438\u043b \u041c\u0430\u0440\u0438\u044e', false, true), 0, 'whole-word: Cyrillic prefix does not leak');
eq(countKey('\u041c\u0430\u0440\u0438\u044e', '\u0432\u0441\u0442\u0440\u0435\u0442\u0438\u043b \u041c\u0430\u0440\u0438\u044e', false, true), 1, 'whole-word: the Cyrillic word itself matches');
eq(countKey('caf', 'the caf\u00e9 was busy', false, false), 1, 'substring mode is unaffected');
eq(countKey('hot tub', 'in the hot tub', false, true), 1, 'multi-word key falls back to substring');
eq(countKey('Kyle', 'kyle KYLE Kyle', false, false), 3, 'case-insensitive by default');
eq(countKey('Kyle', 'kyle KYLE', true, false), 0, 'case-sensitive when asked');
eq(countKey('/jubi\\w+/i', 'the Jubilees came', false, true), 1, 'regex key with flags overrides options');
eq(countKey('nope', 'nothing here', false, false), 0, 'no match is zero');

// --- apostrophe normalisation ---------------------------------------------------------------------
// A key typed with ASCII ' never matched prose written with U+2019, and nothing surfaced it: the key just
// never fired. Models emit typographic apostrophes constantly, so this silently killed possessive and
// contraction keys against chat as well as against entry text. Both directions occur in real books.
const CURLY = String.fromCharCode(0x2019);
eq(countKey("Cap'n Joe", `the ${CURLY}n is silent at Cap${CURLY}n Joe${CURLY}s`, false, false), 1, 'straight key matches curly text');
eq(countKey(`Cap${CURLY}n Joe`, "docked at Cap'n Joe's", false, false), 1, 'curly key matches straight text');
eq(countKey("Kyle's heat", `${CURLY}bout Kyle${CURLY}s heat again`, false, false), 1, 'possessive key, curly text');
eq(countKey(`Jeffrey${CURLY}s watch`, "Jeffrey's watch stopped", false, false), 1, 'curly possessive key, straight text');
// Case-sensitive keys normalise too: quote form is orthogonal to case.
eq(countKey("Cap'n Joe", `Cap${CURLY}n Joe`, true, false), 1, 'case-sensitive still normalises apostrophes');
eq(countKey("cap'n joe", `Cap${CURLY}n Joe`, true, false), 0, 'case-sensitive still respects CASE');
// Whole-word path shares the normalised needle.
eq(countKey("don't", `I don${CURLY}t think so`, false, true), 1, 'whole-word matching normalises too');
// Other variants collapse to the same form.
for (const [name, ch] of [['left single quote', '‘'], ['modifier letter', 'ʼ'], ['prime', '′'], ['acute', '´'], ['grave', '`']]) {
    eq(countKey("Cap'n", `Cap${ch}n`, false, false), 1, `${name} normalises`);
}
// Orthographic variants normalise; anything that could carry meaning does not (see normalizeOrthography).
eq(countKey('a-b', 'a–b', false, false), 1, 'en dash normalises to hyphen');
eq(countKey('"quoted"', '“quoted”', false, false), 1, 'curly double quotes normalise');
eq(countKey('wait--no', 'wait—no', false, false), 1, 'em dash normalises to TWO hyphens');
eq(countKey('wait-no', 'wait—no', false, false), 0, 'em dash does NOT collapse onto a single hyphen');
eq(countKey('a...b', 'a…b', false, false), 1, 'ellipsis normalises');
eq(countKey('a b', 'a b', false, false), 1, 'non-breaking space normalises');
// A hyphen is NOT folded to a space: it can carry meaning, and the haystack is the wrong place to lose it.
eq(countKey('three-inch', 'three inch', false, false), 0, 'hyphen is not folded to a space');
// NFC: precomposed and decomposed spellings of one name are the same name, and look identical on screen.
eq(countKey('Jos\u00e9', `Jose\u0301 Sommers`, false, false), 1, 'decomposed text matches a precomposed key');
eq(countKey(`Jose\u0301`, 'Jos\u00e9 Sommers', false, false), 1, 'precomposed text matches a decomposed key');
eq(countKey(`Jose\u0301`, `Jose\u0301 Sommers`, false, false), 1, 'decomposed both sides still matches');
// Counting still works across repeats and mixed forms in one text.
eq(countKey("Cap'n", `Cap'n and Cap${CURLY}n and Capʼn`, false, false), 3, 'mixed forms all counted');
console.log('ok   apostrophe normalisation: straight/curly interchangeable, orthographic variants folded, meaning-bearing characters untouched');

// Markdown in the scan text, both directions. Emphasis around a WHOLE word is fine; emphasis INSIDE
// one is not, and it fails in opposite directions depending on the mode. Pinned so the behaviour is a
// recorded limit rather than something rediscovered — see countKey's docblock for why it stays.
eq(countKey('sister', "She's my *sister*, Tim", false, false), 1, 'emphasis around a whole word: substring matches');
eq(countKey('sister', "She's my *sister*, Tim", false, true), 1, '...and whole-word matches, since * is a boundary');
eq(countKey('sisterhood', 'It is called *sister*hood', false, false), 0, 'in-word emphasis BREAKS a substring match');
eq(countKey('sister', 'It is called *sister*hood', false, true), 1, 'in-word emphasis CREATES a false word boundary');
eq(countKey('sister', 'It is called sisterhood', false, true), 0, '...which the unemphasised control correctly does not');
console.log('ok   markdown in the scan text: whole-word emphasis fine, in-word emphasis is a known limit');

// keyExcerpt — the /wa-grade "why did this pop" display. It shares countKey's machinery but is
// display-only: called for keys countKey already counted, so these pin (a) agreement with countKey
// on WHERE, and (b) the substring surface form an author needs for tuning, marked «so».
eq(keyExcerpt('thread', 'the curtains were threadbare by then', false, false),
    'the curtains were «thread»bare by then', 'substring: excerpt shows the containing word');
eq(keyExcerpt('thread', 'the curtains were threadbare by then', false, true),
    null, 'whole-word: same text correctly yields no excerpt (countKey counts 0)');
eq(keyExcerpt('sister', "She's my *sister*, Tim", false, true),
    "she's my *«sister»*, tim", 'whole-word: excerpt is from the FOLDED haystack (lowercased)');
eq(keyExcerpt("Cap'n", `A ${'Cap’n'} walks in`, false, false),
    "a «cap'n» walks in", 'orthography: curly apostrophe folded, match still localised');
eq(keyExcerpt('/th\\w+bare/', 'the curtains were threadbare by then', false, false),
    'the curtains were «threadbare» by then', 'regex key: excerpt from the raw text via the pattern');
eq(keyExcerpt('? thread & curtains', 'threadbare curtains', false, false),
    null, 'smartkey: no excerpt — boolean queries are not a substring');
eq(keyExcerpt('ghost', 'no such word here', false, false), null, 'no match, no excerpt');
eq(keyExcerpt('bare', ['first segment', 'the threadbare one'], false, false),
    'the thread«bare» one', 'segments: later segment searched when earlier ones miss');
console.log('ok   keyExcerpt: localises what countKey counted, folded-haystack display, smartkeys excluded');
