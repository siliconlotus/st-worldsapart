// WA's own matcher semantics, which core has no opinion about: SmartKeys, scoring units, the saturation curve, key refusals, excerpts.
// A claim that cites core as the authority belongs in core-matcher-check.mjs.
import { countKey, dropTags, keyExcerpts, keyHits, keySpans, splitKeys, textSegments, keywordScore as rankKeywordScore, markExcerptText, repeatCurveOf, secondaryKeys, usableKeys, usedMatchSources, withMatchSources, WI_LOGIC } from '../extension/matcher.mjs';
import { validateSmartKey } from '../extension/smartkeys.mjs';
import { eq } from './metrics.mjs';

// keywordScore with the production defaults injected; k1 is 2 here, and passing a cfg to this wrapper does nothing.
const keywordScore = (e, t, k) => rankKeywordScore(e, t, k, { k1: 2, caseSensitiveDefault: false, wholeWordsDefault: false });
const scored = (e, t, k) => keywordScore(e, t, k).score > 0;

// --- secondary keys gate the SCORE, not only activation
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

// --- secondary keys are validated like primaries, minus `negation-only`; AND_ALL here, so this is the POSITION rule
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const on = (sec, text, logic = 0) =>
        keywordScore({ key: ['cosmonaut'], keysecondary: sec, selectiveLogic: logic }, text, undefined, cfg).score > 0;

    eq(on(['? -gagarin'], 'the cosmonaut launched', 3), true, 'negation-only secondary: fires when the negated term is absent');
    eq(on(['? -gagarin'], 'cosmonaut gagarin waved', 3), false, '...and gates when it is present');
    eq(on(['? -gagarin', 'astronaut'], 'cosmonaut gagarin waved', 3), false, 'AND_ALL: the negation bites past a positive sibling');
    eq(on(['? -gagarin', 'astronaut'], 'cosmonaut astronaut', 3), true, '...and passes when both conditions hold');
    eq(usableKeys(['? -gagarin']).length, 0, 'the same key stays fatal as a PRIMARY');

    const both = (text) => keywordScore(
        { key: ['astronaut'], keysecondary: ['cosmonaut', '? -gagarin'], selectiveLogic: 3 }, text, undefined, cfg).score > 0;
    eq(both('the astronaut met the cosmonaut'), true, 'AND_ALL: positive secondary present, negated one absent');
    eq(both('astronaut cosmonaut gagarin'), false, '...the negation still excludes');
    eq(both('the astronaut waited alone'), false, '...and the positive secondary is still required');

    // Each text carries the gate's terms: without the drop the expression fails whatever the text says, so a pass is what proves it.
    eq(on(['? /[/'], 'the cosmonaut waited'), true, 'regex-invalid secondary is dropped, leaving the entry ungated');
    eq(on(['?   '], 'the cosmonaut waited'), true, 'no-terms secondary is dropped');
    eq(on(['? "moon', 'apollo'], 'cosmonaut apollo moon', 3), true, 'AND_ALL: a stray-quote sibling drops, the real one still gates');
    eq(on(['? "moon', 'apollo'], 'cosmonaut moon', 3), false, '...and the surviving secondary still has to match');
}

// --- a negation-only secondary by operator: AND_ANY drops it, AND_ALL and the NOT_* pair keep it
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const on = (sec, logic, text) =>
        keywordScore({ key: ['cosmonaut'], keysecondary: sec, selectiveLogic: logic }, text, undefined, cfg).score > 0;
    const ABSENT = 'the cosmonaut waited', PRESENT = 'cosmonaut gagarin waved';

    eq(secondaryKeys({ keysecondary: ['? -gagarin'], selectiveLogic: 0 }).length, 0, 'AND_ANY drops a negation-only secondary');
    eq(on(['? -gagarin'], 0, ABSENT), true, '...leaving the entry ungated, so absence passes');
    eq(on(['? -gagarin'], 0, PRESENT), true, '...and so does presence — the key is gone, not inverted');

    eq(secondaryKeys({ keysecondary: ['apollo', '? -gagarin'], selectiveLogic: 0 }).join(), 'apollo', 'the positive sibling survives alone');
    eq(on(['apollo', '? -gagarin'], 0, 'the cosmonaut waited'), false, 'AND_ANY: the surviving secondary gates, where the OR used to stand open');
    eq(on(['apollo', '? -gagarin'], 0, 'cosmonaut apollo'), true, '...and passes when it is satisfied');

    eq(on(['? -gagarin'], 3, ABSENT), true, 'AND_ALL: a negation-only secondary passes on absence');
    eq(on(['? -gagarin'], 3, PRESENT), false, '...and gates on presence');
    eq(on(['apollo', '? -gagarin'], 3, 'the cosmonaut waited'), false, '...and the positive sibling is still required');

    eq(on(['? -gagarin'], 2, ABSENT), false, 'NOT_ANY: the operator negates the key again, so absence gates');
    eq(on(['? -gagarin'], 2, PRESENT), true, '...and the excluded term is now REQUIRED');
    eq(on(['? -gagarin'], 1, ABSENT), false, 'NOT_ALL: the same inversion');
    eq(on(['? -gagarin'], 1, PRESENT), true, '...and the same requirement');

    const explicit = '? cosmonaut && (apollo || -gagarin)';
    eq(validateSmartKey(explicit).length, 0, 'the explicit route validates clean');
    eq(countKey(explicit, 'the cosmonaut waited', false, false) > 0, true, '...and reproduces the branch AND_ANY no longer offers');
    eq(countKey(explicit, 'cosmonaut gagarin', false, false) > 0, false, '...negation and all');
}

eq(scored({ key: ['zzz'] }, 'alpha beta', ['alpha']), true, 'keywordScore honors explicit keys over entry.key');
eq(scored({ key: ['alpha'] }, 'alpha beta', ['zzz']), false, 'explicit keys with no hit score zero even when entry.key would match');
eq(scored({ key: ['alpha'] }, 'alpha beta'), true, 'defaults to entry.key when no list passed');
eq(scored({ key: ['alpha'] }, 'alpha beta', []), false, 'empty key list (blanked 🔗, option off) scores zero');
eq(keywordScore({ key: ['? -zebra', 'cosmonaut'] }, 'the cosmonaut waited').hits.map(h => h.key).join(','),
    'cosmonaut', 'a validator-error key is dropped from scoring, the valid one is not');
eq(scored({ key: ['? -zebra'] }, 'the cosmonaut waited'), false, 'an entry keyed only on error keys scores zero');
// --- scoring units (smartkeys.mjs `evaluate`): AND adds, OR pools into one saturation, a weight multiplies its unit
{
    const sc = (key, text) => Number(keywordScore({ key: [key] }, text).score.toFixed(3));
    const curve = n => Number(repeatCurveOf(n, 2).toFixed(3));

    eq(sc('? moon', 'moon'), 1, 'a matched expression is worth 1');
    eq(sc('moon', 'moon'), 1, '...and a plain key is the same expression');

    eq(sc('? moon AND rocket', 'moon rocket launch'), 2, 'AND: two units, two things present');
    eq(sc('? moon AND rocket AND launch', 'moon rocket launch'), 3, '...three of them');
    eq(sc('? moon', 'moon rocket launch'), 1, '...against the same text, one thing is still worth one');

    eq(sc('? (glasses OR spectacles)', 'glasses spectacles'), curve(2), 'OR pools its spellings into one unit');
    eq(sc('? glasses', 'glasses glasses'), curve(2), '...which is exactly what the bare key scores');
    eq(sc('? (glasses OR spectacles)', 'a glasses store called Spectacles, more glasses'), curve(3),
        'three mentions across two spellings is one thing seen three times');

    eq(sc('? (everest OR kailash::2)', 'Everest'), 1, 'the unweighted alternative is worth 1');
    eq(sc('? (everest OR kailash::2)', 'Kailash'), 2, '...and ::2 is worth exactly twice it');
    eq(sc('? (everest OR kailash::2) AND mount', 'Mount Everest'), 2, 'the conjunct adds its own unit');
    eq(sc('? (everest OR kailash::2) AND mount', 'Mount Kailash'), 3, '...to either alternative');

    eq(sc('? moon AND rocket::0', 'moon rocket'), 1, 'a zero-weight conjunct gates without scoring');
    eq(sc('? (moon OR rocket::0)', 'moon rocket'), 1, '...and does not drag its group\'s mean down');

    // negation-only is fatal in a primary, so the all-zero-weight key is the reachable case
    eq(sc('? moon::0', 'moon'), 1, 'an all-zero-weight key that matches still counts as one');

    const gated = (logic, sec, text) => Number(keywordScore(
        { key: ['cosmonaut'], keysecondary: sec, selectiveLogic: logic }, text).score.toFixed(3));
    const T = 'cosmonaut apollo soyuz';
    eq(gated(3, ['apollo'], T), sc('? cosmonaut AND apollo', T), 'AND_ALL agrees with the hand-written form');
    eq(gated(3, ['apollo', 'soyuz'], T), sc('? cosmonaut AND apollo AND soyuz', T), '...with two secondaries');
    eq(gated(0, ['apollo', 'soyuz'], T), sc('? cosmonaut AND (apollo OR soyuz)', T), 'AND_ANY agrees — its secondaries are one unit');
    eq(gated(2, ['gagarin'], T), sc('? cosmonaut AND NOT gagarin', T), 'NOT_ANY agrees, as it always did');
    eq(gated(2, ['gagarin'], T), 1, '...at the primary alone, because a NOT yields no unit');

    eq(Number(keywordScore({ key: ['? (glasses OR spectacles)'] }, ['glasses', 'spectacles']).score.toFixed(3)),
        curve(2), 'a unit saturates once across the whole window');
}

// --- count vs score: count is occurrences, score is the weighted contribution; both independent of k1
{
    const { AND_ANY, NOT_ANY, AND_ALL } = WI_LOGIC;
    /** The primary's hit through the shipped path — `count` is occurrences, `score` is contribution. */
    const hit = (primary, sec, logic, text) => {
        const e = { key: [primary], keysecondary: sec, selectiveLogic: logic };
        return keywordScore(e, text, e.key).hits.find(h => h.key === primary);
    };
    const count = (...a) => hit(...a)?.count ?? 0;
    const keyScore = (...a) => hit(...a)?.score ?? 0;
    const fired = (...a) => (count(...a) > 0 ? 1 : 0);

    eq(count('cosmonaut', ['apollo'], AND_ANY, 'cosmonaut and cosmonaut, with apollo'), 3,
        'the primary\'s two occurrences plus the secondary\'s one');
    eq(count('cosmonaut', ['apollo', 'soyuz'], AND_ALL, 'cosmonaut apollo soyuz'), 3,
        'two matched secondaries contribute their own occurrences');
    eq(count('cosmonaut', ['? apollo::5'], AND_ALL, 'cosmonaut apollo'), 2,
        'count is occurrences: the primary once, the secondary once');
    eq(keyScore('cosmonaut', ['? apollo::5'], AND_ALL, 'cosmonaut apollo'), 6,
        '...and score carries the weight — a `?` secondary\'s ::5 is theirs to mean');
    eq(count('cosmonaut', ['gagarin'], NOT_ANY, 'cosmonaut soyuz'), 1,
        'an excluded secondary contributes nothing, as it never could');
    eq(count('? moon mission', ['apollo'], AND_ANY, 'a mission to the moon with apollo'), 3,
        'a spliced `?` primary keeps its own two terms, and the secondary adds its one');

    eq(keyScore('? cosmonaut::0.3', ['? apollo::0.2'], AND_ALL, 'cosmonaut apollo'), 0.5,
        'fractional weights on both sides SCORE below 1 — and the gate PASSED');
    eq(count('? cosmonaut::0.3', ['? apollo::0.2'], AND_ALL, 'cosmonaut apollo'), 2,
        '...while the count is still two plain occurrences, which is why they are separate fields');
    eq(fired('? cosmonaut::0.3', ['? apollo::0.2'], AND_ALL, 'cosmonaut apollo'), 1,
        '...and `> 0` reads the pass, where `>= 1` on the score would call it a refusal');
    eq(count('? cosmonaut::0.3', ['? apollo::0.2'], AND_ALL, 'cosmonaut alone'), 0,
        'a real refusal reports no hit at all');
    eq(keyScore('? cosmonaut::0', ['apollo'], AND_ALL, 'cosmonaut apollo'), 1,
        'an all-zero-weight key that matched is floored to one, not dropped to nothing');
}

// --- repeatCurveOf: k1 is the RATE, the curve is the SHAPE, R is reach; a table, since the curves part only in the tail (K8)
{
    const at = (n, c, R = 1) => Number(repeatCurveOf(n, 1.2, c, R).toFixed(3));

    eq(at(1, 'bm25'), 0.455, 'bm25: a key present once is worth less than half a saturated one');
    eq(at(1, 'presence-log'), 1, 'presence-log: present once is worth exactly the key\'s weight');
    eq(at(1, 'presence'), 1, '...as it is under the bounded form');
    eq(repeatCurveOf(0, 1.2, 'presence-log'), 0, 'absent is 0 under every curve');
    eq(repeatCurveOf(0, 1.2, 'bm25'), 0, '...including bm25');

    eq(at(21, 'bm25'), 0.946, 'bm25 at n=21');
    eq(at(89, 'bm25'), 0.987, '...and at n=89, having moved 0.041 over 4.2x the evidence');
    eq(at(21, 'presence'), 1.943, 'the BOUNDED presence form is just as flat at n=21');
    eq(at(89, 'presence'), 1.987, '...and at n=89 — fixing the floor does nothing for the ceiling');
    eq(at(21, 'presence-log'), 3.872, 'presence-log at n=21');
    eq(at(89, 'presence-log'), 5.309, '...and at n=89, still separating them');

    eq(at(20, 'presence', 1) < at(20, 'presence', 2), true, 'R raises what repeats may add');
    eq(repeatCurveOf(1, 1.2, 'presence', 5), 1, '...and never touches presence itself');
    eq(Number(repeatCurveOf(3, 0.5, 'presence-log').toFixed(3)) > at(3, 'presence-log'), true,
        'a lower k1 accrues repeats faster');
    eq(at(1, 'presence-log') === at(1, 'presence'), true, 'the curves differ only once there is a repeat');

    eq(at(100000, 'presence', 1) < 2.001, true, 'presence R=1 is capped at 2x');
    eq(at(100000, 'presence-log') > 10, true, 'presence-log is not capped');

    eq(repeatCurveOf(5, 1.2), repeatCurveOf(5, 1.2, 'presence-log'), 'the default curve is the shipped curve');
}

eq(countKey('? -zebra', 'the cosmonaut waited', false, false), 1,
    'countKey itself is unfiltered — it answers what the expression does, and the filter is the caller\'s');


// --- keyExcerpts: the first place a key matched, marked «so»; must agree with countKey on WHERE
const keyExcerpt = (key, text, cs, ww, context = 28) => markExcerptText(keyExcerpts(key, text, cs, ww, context, 1)[0]);
eq(keyExcerpt('thread', 'the curtains were threadbare by then', false, false),
    'the curtains were «thread»bare by then', 'substring: excerpt shows the containing word');
eq(keyExcerpt('thread', 'the curtains were threadbare by then', false, true),
    null, 'whole-word: same text correctly yields no excerpt (countKey counts 0)');
eq(keyExcerpt('sister', "She's my *sister*, Tim", false, true),
    "She's my *«sister»*, Tim", 'whole-word: excerpt keeps the source casing');
eq(keyExcerpt("Cap'n", `A ${'Cap’n'} walks in`, false, false),
    `A «${'Cap’n'}» walks in`, 'orthography: a straight-quote key marks the curly-quote source it matched');
eq(keyExcerpt('rut', 'the RUT began… pre-RUT nerves', false, false),
    'the «RUT» began… pre-RUT nerves', 'a fold that lengthens earlier text does not shift the mark');
eq(keyExcerpt('nerves', 'a — b … c nerves here', false, false),
    'a — b … c «nerves» here', 'em-dash and ellipsis before the match keep it correctly placed');
eq(keyExcerpt('knots', 'Cafe\u0301 and Nai\u0308ve. He knots the rope', false, false),
    'Café and Naïve. He «knots» the rope', 'decomposed accents before the match do not shift it');
const own = keyExcerpts('rut', 'she said «no rut» today', false, false)[0];
eq(own.text.slice(own.start, own.end), 'rut', 'offsets select the match even when the source has guillemets');
eq(countKey('/café/', 'the cafe\u0301 rope', false, false), 1, 'a regex matches decomposed text after NFC');
eq(countKey('/—/', 'a — b', false, false), 1, 'orthography is still NOT folded: a pattern can match a real em-dash');
eq(countKey("/Cap'n/", 'Cap\u2019n', false, false), 0, "and a straight-quote pattern still misses a curly one");
eq(countKey("/Cap['\u2019]n/", 'Cap\u2019n', false, false), 1, 'which the author widens with a class, as before');
eq(keyExcerpt('/café/', 'He knots the cafe\u0301 rope', false, false),
    'He knots the «café» rope', 'the excerpt marks the composed form it searched');
eq(keyExcerpt('/knot(s|ting)?/', 'She paused — then again — and sighed… He knots the rope', false, false),
    '…then again — and sighed… He «knots» the rope', 'a regex hit is not walked back through the fold');
eq(keyExcerpt('/th\\w+bare/', 'the curtains were threadbare by then', false, false),
    'the curtains were «threadbare» by then', 'regex key: excerpt from the raw text via the pattern');
eq(keyExcerpt('ghost', 'no such word here', false, false), null, 'no match, no excerpt');
eq(keyExcerpt('bare', ['first segment', 'the threadbare one'], false, false),
    'the thread«bare» one', 'segments: later segment searched when earlier ones miss');
console.log('ok   keyExcerpt: localises what countKey counted, folded-haystack display');


// --- a compound SmartKey excerpts one leaf per credited unit, in TEXT order, each carrying its own occurrence count
const space = 'the Russian cosmonaut Yuri Gagarin flew; the American astronaut Neil Armstrong walked. Gagarin again.';
const leaves = k => keyExcerpts(k, space, false, true).map(e => `${e.term}:${e.n}`);
eq(leaves('? (armstrong gagarin)').join(' '), 'gagarin:2 armstrong:1', 'AND: both leaves, ordered by position, not by the AST');
eq(leaves('? (apple | gagarin | coconut)').join(' '), 'gagarin:2', 'OR: only the side that hit, and the pooled n is that side\'s own');
eq(leaves('? (gagarin -banana)').join(' '), 'gagarin:2 -banana:0', 'NOT: a negative that never fires is named at 0');
eq(leaves('? (gagarin banana)').join(' '), 'gagarin:2', 'a key whose verdict is false still shows the branch that hit — the group is tuned against that');
eq(leaves('? (apple | banana)').join(' '), '', 'a key nothing in it hit shows nothing');
eq(markExcerptText(keyExcerpts('? (armstrong gagarin)', space, false, true, 12)[0]),
    '…monaut Yuri «Gagarin» flew; the A…', 'a leaf excerpt is the ordinary one, at the caller\'s context width');
eq(leaves('? (/Gagar\\w+/ armstrong)').join(' '), '/Gagar\\w+/:2 armstrong:1', 'a regex leaf reports the pattern as its term, and is case-sensitive without /i');
console.log('ok   keyExcerpt: compound SmartKeys excerpt every credited leaf, with per-leaf counts');


// --- a negated leaf is reported too: whether the thing vetoing the key fires at all is the same tuning question
const negs = k => keyHits([k], space, false, true).map(r => `${r.key}:${r.count ?? ''}`).join(' ');
eq(negs('? cosmonaut -astronaut'), '? cosmonaut -astronaut:0 \u21b3 cosmonaut:1 \u21b3 -astronaut:1',
    'the veto is named with its count, so a key reading 0 says what stopped it');
eq(negs('? cosmonaut -astronuat'), '? cosmonaut -astronuat:1 \u21b3 cosmonaut:1 \u21b3 -astronuat:0',
    'a negative that never fires reads 0 — a misspelt one is invisible otherwise');
eq(keyHits(['? cosmonaut -astronuat'], space, false, true)[2].excerpt, undefined,
    'a leaf that did not fire has no excerpt to show');
eq(keySpans(['? cosmonaut -astronaut'], space, false, true).length, 1,
    'and a negated leaf is never marked in the text: a mark means a match');
console.log('ok   keyExcerpt: negated leaves are counted and named, and never marked');


// --- gate: a secondary condition in core's own terms, firing exactly where the entry's key does
{
    const texts = ['apple on a tablet', 'apple alone', 'banana and computer', 'nothing here', 'apple computer tablet'];
    const opts = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const keys = ['apple', 'banana'], sec = ['computer', 'tablet'];
    for (const logic of [WI_LOGIC.AND_ANY, WI_LOGIC.AND_ALL, WI_LOGIC.NOT_ANY, WI_LOGIC.NOT_ALL]) {
        const entry = { key: keys, keysecondary: sec, selective: true, selectiveLogic: logic };
        for (const text of texts) {
            const fired = new Set(rankKeywordScore(entry, text, entry.key, opts).hits.map(h => h.key));
            const gated = keyHits(keys, text, false, false, { gate: { keys: sec, logic } })
                .filter(r => !r.key.startsWith('\u21b3'));
            eq(gated.map(r => r.count > 0).join(), keys.map(k => fired.has(k)).join(),
                `logic ${logic} on "${text}": the gate fires exactly where the entry's own secondary keys do`);
        }
    }
    const gate = { keys: sec, logic: WI_LOGIC.AND_ANY };
    eq(keyHits(['apple'], 'apple apple computer', false, false, { gate })[0].count, 2,
        'the number under a gate is the key\'s own occurrences, not the gate\'s weight');
    eq(keyHits(['apple'], 'apple alone', false, false, { gate }).map(r => `${r.key}:${r.count ?? ''}`).join(' '),
        'apple:0 \u21b3 apple:1', 'a key the gate refused counts 0, and still shows where it hit');
    eq(keyHits(['apple'], 'apple on a tablet', false, false, {}).length, 1, 'no gate, no condition');
    eq(keySpans(['apple'], 'apple alone. apple and a tablet', false, false, { gate, matchWindow: 'scan' }).length, 2,
        'the marks follow the gate, over whatever unit the window makes');
    console.log('ok   gate: a secondary condition on every key, counted as the key and verdicted as the entry');
}


// --- splitKeys: commas and newlines both separate, and a regex or a quoted term keeps its own commas
eq(splitKeys('Russian,\n? cosmonaut astronaut,\nhand,\n\n/(cosmo|astro|taiko)naut/,\negg ').join(' | '),
    'Russian | ? cosmonaut astronaut | hand | /(cosmo|astro|taiko)naut/ | egg',
    'a pane of keys: blank lines, trailing commas and surrounding space all go');
eq(splitKeys('/a{1,3}/,cat').join(' | '), '/a{1,3}/ | cat', 'a regex keeps the commas inside it — core\'s own rule');
eq(splitKeys('? "hot, tub", cat').join(' | '), '? "hot, tub" | cat', 'and so does a quoted term');
eq(splitKeys('and/or, cat').join(' | '), 'and/or | cat', 'a slash mid-token is an ordinary character, not a regex opening');
eq(splitKeys('/unclosed,cat').join(' | '), '/unclosed | cat', 'a regex that never closes is split back up rather than left holding the comma');
eq(splitKeys('/a/,/b/').join(' | '), '/a/ | /b/', 'a regex straight after a comma is seen (upstream-st.md #17: core misses it)');
eq(splitKeys('a,,b\n\n').join(' | '), 'a | b', 'empty tokens are dropped, not kept as blanks');
eq(splitKeys('').length, 0, 'nothing in, nothing out');
console.log('ok   splitKeys: comma and newline separate; regexes and quoted terms keep their commas');


// --- keyHits: the Keyword Lab's rows — a key, then a row per hit, and a message for a key that can never fire
const rows = keyHits(['gagarin', '? (armstrong gagarin)', '? -banana', 'nobody'], space, false, true);
eq(rows.map(r => r.key).join(' | '), 'gagarin | \u21b3 | \u21b3 | ? (armstrong gagarin) | \u21b3 gagarin | \u21b3 armstrong | ? -banana | nobody',
    'every hit gets its own row under the key; a compound names the leaf that produced each');
eq(rows[0].count, 2, 'a plain key reports occurrences');
eq(rows[1].excerpt.at < rows[2].excerpt.at, true, 'the hit rows are in the order they occur in the text');
eq(rows[3].excerpt, undefined, 'the key row carries no excerpt of its own — the hit rows below it are the excerpts');
eq(rows[4].count, 2, 'a compound\'s leaf rows carry that leaf\'s own count');
eq(rows[6].count, undefined, 'a negation-only SmartKey is reported as unusable...');
eq(typeof rows[6].excerpt, 'string', '...by a message where the excerpt goes');
eq(rows[7].count, 0, 'a key that simply did not match is a zero, not an error');
eq(keyHits(['gagarin', '', '  armstrong  '], space, false, true).map(r => r.key).join(','), 'gagarin,\u21b3,\u21b3,armstrong',
    'blanks are dropped and keys trimmed; splitting the caller\'s text into keys is the caller\'s business');
console.log('ok   keyHits: a row per key and per hit, leaves named for compounds, a message for a key that cannot fire');


// --- matchWindow: a key is matched within its unit, and the offsets still land on the whole text
const paras = 'Russian cosmonaut Yuri Gagarin met the American astronaut Neil Armstrong.\n\nThe cosmonaut, hero of the Soviet Union, was vacationing.';
eq(textSegments(paras, 'paragraph').map(sg => sg.at).join(','), '0,75', 'a segment carries its offset into the whole text');
eq(textSegments(paras, 'scan').length, 1, 'any other window leaves the text whole');
eq(textSegments('   ', 'scan').length, 0, 'blank text has no segments to match in');
const win = w => keyHits(['? cosmonaut -astronaut'], paras, false, true, { matchWindow: w }).map(r => `${r.key}:${r.count ?? ''}`);
eq(win('scan').join(' '), '? cosmonaut -astronaut:0 \u21b3 cosmonaut:2 \u21b3 -astronaut:1',
    'across the whole text the negation kills it, and both sides say why');
eq(win('paragraph').join(' '), '? cosmonaut -astronaut:1 \u21b3 cosmonaut:1 \u21b3 -astronaut:0',
    'by paragraph it matches the one the astronaut is absent from, where the veto does not fire');
eq(paras.slice(...(sp => [sp.start, sp.end])(keySpans(['? cosmonaut -astronaut'], paras, false, true, { matchWindow: 'paragraph' })[0])), 'cosmonaut',
    'and marks it there');
eq(keySpans(['? cosmonaut -astronaut'], paras, false, true, { matchWindow: 'paragraph' }).map(sp => sp.start).join(), '79',
    'the span is offset onto the whole text, not the segment it was found in');
console.log('ok   matchWindow: keys match within their unit, spans are offset back onto the whole text');


// --- keySpans: where to mark the haystack itself — source offsets, in order, never overlapping
const spans = keySpans(['gagarin', '? (armstrong gagarin)', 'neil armstrong'], space, false, true);
eq(spans.map(sp => `${sp.key}@${sp.start}`).join(' '), 'gagarin@27 neil armstrong@64 gagarin@87',
    'overlapping matches become one span, at the extent of the one that starts first');
eq(spans[0].keys.map(k => k.key).join(' + '), 'gagarin + ? (armstrong gagarin)',
    'and that span names every key that reached it, for the tooltip');
eq(spans[1].keys.map(k => k.term ?? k.key).join(' + '), 'neil armstrong + armstrong',
    'a compound listed there names its leaf, not the whole key');
eq(space.slice(spans[1].start, spans[1].end), 'Neil Armstrong', 'the offsets index the text itself, not an excerpt');
eq(keySpans(['? (armstrong gagarin)'], space, false, true).map(sp => `${sp.term}@${sp.start}`).join(' '),
    'gagarin@27 armstrong@69', 'a compound names the leaf that produced each span');
console.log('ok   keySpans: source offsets for marking the haystack, ordered and disjoint');


// --- usedMatchSources: what a capture is allowed to freeze
{
    const SRC = {
        personaDescription: 'PERSONA', characterDescription: 'CARD', characterPersonality: 'PERS',
        characterDepthPrompt: 'DEPTH', scenario: 'SCEN', creatorNotes: 'NOTES',
    };
    const none = usedMatchSources(SRC, [{ uid: 1 }, { uid: 2 }]);
    eq(Object.keys(none).length, 0, 'no entry opts in, so a capture freezes none of the card or persona text');

    const one = usedMatchSources(SRC, [{ uid: 1 }, { uid: 2, matchScenario: true }]);
    eq(JSON.stringify(one), '{"scenario":"SCEN"}', 'one entry opting in pulls in THAT field and no other');

    const two = usedMatchSources(SRC, [{ uid: 1, matchPersonaDescription: true }, { uid: 2, matchScenario: true }]);
    eq(Object.keys(two).sort().join(','), 'personaDescription,scenario', 'each flag pulls its own field, across entries');

    eq(Object.keys(usedMatchSources({ scenario: '' }, [{ matchScenario: true }])).length, 0,
        'a flag naming an empty source freezes nothing — there is no text to have matched');
    eq(Object.keys(usedMatchSources(undefined, [{ matchScenario: true }])).length, 0, 'no sources at all is not a throw');
    eq(Object.keys(usedMatchSources(SRC, undefined)).length, 0, 'no entries at all is not a throw');

    const entry = { uid: 2, matchScenario: true, key: ['x'] };
    eq(JSON.stringify(withMatchSources(['chat'], entry, usedMatchSources(SRC, [entry]), 'scan')),
        JSON.stringify(withMatchSources(['chat'], entry, SRC, 'scan')),
        'a gated capture rebuilds the same window as the full source set');
}

// --- dropTags: a named element leaves with its CONTENT, and nothing else moves
{
    const MES = 'She waited.\n<internal_states>\nLocation: Big Sur\nPresent: Kyle, Mara\n</internal_states>\n<div style="border:1px solid">Kyle: are you there?</div>\nShe did not answer.';
    const out = dropTags(MES, 'internal_states');

    eq(countKey('Big Sur', MES, false, false), 1, 'the tracker fires the key before the strip');
    eq(countKey('Big Sur', out, false, false), 0, 'and not after — the content went with the tag');
    eq(countKey('Kyle', out, false, false), 1, 'the div survives: an unnamed tag is scene text, not bookkeeping');
    eq(out.includes('She waited.') && out.includes('She did not answer.'), true, 'prose either side is untouched');

    eq(dropTags(MES, ''), MES, 'empty spec is off, not a no-tag strip');
    eq(dropTags(MES, undefined), MES, 'no spec at all is not a throw');
    eq(dropTags('a<x>1</x>b<y>2</y>c', 'x, y'), 'abc', 'a comma/space list drops each named tag');
    eq(dropTags('a<x>1</x>b', 'x>'), 'ab', 'a tag pasted with its brackets still names the tag');
    eq(dropTags('a<x>1</x>b', '<>'), 'a<x>1</x>b', 'a spec with no tag name in it drops nothing');

    eq(dropTags('a<x>1<x>2</x>3</x>b', 'x'), 'ab', 'same-tag nesting: the inner close does not end the outer element');
    eq(dropTags('keep<x>gone', 'x'), 'keep', 'an unclosed tag runs to the end when it has no parent — presets write these blocks unclosed');
    eq(dropTags('a<x>1</x>b<x>gone', 'x'), 'ab', '...after any closed ones have already gone');

    eq(dropTags('<div>a<x>gone</div>keep', 'x'), '<div>a</div>keep', 'an unclosed tag stops at its parent, not at the end of the message');
    eq(dropTags('<div>a<x>gone<b>1</b>gone</div>keep', 'x'), '<div>a</div>keep', 'balanced tags inside the span do not end it');
    eq(dropTags('<div>a<x>gone<br>gone</div>keep', 'x'), '<div>a</div>keep', 'an unclosed void tag inside the span balances nothing and ends nothing');
    eq(dropTags('<div>a<x>gone</div>b<x>also gone', 'x'), '<div>a</div>b', 'a later copy of the same tag is its own element and gets its own verdict');
    eq(dropTags('<div>a<x>1</x>keep</div>', 'x'), '<div>akeep</div>', 'a tag that closes itself never consults its parent');
    eq(dropTags('a</x>b', 'x'), 'a</x>b', 'a stray close tag is left alone — a lone close makes no claim on any text');
    eq(dropTags('a<x/>b<x />c', 'x'), 'abc', 'the void form takes the tag and no content');
    eq(dropTags('a<xy>1</xy>b', 'x'), 'a<xy>1</xy>b', 'a tag name is matched whole: `x` is not `xy`');
    eq(dropTags('a<X ID="1">1</x>b', 'x'), 'ab', 'tag names are case-insensitive and attributes come along');
}
