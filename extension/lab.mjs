// lab.mjs — the Keyword Lab's model: what a haystack yields for a typed key list or for a book applied to it.
// ST-free and node-importable; the Studio supplies the settings and does the drawing.

import { keyHits, keySpans, mergeSpans, secondaryKeys, splitKeys, usableKeys, WI_LOGIC } from './matcher.mjs';

/** The secondary condition an entry gates its keys by, or undefined when it has none. */
export const entryGate = (entry) => {
    const keys = entry?.selective ? secondaryKeys(entry).map(k => String(k ?? '').trim()).filter(Boolean) : [];
    return keys.length ? { keys, logic: Number(entry.selectiveLogic ?? WI_LOGIC.AND_ANY) } : undefined;
};

/** An entry's resolved match flags: its own where it has them, else the defaults (ST's globals, which the caller reads). */
export const entryFlags = (entry, { caseSensitive = false, wholeWords = false } = {}) => ({
    caseSensitive: entry?.caseSensitive ?? caseSensitive,
    wholeWords: entry?.matchWholeWords ?? wholeWords,
});

/** Which of `entries` the text would activate on keys alone, with what. Disabled entries are out, as core has them; every
 *  other gate core applies — probability, inclusion groups, delay, cooldown, character and tag filters, decorators,
 *  recursion — is not modelled, so this is the keyword half of activation and not a prediction. `keyList` is the run's
 *  distinct keys, which is what a caller colours by: one key two entries both found is one term.
 *
 *  `skipVectorized` leaves out the entries meant to arrive by cosine. Core keyword-matches them like any other, so this is
 *  the reader's question — am I tuning keys or looking at everything — and not a correctness rule. */
export function runBook(entries, text, { matchWindow = 'scan', context = 28, defaults, skipVectorized = false } = {}) {
    const keyed = (entries ?? [])
        .filter(e => e && !e.disable && usableKeys(e.key).length)
        .filter(e => !(skipVectorized && e.vectorized));
    const hits = [];
    for (const entry of keyed) {
        const { caseSensitive, wholeWords } = entryFlags(entry, defaults);
        const rows = keyHits(usableKeys(entry.key), text, caseSensitive, wholeWords,
            { context, matchWindow, gate: entryGate(entry) }).filter(r => r.count > 0);
        if (rows.length) hits.push({ entry, rows });
    }
    return {
        entries: hits,
        scanned: keyed.length,
        books: [...new Set(keyed.map(e => e.world).filter(Boolean))],
        keyList: [...new Set(hits.flatMap(h => h.rows.map(r => r.key)))],
    };
}

/** Where a run's entries landed in `text`, folded once over the union: each entry is matched under its own flags, so a word
 *  two of them found is one span naming both rather than two spans nested in the markup. */
export function runSpans(run, text, { matchWindow = 'scan', defaults } = {}) {
    return mergeSpans((run?.entries ?? []).flatMap(({ entry }) => {
        const { caseSensitive, wholeWords } = entryFlags(entry, defaults);
        return keySpans(usableKeys(entry.key), text, caseSensitive, wholeWords, { matchWindow, gate: entryGate(entry) });
    }));
}

/** The Lab's result, in one shape whichever mode it is in: `keys` to colour by, `rows` for a typed list (a run's rows hang
 *  off the run itself, per entry), `gate` as the panes have it, and `spans` to mark the text with. */
export function labScan({ hay = '', keys = '', sec = '', logic = WI_LOGIC.AND_ANY, matchWindow = 'scan',
    caseSensitive = false, wholeWords = false, context = 28, run = null, defaults } = {}) {
    if (run) {
        return { keys: run.keyList, rows: [], gate: null, spans: runSpans(run, hay, { matchWindow, defaults }) };
    }
    const keyList = splitKeys(keys);
    const gate = { keys: splitKeys(sec), logic: Number(logic) };
    return {
        keys: keyList,
        rows: keyHits(keyList, hay, caseSensitive, wholeWords, { context, matchWindow, gate }),
        gate,
        spans: keySpans(keyList, hay, caseSensitive, wholeWords, { matchWindow, gate }),
    };
}
