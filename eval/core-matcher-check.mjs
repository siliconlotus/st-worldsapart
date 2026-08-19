// HOW WA RELATES TO ST CORE ON AN UNMODIFIED LOREBOOK — the whole of it, in one place.
//
// "An unaltered lorebook behaves under WA as it does under core; every divergence is a decision"
// (matcher-design.md) is a single rule, and a divergence only means anything beside the parity it
// departs from. So both live here: WA matching core's matchKeys and matchSecondaryKeys where it
// should, and the named places it deliberately does not — the Unicode word boundary, whole-word on
// multi-word keys, the orthographic fold. Splitting those would put the fold's superset behaviour in
// one file and the substring default it extends in another.
//
// WA'S OWN SEMANTICS ARE NOT HERE. SmartKeys, scoring units, the saturation curve and the excerpt
// machinery are matcher-check.mjs: core has no opinion on any of them, so there is nothing to be
// faithful to. The two files were tangled until the gate's verdict and the key's count stopped
// agreeing, which forced the split.
//
// Selective logic is answered by ONE expression per primary key — `synthesizeSecondary` builds it,
// `countSelective` evaluates it, `keywordScore` is the only caller. There is no second implementation of the rule left to compare against, which is the point
// of the conversion: `secondaryOk` was a rival evaluator of the same semantics, and CLAUDE.md's
// one-matcher rule covers selective logic as much as key matching.
//
// So this is a WRITTEN-DOWN CASE TABLE rather than a fuzz. Every expected value below is a claim
// about what core's rule says, argued in its own `why`, and the harness runs it through the shipped
// path (keywordScore) rather than a stand-in.
//
// EVERY CLAIM HERE IS ABOUT CORE'S RULE, and nothing here is about WA's scoring. Core gates
// activation and never scores, so what a matched expression is WORTH is a WA question and lives in
// matcher-check.mjs with the rest of it. The two were tangled in this file until the verdict and the
// count stopped agreeing — a key's count is Σ weighted occurrences over the whole expression, so once
// secondaries began to score it no longer doubled as the gate's verdict, and the split became forced.
//
// Rows are `[primary, secondaries, logic, text, expected, why]`, asserting the VERDICT: 1 when the
// gate passes, 0 when it refuses, which is the whole of what core's rule decides.
import { countKey, keywordScore, secondaryKeys, setBoundaryMode, wholeWordAdvice, WI_LOGIC } from '../extension/matcher.mjs';
import { synthesizeSecondary } from '../extension/smartkeys.mjs';
import { eq } from './metrics.mjs';

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

/** Verdict for a single row, for the blocks that assert one call at a time.
 *
 *  `> 0` AND NOT `>= 1`. A matched key is normally worth at least 1, so the two agree almost
 *  everywhere — but a fractional `::weight` is exactly the case they part on, and it is a documented
 *  shape (`? whisper::0.3` down-weights rather than clamping to 1). A fractionally weighted primary
 *  alongside a fractionally weighted secondary totals below 1 while having passed its gate, so
 *  `>= 1` would read a pass as a refusal. Pinned below, since nothing else here weighs a key. */
const fired = (...args) => (count(...args) > 0 ? 1 : 0);

// --- the truth table, which is the whole of core's matchSecondaryKeys -------------------------------
// Primary present once in every text, so the count doubles as the verdict: 1 is "gate passed".
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
        // Core falls back to AND_ANY for a value it does not recognise, and so does this.
        ['cosmonaut', SEC, 99, one, 1, 'an unknown selectiveLogic falls back to AND_ANY'],
    ]);
}

// --- shapes the string route had to REFUSE ---------------------------------------------------------
// Each of these returned null before, and the caller fell back. An AST carries a value verbatim and
// nothing lexes it, so there is nothing left to escape and no refusal left to make.
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
    // The floor, reached through a key that is LEGAL. A purely negated primary would also accumulate
    // no weight, but `negation-only` is a validator error and keywordScore drops those before they
    // arrive; `all-zero-weights` is a warn, and is documented as meaning "gate on this, do not rank
    // on it" — which is exactly a matched expression that must still count as one hit.
    ['? fire::0', ['apollo'], AND_ANY, 'fire near apollo', 1,
        'a matched expression carrying no weight still counts as one hit'],
]);

// --- literals that LOOK like syntax ----------------------------------------------------------------
// A key is arbitrary user text. The string route protected these by quoting; a node needs no
// protection, and these rows are what would break first if anyone reintroduced a string hop.
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

// --- ENTRY FLAGS reach the synthesised nodes -------------------------------------------------------
// The thing the string route could not do at all: countKey returns from its `?` branch before it
// reads the flag arguments, so a synthesised string was always evaluated flags-off. The 16,000-
// comparison fuzz this file replaced never caught it, because it only ever ran with both flags off.
{
    const cs = { caseSensitive: true };
    const ww = { matchWholeWords: true };
    eq(fired('NASA', ['apollo'], AND_ANY, 'nasa flew apollo', cs), 0, 'caseSensitive reaches the primary TERM');
    eq(fired('NASA', ['apollo'], AND_ANY, 'NASA flew apollo', cs), 1, '...and passes on the exact case');
    eq(fired('apollo', ['NASA'], AND_ALL, 'apollo flew nasa', cs), 0, '...and reaches the secondary TERM');
    eq(fired('cat', ['apollo'], AND_ANY, 'the category met apollo', ww), 0, 'matchWholeWords reaches the primary TERM');
    eq(fired('cat', ['apollo'], AND_ANY, 'the cat met apollo', ww), 1, '...and passes on a standalone word');
    eq(fired('apollo', ['cat'], AND_ALL, 'apollo saw the category', ww), 0, '...and reaches the secondary TERM');
    // A `?` or `/re/` key is self-describing: entry flags do not reach inside one.
    eq(fired('? nasa', ['apollo'], AND_ANY, 'nasa flew apollo', cs), 1, 'a `?` primary keeps its own case rules');
    eq(fired('apollo', ['? nasa'], AND_ALL, 'apollo flew nasa', cs), 1, '...and so does a `?` secondary');
    eq(fired('/cat/', ['apollo'], AND_ANY, 'the category met apollo', ww), 1, 'a regex key carries its own rules');
}

// --- blanks, and keys that cannot fire -------------------------------------------------------------
// Blanks and UNUSABLE keys are both dropped BEFORE the logic (matcher.mjs secondaryKeys), so a list of
// them is ungated rather than impossible. A key carrying a fatal validator error used to reach the tree
// and evaluate as never-matching, which silently killed the entry under AND_ALL — accurate, but nobody
// authors a malformed key to mean "never", and the author had nothing to look at. A key that PARSES and
// simply does not occur is the different thing: that is a verdict the logic still has to see.
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

// `selective: false` TURNS THE LIST OFF, and core reads the field (`entry.selective && ...`,
// world-info.js) — WA gated where core does not, which is the one accident in a section where every
// other difference is a decision. CCv2 specifies the switch: `secondary_keys` is "ignored if
// selective == false". `convertCharacterBook` is the only producer, writing `selective || false`
// beside the converted `secondary_keys`, and it saves that to disk — so it is character cards, not
// authored books, that carry the shape, and the false survives every later load because
// `addMissingWorldInfoFields` fills only ABSENT fields.
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const on = (sel, logic, text) => keywordScore(
        { key: ['cosmonaut'], keysecondary: ['apollo'], selectiveLogic: logic, ...(sel === undefined ? {} : { selective: sel }) },
        text, undefined, cfg).score > 0;

    // The gate is off under every logic, including the ones whose gate is an EXCLUSION — those fail
    // on the secondary being PRESENT, so text carrying it is what proves the list went unread.
    eq(on(false, 0, 'the cosmonaut waited'), true, 'selective false: AND_ANY does not gate on a missing secondary');
    eq(on(false, 3, 'the cosmonaut waited'), true, '...nor AND_ALL');
    eq(on(false, 2, 'cosmonaut apollo'), true, '...and NOT_ANY does not exclude on a present one');
    eq(on(false, 1, 'cosmonaut apollo'), true, '...nor NOT_ALL');

    // Both other values keep the gate, and the ABSENT field is the one that matters: core's template
    // defaults `selective` to true, so an entry that never carried the field must gate.
    eq(on(true, 0, 'the cosmonaut waited'), false, 'selective true still gates');
    eq(on(undefined, 0, 'the cosmonaut waited'), false, 'a MISSING selective gates — core\'s own default is true');
    eq(on(true, 0, 'cosmonaut apollo'), true, '...and passes when the secondary is there');

    // Nothing but `false` reads as off: the Studio's write gate probes `secondaryKeys` with a bare
    // key list to ask whether a POSITION tolerates a key, and a falsy-but-absent field there would
    // make the editor refuse every secondary anyone typed.
    eq(secondaryKeys({ keysecondary: ['apollo'] }).length, 1, 'no selective field: the key is usable');
    eq(secondaryKeys({ keysecondary: ['apollo'], selective: false }).length, 0, 'selective false: the list is empty');
    eq(secondaryKeys({ keysecondary: ['apollo'], selective: 0 }).length, 1, 'only a real false switches it off');
}

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
    // An inherited name is an unknown mode too. `in` accepted these, and the fallback that makes the
    // line above pass never ran — the class became a Function and every whole-word key answered 0.
    setBoundaryMode('constructor');
    eq(countKey('Joe', 'Joe arrived', false, true), 1, 'a prototype property name is not a mode');
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

// --- a doubled hyphen is a boundary, in both modes ------------------------------------------------
// Strict counts `-` as inside a word so a compound does not match its head. `normalizeOrthography`
// folds an em dash to `--` so `wait--no` matches `wait—no`. Composed without an exception, an ordinary
// dash reads as word-internal and swallows the boundary — which is prose punctuation, not a compound,
// and cost four of the seven spacings real text uses.
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

    // The exception is EXACTLY the doubled hyphen. Everything strict exists for still fails.
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

// --- apostrophe normalisation ---------------------------------------------------------------------
// A key typed with ASCII ' never matched prose written with U+2019, and nothing surfaced it: the key just
// never fired. Models emit typographic apostrophes constantly, so this silently killed possessive and
// contraction keys against chat as well as against entry text. Both directions occur in real books.
// CURLY is declared at the top of this file — the fold's own tests and the synthesis's share it.

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
