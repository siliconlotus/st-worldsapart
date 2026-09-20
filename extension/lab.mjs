// lab.mjs — the Key Lab's model: a text against a typed key list, or against a book's entries. ST-free; the Studio
// injects the settings.

import { dropTags, keyHits, keySpans, mergeSpans, scanSegments, secondaryKeys, splitKeys, usableKeys, WI_LOGIC } from './matcher.mjs';
import { getMacros, setMacros } from './smartkeys.mjs';

/** `fn(text, at)` over each part under its own macro map, or once over `hay` under the map in force; always a list. A part is
 *  `{ text, at, macros }`, `at` its offset into the joined text the caller shows. */
const perPart = (parts, hay, fn) => {
    if (!parts?.length) return [fn(hay, 0)];
    const was = getMacros();   // put back after: a parts scan must not leave a part's map in force for the next caller
    try { return parts.map(p => { setMacros(p.macros ?? {}); return fn(String(p.text ?? ''), Number(p.at) || 0); }); } finally { setMacros(was); }
};
const shiftSpans = (spans, at) => (at ? spans.map(sp => ({ ...sp, start: sp.start + at, end: sp.end + at, keys: (sp.keys ?? []).map(k => ({ ...k, start: k.start + at, end: k.end + at })) })) : spans);
const shiftRows = (rows, at) => (at ? rows.map(r => ({ ...r, segments: r.segments.map(sg => ({ ...sg, at: sg.at + at })) })) : rows);
const byStart = (a, b) => a.start - b.start;
/** Several parts' rows as one list: per key, counts summed and segments concatenated in part order. */
const mergeRows = lists => {
    const byKey = new Map();
    for (const rows of lists) for (const r of rows) {
        const m = byKey.get(r.key);
        if (!m) byKey.set(r.key, { ...r, segments: [...r.segments] });
        else { m.count = (m.count ?? 0) + (r.count ?? 0); m.segments.push(...r.segments); }
    }
    return [...byKey.values()];
};

/** An entry's secondary condition as `keyHits`/`keySpans` take it, or undefined when it has none. Blank secondaries are
 *  dropped and `selective` is read: core ignores keysecondary without it. */
export const entryGate = (entry) => {
    // secondaryKeys owns the rule (`selective === false` ignores the list, an absent field keeps core's default); reading
    // the flag again here made the Lab show a gate the runtime applies as un-gated.
    const keys = secondaryKeys(entry).map(k => String(k ?? '').trim()).filter(Boolean);
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
export function runBook(entries, text, { matchWindow = 'scan', context = 28, defaults, skipVectorized = false, override = {}, parts } = {}) {
    if (parts?.length) {
        // Each part under its own map, then one run: an entry's rows merged per key, the tallies those of one scan.
        const runs = perPart(parts, text, (t, at) => {
            const r = runBook(entries, t, { matchWindow, context, defaults, skipVectorized, override });
            return { ...r, entries: r.entries.map(h => ({ entry: h.entry, rows: shiftRows(h.rows, at) })) };
        });
        const hits = new Map();
        for (const r of runs) for (const h of r.entries) {
            const prev = hits.get(h.entry);
            if (prev) prev.rows = mergeRows([prev.rows, h.rows]); else hits.set(h.entry, { entry: h.entry, rows: h.rows });
        }
        const out = [...hits.values()];
        return { entries: out, scanned: runs[0].scanned, books: [...new Set(runs.flatMap(r => r.books))], keyList: [...new Set(out.flatMap(h => h.rows.map(r => r.key)))] };
    }
    const keyed = (entries ?? [])
        .filter(e => e && !e.disable && usableKeys(e.key).length)
        .filter(e => !(skipVectorized && e.vectorized));
    const hits = [];
    for (const entry of keyed) {
        // `override` is the Lab's boxes over every entry's own flags, per flag, so on and off compare on one run.
        const { caseSensitive, wholeWords } = { ...entryFlags(entry, defaults), ...override };
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
export function runSpans(run, text, { matchWindow = 'scan', defaults, override = {}, parts } = {}) {
    const one = (t, at) => shiftSpans(mergeSpans((run?.entries ?? []).flatMap(({ entry }) => {
        const { caseSensitive, wholeWords } = { ...entryFlags(entry, defaults), ...override };
        return keySpans(usableKeys(entry.key), t, caseSensitive, wholeWords, { matchWindow, gate: entryGate(entry) });
    })), at);
    return perPart(parts, text, one).flat().sort(byStart);
}

/** `{ keys, rows, gate, spans }` for either mode. With `run` set, `rows` is empty (a run's rows are per entry, on the run)
 *  and `gate` is null (each entry carries its own). Both fields are present either way: a caller destructures one shape. */
export function labScan({ hay = '', keys = '', sec = '', logic = WI_LOGIC.AND_ANY, matchWindow = 'scan',
    caseSensitive = false, wholeWords = false, context = 28, run = null, defaults, override = {}, parts } = {}) {
    if (run) {
        return { keys: run.keyList, rows: [], gate: null, spans: runSpans(run, hay, { matchWindow, defaults, override, parts }) };
    }
    const keyList = splitKeys(keys);
    const gate = { keys: splitKeys(sec), logic: Number(logic) };
    return {
        keys: keyList,
        rows: mergeRows(perPart(parts, hay, (t, at) => shiftRows(keyHits(keyList, t, caseSensitive, wholeWords, { context, matchWindow, gate }), at))),
        gate,
        spans: perPart(parts, hay, (t, at) => shiftSpans(keySpans(keyList, t, caseSensitive, wholeWords, { matchWindow, gate }), at)).flat().sort(byStart),
    };
}

/** `sg`'s window text with every hit in it guillemeted, «so» for a positive and »so« for a negative, for a title
 *  attribute, which takes no markup. Over 320 characters it is clipped to 110 either side of `ex`. */
export function windowTip(sg, ex) {
    const src = String(sg.text ?? '');
    const wide = src.length > 320;
    const from = wide ? Math.max(0, ex.at - 110) : 0;
    const to = wide ? Math.min(src.length, ex.to + 110) : src.length;
    let out = '', at = from;
    for (const x of [...sg.excerpts].sort((a, b) => a.at - b.at)) {
        if (x.at < from || x.to > to) continue;
        const [open, close] = x.negated ? ['»', '«'] : ['«', '»'];
        out += `${src.slice(at, x.at)}${open}${src.slice(x.at, x.to)}${close}`;
        at = x.to;
    }
    out = `${out}${src.slice(at, to)}`.replace(/\s+/g, ' ').trim();
    return `${from > 0 ? '…' : ''}${out}${to < src.length ? '…' : ''}`;
}

/** One chat's messages as WA reads them for a scan: cut at `end` (a MESSAGE ID, so on the raw list, hidden messages
 *  counted), is_system dropped, dropChatTags applied, then segmented to `depth`. `hidden` is what the cut held back. */
export function labMessages(full, { depth, end = -1, dropSpec = '', includeNames = false } = {}) {
    const raw = end >= 0 ? (full ?? []).slice(0, end + 1) : (full ?? []);
    const chat = raw.filter(m => m && !m.is_system)
        .map(m => (dropSpec?.trim() ? { ...m, mes: dropTags(String(m.mes ?? ''), dropSpec) } : m));
    return {
        messages: scanSegments(chat, { depth, includeNames, matchWindow: 'message' }),
        hidden: raw.length - chat.length,
    };
}
