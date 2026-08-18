// Core's `(key, keysecondary, selectiveLogic)` is answered by ONE expression per primary key —
// `synthesizeSecondary` builds it, `countSelective` evaluates it, and `keywordScore` is the only
// caller. There is no second implementation of the rule left to compare against, which is the point
// of the conversion: `secondaryOk` was a rival evaluator of the same semantics, and CLAUDE.md's
// one-matcher rule covers selective logic as much as key matching.
//
// So this is a WRITTEN-DOWN CASE TABLE rather than a fuzz. Every expected value below is a claim
// about what core's rule says, argued in its own `why`, and the harness runs it through the shipped
// path (keywordScore) rather than a stand-in.
//
// Rows are `[primary, secondaries, logic, text, expected, why]`, where `expected` is the primary
// key's OCCURRENCE COUNT — 0 when the gate refuses.
import { keywordScore, WI_LOGIC } from '../extension/matcher.mjs';
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

const run = rows => {
    for (const [primary, secondaries, logic, text, expected, why] of rows) {
        eq(count(primary, secondaries, logic, text), expected, why);
    }
};

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

// --- the gate is a GATE, never a contribution ------------------------------------------------------
// Secondary nodes carry weight 0. evaluate's AND and OR both sum, so a gate contributing anything
// would inflate the primary's count — which is what makes the conversion score-neutral.
run([
    ['cosmonaut', ['apollo'], AND_ANY, 'cosmonaut and cosmonaut, with apollo', 2,
        'the count is the primary\'s own occurrences, not the pair\'s'],
    ['cosmonaut', ['apollo', 'soyuz'], AND_ALL, 'cosmonaut apollo soyuz', 1,
        'two matched secondaries still add nothing'],
    ['cosmonaut', ['? apollo::5'], AND_ALL, 'cosmonaut apollo', 1,
        'a `?` secondary\'s OWN weights are zeroed too, or the author\'s ::5 would leak into the score'],
]);

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
    ['? moon mission', ['apollo'], AND_ANY, 'a mission to the moon with apollo', 2,
        'a `?` primary splices in as a subtree, keeping its own two-term score'],
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
    eq(count('NASA', ['apollo'], AND_ANY, 'nasa flew apollo', cs), 0, 'caseSensitive reaches the primary TERM');
    eq(count('NASA', ['apollo'], AND_ANY, 'NASA flew apollo', cs), 1, '...and passes on the exact case');
    eq(count('apollo', ['NASA'], AND_ALL, 'apollo flew nasa', cs), 0, '...and reaches the secondary TERM');
    eq(count('cat', ['apollo'], AND_ANY, 'the category met apollo', ww), 0, 'matchWholeWords reaches the primary TERM');
    eq(count('cat', ['apollo'], AND_ANY, 'the cat met apollo', ww), 1, '...and passes on a standalone word');
    eq(count('apollo', ['cat'], AND_ALL, 'apollo saw the category', ww), 0, '...and reaches the secondary TERM');
    // A `?` or `/re/` key is self-describing: entry flags do not reach inside one.
    eq(count('? nasa', ['apollo'], AND_ANY, 'nasa flew apollo', cs), 1, 'a `?` primary keeps its own case rules');
    eq(count('apollo', ['? nasa'], AND_ALL, 'apollo flew nasa', cs), 1, '...and so does a `?` secondary');
    eq(count('/cat/', ['apollo'], AND_ANY, 'the category met apollo', ww), 1, 'a regex key carries its own rules');
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
    eq(synthesizeSecondary('k', ['a'], AND_ALL).right.weight, 0, 'and every secondary node carries weight 0');
    eq(synthesizeSecondary('k', ['a'], AND_ALL).left.weight, 1, '...while the primary keeps its own');
}

console.log('ok   keysecondary synthesis: core\'s four logics, score-neutral gates, entry flags, no refusals');
