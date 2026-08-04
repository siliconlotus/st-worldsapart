// Bucket 2 rests on ONE claim: core's `(key, keysecondary, selectiveLogic)` can be rewritten as a
// SmartKey query that fires in exactly the same places. It was verified once, by a harness that no
// longer exists, and everything else load-bearing from that era turned out to be wrong at least once
// before it was checked. So: fuzz the synthesis against secondaryOk, which is core's semantics.
//
// The comparison is per PRIMARY key, because that is how the rewrite works — one query per primary,
// not one per entry — so the expected answer is `this key matches AND the secondary condition holds`.
import { countKey, secondaryOk, WI_LOGIC } from '../extension/ranking.mjs';
import { synthesizeSecondary } from '../extension/smartkeys.mjs';
import { eq } from './metrics.mjs';

const LOGICS = [WI_LOGIC.AND_ANY, WI_LOGIC.NOT_ALL, WI_LOGIC.NOT_ANY, WI_LOGIC.AND_ALL];
const NAMES = { 0: 'AND_ANY', 1: 'NOT_ALL', 2: 'NOT_ANY', 3: 'AND_ALL' };

// Deliberately awkward: a phrase (would be a conjunction unquoted), a leading hyphen (a negation), a
// paren, a word that is an operator, and one that is a substring of another.
const WORDS = ['apollo', 'soyuz', 'hot tub', '-cosmonaut', 'fire(', 'AND', 'ver', 'clever', 'Cap’n', 'café'];
const FRAGMENTS = ['apollo', 'soyuz landed', 'a hot tub', 'cosmonaut', 'fire(1)', 'AND', 'never', 'clever', "Cap'n", 'cafe', 'nothing here'];

let seed = 20260804;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = a => a[Math.floor(rnd() * a.length)];

let trials = 0, mismatches = [];
for (let i = 0; i < 16000; i++) {
    const primary = pick(WORDS);
    const secondaries = Array.from({ length: Math.floor(rnd() * 4) }, () => pick(WORDS));
    const logic = pick(LOGICS);
    const text = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(FRAGMENTS)).join(' ');

    const query = synthesizeSecondary(primary, secondaries, logic);
    if (query === null) continue;   // declines to express it; the caller falls back, nothing to compare
    trials++;

    const expected = countKey(primary, text, false, false) > 0
        && secondaryOk({ keysecondary: secondaries, selectiveLogic: logic }, text, false, false);
    const actual = countKey(query, text, false, false) > 0;
    if (expected !== actual && mismatches.length < 5) {
        mismatches.push({ primary, secondaries, logic: NAMES[logic], text, query, expected, actual });
    }
}

if (mismatches.length) {
    for (const m of mismatches) console.log('FAIL mismatch', JSON.stringify(m));
}
eq(mismatches.length, 0, `synthesis agrees with core's selective logic over ${trials} random comparisons`);
eq(trials > 10000, true, `enough of the fuzz was expressible to mean something (${trials})`);

// The cases it must REFUSE rather than approximate — a caller that treats null as "no secondaries"
// would silently drop the gate, which is the one failure worse than falling back.
eq(synthesizeSecondary('say "hi"', ['a'], 0), null, 'a quote in a key has no escape in this grammar');
eq(synthesizeSecondary('k', ['say "hi"'], 0), null, '...on either side');
eq(synthesizeSecondary('/re/', ['a'], 0), null, 'a regex key is a different matcher, not a term');
eq(synthesizeSecondary('? q', ['a'], 0), null, '...and so is a query');
eq(synthesizeSecondary('k', ['/re/'], 0), null, '...on either side, again');

// Blank secondaries are dropped before the logic runs, exactly as secondaryOk does, so an entry whose
// secondaries are all whitespace is ungated rather than impossible.
eq(synthesizeSecondary('k', ['', '   '], WI_LOGIC.AND_ALL), '? "k"', 'blank secondaries drop out');
{
    const text = 'k and nothing else';
    const e = { keysecondary: ['', '  '], selectiveLogic: WI_LOGIC.NOT_ANY };
    eq(countKey(synthesizeSecondary('k', e.keysecondary, e.selectiveLogic), text, false, false) > 0,
        secondaryOk(e, text, false, false) && countKey('k', text, false, false) > 0,
        '...and agree with core about it');
}

console.log(`ok   keysecondary synthesis matches core's selective logic (${trials} comparisons)`);
