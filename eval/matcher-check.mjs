// WA'S OWN MATCHER SEMANTICS — the half core has no opinion about.
//
// SmartKeys, what a matched expression is WORTH (scoring units, the saturation curve, weights), which
// keys the matcher refuses, and the excerpt machinery the Studio reads. Core gates activation and
// never scores, so none of this has anything to be faithful to.
//
// PARITY AND DIVERGENCE ARE core-matcher-check.mjs: whether an unaltered lorebook behaves under WA as
// it does under core, and the named places it deliberately does not. A claim that cites core as the
// authority belongs there, not here.
//
// countKey/keywordScore live in matcher.mjs, which is isomorphic — imported directly.
import { countKey, keyExcerpt, keyExcerpts, keywordScore as rankKeywordScore, repeatCurveOf, secondaryKeys, usableKeys, WI_LOGIC } from '../extension/matcher.mjs';
import { validateSmartKey } from '../extension/smartkeys.mjs';
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

// Secondary keys are VALIDATED like primaries, minus one code. A fatal key is dropped, so the gate
// loosens (all-dead secondaries are ungated, as blanks already were) instead of the malformed key
// poisoning the expression and killing every scan. `negation-only` is the exemption: a secondary
// never fires on its own — the primary gates activation — so "present unless X" is a condition an
// author can mean, and usableKeys must go on refusing the same shape as a primary. The exemption is
// itself exempted under AND_ANY, which is the block below; AND_ALL is used here so this one keeps
// testing the POSITION rule rather than the operator rule.
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const on = (sec, text, logic = 0) =>
        keywordScore({ key: ['cosmonaut'], keysecondary: sec, selectiveLogic: logic }, text, undefined, cfg).score > 0;

    eq(on(['? -gagarin'], 'the cosmonaut launched', 3), true, 'negation-only secondary: fires when the negated term is absent');
    eq(on(['? -gagarin'], 'cosmonaut gagarin waved', 3), false, '...and gates when it is present');
    eq(on(['? -gagarin', 'astronaut'], 'cosmonaut gagarin waved', 3), false, 'AND_ALL: the negation bites past a positive sibling');
    eq(on(['? -gagarin', 'astronaut'], 'cosmonaut astronaut', 3), true, '...and passes when both conditions hold');
    eq(usableKeys(['? -gagarin']).length, 0, 'the same key stays fatal as a PRIMARY');

    // AND_ALL is where the shape earns its keep: "both crews, but not Gagarin" — a positive secondary
    // and a negated one in the same list, which core has no way to write.
    const both = (text) => keywordScore(
        { key: ['astronaut'], keysecondary: ['cosmonaut', '? -gagarin'], selectiveLogic: 3 }, text, undefined, cfg).score > 0;
    eq(both('the astronaut met the cosmonaut'), true, 'AND_ALL: positive secondary present, negated one absent');
    eq(both('astronaut cosmonaut gagarin'), false, '...the negation still excludes');
    eq(both('the astronaut waited alone'), false, '...and the positive secondary is still required');

    // The three fatal shapes, each with the gate's terms present in the text: without the filter the
    // expression fails whatever the text says, so a passing score is what proves the key was dropped.
    eq(on(['? /[/'], 'the cosmonaut waited'), true, 'regex-invalid secondary is dropped, leaving the entry ungated');
    eq(on(['?   '], 'the cosmonaut waited'), true, 'no-terms secondary is dropped');
    eq(on(['? "moon', 'apollo'], 'cosmonaut apollo moon', 3), true, 'AND_ALL: a stray-quote sibling drops, the real one still gates');
    eq(on(['? "moon', 'apollo'], 'cosmonaut moon', 3), false, '...and the surviving secondary still has to match');
}

// WHAT A NEGATION-ONLY SECONDARY DOES DEPENDS ON THE OPERATOR, so AND_ANY is cut out of the tolerance.
// A negation is satisfied by ABSENCE and AND_ANY ORs its secondaries, so the branch is open on nearly
// any text: the gate stops gating, which is the same objection that makes the key fatal as a primary.
// The NOT_* pair keeps the tolerance — there the operator's own negation cancels the key's, turning it
// into a REQUIREMENT ("unless gagarin" reads "only when gagarin"), which is surprising but is a
// condition an author can mean and core cannot write.
//
// Pinned because nothing fails on its own if it drifts: the composition is CORRECT at every position
// (`NOT (NOT x)` is `x`), so the wrong answer here is a plausible one. The Studio makes the flip one
// click, and the chips look identical either side of it.
{
    const cfg = { k1: 1.2, caseSensitiveDefault: false, wholeWordsDefault: false };
    const on = (sec, logic, text) =>
        keywordScore({ key: ['cosmonaut'], keysecondary: sec, selectiveLogic: logic }, text, undefined, cfg).score > 0;
    const ABSENT = 'the cosmonaut waited', PRESENT = 'cosmonaut gagarin waved';

    // AND_ANY drops it, and dropping LOOSENS: a list that was nothing but negations leaves the entry
    // ungated, so BOTH texts pass. That is the direction the key was already pushing.
    eq(secondaryKeys({ keysecondary: ['? -gagarin'], selectiveLogic: 0 }).length, 0, 'AND_ANY drops a negation-only secondary');
    eq(on(['? -gagarin'], 0, ABSENT), true, '...leaving the entry ungated, so absence passes');
    eq(on(['? -gagarin'], 0, PRESENT), true, '...and so does presence — the key is gone, not inverted');

    // With a positive sibling the drop TIGHTENS, because the branch that was always open is gone and
    // the real key gates alone. This is the case the ban exists for.
    eq(secondaryKeys({ keysecondary: ['apollo', '? -gagarin'], selectiveLogic: 0 }).join(), 'apollo', 'the positive sibling survives alone');
    eq(on(['apollo', '? -gagarin'], 0, 'the cosmonaut waited'), false, 'AND_ANY: the surviving secondary gates, where the OR used to stand open');
    eq(on(['apollo', '? -gagarin'], 0, 'cosmonaut apollo'), true, '...and passes when it is satisfied');

    // AND_ALL keeps it: this is the narrowing the tolerance was written for.
    eq(on(['? -gagarin'], 3, ABSENT), true, 'AND_ALL: a negation-only secondary passes on absence');
    eq(on(['? -gagarin'], 3, PRESENT), false, '...and gates on presence');
    eq(on(['apollo', '? -gagarin'], 3, 'the cosmonaut waited'), false, '...and the positive sibling is still required');

    // The NOT pair keeps it too, inverted. Absence — the ordinary state of the text — now FAILS.
    eq(on(['? -gagarin'], 2, ABSENT), false, 'NOT_ANY: the operator negates the key again, so absence gates');
    eq(on(['? -gagarin'], 2, PRESENT), true, '...and the excluded term is now REQUIRED');
    eq(on(['? -gagarin'], 1, ABSENT), false, 'NOT_ALL: the same inversion');
    eq(on(['? -gagarin'], 1, PRESENT), true, '...and the same requirement');

    // The shape AND_ANY refuses is still writable — as ONE primary SmartKey, where the author reads
    // the OR they are asking for. The ban takes away an operator that produced it by accident, not
    // the ability to mean it: secondaries are synthesised into the primary's expression anyway, so
    // this is the same tree by the explicit route, and it validates clean because it has a positive
    // term. Which is also why `negation-only` here is a verdict about the BRANCH, not the expression.
    const explicit = '? cosmonaut && (apollo || -gagarin)';
    eq(validateSmartKey(explicit).length, 0, 'the explicit route validates clean');
    eq(countKey(explicit, 'the cosmonaut waited', false, false) > 0, true, '...and reproduces the branch AND_ANY no longer offers');
    eq(countKey(explicit, 'cosmonaut gagarin', false, false) > 0, false, '...negation and all');
}

eq(scored({ key: ['zzz'] }, 'alpha beta', ['alpha']), true, 'keywordScore honors explicit keys over entry.key');
eq(scored({ key: ['alpha'] }, 'alpha beta', ['zzz']), false, 'explicit keys with no hit score zero even when entry.key would match');
eq(scored({ key: ['alpha'] }, 'alpha beta'), true, 'defaults to entry.key when no list passed');
eq(scored({ key: ['alpha'] }, 'alpha beta', []), false, 'empty key list (blanked 🔗, option off) scores zero');
// A key WA calls fatally invalid scores nothing, the same rule stage 2 applies to activation. Only
// the Studio refuses to write one; core's WI editor and an imported book never ask, so the runtime
// is where it has to hold. `? -zebra` matches on absence, i.e. nearly always, so unfiltered it fed a
// full hit into the layout ranking of any entry that got in by some other route.
eq(keywordScore({ key: ['? -zebra', 'cosmonaut'] }, 'the cosmonaut waited').hits.map(h => h.key).join(','),
    'cosmonaut', 'a validator-error key is dropped from scoring, the valid one is not');
eq(scored({ key: ['? -zebra'] }, 'the cosmonaut waited'), false, 'an entry keyed only on error keys scores zero');
// SCORING UNITS. A key's score is the sum over the things it is ABOUT, each saturating on its own
// pooled occurrences (smartkeys.mjs `evaluate`). AND joins distinct things and their scores add; OR
// names one thing several ways and its mentions pool into a single saturation; a weight multiplies
// its unit rather than feeding the curve, so `::2` is twice as important rather than as-if-seen-twice.
//
// EVERY ROW HERE WAS A DEFECT before units. A stricter expression outscored its own left operand, a
// synonym group collected a saturation budget per spelling, and `::2` survived the curve as 1.38x.
// None of it was visible to a `score > 0` assertion, which is what the rest of this file mostly makes.
//
// Through this file's own `keywordScore` wrapper, so k1 is 2 here and `curve` says so — passing a cfg
// to that wrapper does nothing, which is how the first draft of this block silently scored at a k1 it
// was not comparing against.
{
    const sc = (key, text) => Number(keywordScore({ key: [key] }, text).score.toFixed(3));
    const curve = n => Number(repeatCurveOf(n, 2).toFixed(3));

    // PRESENCE IS THE UNIT. One matched thing is worth exactly its weight, whatever it is made of.
    eq(sc('? moon', 'moon'), 1, 'a matched expression is worth 1');
    eq(sc('moon', 'moon'), 1, '...and a plain key is the same expression');

    // AND: distinct things, so they ADD — and a conjunction no longer beats its own operand for free.
    eq(sc('? moon AND rocket', 'moon rocket launch'), 2, 'AND: two units, two things present');
    eq(sc('? moon AND rocket AND launch', 'moon rocket launch'), 3, '...three of them');
    eq(sc('? moon', 'moon rocket launch'), 1, '...against the same text, one thing is still worth one');

    // OR: one thing, several spellings — the mentions pool and saturate ONCE. The bare key is the
    // control: on equal evidence a synonym group must not out-earn the key it generalises.
    eq(sc('? (glasses OR spectacles)', 'glasses spectacles'), curve(2), 'OR pools its spellings into one unit');
    eq(sc('? glasses', 'glasses glasses'), curve(2), '...which is exactly what the bare key scores');
    eq(sc('? (glasses OR spectacles)', 'a glasses store called Spectacles, more glasses'), curve(3),
        'three mentions across two spellings is one thing seen three times');

    // WEIGHT MULTIPLIES THE UNIT, so a ratio the author wrote survives to the score.
    eq(sc('? (everest OR kailash::2)', 'Everest'), 1, 'the unweighted alternative is worth 1');
    eq(sc('? (everest OR kailash::2)', 'Kailash'), 2, '...and ::2 is worth exactly twice it');
    eq(sc('? (everest OR kailash::2) AND mount', 'Mount Everest'), 2, 'the conjunct adds its own unit');
    eq(sc('? (everest OR kailash::2) AND mount', 'Mount Kailash'), 3, '...to either alternative');

    // WEIGHT 0 IS A CONDITION, NOT EVIDENCE: no unit, and excluded from its group's mean rather than
    // averaged in — or a zero-weight sibling would quietly discount the term the author did mean.
    eq(sc('? moon AND rocket::0', 'moon rocket'), 1, 'a zero-weight conjunct gates without scoring');
    eq(sc('? (moon OR rocket::0)', 'moon rocket'), 1, '...and does not drag its group\'s mean down');

    // A matched expression carrying NO unit is still one hit — countKey's negation-only floor, which
    // keyUnits reproduces rather than re-deriving, or the two disagree about whether it scored. A
    // wholly zero-weighted key is the reachable case: negation-only is fatal in a primary (usableKeys
    // drops it before scoring), so it cannot be tested from here.
    eq(sc('? moon::0', 'moon'), 1, 'an all-zero-weight key that matches still counts as one');

    // THE TWO SYNTAXES MUST AGREE. keysecondary is rewritten into one expression per primary
    // (synthesizeSecondary), so the same logic written either way has to score the same — that
    // agreement is the whole reason the rewrite exists, and it held for the NOT logics only until
    // secondaries stopped being zero-weighted.
    const gated = (logic, sec, text) => Number(keywordScore(
        { key: ['cosmonaut'], keysecondary: sec, selectiveLogic: logic }, text).score.toFixed(3));
    const T = 'cosmonaut apollo soyuz';
    eq(gated(3, ['apollo'], T), sc('? cosmonaut AND apollo', T), 'AND_ALL agrees with the hand-written form');
    eq(gated(3, ['apollo', 'soyuz'], T), sc('? cosmonaut AND apollo AND soyuz', T), '...with two secondaries');
    eq(gated(0, ['apollo', 'soyuz'], T), sc('? cosmonaut AND (apollo OR soyuz)', T), 'AND_ANY agrees — its secondaries are one unit');
    eq(gated(2, ['gagarin'], T), sc('? cosmonaut AND NOT gagarin', T), 'NOT_ANY agrees, as it always did');
    eq(gated(2, ['gagarin'], T), 1, '...at the primary alone, because a NOT yields no unit');

    // Units pool ACROSS SEGMENTS, not just within one: the id is the AST node, interned per scope, so
    // the same unit in two segments is one unit seen twice. This is the plain-key rule generalised.
    eq(Number(keywordScore({ key: ['? (glasses OR spectacles)'] }, ['glasses', 'spectacles']).score.toFixed(3)),
        curve(2), 'a unit saturates once across the whole window');
}

// WHAT A MATCHED EXPRESSION IS WORTH. Core gates activation and never scores, so none of this is a
// core-parity claim — core-matcher-check.mjs holds those, and these two blocks lived there until the
// verdict and the count stopped agreeing.
//
// The values below are COUNTS (Σ weighted occurrences) and verdicts, both independent of k1, so they
// read the same here as they did beside the truth table.
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

    // A SECONDARY IS A TERM AND SCORES LIKE ONE. They were zeroed while AND and OR summed into one
    // count, where a contributing gate would have inflated the primary's; scoring units ended that —
    // a secondary is its own unit — and what the zeroing left behind was the same logic scoring
    // differently depending on which of WA's two syntaxes wrote it.
    //
    // ONLY THE AND LOGICS EVER SAW THIS: a NOT yields no unit whatever its operand weighs.
    eq(count('cosmonaut', ['apollo'], AND_ANY, 'cosmonaut and cosmonaut, with apollo'), 3,
        'the primary\'s two occurrences plus the secondary\'s one');
    eq(count('cosmonaut', ['apollo', 'soyuz'], AND_ALL, 'cosmonaut apollo soyuz'), 3,
        'two matched secondaries contribute their own occurrences');
    // COUNT AND SCORE ARE DIFFERENT QUESTIONS, and a weighted key is where they part: two terms
    // appeared once each, and the author's ::5 says what that is worth.
    eq(count('cosmonaut', ['? apollo::5'], AND_ALL, 'cosmonaut apollo'), 2,
        'count is occurrences: the primary once, the secondary once');
    eq(keyScore('cosmonaut', ['? apollo::5'], AND_ALL, 'cosmonaut apollo'), 6,
        '...and score carries the weight — a `?` secondary\'s ::5 is theirs to mean');
    eq(count('cosmonaut', ['gagarin'], NOT_ANY, 'cosmonaut soyuz'), 1,
        'an excluded secondary contributes nothing, as it never could');
    eq(count('? moon mission', ['apollo'], AND_ANY, 'a mission to the moon with apollo'), 3,
        'a spliced `?` primary keeps its own two terms, and the secondary adds its one');

    // A PASSED GATE IS `> 0`, NOT `>= 1`. A matched key is normally worth at least 1, so the two agree
    // almost everywhere — but a fractional `::weight` is documented (`? whisper::0.3` down-weights
    // rather than clamping), and two fractional sides total below 1 while having passed.
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

// OCCURRENCES -> SCORE (repeatCurveOf). k1 is the RATE repeats accrue at; the curve is the SHAPE, and
// they were one knob until the shape started mattering. 'bm25' is the classic tf term and what every
// stored capture ran under; 'presence-log' is what ships, and makes presence categorical so a matched
// key is worth its full weight with only the n-1 repeats accruing.
//
// PINNED AS A TABLE because the difference only shows at counts a synthetic test would not think to
// use. Foxbridge's busiest key reaches 10 and every curve looks alike there; sommers runs to 90, and
// across n=21..89 — 4.2x the evidence — bm25 moves 0.041 while presence-log moves 1.44. A regression
// that flattened the tail again would pass every other assertion in this file.
{
    const at = (n, c, R = 1) => Number(repeatCurveOf(n, 1.2, c, R).toFixed(3));

    eq(at(1, 'bm25'), 0.455, 'bm25: a key present once is worth less than half a saturated one');
    eq(at(1, 'presence-log'), 1, 'presence-log: present once is worth exactly the key\'s weight');
    eq(at(1, 'presence'), 1, '...as it is under the bounded form');
    eq(repeatCurveOf(0, 1.2, 'presence-log'), 0, 'absent is 0 under every curve');
    eq(repeatCurveOf(0, 1.2, 'bm25'), 0, '...including bm25');

    // The tail, which is the whole reason the default moved. Real counts from the sommers scenes.
    eq(at(21, 'bm25'), 0.946, 'bm25 at n=21');
    eq(at(89, 'bm25'), 0.987, '...and at n=89, having moved 0.041 over 4.2x the evidence');
    eq(at(21, 'presence'), 1.943, 'the BOUNDED presence form is just as flat at n=21');
    eq(at(89, 'presence'), 1.987, '...and at n=89 — fixing the floor does nothing for the ceiling');
    eq(at(21, 'presence-log'), 3.872, 'presence-log at n=21');
    eq(at(89, 'presence-log'), 5.309, '...and at n=89, still separating them');

    // R is reach, k1 is rate, and they are independent — one knob could express neither alone.
    eq(at(20, 'presence', 1) < at(20, 'presence', 2), true, 'R raises what repeats may add');
    eq(repeatCurveOf(1, 1.2, 'presence', 5), 1, '...and never touches presence itself');
    eq(Number(repeatCurveOf(3, 0.5, 'presence-log').toFixed(3)) > at(3, 'presence-log'), true,
        'a lower k1 accrues repeats faster');
    eq(at(1, 'presence-log') === at(1, 'presence'), true, 'the curves differ only once there is a repeat');

    // Bounded means bounded: presence can never exceed 1+R, log has no ceiling at all.
    eq(at(100000, 'presence', 1) < 2.001, true, 'presence R=1 is capped at 2x');
    eq(at(100000, 'presence-log') > 10, true, 'presence-log is not capped');

    // The default is what ships (state.mjs), so an omitted curve is not silently the old one.
    eq(repeatCurveOf(5, 1.2), repeatCurveOf(5, 1.2, 'presence-log'), 'the default curve is the shipped curve');
}

eq(countKey('? -zebra', 'the cosmonaut waited', false, false), 1,
    'countKey itself is unfiltered — it answers what the expression does, and the filter is the caller\'s');


// keyExcerpt — the /wa-grade "why did this pop" display. It shares countKey's machinery but is
// display-only: called for keys countKey already counted, so these pin (a) agreement with countKey
// on WHERE, and (b) the substring surface form an author needs for tuning, marked «so».
eq(keyExcerpt('thread', 'the curtains were threadbare by then', false, false),
    'the curtains were «thread»bare by then', 'substring: excerpt shows the containing word');
eq(keyExcerpt('thread', 'the curtains were threadbare by then', false, true),
    null, 'whole-word: same text correctly yields no excerpt (countKey counts 0)');
// THE EXCERPT IS THE SOURCE TEXT, the match is found in the folded one. Both of these pinned the old
// behaviour, where the author was shown a lowercased, re-punctuated sentence they never wrote and asked
// to judge a key against it. Case and typography now survive; the mark still lands on the right span,
// which is the part that could break, since folding shifts every offset after it.
eq(keyExcerpt('sister', "She's my *sister*, Tim", false, true),
    "She's my *«sister»*, Tim", 'whole-word: excerpt keeps the source casing');
eq(keyExcerpt("Cap'n", `A ${'Cap’n'} walks in`, false, false),
    `A «${'Cap’n'}» walks in`, 'orthography: a straight-quote key marks the curly-quote source it matched');
// The offsets after a length-CHANGING fold are the case that made this hard: — folds to two characters
// and … to three, so a naive folded index lands mid-word in the source.
eq(keyExcerpt('rut', 'the RUT began… pre-RUT nerves', false, false),
    'the «RUT» began… pre-RUT nerves', 'a fold that lengthens earlier text does not shift the mark');
eq(keyExcerpt('nerves', 'a — b … c nerves here', false, false),
    'a — b … c «nerves» here', 'em-dash and ellipsis before the match keep it correctly placed');
// COMBINING MARKS were the case that broke it in the browser: the fold NFC-composes over the whole
// string, so "e + ́" is two characters before and one after. A per-character walk cannot reproduce that,
// and every offset past the first such sequence drifted — a hit on `knots` rendered as `H«e kno»ts`.
eq(keyExcerpt('knots', 'Cafe\u0301 and Nai\u0308ve. He knots the rope', false, false),
    'Café and Naïve. He «knots» the rope', 'decomposed accents before the match do not shift it');
// The delimiters are not in the data: an entry with guillemets of its own used to mark the wrong span,
// because the reader stopped at the first closing one.
const own = keyExcerpts('rut', 'she said «no rut» today', false, false)[0];
eq(own.text.slice(own.start, own.end), 'rut', 'offsets select the match even when the source has guillemets');
// A REGEX runs on the raw segment, so its offsets are already source offsets. Mapping them back through
// the fold a second time — as the literal paths must — dragged the mark left by one per em-dash and two
// per ellipsis before the match, which is how `/knot(s|ting)?/` over RP prose rendered as `« He k»nots`.
// NFC IS THE ONE FOLD A REGEX GETS. Decomposed text is the same characters differently encoded, and no
// spelling of a pattern covers both forms — unlike case (/i) and orthography (['’]), where the author has
// an escape. Everything else stays raw, or a pattern written against real text stops working.
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
eq(keyExcerpt('? thread & curtains', 'threadbare curtains', false, false),
    null, 'smartkey: no excerpt — a SmartKey is not a substring');
eq(keyExcerpt('ghost', 'no such word here', false, false), null, 'no match, no excerpt');
eq(keyExcerpt('bare', ['first segment', 'the threadbare one'], false, false),
    'the thread«bare» one', 'segments: later segment searched when earlier ones miss');
console.log('ok   keyExcerpt: localises what countKey counted, folded-haystack display, smartkeys excluded');
