// Verifies WA's keyword matcher tracks core's world-info.js matchKeys semantics.
// countKey/keywordScore live in matcher.mjs, which is isomorphic — imported directly.
import { countKey, keyExcerpt, keywordScore as rankKeywordScore, setBoundaryMode, wholeWordAdvice } from '../extension/matcher.mjs';
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
eq(countKey('hot tub', 'in the hot tub', false, true), 1, 'multi-word key, whole-word, standing alone');
eq(countKey('Kyle', 'kyle KYLE Kyle', false, false), 3, 'case-insensitive by default');
eq(countKey('Kyle', 'kyle KYLE', true, false), 0, 'case-sensitive when asked');
eq(countKey('/jubi\\w+/i', 'the Jubilees came', false, true), 1, 'regex key with flags overrides options');
eq(countKey('nope', 'nothing here', false, false), 0, 'no match is zero');

// --- Match Whole Words means what it says -----------------------------------------------------------
// Core under-applies its own label twice: it skips any key containing a space, and it stops at an
// affix. WA applies it in both directions, and which characters count as "inside a word" is the
// wordBoundary setting rather than a rule, because both readings are defensible.
{
    // THE MULTI-WORD HALF, unconditional — a space in the key is not an exemption.
    eq(countKey('satyr camp', 'the satyr camps burned', false, true), 0, 'a multi-word key is NOT exempt from whole-word');
    eq(countKey('satyr camp', 'the satyr camp burned', false, true), 1, '...and still matches standing alone');
    eq(countKey('satyr camp', 'the satyr camps burned', false, false), 1, 'substring mode is where the plural still counts');
    eq(countKey('hot tub', 'unhot tub', false, true), 0, 'the LEFT edge of a multi-word key is bounded too');

    // `_` is in neither class. It is in \w for programming identifiers, and underscore emphasis puts
    // it around whole words exactly as asterisks do, so `_Joe_` failing has no defender.
    eq(countKey('Joe', '_Joe_ arrived', false, true), 1, 'underscore is a boundary, so emphasis does not hide a word');
    eq(countKey('Joe', 'Joe_Bloggs', false, true), 1, '...in both directions, including an identifier');

    // Combining marks ARE in both classes: a mark is part of the letter it sits on, so a decomposed
    // spelling must not match where its precomposed twin does not.
    // x + COMBINING ACUTE (U+0301) has no precomposed form, so it survives the fold's NFC pass
    // as a real mark — which \p{L} alone would read as a boundary.
    eq(countKey('x', 'the x\u0301 mark', false, true), 0, 'a combining mark is inside the word, not a boundary');

    // THE SETTING. Strict is the default; permissive is core's own reading of an affix.
    setBoundaryMode('permissive');
    eq(countKey('Joe', "that is Joe's coat", false, true), 1, 'permissive: an apostrophe is a boundary, so a possessive matches');
    eq(countKey('hot tub', 'the hot tub-side chair', false, true), 1, 'permissive: a hyphen is a boundary too');
    eq(countKey('Joe', 'Joel arrived', false, true), 0, 'permissive still stops at a letter');

    setBoundaryMode('strict');
    eq(countKey('Joe', "that is Joe's coat", false, true), 0, 'strict: an apostrophe is inside the word');
    eq(countKey('Joe', 'that is Joe\u2019s coat', false, true), 0, '...and the fold means the curly form behaves identically');
    eq(countKey('hot tub', 'the hot tub-side chair', false, true), 0, 'strict: a hyphen is inside the word');
    eq(countKey('Joe', 'Joe arrived', false, true), 1, 'strict still matches a word standing alone');
    eq(countKey("Joe's", "that is Joe's coat", false, true), 1, '...and the affixed form is reachable by keying it');
    // A `\b` regex key is the escape hatch that makes strict the cheap default to leave.
    eq(countKey('/\\bJoe\\b/', "that is Joe's coat", false, true), 1, 'a \\b regex key recovers permissive behaviour');

    setBoundaryMode('nonsense');
    eq(countKey('Joe', "that is Joe's coat", false, true), 0, 'an unknown mode falls back to the default');
    setBoundaryMode('strict');

    // Substring mode never reads the class at all.
    eq(countKey('Joe', "that is Joe's coat", false, false), 1, 'the setting does not reach substring matching');
}
console.log('ok   whole words: multi-word keys included, _ excluded, permissive/strict boundary class');

// The Studio's structural flag for the same change: computable from the entry, no text and no second
// matcher. Two triggers, both only when the box is on, and nothing else earns one.
{
    const n = (keys, ww = true) => wholeWordAdvice(keys, ww).length;
    eq(n(['satyr camp'], false), 0, 'box off: nothing to say');
    eq(n(['satyr']), 0, 'a single-word Latin key is unremarkable');
    eq(n(['satyr camp']), 1, 'a multi-word key narrows, and core would not have narrowed it');
    eq(n(['? hot tub']), 0, 'a SmartKey does not take entry flags, so neither trigger is true of it');
    eq(n(['/hot tub/']), 0, '...nor does a regex key');
    eq(n(['\u9f8d\u306e\u5bfa']), 1, 'a spaceless script is advised about');
    eq(n(['satyr camp', '\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e']), 2, 'both triggers can fire on one entry');
    // Name the script actually detected — a Thai author must not read copy about Japanese.
    const named = k => /written in (\w+)/.exec(wholeWordAdvice([k], true)[0])?.[1];
    eq(named('\u3072\u3089\u304c\u306a'), 'Japanese', 'kana is named Japanese');
    eq(named('\u9f8d\u5bfa'), 'Chinese', 'Han alone is named Chinese');
    eq(named('\u0e01\u0e23\u0e38\u0e07'), 'Thai', 'Thai is named Thai');
    eq(named('\u9f8d\u306e\u5bfa'), 'Japanese', 'kana wins over the Han it sits beside');
    eq(n(['\uc11c\uc6b8']), 0, 'Hangul is not in the class — modern Korean is spaced');
    eq(n(['\u0f56\u0f7c\u0f51']), 0, 'Tibetan is deliberately out of scope');
}
console.log('ok   whole-word advisory: structural, two triggers, names the script it found');

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
for (const [name, ch] of [['left single quote', '‘'], ['modifier letter', 'ʼ'], ['prime', '′'], ['acute', '´'], ['grave', '`'],
    ['modifier letter prime', 'ʹ'], ['low-9 quote', '‚'], ['high-reversed-9 quote', '‛'],
    ['left single guillemet', '‹'], ['right single guillemet', '›']]) {
    eq(countKey("Cap'n", `Cap${ch}n`, false, false), 1, `${name} normalises`);
}
// The double family, same test. `″` was the asymmetry: `′` was in the class and `″` in none, so a key
// `5'10"` half-matched prose written `5′10″` and `6" pipe` missed `6″ pipe` outright.
for (const [name, ch] of [['double prime', '″'], ['modifier letter double prime', 'ʺ'], ['low-9 double', '„'],
    ['high-reversed-9 double', '‟'], ['left guillemet', '«'], ['right guillemet', '»']]) {
    eq(countKey('6" pipe', `a 6${ch} pipe`, false, false), 1, `${name} normalises`);
}
eq(countKey(`5'10"`, '5′10″ barefoot', false, false), 1, 'both primes fold, so a height key matches typeset prose');
// FINER-GRAINED, not variants: these partition what " collapses, so folding them would erase a
// distinction in the haystack that no key could ask back.
eq(countKey('"title"', '《title》', false, false), 0, 'CJK angle brackets are NOT folded');
eq(countKey('"spoken"', '「spoken」', false, false), 0, 'CJK corner brackets are NOT folded');
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
    null, 'smartkey: no excerpt — a SmartKey is not a substring');
eq(keyExcerpt('ghost', 'no such word here', false, false), null, 'no match, no excerpt');
eq(keyExcerpt('bare', ['first segment', 'the threadbare one'], false, false),
    'the thread«bare» one', 'segments: later segment searched when earlier ones miss');
console.log('ok   keyExcerpt: localises what countKey counted, folded-haystack display, smartkeys excluded');
