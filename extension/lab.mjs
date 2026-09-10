// lab.mjs — the Keyword Lab's model: a text against a typed key list, or against a book's entries. ST-free; the Studio
// injects the settings.

import { keyHits, keySpans, mergeSpans, secondaryKeys, splitKeys, usableKeys, WI_LOGIC } from './matcher.mjs';

/** An entry's secondary condition as `keyHits`/`keySpans` take it, or undefined when it has none. Blank secondaries are
 *  dropped and `selective` is read: core ignores keysecondary without it. */
export const entryGate = (entry) => {
    const keys = entry?.selective ? secondaryKeys(entry).map(k => String(k ?? '').trim()).filter(Boolean) : [];
    return keys.length ? { keys, logic: Number(entry.selectiveLogic ?? WI_LOGIC.AND_ANY) } : undefined;
};

/** An entry's match flags with the caller's defaults filled in. Nullish, not falsy: `caseSensitive: false` is authored. */
export const entryFlags = (entry, { caseSensitive = false, wholeWords = false } = {}) => ({
    caseSensitive: entry?.caseSensitive ?? caseSensitive,
    wholeWords: entry?.matchWholeWords ?? wholeWords,
});

/** `{ entries: [{ entry, rows }], scanned, books, keyList }` for the entries of `entries` whose keys hit `text`, each under
 *  its own gate and flags. Skips `disable`, and `vectorized` when `skipVectorized` — core keyword-matches those. Models no
 *  other gate core applies: probability, inclusion groups, delay, cooldown, character and tag filters, decorators,
 *  recursion. `scanned` counts the entries tested, `books` their worlds, `keyList` their hit keys deduped. */
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

/** A run's spans over `text`, merged across its entries in one pass. Per-entry merging would leave two spans on a word two
 *  entries both hit, which cannot nest in markup. */
export function runSpans(run, text, { matchWindow = 'scan', defaults } = {}) {
    return mergeSpans((run?.entries ?? []).flatMap(({ entry }) => {
        const { caseSensitive, wholeWords } = entryFlags(entry, defaults);
        return keySpans(usableKeys(entry.key), text, caseSensitive, wholeWords, { matchWindow, gate: entryGate(entry) });
    }));
}

/** `{ keys, rows, gate, spans }` for either mode. With `run` set, `rows` is empty (a run's rows are per entry, on the run)
 *  and `gate` is null (each entry carries its own). Both fields are present either way: a caller destructures one shape. */
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
