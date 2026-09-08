// automaton.mjs — the Aho-Corasick literal matcher and the text fold it matches on. No imports; shared by the
// extension (via smartkeys.mjs) and the server plugin. One copy, or the browser and the server disagree.

const APOSTROPHES = /[‘’‚‛ʼʹ´`′‹›]/g;
const DOUBLE_QUOTES = /[“”„‟″ʺ«»]/g;
const COMBINING = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/;

/** Orthography without case: apostrophe and quote variants, dashes, ellipsis, NBSP, NFC. Never anything that can carry meaning (a hyphen against a space); 《》 and 「」 stay out, they partition what " collapses (K10). */
export const normalizeOrthography = s => {
    s = String(s ?? '');
    if (COMBINING.test(s)) s = s.normalize('NFC');
    return s
        .replace(APOSTROPHES, "'")
        .replace(DOUBLE_QUOTES, '"')
        // An em-dash is TWO hyphens and an en-dash one; they must not collapse together.
        .replace(/—/g, '--')
        .replace(/–/g, '-')
        .replace(/…/g, '...')
        .replace(/ /g, ' ');
};

/** The one fold every match uses; registry, scan and fallback all go through it or they silently disagree. */
export const fold = s => normalizeOrthography(s).toLowerCase();

/** Aho-Corasick automaton over folded literals: `{next, fail, out, len}`. */
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

/** NON-overlapping occurrences per pattern present, greedy left-to-right — parity with countKey's indexOf loop ("aa" in "aaa" counts once). */
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

/** Adds one hit per pattern PRESENT in `text` to `totals`: messages containing, never occurrences, which anything compared against a message total must count. */
export function addMessageHits(aut, text, totals) {
    for (const [i] of scanAutomaton(aut, fold(text))) totals.set(i, (totals.get(i) ?? 0) + 1);
}
