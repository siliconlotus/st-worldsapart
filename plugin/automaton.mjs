// automaton.mjs — the Aho-Corasick literal matcher and the text fold it matches on. Pure, no imports,
// and SHARED BY BOTH SIDES: the extension's smartkeys.mjs re-exports it for keyword matching, and the
// server plugin uses it to scan chat histories without shipping them to the browser.
//
// It lives under plugin/ because that is the half that gets deployed, and the extension can import across
// but not the reverse. Duplicating it was the alternative and would have been the same mistake CLAUDE.md
// records for countKey: two copies of a matcher drift, and the drift surfaces as a scoring difference
// nobody can trace back.

/** Apostrophe variants that authors and models mix freely: right/left single quotes, the modifier
 *  letter apostrophe, prime, acute and grave. All collapse to ASCII ' before matching. */
const APOSTROPHES = /[‘’ʼ´`′]/g;
/** Typographic double quotes. A key field takes the straight one; prose arrives typeset. */
const DOUBLE_QUOTES = /[“”]/g;

/**
 * Normalises ORTHOGRAPHY without touching case: the same character in a different encoding.
 *
 * WHY THIS EXISTS. A key written "Cap'n Joe" never matched prose written "Cap’n Joe", and nothing
 * surfaced it — the key simply never fired. Models emit typographic apostrophes constantly, so a key typed
 * with a straight one silently dies against chat as well as against entry text. Measured on real books:
 * 2 of 3 apostrophe-bearing keys in one, 2 of 84 in another, mismatched in BOTH directions.
 *
 * The same argument covers every other form here, and the counts are larger. Over 512 MB of chat:
 * em-dash 729,692, curly doubles 93,065, curly singles 87,665, ellipsis 7,215, en-dash 2,230,
 * non-breaking space 57.
 *
 * STRICTLY ORTHOGRAPHY, and that boundary is the whole point. None of these rewrites can destroy a
 * distinction anyone means, because nobody means anything different by a curly apostrophe. Anything
 * that CAN carry meaning — a hyphen against a space, a case difference — does not belong here: folding
 * it into the scan text erases it for every key at once, and no flag can ask for it back, because the
 * damage was done to the haystack. Case gets away with it only because `^` exists to opt out.
 *
 * NOT included, measured absent from that corpus: combining diacritics (0, and the text is already
 * NFC), zero-width characters (0), ligatures (0), U+2212 minus (0), angle and low quotes (0).
 */
export const normalizeOrthography = s => String(s ?? '')
    .replace(APOSTROPHES, "'")
    .replace(DOUBLE_QUOTES, '"')
    // An em-dash's ASCII form is TWO hyphens; an en-dash's is one. They must not collapse together —
    // the em-dash separates clauses and the en-dash joins, so a key meaning one must not match the other.
    .replace(/—/g, '--')
    .replace(/–/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');

/**
 * The one folding used for every match: orthography-normalised and case-folded.
 *
 * MUST be the only fold. countKey short-circuits on a 0 from the automaton (`if (cached === 0) return 0`),
 * so normalising the naive walk alone would change nothing — the trie would still report a miss and return
 * before the walk ran. Registry, scan and fallback all go through here or they silently disagree.
 */
export const fold = s => normalizeOrthography(s).toLowerCase();

/**
 * Pass 1 — Aho-Corasick automaton over the case-folded literals of every registered term.
 * One scan of the text yields the set of terms present as substrings; per-key evaluation
 * then never re-walks the text (except to verify =/^ flags on candidate terms).
 * @param {string[]} patterns Case-folded literals
 * @returns {{next: Map[], fail: number[], out: Set[]}}
 */
export function buildAutomaton(patterns) {
    const next = [new Map()], fail = [0], out = [new Set()];
    for (let p = 0; p < patterns.length; p++) {
        let node = 0;
        for (let i = 0; i < patterns[p].length; i++) {
            const ch = patterns[p][i];
            if (!next[node].has(ch)) {
                next[node].set(ch, next.length);
                next.push(new Map()); fail.push(0); out.push(new Set());
            }
            node = next[node].get(ch);
        }
        out[node].add(p);
    }
    // Failure links, breadth-first: fail[v] is the longest proper suffix of v's path that is
    // also a path in the trie; outputs propagate along it so nested patterns still report.
    const queue = [...next[0].values()];
    while (queue.length) {
        const u = queue.shift();
        for (const [ch, v] of next[u]) {
            queue.push(v);
            let f = fail[u];
            while (f !== 0 && !next[f].has(ch)) f = fail[f];
            fail[v] = next[f].get(ch) ?? 0;
            for (const o of out[fail[v]]) out[v].add(o);
        }
    }
    return { next, fail, out, len: patterns.map(p => p.length) };
}

/**
 * Scans case-folded text through the automaton, counting NON-overlapping occurrences per
 * pattern (greedy left-to-right) — exact parity with countKey's indexOf loop, where "aa"
 * in "aaa" counts once.
 * @returns {Map<number, number>} pattern index -> occurrence count (present patterns only)
 */
export function scanAutomaton(aut, foldedText) {
    const counts = new Map();
    const lastEnd = new Map();
    let node = 0;
    for (let i = 0; i < foldedText.length; i++) {
        const ch = foldedText[i];
        while (node !== 0 && !aut.next[node].has(ch)) node = aut.fail[node];
        node = aut.next[node].get(ch) ?? 0;
        for (const p of aut.out[node]) {
            if (i - aut.len[p] + 1 > (lastEnd.get(p) ?? -1)) {
                counts.set(p, (counts.get(p) ?? 0) + 1);
                lastEnd.set(p, i);
            }
        }
    }
    return counts;
}
