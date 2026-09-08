// matcher.mjs — countKey and everything a match verdict rests on: the fold, boundaries, regex keys, SmartKeys
// dispatch, secondary keys, the scan window, stage-2 activation. ST-free; core parity is asserted in core-matcher-check, worth in matcher-check.

import { cachedCount, evaluateAst, evaluateSmartKey, fold, normalizeOrthography, parse, primeScan, synthesizeSecondary, tokenize, validateSmartKey } from './smartkeys.mjs';

export function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The word-character class whole-word matching uses; never `\w`, which is ASCII-only. Needs the `u` flag. */
const BOUNDARY_CLASSES = {
    permissive: '[\\p{L}\\p{N}\\p{M}]',
    strict: '[\\p{L}\\p{N}\\p{M}\\-\'’]',
};
let boundaryMode = 'strict';

/** Injects the resolved `wordBoundary` setting. Object.hasOwn, not `in`: 'constructor' would resolve wordChar() to a Function. */
export const setBoundaryMode = mode => { boundaryMode = Object.hasOwn(BOUNDARY_CLASSES, mode) ? mode : 'strict'; };

export const wordChar = () => BOUNDARY_CLASSES[boundaryMode];

/** Whole-word assertions: the neighbour is not a word character, or is `--` (a folded dash). Zero-width: run under `g` to count, and keyExcerpts reads the offsets. */
export const boundaryBefore = () => `(?:(?<!${wordChar()})|(?<=--))`;
export const boundaryAfter = () => `(?:(?!${wordChar()})|(?=--))`;

/** Scripts written without word separators, in test order: kana before Han, so a Japanese key is named Japanese. */
const SPACELESS_SCRIPTS = [
    ['Japanese', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
    ['Chinese', /\p{Script=Han}/u],
    ['Thai', /\p{Script=Thai}/u],
    ['Lao', /\p{Script=Lao}/u],
    ['Khmer', /\p{Script=Khmer}/u],
    ['Burmese', /\p{Script=Myanmar}/u],
];

/** Messages an author needs about Match Whole Words (`wholeWords` is the resolved flag): a spaced key, which WA applies the flag to and core does not, or a spaceless-script key. `?` and `/re/` keys are excluded. */
export function wholeWordAdvice(keys, wholeWords) {
    const out = [];
    if (!wholeWords) return out;
    const plain = (Array.isArray(keys) ? keys : [])
        .map(k => String(k ?? '').trim())
        .filter(k => k && !k.startsWith('?') && !isRegexKey(k));

    const spaced = plain.find(k => /\s/.test(k));
    if (spaced) {
        out.push(`Whole-word matching applies to multi-word keys here, unlike SillyTavern core — “${spaced}” will not match a suffixed form such as its plural.`);
    }
    const script = SPACELESS_SCRIPTS.find(([, re]) => plain.some(k => re.test(k)));
    if (script) {
        out.push(`A key here is written in ${script[0]}, a script without word boundaries. Whole-word matching is likely to work where it appears among Latin text or punctuation, but it can never fire inside a wholly ${script[0]} sentence.`);
    }
    return out;
}

/** A /pattern/flags regex key, as countKey routes them. `[\s\S]`, not `.`: a body may hold a newline, as core's `[\w\W]` admits. */
export const REGEX_KEY_RE = /^\/([\s\S]+)\/([gimsuy]*)$/;
export const isRegexKey = k => REGEX_KEY_RE.test(String(k));

/** Core's reading of a regex key (`parseRegexFromString`), which refuses an unescaped `/` in the body. Not a matcher: only validateSmartKey reads it. */
const CORE_REGEX_KEY_RE = /^\/([\w\W]+?)\/([gimsuy]*)$/;
export function coreReadsAsRegex(k) {
    const m = String(k).match(CORE_REGEX_KEY_RE);
    return !!m && !/(^|[^\\])\//.test(m[1]);
}

/** Occurrences of a `/pattern/flags` key; an unparseable pattern counts 0, as core does. */
export function countRegexKey(raw, text) {
    const m = String(raw).match(REGEX_KEY_RE);
    if (!m) return 0;
    try {
        // NFC only: a regex is otherwise fold-exempt, or a pattern written against real text stops matching.
        return (String(text).normalize('NFC').match(new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`)) ?? []).length;
    } catch {
        return 0;
    }
}

/** The keyword scan window over the last `cfg.depth` messages, joined; `cfg.includeNames` is world_info_include_names. */
export function scanWindow(chat, cfg) {
    return scanSegments(chat, { ...cfg, matchWindow: 'scan' })[0];
}

/** A paragraph break: a blank line, tolerating trailing whitespace above. Not a single newline (K7). */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/** Removes named elements, tag and content, from one message; `spec` is a comma/space-separated list or an array. An unclosed element runs to its parent's close tag, or to the end (K6). */
export function dropTags(text, spec) {
    const tags = (Array.isArray(spec) ? spec : String(spec ?? '').split(/[\s,]+/))
        // A tag name, or nothing: a stray `<`, `/` or `>` must not reach the RegExp as syntax.
        .map(t => String(t).replace(/[^\w:-]/g, '')).filter(Boolean);
    let out = String(text ?? '');
    if (!out || !tags.length) return out;

    // `(?=[\s/>])` so `<div>` is not matched by the tag `di`, and the attributes come along.
    for (const tag of tags) {
        const re = new RegExp(`<(/?)${tag}(?=[\\s/>])[^>]*>`, 'gi');
        for (let unclosed = true; unclosed;) {
            let kept = 0, start = -1, openEnd = 0, depth = 0, next = '', m;
            unclosed = false;
            re.lastIndex = 0;
            while ((m = re.exec(out)) !== null) {
                if (m[1] === '/') {
                    if (depth && --depth === 0) { next += out.slice(kept, start); kept = re.lastIndex; }
                } else if (m[0].endsWith('/>')) {
                    if (!depth) { next += out.slice(kept, m.index); kept = re.lastIndex; }
                } else {
                    if (!depth) { start = m.index; openEnd = re.lastIndex; }
                    depth++;
                }
            }
            if (depth) { unclosed = true; next += out.slice(kept, start); kept = parentClose(out, openEnd, tag); }
            out = next + out.slice(kept);
        }
    }
    return out;
}

const ANY_TAG = /<(\/?)([A-Za-z][\w:-]*)(?=[\s/>])[^>]*>/g;

/** Offset of the first close tag after `from` (just past the unclosed open tag, whose own name `tag` is skipped) with no matching open in the span, or `text.length`. */
function parentClose(text, from, tag) {
    const open = new Map();
    ANY_TAG.lastIndex = from;
    for (let m; (m = ANY_TAG.exec(text)) !== null;) {
        const name = m[2].toLowerCase();
        if (name === tag.toLowerCase()) continue;
        if (m[1] === '/') {
            const n = open.get(name) ?? 0;
            if (!n) return m.index;
            open.set(name, n - 1);
        } else if (!m[0].endsWith('/>')) {
            open.set(name, (open.get(name) ?? 0) + 1);
        }
    }
    return text.length;
}

/** The scan window as chronological segments, the unit a key must match within; `scan` is the one-segment case. */
export function scanSegments(chat, { depth, includeNames = true, matchWindow = 'scan' }) {
    // 0 is authored: core's per-entry scanDepth 0 means "match nothing from chat". NaN keeps its whole-chat reading.
    const take = Number(depth);
    const messages = (take <= 0 ? [] : chat.slice(-take))
        .map(x => (includeNames && x?.name ? `${x.name}: ${x.mes ?? ''}` : String(x?.mes ?? '')));
    return segment(messages, matchWindow);
}

/** Applies the match window to already-separated texts: paragraph mode may subdivide a text, no mode merges two. */
export function segment(texts, matchWindow) {
    if (matchWindow === 'scan') return [texts.join('\n')];
    const out = matchWindow === 'paragraph'
        ? texts.flatMap(t => String(t).split(PARAGRAPH_BREAK))
        : texts.map(String);
    return out.filter(t => t.trim());
}

/** Entry match-flag -> scan-sources field, as core's buffer does. */
export const MATCH_SOURCE_FIELDS = {
    matchPersonaDescription: 'personaDescription',
    matchCharacterDescription: 'characterDescription',
    matchCharacterPersonality: 'characterPersonality',
    matchCharacterDepthPrompt: 'characterDepthPrompt',
    matchScenario: 'scenario',
    matchCreatorNotes: 'creatorNotes',
};

/** The subset of scanSources() that some entry of some attached book opted into — what a capture may freeze. */
export function usedMatchSources(sources, entries) {
    const out = {};
    const list = entries ?? [];
    for (const [flag, field] of Object.entries(MATCH_SOURCE_FIELDS)) {
        if (sources?.[field] && list.some(e => e?.[flag])) out[field] = sources[field];
    }
    return out;
}

/** The chat segments plus the sources this entry opted into (keyed as MATCH_SOURCE_FIELDS' values), re-segmented: a source is its own text, never a continuation of the last message. */
export function withMatchSources(chatWindow, entry, sources, matchWindow) {
    const texts = [...chatWindow];

    for (const [flag, field] of Object.entries(MATCH_SOURCE_FIELDS)) {
        if (entry[flag] && sources[field]) {
            texts.push(sources[field]);
        }
    }

    return segment(texts, matchWindow);
}

/** The `windowFor(depth, entry)` the activation verdicts consume: the chat window memoised per depth, then the injects inside that depth
 *  — an `ambient` one (`position !== IN_CHAT`, resolved by the caller) is in every window, diverging from core (upstream-st.md #16) — then the sources. */
export function makeWindowFor(chat, { injects = [], sources = {}, matchWindow = 'scan', includeNames = true } = {}) {
    const windows = new Map();
    const windowFor = (depth, entry) => {
        if (!windows.has(depth)) windows.set(depth, scanSegments(chat, { depth, includeNames, matchWindow }));
        const admitted = injects
            // `<`, matching core's own `#depthBuffer.slice(startDepth, depth)`.
            .filter(i => i?.text && (i.ambient || Number(i.depth ?? 0) < depth))
            .map(i => i.text);
        return withMatchSources([...windows.get(depth), ...admitted], entry, sources, matchWindow);
    };
    windowFor.windows = windows;
    return windowFor;
}

/** A `windowFor` with recursion `texts` appended, each its own unit, and the whole re-segmented. */
export function withExtraTexts(windowFor, texts, matchWindow) {
    return (depth, entry) => segment([...windowFor(depth, entry), ...texts], matchWindow);
}

let foldMemoIn = null, foldMemoOut = null, orthMemoIn = null, orthMemoOut = null;
export const foldedHay = (text, caseSensitive) => {
    if (caseSensitive) {
        if (text !== orthMemoIn) { orthMemoIn = text; orthMemoOut = normalizeOrthography(text); }
        return orthMemoOut;
    }
    if (text !== foldMemoIn) { foldMemoIn = text; foldMemoOut = fold(text); }
    return foldMemoOut;
};

/** Occurrences of `key` — a keyword, /regex/flags, or a `?` SmartKey, which returns its weight — following core's matchKeys
 *  for flags and regex precedence and diverging on orthography, which normalizeOrthography folds and core does not. */
export function countKey(key, text, caseSensitive, wholeWords, scope) {
    const raw = String(key ?? '').trim();

    if (!raw || !text) {
        return 0;
    }

    if (raw.startsWith('?')) {
        const { matched, scoreBoost } = evaluateSmartKey(raw, text, scope);
        // A negation-only SmartKey matches with zero weight; floor only that case, so a sub-1 :weight still down-weights.
        return matched ? (scoreBoost > 0 ? scoreBoost : 1) : 0;
    }

    if (isRegexKey(raw)) return countRegexKey(raw, text);

    // Aho-Corasick fast path: 0 is final under any flags; a positive count is final only for plain substring semantics.
    const cached = cachedCount(raw, text, scope);
    if (cached === 0) return 0;
    if (cached !== undefined && !caseSensitive && !wholeWords) return cached;

    // Must match smartkeys' fold exactly, or the trie and this walk disagree.
    const hay = foldedHay(text, caseSensitive);
    const needle = caseSensitive ? normalizeOrthography(raw) : fold(raw);

    if (wholeWords) {
        try {
            // Lookaround, not `\b`: a key may start or end with punctuation, and adjacent occurrences all count.
            const regex = new RegExp(`${boundaryBefore()}${escapeRegex(needle)}${boundaryAfter()}`, 'gu');
            return (hay.match(regex) ?? []).length;
        } catch {
            return 0;
        }
    }

    let count = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
        count++;
    }
    return count;
}

/** An excerpt as plain text with the match in guillemets, for places that cannot carry markup. */
export const markExcerptText = ex => (ex
    ? `${ex.text.slice(0, ex.start)}«${ex.text.slice(ex.start, ex.end)}»${ex.text.slice(ex.end)}`
    : null);

/** Every place a key matched, up to `limit`, as excerpts with match offsets; display only. A compound SmartKey returns nothing; a single-term one uses its own flags. */
export function keyExcerpts(key, text, caseSensitive, wholeWords, context = 28, limit = 20) {
    const out = [];
    let raw = String(key ?? '').trim();
    if (!raw || limit < 1) return out;
    if (raw.startsWith('?')) {
        let node = null;
        try { node = parse(tokenize(raw)); } catch { return out; }
        if (!node || (node.type !== 'TERM' && node.type !== 'REGEX')) return out;
        raw = String(node.value ?? '').trim();
        if (!raw) return out;
        caseSensitive = node.type === 'REGEX' ? caseSensitive : !!node.isCaseSensitive;
        wholeWords = node.type === 'REGEX' ? wholeWords : !!node.isExact;
    }
    // Folded -> source offset, folding one character at a time; the source must be NFC first or offsets drift.
    const srcIndex = (src, target) => {
        let acc = 0;
        for (let i = 0; i < src.length; i++) {
            if (acc >= target) return i;
            acc += (caseSensitive ? normalizeOrthography(src[i]) : fold(src[i])).length;
        }
        return src.length;
    };
    const markAt = (src, start, end) => {
        const from = Math.max(0, start - context);
        const to = Math.min(src.length, end + context);
        const head = `${from > 0 ? '…' : ''}${src.slice(from, start)}`.replace(/\s+/g, ' ');
        const hit = src.slice(start, end).replace(/\s+/g, ' ');
        const tail = `${src.slice(end, to)}${to < src.length ? '…' : ''}`.replace(/\s+/g, ' ');
        return { text: head + hit + tail, start: head.length, end: head.length + hit.length };
    };
    const mark = (raw0, index, length) => {
        const src = raw0.normalize('NFC');
        return markAt(src, srcIndex(src, index), srcIndex(src, index + length));
    };
    const push = (segment, index, length) => { out.push(mark(segment, index, length)); return out.length >= limit; };
    const pushAt = (segment, start, end) => { out.push(markAt(segment, start, end)); return out.length >= limit; };
    for (const segment of Array.isArray(text) ? text : [text]) {
        if (!segment) continue;
        const asRegex = raw.match(REGEX_KEY_RE);
        if (asRegex) {
            try {
                // Same NFC as countRegexKey, and marked against the same string it was searched in.
                const src = String(segment).normalize('NFC');
                const re = new RegExp(asRegex[1], asRegex[2].includes('g') ? asRegex[2] : `${asRegex[2]}g`);
                for (let m = re.exec(src); m; m = re.exec(src)) {
                    if (!m[0]) { re.lastIndex += 1; continue; }
                    if (pushAt(src, m.index, m.index + m[0].length)) return out;
                }
            } catch { /* countKey returned 0 for it too */ }
            continue;
        }
        const hay = foldedHay(segment, caseSensitive);
        const needle = caseSensitive ? normalizeOrthography(raw) : fold(raw);
        if (!needle) continue;
        if (wholeWords) {
            try {
                const re = new RegExp(`${boundaryBefore()}${escapeRegex(needle)}${boundaryAfter()}`, 'gu');
                for (let m = re.exec(hay); m; m = re.exec(hay)) {
                    if (!m[0]) { re.lastIndex += 1; continue; }
                    if (push(segment, m.index, m[0].length)) return out;
                }
            } catch { /* mirror countKey's failure mode */ }
            continue;
        }
        for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
            if (push(segment, i, needle.length)) return out;
        }
    }
    return out;
}

/** `selectiveLogic` values; must match core's `world_info_logic` (world-info.js). */
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

const fatalKey = (key, except) => validateSmartKey(key).some(f => f.severity === 'error' && f.code !== except);

/** The entry's usable secondary keys, or []; a negation-only key is dropped under AND_ANY only. `selective === false` means ignore the list — `=== false`, so an absent field keeps core's default. */
export const secondaryKeys = (entry) => {
    if (entry?.selective === false) return [];
    const except = (entry?.selectiveLogic ?? WI_LOGIC.AND_ANY) === WI_LOGIC.AND_ANY ? undefined : 'negation-only';
    return (Array.isArray(entry?.keysecondary) ? entry.keysecondary : [])
        .filter(k => String(k ?? '').trim() && !fatalKey(k, except));
};

/** One primary key under the entry's selective logic, as one synthesised expression whose gate nodes carry weight 0.
 *  The cache id must join every input the tree depends on (US): registerTerms stamps scope-local indices onto it. */
const SELECTIVE_SEP = '\u001f';
function selectiveEval(entry, key, text, caseSensitive, wholeWords, sec) {
    const logic = entry?.selectiveLogic ?? WI_LOGIC.AND_ANY;
    const id = [key, logic, caseSensitive ? 1 : 0, wholeWords ? 1 : 0, ...sec].join(SELECTIVE_SEP);
    return evaluateAst(id, () => synthesizeSecondary(key, sec, logic, { caseSensitive, wholeWords }), text);
}

/** One key's scoring units against one segment; a plain key is one unit seen n times, and a matched expression with no units is one unit (countKey's negation-only floor). */
function keyUnits(entry, key, text, caseSensitive, wholeWords, sec) {
    const raw = String(key ?? '').trim();
    if (!raw || !text) return [];

    if (sec?.length || raw.startsWith('?')) {
        const { matched, units } = sec?.length
            ? selectiveEval(entry, raw, text, caseSensitive, wholeWords, sec)
            : evaluateSmartKey(raw, text);
        if (!matched) return [];
        return units.length ? units : [{ id: raw, wsum: 1, n: 1 }];
    }

    const n = countKey(raw, text, caseSensitive, wholeWords);
    return n > 0 ? [{ id: raw, wsum: n, n }] : [];
}

/** Occurrences -> a key's contribution: `bm25` is tf/(tf+k1); `presence`/`presence-log` credit presence in full and let the repeats add up to R or without bound. `k1` is how fast repeats accrue, never how far. */
export function repeatCurveOf(n, k1, curve = 'presence-log', R = 1) {
    if (!(n > 0)) return 0;
    if (curve === 'presence') return 1 + R * (n - 1) / ((n - 1) + k1);
    if (curve === 'presence-log') return 1 + R * Math.log(1 + (n - 1) / k1);
    return n / (n + k1);
}

/** BM25-style keyword score for one entry over one segment or scanSegments() output; the defaults are ST's world_info_case_sensitive and world_info_match_whole_words, the entry overriding. */
export function keywordScore(entry, text, keys = entry.key, { k1, caseSensitiveDefault, wholeWordsDefault, repeatCurve = 'presence-log', repeatR = 1 } = {}) {
    if (!Array.isArray(keys) || !keys.length) {
        return { score: 0, hits: [] };
    }

    const caseSensitive = entry.caseSensitive ?? caseSensitiveDefault;
    const wholeWords = entry.matchWholeWords ?? wholeWordsDefault;

    keys = usableKeys(keys);
    if (!keys.length) {
        return { score: 0, hits: [] };
    }

    const segments = Array.isArray(text) ? text : [text];

    // Prime secondaries with the primaries, not on first use: interning mid-loop dirties the automaton and discards every cached scan.
    const sec = secondaryKeys(entry);
    if (segments.length) primeScan(sec.length ? [...keys, ...sec] : keys, segments);

    let score = 0;
    const hits = [];
    const byKey = new Map();

    for (const segment of segments) {
        if (!segment) continue;

        for (const key of keys) {
            const units = keyUnits(entry, key, segment, caseSensitive, wholeWords, sec);
            if (!units.length) continue;
            let pooled = byKey.get(key);
            if (!pooled) byKey.set(key, pooled = new Map());
            for (const u of units) {
                const prev = pooled.get(u.id);
                if (prev) { prev.wsum += u.wsum; prev.n += u.n; }
                else pooled.set(u.id, { wsum: u.wsum, n: u.n });
            }
        }
    }

    // A unit saturates once over the window, and its weight (the mean wsum/n) multiplies the curve; `count` is occurrences only, `score` carries weights.
    for (const [key, pooled] of byKey) {
        let count = 0, keyScore = 0;
        for (const u of pooled.values()) {
            keyScore += (u.wsum / u.n) * repeatCurveOf(u.n, k1, repeatCurve, repeatR);
            count += u.n;
        }
        score += keyScore;
        hits.push({ key, count, score: keyScore });
    }

    hits.sort((a, b) => b.score - a.score);
    return { score, hits };
}

/** The leading `@@` lines of raw content, by core's parseDecorators, returned raw: withPromote must preserve their spelling.
 *  ponytail: the `@@@` fallback-chain rule (only after an unknown decorator) is not mirrored; over-detecting errs safe here. */
function leadingDecorators(content) {
    const text = String(content ?? '');
    if (!text.startsWith('@@')) return [];
    const lines = text.split('\n');
    let end = 0;
    while (end < lines.length && lines[end].startsWith('@@')) end += 1;
    return lines.slice(0, end);
}

/** A `@@@name` line is the fallback form of `@@name`; core's own test is a bare startsWith on the name. */
const bareDecorator = line => (line.startsWith('@@@') ? line.slice(1) : line);

/** Whether the entry carries a decorator. A parsed entry (getSortedEntries shape) has them in `decorators` with content stripped, so the array is authoritative. */
export function hasDecorator(entry, name) {
    if (Array.isArray(entry?.decorators)) {
        return entry.decorators.some(d => String(d).startsWith(name));
    }
    return leadingDecorators(entry?.content).some(l => bareDecorator(l).startsWith(name));
}

/** `@@promote`, exact: the namespace is open, so a prefix test would claim every future `@@promote_*`. A trailing argument is allowed. */
const isPromoteDecorator = line => /^@@promote(\s|$)/.test(String(line ?? ''));

/** Whether the author promoted this entry, off RAW content; false for a parsed entry, whose content core stripped — the runtime reads the stash. */
export function hasPromoteDecorator(entry) {
    return leadingDecorators(entry?.content).some(l => isPromoteDecorator(bareDecorator(l)));
}

/** Content with `@@promote` added or removed — what a Studio toggle writes. Removal touches the leading run only; adding prepends. */
export function withPromote(content, on) {
    const run = leadingDecorators(content);
    const head = run.filter(l => !isPromoteDecorator(bareDecorator(l)));
    if (on) head.unshift('@@promote');
    return [...head, ...String(content ?? '').split('\n').slice(run.length)].join('\n');
}

/** Keys WA acts on at all: non-blank, and no fatal validator error. Gates scoring as well as activation. */
export const usableKeys = keys => (Array.isArray(keys) ? keys : [])
    .filter(k => String(k ?? '').trim() && !fatalKey(k));

/** The depth an entry's chat window is scanned at: per-entry `scanDepth`, then `messageDepth`, then `fallbackDepth` (core's
 *  world_info_depth). Nullish, not truthy: `scanDepth: 0` is authored. `depthSkew` widens the global depth only. */
export const scanDepthFor = (entry, messageDepth, fallbackDepth = 0, depthSkew = 0) =>
    Number(entry?.scanDepth ?? ((messageDepth || fallbackDepth) + (depthSkew || 0)));

/** Entries WA force-activates, judged over WA's own window (`windowFor(depth, entry)` -> segments). Skips disabled, `constant` and
 *  `@@dont_activate`; `delayUntilRecursion` is not skipped — WA emits and core's gate rejects until its level arrives. */
export function activationAdds(entries, windowFor, opts = {}) {
    const out = [];
    for (const entry of entries ?? []) {
        if (!entry || entry.disable || entry.constant) continue;
        if (hasDecorator(entry, '@@dont_activate')) continue;
        const keys = usableKeys(entry.key);
        if (!keys.length) continue;
        const depth = scanDepthFor(entry, opts.messageDepth, opts.fallbackDepth, opts.depthSkew);
        // hits, not score: the verdict must not depend on k1.
        if (keywordScore(entry, windowFor(depth, entry) ?? [], keys, opts).hits.length) {
            out.push(entry);
        }
    }
    return out;
}
