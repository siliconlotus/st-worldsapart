// How WA relates to ST core on an unmodified lorebook: parity with matchKeys/matchSecondaryKeys, and the named divergences.
// An assertion citing core as the authority goes here; one about what a matched expression is WORTH goes in matcher-check.mjs.
import { coreReadsAsRegex, countKey, decoratorArg, hasDecorator, hasPromoteDecorator, keywordScore, resolveDecorators, secondaryKeys, setBoundaryMode, splitKeys, wholeWordAdvice, withPromote, WI_LOGIC } from '../extension/matcher.mjs';
import { synthesizeSecondary, validateSmartKey } from '../extension/smartkeys.mjs';
import { eq } from '../eval/lib/metrics.mjs';

const { AND_ANY, NOT_ALL, NOT_ANY, AND_ALL } = WI_LOGIC;
const CURLY = String.fromCharCode(0x2019);

/** The primary's count as the shipped path reports it, under the given entry-level match flags. */
const count = (primary, secondaries, logic, text, flags = {}) => {
    const entry = { key: [primary], keysecondary: secondaries, selectiveLogic: logic, ...flags };
    const hit = keywordScore(entry, text, entry.key, { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false })
        .hits.find(h => h.key === primary);
    return hit ? hit.count : 0;
};

/** Verdict: did the gate pass. */
const run = rows => {
    for (const [primary, secondaries, logic, text, expected, why] of rows) {
        eq(count(primary, secondaries, logic, text) > 0 ? 1 : 0, expected, why);
    }
};

/** Verdict for a single row. `> 0`, not `>= 1`: fractional `::weight`s on both sides total below 1 having passed the gate (pinned below). */
const matched = (...args) => (count(...args) > 0 ? 1 : 0);

// --- the truth table, which is the whole of core's matchSecondaryKeys -------------------------------
{
    const SEC = ['apollo', 'soyuz'];
    const none = 'the cosmonaut waited';
    const one = 'the cosmonaut boarded apollo';
    const all = 'cosmonaut apollo soyuz';
    run([
        ['cosmonaut', SEC, AND_ANY, none, 0, 'AND_ANY needs at least one secondary'],
        ['cosmonaut', SEC, AND_ANY, one, 1, 'AND_ANY: one is enough'],
        ['cosmonaut', SEC, AND_ANY, all, 1, 'AND_ANY: all is also enough'],
        ['cosmonaut', SEC, NOT_ALL, none, 1, 'NOT_ALL: none present is not all'],
        ['cosmonaut', SEC, NOT_ALL, one, 1, 'NOT_ALL: one present is not all'],
        ['cosmonaut', SEC, NOT_ALL, all, 0, 'NOT_ALL: all present refuses'],
        ['cosmonaut', SEC, NOT_ANY, none, 1, 'NOT_ANY: none present passes'],
        ['cosmonaut', SEC, NOT_ANY, one, 0, 'NOT_ANY: one present refuses'],
        ['cosmonaut', SEC, NOT_ANY, all, 0, 'NOT_ANY: all present refuses'],
        ['cosmonaut', SEC, AND_ALL, none, 0, 'AND_ALL needs every secondary'],
        ['cosmonaut', SEC, AND_ALL, one, 0, 'AND_ALL: one is not enough'],
        ['cosmonaut', SEC, AND_ALL, all, 1, 'AND_ALL: all present passes'],
        ['cosmonaut', SEC, 99, one, 1, 'an unknown selectiveLogic falls back to AND_ANY'],
    ]);
}

// --- quotes, regex and `?` keys on either side -----------------------------------------------------
run([
    ['say "hi"', ['apollo'], AND_ANY, 'he did say "hi" to apollo', 1,
        'a double quote in the primary needs no escape — a TERM node carries it verbatim'],
    ['cosmonaut', ['say "hi"'], AND_ALL, 'the cosmonaut did say "hi"', 1, '...and none on the secondary side'],
    ['cosmonaut', ['say "hi"'], AND_ALL, 'the cosmonaut said nothing', 0, '...and it is still a real gate'],
    ['/co(l|s)monaut/', ['apollo'], AND_ANY, 'the colmonaut met apollo', 1, 'a regex primary is a REGEX node'],
    ['cosmonaut', ['/apoll./'], AND_ALL, 'cosmonaut apollo', 1, 'ST core permits regex in keysecondary, and so does this'],
    ['cosmonaut', ['/apoll./'], AND_ALL, 'cosmonaut alone', 0, '...as a gate that can refuse'],
    ['? moon mission', ['apollo'], AND_ANY, 'a mission to the moon with apollo', 1,
        'a `?` primary splices in as a subtree rather than being refused'],
    ['cosmonaut', ['? apollo soyuz'], AND_ALL, 'cosmonaut apollo soyuz', 1, 'a `?` secondary is a subtree too'],
    ['cosmonaut', ['? apollo soyuz'], AND_ALL, 'cosmonaut apollo', 0, '...evaluated by its own rules'],
        // `fire::0` because negation-only is a validator error keywordScore drops before it arrives; all-zero-weights is only a warn.
    ['? fire::0', ['apollo'], AND_ANY, 'fire near apollo', 1,
        'a matched expression carrying no weight still counts as one hit'],
]);

// --- literals that LOOK like syntax ----------------------------------------------------------------
run([
    ['cosmonaut', ['hot tub'], AND_ALL, 'the cosmonaut took a hot bath by a cold tub', 0,
        'a multi-word secondary is a PHRASE, not a conjunction of two words'],
    ['cosmonaut', ['hot tub'], AND_ALL, 'the cosmonaut in the hot tub', 1, '...and matches when the phrase is there'],
    ['apollo', ['-cosmonaut'], AND_ALL, 'apollo alone', 0,
        'a leading hyphen is part of the literal, not a negation — which would have PASSED here'],
    ['apollo', ['-cosmonaut'], AND_ALL, 'apollo and -cosmonaut', 1, '...and the literal matches where it appears'],
    ['apollo', ['AND'], AND_ALL, 'apollo AND soyuz', 1, 'an operator word is a literal secondary'],
    ['apollo', ['fire('], AND_ALL, 'apollo saw fire( there', 1, 'so is an unbalanced paren'],
    ['apollo', ['ver'], AND_ALL, 'apollo was never here', 1, 'substring semantics survive: `ver` inside `never`'],
]);

// --- the fold reaches the synthesised nodes --------------------------------------------------------
run([
    ['cosmonaut', ["Cap'n"], AND_ALL, `the cosmonaut saluted Cap${CURLY}n Joe`, 1,
        'a TERM node folds orthography exactly as countKey does'],
    [`Cap${CURLY}n`, ['apollo'], AND_ANY, "Cap'n Joe flew apollo", 1, '...on the primary side too'],
]);

// --- entry flags reach the synthesised nodes -------------------------------------------------------
{
    const cs = { caseSensitive: true };
    const ww = { matchWholeWords: true };
    eq(matched('NASA', ['apollo'], AND_ANY, 'nasa flew apollo', cs), 0, 'caseSensitive reaches the primary TERM');
    eq(matched('NASA', ['apollo'], AND_ANY, 'NASA flew apollo', cs), 1, '...and passes on the exact case');
    eq(matched('apollo', ['NASA'], AND_ALL, 'apollo flew nasa', cs), 0, '...and reaches the secondary TERM');
    eq(matched('cat', ['apollo'], AND_ANY, 'the category met apollo', ww), 0, 'matchWholeWords reaches the primary TERM');
    eq(matched('cat', ['apollo'], AND_ANY, 'the cat met apollo', ww), 1, '...and passes on a standalone word');
    eq(matched('apollo', ['cat'], AND_ALL, 'apollo saw the category', ww), 0, '...and reaches the secondary TERM');
    eq(matched('? nasa', ['apollo'], AND_ANY, 'nasa flew apollo', cs), 1, 'a `?` primary keeps its own case rules');
    eq(matched('apollo', ['? nasa'], AND_ALL, 'apollo flew nasa', cs), 1, '...and so does a `?` secondary');
    eq(matched('/cat/', ['apollo'], AND_ANY, 'the category met apollo', ww), 1, 'a regex key carries its own rules');
}

// --- blanks, and keys that cannot match -------------------------------------------------------------
run([
    ['cosmonaut', ['', '   '], AND_ALL, 'the cosmonaut waited', 1, 'blank secondaries drop out, leaving no gate'],
    ['cosmonaut', ['', '   '], NOT_ANY, 'the cosmonaut waited', 1, '...under every logic, since the list is empty'],
    ['cosmonaut', ['? '], AND_ALL, 'the cosmonaut waited', 1, 'a no-terms secondary drops too, rather than refusing AND_ALL'],
    ['cosmonaut', ['? "moon', 'apollo'], AND_ALL, 'cosmonaut apollo moon', 1, '...and a stray-quote sibling leaves the usable one gating'],
    ['cosmonaut', ['? apollo'], AND_ALL, 'the cosmonaut waited', 0, 'a USABLE secondary that does not occur still refuses AND_ALL'],
    ['cosmonaut', ['? apollo'], NOT_ANY, 'the cosmonaut waited', 1, '...and satisfies NOT_ANY, because it did not match'],
]);

// --- the builder's own contract --------------------------------------------------------------------
{
    eq(synthesizeSecondary('', ['a'], AND_ANY), null, 'a blank primary has nothing to synthesise');
    eq(synthesizeSecondary('k', [], AND_ANY).type, 'TERM', 'no secondaries: the tree is just the primary');
    eq(synthesizeSecondary('k', ['a'], AND_ANY).type, 'AND', 'a gate is ANDed onto the primary under every logic');
    eq(synthesizeSecondary('k', ['a'], NOT_ANY).right.type, 'NOT', 'NOT_ANY negates each secondary');
    eq(synthesizeSecondary('k', ['a', 'b'], NOT_ALL).right.type, 'NOT', 'NOT_ALL negates their conjunction');
    eq(synthesizeSecondary('k', ['a', 'b'], AND_ANY).right.type, 'OR', 'AND_ANY joins them with OR');
    eq(synthesizeSecondary('k', ['a', 'b'], AND_ALL).right.type, 'AND', 'AND_ALL joins them with AND');
    eq(synthesizeSecondary('k', ['a'], AND_ALL).right.weight, 1, 'a secondary node carries weight 1, like any term');
    eq(synthesizeSecondary('k', ['a'], AND_ALL).left.weight, 1, '...the same as the primary');
}

console.log('ok   core parity: keysecondary\'s four logics, entry flags, literals, no refusals');

// --- `selective: false` turns the list off; core reads the field, and character cards are what write it
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const on = (sel, logic, text) => keywordScore(
        { key: ['cosmonaut'], keysecondary: ['apollo'], selectiveLogic: logic, ...(sel === undefined ? {} : { selective: sel }) },
        text, undefined, cfg).score > 0;

    // The NOT_* rows carry the secondary: an exclusion fails on PRESENCE, so that is what proves the list went unread.
    eq(on(false, 0, 'the cosmonaut waited'), true, 'selective false: AND_ANY does not gate on a missing secondary');
    eq(on(false, 3, 'the cosmonaut waited'), true, '...nor AND_ALL');
    eq(on(false, 2, 'cosmonaut apollo'), true, '...and NOT_ANY does not exclude on a present one');
    eq(on(false, 1, 'cosmonaut apollo'), true, '...nor NOT_ALL');

    eq(on(true, 0, 'the cosmonaut waited'), false, 'selective true still gates');
    eq(on(undefined, 0, 'the cosmonaut waited'), false, 'a MISSING selective gates — core\'s own default is true');
    eq(on(true, 0, 'cosmonaut apollo'), true, '...and passes when the secondary is there');

    eq(secondaryKeys({ keysecondary: ['apollo'] }).length, 1, 'no selective field: the key is usable');
    eq(secondaryKeys({ keysecondary: ['apollo'], selective: false }).length, 0, 'selective false: the list is empty');
    eq(secondaryKeys({ keysecondary: ['apollo'], selective: 0 }).length, 1, 'only a real false switches it off');
}

// --- countKey parity: substring, whole-word, case, regex
eq(countKey('Jubilee', 'the Jubilees arrived', false, false), 1, 'substring: Jubilee inside Jubilees (whole-word off)');
eq(countKey('Jubilee', 'the Jubilees arrived', false, true), 0, 'whole-word on: not inside a larger word');
eq(countKey('Jubilee', 'Jubilee met Jubilee', false, true), 2, 'whole-word counts standalone occurrences');
eq(countKey('cat', 'cat cats scatter', false, false), 3, 'substring counts every occurrence');
eq(countKey('cat', 'cat cats scatter', false, true), 1, 'whole-word counts only the standalone');
eq(countKey('v2', 'the v2 model', false, true), 1, 'single token with a digit, whole-word');
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
// --- markup is masked for a literal key, where core matches inside a tag: a named divergence, not parity
eq(countKey('size', '<div style="font-size:13px;">a minotaur</div>', false, false), 0,
    'a literal key does not match inside a tag — core would count this 1');
eq(countKey('div', '<div>a minotaur</div>', false, false), 0, 'nor the tag name itself');
eq(countKey('minotaur', '<div style="font-size:13px;">a minotaur</div>', false, false), 1, 'the text between tags matches as ever');
eq(countKey('/font-size/', '<div style="font-size:13px;">a minotaur</div>', false, false), 1,
    'a regex key is the opt-in and sees the raw text');
eq(countKey('gfx', '<!-- GFX_START -->', false, false), 0, 'a comment is markup too');

// --- Match Whole Words: multi-word keys included, and the boundary class is the wordBoundary setting ------
{
    eq(countKey('satyr camp', 'the satyr camps burned', false, true), 0, 'a multi-word key is NOT exempt from whole-word');
    eq(countKey('satyr camp', 'the satyr camp burned', false, true), 1, '...and still matches standing alone');
    eq(countKey('satyr camp', 'the satyr camps burned', false, false), 1, 'substring mode is where the plural still counts');
    eq(countKey('hot tub', 'unhot tub', false, true), 0, 'the LEFT edge of a multi-word key is bounded too');

    eq(countKey('Joe', '_Joe_ arrived', false, true), 1, 'underscore is a boundary, so emphasis does not hide a word');
    eq(countKey('Joe', 'Joe_Bloggs', false, true), 1, '...in both directions, including an identifier');

    // x + U+0301 has no precomposed form, so it survives the fold's NFC pass as a real mark; e + U+0301 would not.
    eq(countKey('x', 'the x\u0301 mark', false, true), 0, 'a combining mark is inside the word, not a boundary');

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
    eq(countKey('/\\bJoe\\b/', "that is Joe's coat", false, true), 1, 'a \\b regex key recovers permissive behaviour');

    setBoundaryMode('nonsense');
    eq(countKey('Joe', "that is Joe's coat", false, true), 0, 'an unknown mode falls back to the default');
    setBoundaryMode('constructor');
    eq(countKey('Joe', 'Joe arrived', false, true), 1, 'a prototype property name is not a mode');
    setBoundaryMode('strict');

    eq(countKey('Joe', "that is Joe's coat", false, false), 1, 'the setting does not reach substring matching');
}
console.log('ok   whole words: multi-word keys included, _ excluded, permissive/strict boundary class');

// --- wholeWordAdvice: the Studio's structural flag, two triggers, only when the box is on
{
    const n = (keys, ww = true) => wholeWordAdvice(keys, ww).length;
    eq(n(['satyr camp'], false), 0, 'box off: nothing to say');
    eq(n(['satyr']), 0, 'a single-word Latin key is unremarkable');
    eq(n(['satyr camp']), 1, 'a multi-word key narrows, and core would not have narrowed it');
    eq(n(['? hot tub']), 0, 'a SmartKey does not take entry flags, so neither trigger is true of it');
    eq(n(['/hot tub/']), 0, '...nor does a regex key');
    eq(n(['\u9f8d\u306e\u5bfa']), 1, 'a spaceless script is advised about');
    eq(n(['satyr camp', '\u0e01\u0e23\u0e38\u0e07\u0e40\u0e17\u0e1e']), 2, 'both keys can match on one entry');
    const named = k => /written in (\w+)/.exec(wholeWordAdvice([k], true)[0])?.[1];
    eq(named('\u3072\u3089\u304c\u306a'), 'Japanese', 'kana is named Japanese');
    eq(named('\u9f8d\u5bfa'), 'Chinese', 'Han alone is named Chinese');
    eq(named('\u0e01\u0e23\u0e38\u0e07'), 'Thai', 'Thai is named Thai');
    eq(named('\u9f8d\u306e\u5bfa'), 'Japanese', 'kana wins over the Han it sits beside');
    eq(n(['\uc11c\uc6b8']), 0, 'Hangul is not in the class — modern Korean is spaced');
    eq(n(['\u0f56\u0f7c\u0f51']), 0, 'Tibetan is deliberately out of scope');
}
console.log('ok   whole-word advisory: structural, two triggers, names the script it found');

// --- a doubled hyphen is a boundary in both modes (the fold writes an em dash as `--`) ------------
{
    const SARA = 'Sara';
    const em = [
        ['Sara—catch', 'em dash, no spaces'],
        ['Sara— catch', 'em dash, trailing space — the common style'],
        ['Sara —catch', 'em dash, leading space'],
        ['Sara — catch', 'em dash, spaced both sides'],
        ['Hey—Sara said', 'dash before the key'],
        ['Hey —Sara said', 'dash before, attached to the key'],
    ];
    for (const mode of ['permissive', 'strict']) {
        setBoundaryMode(mode);
        for (const [text, why] of em) {
            eq(countKey(SARA, text, false, true), 1, `${mode}: whole-word matches across an ${why}`);
        }
    }

    setBoundaryMode('strict');
    eq(countKey(SARA, 'the Sara-shaped gap', false, true), 0, 'strict: a single hyphen is still inside a word');
    eq(countKey(SARA, "Sara's coat", false, true), 0, "strict: an apostrophe is still inside a word");
    eq(countKey(SARA, 'Sarah went', false, true), 0, 'strict: and a longer word is still a different word');
    eq(countKey('wait--no', 'the wait—no moment', false, true), 1,
        'the fold this excepts still works: a `--` key matches an em dash in the text');
    setBoundaryMode('permissive');
    eq(countKey(SARA, 'the Sara-shaped gap', false, true), 1, 'permissive: a hyphen was always a boundary');
    setBoundaryMode('strict');
}
console.log('ok   doubled hyphen: an em dash is a boundary, a compound hyphen is not');

// --- apostrophe and orthographic normalisation ------------------------------------------------------

eq(countKey("Cap'n Joe", `the ${CURLY}n is silent at Cap${CURLY}n Joe${CURLY}s`, false, false), 1, 'straight key matches curly text');
eq(countKey(`Cap${CURLY}n Joe`, "docked at Cap'n Joe's", false, false), 1, 'curly key matches straight text');
eq(countKey("Kyle's heat", `${CURLY}bout Kyle${CURLY}s heat again`, false, false), 1, 'possessive key, curly text');
eq(countKey(`Jeffrey${CURLY}s watch`, "Jeffrey's watch stopped", false, false), 1, 'curly possessive key, straight text');
eq(countKey("Cap'n Joe", `Cap${CURLY}n Joe`, true, false), 1, 'case-sensitive still normalises apostrophes');
eq(countKey("cap'n joe", `Cap${CURLY}n Joe`, true, false), 0, 'case-sensitive still respects CASE');
eq(countKey("don't", `I don${CURLY}t think so`, false, true), 1, 'whole-word matching normalises too');
for (const [name, ch] of [['left single quote', '‘'], ['modifier letter', 'ʼ'], ['prime', '′'], ['acute', '´'], ['grave', '`'],
    ['modifier letter prime', 'ʹ'], ['low-9 quote', '‚'], ['high-reversed-9 quote', '‛'],
    ['left single guillemet', '‹'], ['right single guillemet', '›']]) {
    eq(countKey("Cap'n", `Cap${ch}n`, false, false), 1, `${name} normalises`);
}
for (const [name, ch] of [['double prime', '″'], ['modifier letter double prime', 'ʺ'], ['low-9 double', '„'],
    ['high-reversed-9 double', '‟'], ['left guillemet', '«'], ['right guillemet', '»']]) {
    eq(countKey('6" pipe', `a 6${ch} pipe`, false, false), 1, `${name} normalises`);
}
eq(countKey(`5'10"`, '5′10″ barefoot', false, false), 1, 'both primes fold, so a height key matches typeset prose');
eq(countKey('"title"', '《title》', false, false), 0, 'CJK angle brackets are NOT folded');
eq(countKey('"spoken"', '「spoken」', false, false), 0, 'CJK corner brackets are NOT folded');
eq(countKey('a-b', 'a–b', false, false), 1, 'en dash normalises to hyphen');
eq(countKey('"quoted"', '“quoted”', false, false), 1, 'curly double quotes normalise');
eq(countKey('wait--no', 'wait—no', false, false), 1, 'em dash normalises to TWO hyphens');
eq(countKey('wait-no', 'wait—no', false, false), 0, 'em dash does NOT collapse onto a single hyphen');
eq(countKey('a...b', 'a…b', false, false), 1, 'ellipsis normalises');
eq(countKey('a b', 'a b', false, false), 1, 'non-breaking space normalises');
eq(countKey('three-inch', 'three inch', false, false), 1, 'DIVERGENCE: a key expands hyphen <-> space, where core matches neither way');
eq(countKey('three inch', 'three-inch', false, false), 0, 'one way only: a spaces-only key interns no hyphenated form');
eq(countKey('wait-no', 'wait\u2014no', false, false), 0, 'the expansion is not the fold: an em-dash stays two hyphens and no variant reaches it');
eq(countKey('Bose\u2013Einstein', 'the Bose Einstein condensate', false, false), 1, 'an en-dash key expands as the hyphen it folds to');
eq(countKey('Jos\u00e9', `Jose\u0301 Navarro`, false, false), 1, 'decomposed text matches a precomposed key');
eq(countKey(`Jose\u0301`, 'Jos\u00e9 Navarro', false, false), 1, 'precomposed text matches a decomposed key');
eq(countKey(`Jose\u0301`, `Jose\u0301 Navarro`, false, false), 1, 'decomposed both sides still matches');
eq(countKey("Cap'n", `Cap'n and Cap${CURLY}n and Capʼn`, false, false), 3, 'mixed forms all counted');
console.log('ok   apostrophe normalisation: straight/curly interchangeable, orthographic variants folded, meaning-bearing characters untouched');

// --- markdown in the scan text: in-word emphasis is a recorded limit (countKey's docblock)
eq(countKey('sister', "She's my *sister*, Tim", false, false), 1, 'emphasis around a whole word: substring matches');
eq(countKey('sister', "She's my *sister*, Tim", false, true), 1, '...and whole-word matches, since * is a boundary');
eq(countKey('sisterhood', 'It is called *sister*hood', false, false), 0, 'in-word emphasis BREAKS a substring match');
eq(countKey('sister', 'It is called *sister*hood', false, true), 1, 'in-word emphasis CREATES a false word boundary');
eq(countKey('sister', 'It is called sisterhood', false, true), 0, '...which the unemphasised control correctly does not');
console.log('ok   markdown in the scan text: whole-word emphasis fine, in-word emphasis is a known limit');

// --- `@@promote`, under core's decorator grammar (parseDecorators, world-info.js): leading `@@` lines only, `@@@` fallback
const promo = content => hasPromoteDecorator({ content });
eq(promo('@@promote\nThe villa'), true, 'a leading @@promote is read');
eq(promo('@@promote'), true, '...with no content after it');
eq(promo('@@dont_activate\n@@promote\nThe villa'), true, 'one of several leading decorator lines is read');
eq(promo('The villa\n@@promote'), false, 'a decorator after content is not a decorator, by core\'s rule');
eq(promo('@@promote\n@@dont_activate\nx'), true, 'order among the leading lines does not matter');
eq(promo(''), false, 'empty content promotes nothing');
eq(promo('Nothing here'), false, '...and neither does ordinary content');
eq(promo('@@@promote\nx'), true, 'the @@@ fallback form is the same decorator');
eq(promo('@@promoted_by_hand\nx'), false, 'a longer name that merely starts with promote is a different decorator');
eq(promo('@@promote 2\nx'), true, '...but an argument after the name is the same decorator');
console.log('ok   @@promote: core\'s leading-line grammar and fallback form, with an exact name test');

// --- withPromote: the Studio toggle edits CONTENT, there being no field to set
const rt = (text, on) => promo(withPromote(text, on));
eq(withPromote('The villa', true), '@@promote\nThe villa', 'adding prepends the line');
eq(rt('The villa', true), true, '...and the reader sees it');
eq(withPromote('@@promote\nThe villa', true), '@@promote\nThe villa', 'adding twice is idempotent');
eq(withPromote('@@promote\nThe villa', false), 'The villa', 'removing takes the line and nothing else');
eq(rt('@@promote\nThe villa', false), false, '...and the reader agrees');
eq(withPromote('@@dont_activate\n@@promote\nThe villa', false), '@@dont_activate\nThe villa',
    'removing leaves core\'s own decorators alone');
eq(withPromote('@@@promote\nx', false), 'x', 'the fallback form is removed too, being the same name');
eq(withPromote('The villa\n@@promote', false), 'The villa\n@@promote',
    'a line past the leading run is content, not a decorator, so removal does not touch it');
eq(withPromote('', true), '@@promote\n', 'an empty entry can be promoted');
eq(withPromote(undefined, false), '', 'absent content is not a throw');
console.log('ok   withPromote: add/remove round-trips through the reader and leaves the rest of the run alone');

// --- splitKeys: a NAMED divergence, so the claim about core lives here
eq(splitKeys('/a/,/b/').join(' | '), '/a/ | /b/', 'a regex straight after a comma is seen (upstream-st.md #17: core\'s customTokenizer misses it)');
console.log('ok   splitKeys: the key-field tokenizer diverges from core where core skips the character after a comma');

// --- decorator names match EXACTLY: core's gates are `.includes('@@activate')` (world-info.js `checkWorldInfo`), so a
// longer name that merely starts with one of core's two must not read as it.
const dec = (decorators, name) => hasDecorator({ uid: 1, key: ['x'], decorators, content: 'y' }, name);

eq(dec(['@@activate'], '@@activate'), true, 'the bare name matches');
eq(dec(['@@activate_only_after 3'], '@@activate'), false, 'a longer name starting with it is a DIFFERENT decorator');
eq(dec(['@@dont_activate_after_match'], '@@dont_activate'), false, '...and so is this one');
eq(dec(['@@dont_activate'], '@@dont_activate'), true, 'the bare name still matches');
eq(dec(['@@activate 2'], '@@activate'), true, 'an argument after the name is the same decorator');

eq(decoratorArg('@@depth 0', '@@depth'), '0', 'the argument comes back');
eq(decoratorArg('@@depth   7  ', '@@depth'), '7', '...trimmed, whatever the spacing');
eq(decoratorArg('@@promote', '@@promote'), '', 'a bare match is the empty string, not null');
eq(decoratorArg('@@depth', '@@role'), null, 'a different name is null');
eq(decoratorArg('@@depthly 3', '@@depth'), null, 'a longer name is null, not an argument of "ly 3"');
eq(decoratorArg('@@@depth 0', '@@depth'), '0', 'the @@@ fallback spelling is the same decorator');
console.log('ok   decorator names match exactly, with the argument and the @@@ spelling');

// --- the `@@@` fallback chain, by core's parseDecorators grammar (world-info.js `parseDecorators`): a `@@@name`
// line counts only when the decorator BEFORE it was unrecognised.
const res = content => resolveDecorators(content).join(',');

eq(res('@@depth 0\nx'), '@@depth 0', 'a recognised leading line is returned bare');
eq(res('@@risu_thing\n@@@depth 0\nx'), '@@depth 0', 'a @@@ line after an UNKNOWN decorator applies');
eq(res('@@depth 0\n@@@depth 5\nx'), '@@depth 0', '...and after a RECOGNISED one it does not');
eq(res('@@@depth 0\nx'), '', 'a @@@ line with nothing before it does not apply');
eq(res('x\n@@depth 0'), '', 'a decorator after content is not a decorator');
eq(res('@@risu_a\n@@risu_b\n@@@depth 0\nx'), '@@depth 0', 'the chain survives two unknowns');
eq(res('@@depth 0\n@@role user\nx'), '@@depth 0,@@role user', 'several recognised lines all return, in order');
console.log('ok   the @@@ fallback chain follows core\'s grammar');

// WA recognises more names than core, so the two resolve a chain differently. WA is the spec-correct side.
eq(res('@@depth 0\n@@@activate\nx').includes('@@activate'), false,
    'WA recognised @@depth, so the @@@activate after it does NOT apply; core, not knowing @@depth, would apply it');
console.log('ok   the divergence from core that follows from a larger recognised set');

// @@ignore_on_max_context is a deliberate no-op, but it must still be RECOGNISED so it closes the chain
// like any other WA decorator.
eq(res('@@ignore_on_max_context\n@@@depth 0\nx').includes('@@depth 0'), false,
    '@@ignore_on_max_context is recognised, so the @@@depth after it does NOT apply');
console.log('ok   @@ignore_on_max_context closes the @@@ chain');

// --- DIVERGENCE: a key is a JS regex. Core takes a narrower set, and coreReadsAsRegex models THAT, never WA's own.
{
    // Core's own list (`parseRegexFromString`): g i m s u y. `d` and `v` postdate it.
    for (const f of ['', 'i', 'gi', 'm', 's', 'u', 'y']) {
        eq(countKey(`/ca[t]/${f}`, 'the cat', false, false), f === 'y' ? 0 : 1, `core's own flag "${f}" runs in WA too`);
        eq(coreReadsAsRegex(`/ca[t]/${f}`), true, `...and core reads it as a pattern`);
    }
    for (const f of ['d', 'v', 'iv']) {
        eq(countKey(`/ca[t]/${f}`, 'the cat', false, false), 1, `DIVERGENCE: WA runs the post-2021 flag "${f}"`);
        eq(coreReadsAsRegex(`/ca[t]/${f}`), false, `...where core reads the whole thing as literal text`);
    }
    // u and v are mutually exclusive, so the pattern never compiles — refused, not silently run.
    eq(countKey('/ca[t]/uv', 'the cat', false, false), 0, 'uv together is an invalid regex, so it counts 0');
    eq(validateSmartKey('/ca[t]/uv')[0]?.code, 'regex-invalid', '...and is reported as one');
    // The same divergence the unescaped slash is: WA runs what JS runs, and the Studio says core will not.
    eq(validateSmartKey('/ca[t]/v')[0]?.code, 'regex-core-refuses', 'a v key warns that core refuses it');
    eq(validateSmartKey('/one/(two|three)/')[0]?.code, 'regex-core-refuses', '...the same warn the unescaped slash gets');
    eq(validateSmartKey('/ca[t]/i')?.length, 0, 'a flag core shares warns about nothing');
}
console.log('ok   regex flags: WA takes every JS flag, core takes its own list, and the gap is warned');
