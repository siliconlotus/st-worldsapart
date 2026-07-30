// Verifies WA's keyword matcher tracks core's world-info.js matchKeys semantics.
// countKey/keywordScore live in ranking.mjs, which is isomorphic — imported directly.
import { countKey, keywordScore as rankKeywordScore } from '../extension/ranking.mjs';
import { eq } from './metrics.mjs';

// keywordScore with the production defaults injected. Guards the scoreVectorKeys path —
// that a caller can score against an explicit key list (waKeys) instead of entry.key.
const keywordScore = (e, t, k) => rankKeywordScore(e, t, k, { k1: 2, caseSensitiveDefault: false, wholeWordsDefault: false });
const scored = (e, t, k) => keywordScore(e, t, k).score > 0;
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
// Non-apostrophe punctuation is untouched — this must not become a general unicode fold.
eq(countKey('a-b', 'a–b', false, false), 0, 'en dash is NOT normalised to hyphen');
eq(countKey('"quoted"', '“quoted”', false, false), 0, 'double quotes are NOT normalised');
// Counting still works across repeats and mixed forms in one text.
eq(countKey("Cap'n", `Cap'n and Cap${CURLY}n and Capʼn`, false, false), 3, 'mixed forms all counted');
console.log('ok   apostrophe normalisation: straight/curly interchangeable, other punctuation untouched');
