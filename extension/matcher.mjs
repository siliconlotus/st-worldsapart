// matcher.mjs — countKey and everything a match verdict rests on: the fold, boundaries, regex keys, SmartKeys
// dispatch, secondary keys, the scan window, stage-2 activation. ST-free; core parity is asserted in core-matcher-check, worth in matcher-check.

import { addMessageHits, buildAutomaton, cachedCount, createScanScope, evaluate, evaluateAst, evaluateSmartKey, fold, keyVariants, normalizeOrthography, parse, primeScan, synthesizeSecondary, tokenize, validateSmartKey } from './smartkeys.mjs';

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

/** Plain interpolation: what an injected `t` does when nobody supplies one, so the checks assert English. */
export const plainTag = (s, ...v) => s.reduce((a, str, i) => a + str + (i < v.length ? String(v[i] ?? '') : ''), '');

/** Messages an author needs about Match Whole Words (`wholeWords` is the resolved flag): a spaced key, which WA applies the flag to and core does not, or a spaceless-script key. `?` and `/re/` keys are excluded. `t` is the template tag the text goes through; ST passes its i18n tag. */
export function wholeWordAdvice(keys, wholeWords, t = plainTag) {
    const out = [];
    if (!wholeWords) return out;
    const plain = (Array.isArray(keys) ? keys : [])
        .map(k => String(k ?? '').trim())
        .filter(k => k && !k.startsWith('?') && !isRegexKey(k));

    const spaced = plain.find(k => /\s/.test(k));
    if (spaced) {
        out.push(t`Whole-word matching applies to multi-word keys here, unlike SillyTavern core — “${spaced}” will not match a suffixed form such as its plural.`);
    }
    const script = SPACELESS_SCRIPTS.find(([, re]) => plain.some(k => re.test(k)));
    if (script) {
        out.push(t`A key here is written in ${script[0]}, a script without word boundaries. Whole-word matching is likely to work where it appears among Latin text or punctuation, but it can never match inside a wholly ${script[0]} sentence.`);
    }
    return out;
}

/** A /pattern/flags regex key, as countKey routes them. `[\s\S]`, not `.`: a body may hold a newline, as core's `[\w\W]` admits. */
export const REGEX_KEY_RE = /^\/([\s\S]+)\/([gimsuy]*)$/;
/** A key matched by its own text: not a SmartKey, not a regex. */
export const isLiteral = k => !k.startsWith('?') && !isRegexKey(k);

export const isRegexKey = k => REGEX_KEY_RE.test(String(k));

/** Splits a key list on commas and newlines. A `/regex/` and a "quoted" term keep their commas; a `/` that is not the first
 *  character of a token is literal; a token that opens a regex without closing it is re-split on its commas. Diverges from
 *  core's customTokenizer, which skips the character after every comma (upstream-st.md #17). */
export function splitKeys(input) {
    const out = [];
    let cur = '', inRegex = false, inQuote = false;
    const push = () => {
        const tok = cur.trim();
        // A token that opened a regex without closing it: core splits it on its commas.
        if (tok.startsWith('/') && !isRegexKey(tok)) out.push(...tok.split(',').map(x => x.trim()).filter(Boolean));
        else if (tok) out.push(tok);
        cur = '';
    };
    const src = String(input ?? '');
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '\\') { cur += c + (src[i + 1] ?? ''); i++; continue; }
        if (c === '\n') { inRegex = false; inQuote = false; push(); continue; }
        if (c === '"' && !inRegex) inQuote = !inQuote;
        else if (c === '/' && !inQuote && (inRegex || !cur.trim())) inRegex = !inRegex;
        else if (c === ',' && !inRegex && !inQuote) { push(); continue; }
        cur += c;
    }
    push();
    return out;
}

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

/** A pattern's LITERAL hyphens rewritten as `to`, range markers left alone: `[a-z]` keeps its range, `[-a]`, `[a-]`
 *  and `[a-z-x]`'s second hyphen do not. Escaped hyphens are left alone too, and a `v` pattern is returned unchanged,
 *  `--` being set difference there. Detection only — a 1-for-1 swap needs no class splicing. */
export function swapLiteralHyphens(raw, to) {
    const m = String(raw).match(REGEX_KEY_RE);
    if (!m || m[2].includes('v')) return null;
    const body = m[1];
    let out = '', inClass = false, classAt = -1, operand = false, ranging = false;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '\\') { out += c + (body[i + 1] ?? ''); i++; operand = !ranging; ranging = false; continue; }
        if (!inClass) {
            out += c === '-' ? to : c;
            if (c === '[') { inClass = true; classAt = i; operand = false; }
            continue;
        }
        if (c === ']') { out += c; inClass = false; operand = false; ranging = false; continue; }
        if (c === '-') {
            const first = i === classAt + 1 || (body[classAt + 1] === '^' && i === classAt + 2);
            const isRange = operand && !first && body[i + 1] !== ']';
            out += isRange ? c : to;
            operand = !isRange;
            ranging = isRange;
            continue;
        }
        out += c;
        operand = !ranging;
        ranging = false;
    }
    return `/${out}/${m[2]}`;
}

/** The keyword scan window over the last `cfg.depth` messages, joined; `cfg.includeNames` is world_info_include_names. */
export function scanWindow(chat, cfg) {
    return scanSegments(chat, { ...cfg, matchWindow: 'scan' })[0];
}

/** A paragraph break: a blank line, tolerating trailing whitespace above. Not a single newline (K7). */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/** Block-level element names, alternated for a regex. Excludes inline elements and `br`, which do not end a paragraph. */
const BLOCK_TAGS = 'address|article|aside|blockquote|details|div|dd|dl|dt|fieldset|figcaption|figure|footer|form'
    + '|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul';

/** A zero-width cut before a block open tag and after a block close tag. Zero-width so the tag stays in the text, which a
 *  key can still match. */
const BLOCK_EDGE = new RegExp(`(?=<(?:${BLOCK_TAGS})\\b[^>]*>)|(?<=<\\/(?:${BLOCK_TAGS})\\s*>)`, 'gi');

/** Splits each of `texts` at every BLOCK_EDGE. Consumes nothing, so a caller tracking offsets sums the piece lengths. */
const cutBlocks = texts => texts.flatMap(x => String(x).split(BLOCK_EDGE));

/** Removes named elements, tag and content, from one message; `spec` is a comma/space-separated list or an array. An unclosed element runs to its parent's close tag, or to the end (K6). */
export function dropTags(text, spec) {
    const tags = (Array.isArray(spec) ? spec : String(spec ?? '').split(/[\s,]+/))
        // A tag name, or nothing: a stray `<`, `/` or `>` must not reach the RegExp as syntax.
        .map(x => String(x).replace(/[^\w:-]/g, '')).filter(Boolean);
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

/** Applies the match window to already-separated texts: paragraph mode may subdivide a text, at a blank line or a block
 *  element's edge; no mode merges two. */
export function segment(texts, matchWindow) {
    if (matchWindow === 'scan') return [texts.join('\n')];
    const out = matchWindow === 'paragraph'
        ? cutBlocks(texts.flatMap(x => String(x).split(PARAGRAPH_BREAK)))
        : texts.map(String);
    return out.filter(x => x.trim());
}

/** A message boundary in a single string: a line of three or more dashes and nothing else. */
const MESSAGE_BREAK = /^[ \t]*-{3,}[ \t]*$/;

/** Subdivides `parts` on `re`, each piece keeping its offset into the original text. */
const cutOn = (parts, pattern) => parts.flatMap(p => {
    const re = new RegExp(pattern, 'gm');
    const out = [];
    let last = 0;
    for (let m = re.exec(p.text); m; m = re.exec(p.text)) {
        out.push({ text: p.text.slice(last, m.index), at: p.at + last });
        last = m.index + m[0].length;
    }
    out.push({ text: p.text.slice(last), at: p.at + last });
    return out;
});

/** `segment` with offsets: `[{ text, at }]`, `at` being the index into the NFC form of `text`. `message` cuts on
 *  MESSAGE_BREAK; `paragraph` cuts those again on PARAGRAPH_BREAK and BLOCK_EDGE; any other window returns one piece. */
export function textSegments(text, matchWindow) {
    const src = String(text ?? '').normalize('NFC');
    if (matchWindow !== 'paragraph' && matchWindow !== 'message') return src.trim() ? [{ text: src, at: 0 }] : [];
    let parts = cutOn([{ text: src, at: 0 }], MESSAGE_BREAK.source);
    if (matchWindow === 'paragraph') {
        parts = cutOn(parts, PARAGRAPH_BREAK.source).flatMap(p => {
            let at = p.at;
            return cutBlocks([p.text]).map(text => { const piece = { text, at }; at += text.length; return piece; });
        });
    }
    return parts.filter(sg => sg.text.trim());
}

/** Entry match-flag -> scan-sources field, as core's buffer does. */
const MATCH_SOURCE_FIELDS = {
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
    // The window plus its injects, segmented ONCE per depth: both depend on `depth` alone, and re-segmenting them for
    // every candidate entry was a full pass over the scan window per entry per activation pass.
    const base = new Map();
    const windowFor = (depth, entry) => {
        if (!windows.has(depth)) windows.set(depth, scanSegments(chat, { depth, includeNames, matchWindow }));
        if (!base.has(depth)) {
            const admitted = injects
                // `<`, matching core's own `#depthBuffer.slice(startDepth, depth)`.
                .filter(i => i?.text && (i.ambient || Number(i.depth ?? 0) < depth))
                .map(i => i.text);
            base.set(depth, segment([...windows.get(depth), ...admitted], matchWindow));
        }
        // Only the entry's own sources are per-entry. Segmenting a concatenation is concatenating the segmentations,
        // so appending their segments matches what withMatchSources returns for the whole. Read-only: shared per depth.
        const extra = [];
        for (const [flag, field] of Object.entries(MATCH_SOURCE_FIELDS)) if (entry?.[flag] && sources[field]) extra.push(sources[field]);
        return extra.length ? [...base.get(depth), ...segment(extra, matchWindow)] : base.get(depth);
    };
    windowFor.windows = windows;
    return windowFor;
}

/** A `windowFor` with recursion `texts` appended, each its own unit, and the whole re-segmented. */
export function withExtraTexts(windowFor, texts, matchWindow) {
    return (depth, entry) => segment([...windowFor(depth, entry), ...texts], matchWindow);
}

/** Tags and HTML comments replaced by spaces, one per character, so a literal key cannot match inside one. Every offset is
 *  preserved. Regex keys bypass this and match the raw text (docs/matching.md, *Divergences from ST core*). */
export const maskMarkup = text => String(text).replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g, m => ' '.repeat(m.length));

let maskMemoIn = null, maskMemoOut = null;
const maskedHay = text => {
    if (text !== maskMemoIn) { maskMemoIn = text; maskMemoOut = maskMarkup(text); }
    return maskMemoOut;
};

let foldMemoIn = null, foldMemoOut = null, orthMemoIn = null, orthMemoOut = null;
export const foldedHay = (text, caseSensitive) => {
    const hay = maskedHay(text);
    if (caseSensitive) {
        if (hay !== orthMemoIn) { orthMemoIn = hay; orthMemoOut = normalizeOrthography(hay); }
        return orthMemoOut;
    }
    if (hay !== foldMemoIn) { foldMemoIn = hay; foldMemoOut = fold(hay); }
    return foldMemoOut;
};

/** UNITS containing each key (messages by default; see chatUnits), never occurrences — the Studio's chat evidence, and the shape buildKeyPruneScan's
 *  `chatScan` takes. Literals go through one automaton pass; a `?` or `/re/` key is evaluated per message, under its
 *  own flags rather than an entry's. `messages` may be any iterable, so the server route streams a chat file into it.
 *  `typedWith` is the same count for the key AS WRITTEN, its variants excluded, which is how the audit tells a key
 *  that only ever lands un-hyphenated. Merge two results by summing every field: a hit is per message, so the split
 *  point cannot matter. */
/** The chat cut into the unit a conjunction is matched within — each message, each paragraph of each message, or blocks
 *  of `depth` messages joined as the live scan joins them, cut from the newest end so the last block is full. Through
 *  scanSegments, so a message reads `Name: text` exactly when the live scan would; a bare string is a nameless message. */
function chatUnits(messages, { matchWindow = 'message', depth = 0, includeNames = false } = {}) {
    const chat = [...messages].map(m => (typeof m === 'string' ? { mes: m } : m));
    if (matchWindow !== 'scan') return scanSegments(chat, { depth: chat.length, includeNames, matchWindow });
    const n = Math.max(1, Number(depth) || chat.length);
    const out = [];
    for (let end = chat.length; end > 0; end -= n) out.unshift(...scanSegments(chat.slice(Math.max(0, end - n), end), { depth: n, includeNames, matchWindow: 'scan' }));
    return out;
}

let chatAutKey = null, chatAut = null;
const chatAutomaton = folded => {
    const id = folded.join('\u001f');
    if (id !== chatAutKey) { chatAutKey = id; chatAut = buildAutomaton(folded); }
    return chatAut;
};

export function countChatHits(keys, messages, { matchWindow = 'message', depth = 0, includeNames = false } = {}) {
    // Test like we fight: the units are what the matcher matches a conjunction within, so a `?` key whose terms sit in
    // adjacent messages counts under `scan` and not under `message`, as it matches. `messagesWith`/`messages` keep their
    // names and count units; `unit` says which.
    messages = chatUnits(messages, { matchWindow, depth, includeNames });
    const all = [...new Set(keys.map(k => String(k ?? '').trim()).filter(Boolean))];
    const literals = all.filter(isLiteral), rest = all.filter(k => !isLiteral(k));
    // Every variant is its own pattern, or a hyphenated key reports fewer messages here than countKey matches.
    const folded = [...new Set(literals.flatMap(k => keyVariants(k).map(fold)))];
    const idxOf = new Map(folded.map((f, i) => [f, i]));
    // Memoised on the folded list: the plugin calls this once per chat FILE with one book's keys, and rebuilding the
    // trie per file was the whole cost of a multi-chat scan.
    const aut = chatAutomaton(folded);
    const counts = new Map();
    const messagesWith = new Map(rest.map(k => [k, 0]));
    // A key whose forms could both land in one message is counted by union; summing its indices would count it twice.
    const expanded = literals.map(k => [k, keyVariants(k).map(v => idxOf.get(fold(v)))]).filter(([, idx]) => idx.length > 1);
    for (const [k] of expanded) messagesWith.set(k, 0);
    // Its own scope: the live one carries the active books' vocabulary, and a whole book's keys would swamp it.
    const scope = createScanScope();
    let seen = 0;
    for (const msg of messages) {
        seen++;
        const hit = expanded.length ? new Map() : counts;
        // The masked form, as countKey counts: a key inside a tag or an HTML comment matches neither, and `rest` below is masked by countKey.
        addMessageHits(aut, maskedHay(msg), hit);
        if (hit !== counts) {
            for (const [i, n] of hit) counts.set(i, (counts.get(i) ?? 0) + n);
            for (const [k, idx] of expanded) if (idx.some(i => hit.has(i))) messagesWith.set(k, messagesWith.get(k) + 1);
        }
        for (const k of rest) if (countKey(k, msg, false, false, scope) > 0) messagesWith.set(k, messagesWith.get(k) + 1);
    }
    const typedWith = new Map(literals.map(k => [k, counts.get(idxOf.get(fold(k))) ?? 0]));
    for (const k of literals) if (!messagesWith.has(k)) messagesWith.set(k, typedWith.get(k));
    return { messagesWith, typedWith, messages: seen, unit: matchWindow === 'scan' ? 'window' : matchWindow === 'paragraph' ? 'paragraph' : 'message' };
}

/** Occurrences of `key` — a keyword, /regex/flags, or a `?` SmartKey, which returns its weight — following core's matchKeys
 *  for flags and regex precedence and diverging on orthography, which normalizeOrthography folds and core does not.
 *  `gateAst`, when given, is the AST `key` is evaluated as: how a secondary-gated key is counted. */
/** The whole-word pattern for a needle, compiled once: a batch verifies every reported hit under this, and the runtime
 *  scorer every entry with the flag, and compiling per call was the cost. Bounded; the boundary mode is part of the key. */
const wholeWordRe = new Map();
function wholeWordRegex(needle) {
    const id = `${boundaryBefore()}${needle}`;
    let re = wholeWordRe.get(id);
    if (!re) {
        re = new RegExp(`${boundaryBefore()}${escapeRegex(needle)}${boundaryAfter()}`, 'gu');
        if (wholeWordRe.size >= 4096) wholeWordRe.clear();
        wholeWordRe.set(id, re);
    }
    re.lastIndex = 0;
    return re;
}

export function countKey(key, text, caseSensitive, wholeWords, scope, gateAst = null) {
    const raw = String(key ?? '').trim();

    if (!raw || !text) {
        return 0;
    }

    if (gateAst) {
        const { matched, scoreBoost } = evaluate(gateAst, text);
        return matched ? (scoreBoost > 0 ? scoreBoost : 1) : 0;
    }

    if (raw.startsWith('?')) {
        // Audit and Lab callers hand over keys usableKeys never filtered: a key the grammar refuses counts 0, and never aborts the scan matching it.
        let sk;
        try {
            sk = evaluateSmartKey(raw, text, scope);
        } catch {
            return 0;
        }
        // A negation-only SmartKey matches with zero weight; floor only that case, so a sub-1 :weight still down-weights.
        return sk.matched ? (sk.scoreBoost > 0 ? sk.scoreBoost : 1) : 0;
    }

    if (isRegexKey(raw)) return countRegexKey(raw, text);

    // Aho-Corasick fast path: 0 is final under any flags; a positive count is final only for plain substring semantics.
    const cached = cachedCount(raw, text, scope);
    if (cached === 0) return 0;
    if (cached !== undefined && !caseSensitive && !wholeWords) return cached;

    // Must match smartkeys' fold exactly, or the trie and this walk disagree.
    const hay = foldedHay(text, caseSensitive);
    let count = 0;
    for (const variant of keyVariants(raw)) {
        const needle = caseSensitive ? normalizeOrthography(variant) : fold(variant);
        if (!needle) continue;
        if (wholeWords) {
            try {
                // Lookaround, not `\b`: a key may start or end with punctuation, and adjacent occurrences all count.
                count += (hay.match(wholeWordRegex(needle)) ?? []).length;
            } catch {
                return 0;
            }
            continue;
        }
        for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
            count++;
        }
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
    // A TERM's value is a literal whatever it looks like: `? "/re/"` is the hatch validateSmartKey recommends, and
    // re-reading its shape below would mark it as a pattern that countKey never ran.
    let literalOnly = false;
    if (raw.startsWith('?')) {
        let node = null;
        try { node = parse(tokenize(raw)); } catch { return out; }
        if (!node) return out;
        if (node.type !== 'TERM' && node.type !== 'REGEX') return compoundExcerpts(node, text, context, limit);
        raw = String(node.value ?? '').trim();
        if (!raw) return out;
        literalOnly = node.type === 'TERM';
        caseSensitive = node.type === 'REGEX' ? caseSensitive : !!node.isCaseSensitive;
        wholeWords = node.type === 'REGEX' ? wholeWords : !!node.isExact;
    }
    // Folded -> source offset, folding one character at a time; the source must be NFC first or offsets drift.
    // Prefix sums, built once per segment: srcIndex runs twice per match and `limit` is Infinity on the proximity path.
    let sumsFor = null, sums = null;
    const srcIndex = (src, target) => {
        if (src !== sumsFor) {
            // The masked form, which is what foldedHay folded. Same length, so the indexes agree.
            const walk = maskMarkup(src);
            sums = new Int32Array(walk.length + 1);
            let acc = 0;
            for (let i = 0; i < walk.length; i++) {
                sums[i] = acc;
                acc += (caseSensitive ? normalizeOrthography(walk[i]) : fold(walk[i])).length;
            }
            sums[walk.length] = acc;
            sumsFor = src;
        }
        // The leftmost index whose folded prefix reaches `target`, as the walk it replaces returned.
        let lo = 0, hi = sums.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (sums[mid] >= target) hi = mid; else lo = mid + 1; }
        return sums[lo] >= target ? lo : sums.length - 1;
    };
    const markAt = (src, start, end) => {
        let from = Math.max(0, start - context);
        let to = Math.min(src.length, end + context);
        // Move the ends to a whitespace boundary within 24 characters, so the window does not open or close mid-word.
        // Bounded by `start` and `end`: the window must not cut into the match.
        if (from > 0) {
            const head = /\s/.exec(src.slice(from, Math.min(start, from + 24)));
            if (head) from += head.index + 1;
        }
        if (to < src.length) {
            const at = Math.max(end, to - 24);
            const tail = /\s\S*$/.exec(src.slice(at, to));
            if (tail) to = at + tail.index;
        }
        const head = `${from > 0 ? '…' : ''}${src.slice(from, start)}`.replace(/\s+/g, ' ');
        const hit = src.slice(start, end).replace(/\s+/g, ' ');
        const tail = `${src.slice(end, to)}${to < src.length ? '…' : ''}`.replace(/\s+/g, ' ');
        return { text: head + hit + tail, start: head.length, end: head.length + hit.length, at: start, to: end };
    };
    let nfcFor = null, nfc = null;
    const mark = (raw0, index, length) => {
        if (raw0 !== nfcFor) { nfcFor = raw0; nfc = raw0.normalize('NFC'); }
        return markAt(nfc, srcIndex(nfc, index), srcIndex(nfc, index + length));
    };
    const push = (segment, index, length) => { out.push(mark(segment, index, length)); return out.length >= limit; };
    const pushAt = (segment, start, end) => { out.push(markAt(segment, start, end)); return out.length >= limit; };
    for (const segment of Array.isArray(text) ? text : [text]) {
        if (!segment) continue;
        const asRegex = literalOnly ? null : raw.match(REGEX_KEY_RE);
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
        for (const variant of keyVariants(raw)) {
            const needle = caseSensitive ? normalizeOrthography(variant) : fold(variant);
            if (!needle) continue;
            if (wholeWords) {
                try {
                    const re = wholeWordRegex(needle);
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
    }
    return out;
}

/** Every leaf of a compound SmartKey's AST with whether it sits under an odd number of NOTs, in source order. */
function leafNodes(node, negated = false, out = []) {
    if (!node) return out;
    if (node.type === 'TERM' || node.type === 'REGEX') { out.push({ node, negated }); return out; }
    if (node.type === 'NOT') return leafNodes(node.operand, !negated, out);
    leafNodes(node.left, negated, out);
    return leafNodes(node.right, negated, out);
}

/** One leaf's occurrences in `text` under its own flags; a REGEX leaf carries its flags in the pattern. */
const leafCount = (id, text) => {
    const v = String(id?.value ?? '');
    const cs = id?.type !== 'REGEX' && !!id?.isCaseSensitive, ww = id?.type !== 'REGEX' && !!id?.isExact;
    // A TERM shaped like a pattern is still a literal (`? "/re/"`), so it is re-quoted rather than handed to countKey bare.
    const literal = id?.type !== 'REGEX' && isRegexKey(v) && !v.includes('"');
    return countKey(literal ? `? ${ww ? '=' : ''}${cs ? '^' : ''}"${v}"` : v, text, cs, ww);
};

/** One excerpt per leaf that matched, at its first occurrence, ordered by position: `term` is the leaf's value and `n` its
 *  occurrences in that segment. Reports leaves whatever the key's verdict — a false key's leaves come off the AST, since
 *  evaluate returns no units then. A negated leaf is reported with `negated` set, and at n 0 carries no offsets. */
function compoundExcerpts(node, text, context, limit) {
    const out = [];
    const leaves = leafNodes(node);
    for (const segment of Array.isArray(text) ? text : [text]) {
        if (!segment) continue;
        const credited = [];
        // A pooled unit is the alternation, its children under `parts`; only leaves carry a term.
        const walk = us => { for (const u of us) { if (u.parts) walk(u.parts); else credited.push(u); } };
        walk(evaluate(node, segment).units);
        const positive = credited.length
            ? credited
            : leaves.filter(l => !l.negated)
                .map(l => ({ id: l.node, n: leafCount(l.node, segment) }))
                .filter(u => u.n > 0);
        const found = [];
        for (const { id, n } of positive) {
            const isRegex = id?.type === 'REGEX';
            const [ex] = keyExcerpts(String(id?.value ?? ''), segment, !isRegex && !!id.isCaseSensitive, !isRegex && !!id.isExact, context, 1);
            if (ex) found.push({ ...ex, term: String(id?.value ?? ''), n });
        }
        for (const { node: id } of leaves.filter(l => l.negated)) {
            const isRegex = id?.type === 'REGEX';
            const value = String(id?.value ?? '');
            const n = leafCount(id, segment);
            const [ex] = n ? keyExcerpts(value, segment, !isRegex && !!id.isCaseSensitive, !isRegex && !!id.isExact, context, 1) : [];
            // No hit, no offset: sorted last.
            found.push({ ...(ex ?? { at: Number.MAX_SAFE_INTEGER, to: Number.MAX_SAFE_INTEGER }), term: value, n, negated: true });
        }
        found.sort((a, b) => a.at - b.at);
        for (const ex of found) {
            out.push(ex);
            if (out.length >= limit) return out;
        }
    }
    return out;
}

/** `key -> AST` for a `{ keys, logic }` gate, or `key -> null` without one. One node per key, as keyUnits builds one per
 *  primary; applies to `?` and `/re/` keys too. */
const gateNodeFor = (gate, caseSensitive, wholeWords) => {
    const sec = (Array.isArray(gate?.keys) ? gate.keys : []).map(k => String(k ?? '').trim()).filter(Boolean);
    if (!sec.length) return () => null;
    const logic = Number(gate?.logic ?? WI_LOGIC.AND_ANY);
    return key => {
        // A gate list a caller did not run through secondaryKeys can hold a key the grammar refuses: it gates nothing rather than aborting.
        try {
            return synthesizeSecondary(key, sec, logic, { caseSensitive, wholeWords });
        } catch {
            return null;
        }
    };
};

/** The leaves of the key's AST, or one synthetic TERM branch for a plain key with no gate. */
const branchesOf = (key, node, caseSensitive, wholeWords) => (node
    ? leafNodes(node).map(l => ({ id: l.node, negated: l.negated }))
    : [{ id: { type: 'TERM', value: key, isCaseSensitive: caseSensitive, isExact: wholeWords }, negated: false }]);

/** Every place one branch landed in `text`, under its own flags; a REGEX branch carries its flags in the pattern. */
const branchExcerpts = (id, text, context, limit) => {
    const isRegex = id?.type === 'REGEX';
    return keyExcerpts(String(id?.value ?? ''), text, !isRegex && !!id?.isCaseSensitive, !isRegex && !!id?.isExact, context, limit);
};

/** The AST a key is matched by: its gate's if it has one, its own if it is a `?` key, and none at all if it is a plain term. */
const astFor = (key, gateOf) => {
    const gated = gateOf(key);
    if (gated) return gated;
    if (!key.startsWith('?')) return null;
    try { return parse(tokenize(key)); } catch { return null; }
};

/** Overlapping spans folded to one, in source order: the first to start keeps its extent and every span it swallowed is
 *  listed in `keys`. A caller producing spans in several passes merges the union here, not each pass. */
export function mergeSpans(spans) {
    const out = [];
    for (const sp of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
        const last = out[out.length - 1];
        if (last && last.end > sp.start) last.keys.push(sp);
        else out.push({ ...sp, keys: [sp] });
    }
    return out;
}

export function keySpans(keys, text, caseSensitive, wholeWords, { limit = 200, matchWindow = 'scan', gate } = {}) {
    const segs = textSegments(text, matchWindow);
    const gateOf = gateNodeFor(gate, caseSensitive, wholeWords);
    const spans = (Array.isArray(keys) ? keys : [])
        .map(k => String(k ?? '').trim()).filter(Boolean)
        .flatMap(key => {
            const branches = branchesOf(key, astFor(key, gateOf), caseSensitive, wholeWords);
            return segs.flatMap(sg => {
                const found = branches.flatMap(b => branchExcerpts(b.id, sg.text, 0, limit)
                    .map(e => ({ key, term: String(b.id?.value ?? ''), negated: b.negated, start: e.at + sg.at, end: e.to + sg.at })));
                // As keyHits: no positive branch in the window, nothing marked in it.
                return found.some(e => !e.negated) ? found : [];
            });
        })
        ;
    return mergeSpans(spans);
}

/** One entry per key: `{ key, count, segments }`, or `{ key, message }` for a key validateSmartKey rejects. `segments` holds
 *  the windows with at least one positive branch hit, each `{ at, text, matched, leaves, excerpts }` — `matched` the key's
 *  verdict there, `leaves` every branch with that window's count and a `negated` flag, `excerpts` one per branch that matched
 *  (every occurrence when the key is a single positive branch), whose `at`/`to` index `text`. `count` sums the key's own
 *  occurrences over matched windows. `gate` is `{ keys, logic }`, applied to every key as keysecondary gates a primary. */
export function keyHits(keys, text, caseSensitive, wholeWords, { context = 28, limit = 20, matchWindow = 'scan', gate } = {}) {
    const segs = textSegments(text, matchWindow);
    const gateOf = gateNodeFor(gate, caseSensitive, wholeWords);
    return (Array.isArray(keys) ? keys : [])
        .map(k => String(k ?? '').trim()).filter(Boolean)
        .map(key => {
            const bad = key.startsWith('?') ? validateSmartKey(key).find(v => v.severity === 'error') : null;
            if (bad) return { key, message: bad.message, segments: [] };

            const ast = astFor(key, gateOf);
            const branches = branchesOf(key, ast, caseSensitive, wholeWords);
            const single = branches.length === 1 && !branches[0].negated;

            const segments = [];
            let count = 0;
            for (const sg of segs) {
                const matched = countKey(key, sg.text, caseSensitive, wholeWords, undefined, ast) > 0;
                if (matched) count += countKey(key, sg.text, caseSensitive, wholeWords);
                const leaves = branches.map(b => ({ term: String(b.id?.value ?? ''), n: leafCount(b.id, sg.text), negated: b.negated }));
                // No positive branch in this window: skipped, whatever its negatives count.
                if (!leaves.some(l => l.n > 0 && !l.negated)) continue;
                // First occurrence per branch, except for a single-positive-branch key, which carries every occurrence.
                const excerpts = [];
                for (const b of branches) {
                    for (const ex of branchExcerpts(b.id, sg.text, context, single ? limit : 1)) {
                        excerpts.push({ ...ex, term: String(b.id?.value ?? ''), negated: b.negated });
                    }
                }
                segments.push({ at: sg.at, text: sg.text, matched, leaves, excerpts });
                if (segments.length >= limit) break;
            }
            return { key, count, segments };
        });
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

/** The leading `@@` lines of raw content, by core's parseDecorators, returned raw: withPromote must preserve their spelling. */
function leadingDecorators(content) {
    const text = String(content ?? '');
    if (!text.startsWith('@@')) return [];
    const lines = text.split('\n');
    let end = 0;
    while (end < lines.length && lines[end].startsWith('@@')) end += 1;
    return lines.slice(0, end);
}

/** Every decorator name WA acts on: core's two, WA's own, and the CCv3 set the desugar implements. */
export const WA_DECORATORS = Object.freeze([
    '@@activate', '@@dont_activate', '@@promote',
    '@@depth', '@@reverse_depth', '@@role', '@@scan_depth', '@@position', '@@activate_only_after',
    '@@is_greeting', '@@activate_only_every', '@@is_user_icon',
    '@@additional_keys', '@@exclude_keys',
    '@@dont_activate_after_match', '@@keep_activate_after_match',
]);

/** The leading decorator lines that apply, bare-spelled and in document order.
 *  `fallbacked` mirrors core's parseDecorators: a `@@@` line counts only after an UNRECOGNISED one. */
export function resolveDecorators(content) {
    const out = [];
    let fallbacked = false;
    for (const line of leadingDecorators(content)) {
        if (line.startsWith('@@@') && !fallbacked) continue;
        const bare = bareDecorator(line);
        if (WA_DECORATORS.some(name => decoratorArg(bare, name) !== null)) {
            out.push(bare);
            fallbacked = false;
        } else {
            fallbacked = true;
        }
    }
    return out;
}

/** A `@@@name` line is the fallback form of `@@name`. */
const bareDecorator = line => (String(line ?? '').startsWith('@@@') ? String(line).slice(1) : String(line ?? ''));

/** The decorator's argument, `''` when it has none, or null when `line` is a different decorator.
 *  Exact on the name: the namespace is open, so a prefix test would claim every future `@@name_*`. */
export function decoratorArg(line, name) {
    const bare = bareDecorator(line);
    if (!bare.startsWith(name)) return null;
    const rest = bare.slice(name.length);
    if (rest === '') return '';
    if (!/^\s/.test(rest)) return null;
    return rest.trim();
}

/** Whether the entry carries a decorator. A parsed entry (getSortedEntries shape) has them in `decorators` with content stripped, so the array is authoritative. */
export function hasDecorator(entry, name) {
    const lines = Array.isArray(entry?.decorators) ? entry.decorators : leadingDecorators(entry?.content);
    return lines.some(l => decoratorArg(l, name) !== null);
}

/** Whether the author promoted this entry, off RAW content; false for a parsed entry, whose content core stripped — the runtime reads the stash. */
export function hasPromoteDecorator(entry) {
    return leadingDecorators(entry?.content).some(l => decoratorArg(l, '@@promote') !== null);
}

/** Content with `@@promote` added or removed — what a Studio toggle writes. Removal touches the leading run only; adding prepends. */
export function withPromote(content, on) {
    const run = leadingDecorators(content);
    const head = run.filter(l => decoratorArg(l, '@@promote') === null);
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
        // `@@activate` is core's to honour, like `constant`: WA leaves those keys unblanked and core's ladder reaches it
        // at a step above `@@dont_activate`, so forcing it again here would be noise (CCv3 gives `@@activate` precedence).
        if (hasDecorator(entry, '@@dont_activate') || hasDecorator(entry, '@@activate')) continue;
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

/** `position` values; must match core's `world_info_position` (world-info.js). */
export const WI_POSITION = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };

/** `role` values; must match core's `extension_prompt_roles` (script.js). */
export const WI_ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };

/** Core's DEFAULT_DEPTH (world-info.js). */
export const DEFAULT_WI_DEPTH = 4;

const POSITION_WORDS = { before_desc: WI_POSITION.before, after_desc: WI_POSITION.after, personality: WI_POSITION.after, scenario: WI_POSITION.after };
const ROLE_WORDS = { system: WI_ROLE.SYSTEM, user: WI_ROLE.USER, assistant: WI_ROLE.ASSISTANT };

/** A non-negative integer, or null. */
const wholeNumber = arg => (/^\d+$/.test(String(arg ?? '').trim()) ? Number(arg) : null);

/** The ST field patch an entry's decorators ask for; `{}` when none apply. Pure: mutates nothing.
 *  `ctx` is `{ chatLength, smartKeys }`. First write to a field wins, so a later decorator never overwrites an earlier one. */
export function decoratorFields(entry, ctx = {}) {
    const lines = resolveDecorators(entry?.content);
    if (!lines.length) return {};

    const patch = {};
    const set = (field, value) => { if (!(field in patch)) patch[field] = value; };
    let sawPosition = false;
    let role = null;

    for (const line of lines) {
        let arg;

        if ((arg = decoratorArg(line, '@@depth')) !== null) {
            const n = wholeNumber(arg);
            if (n === null) continue;
            sawPosition = true;
            set('position', WI_POSITION.atDepth);
            if (patch.position === WI_POSITION.atDepth) set('depth', n);
            continue;
        }

        if ((arg = decoratorArg(line, '@@reverse_depth')) !== null) {
            const n = wholeNumber(arg);
            // Counted from the START, so it moves with the chat; the spec defines it as @@depth <total> - N.
            const d = n === null ? null : Number(ctx?.chatLength ?? 0) - n;
            if (d === null || d < 0) continue;
            sawPosition = true;
            set('position', WI_POSITION.atDepth);
            if (patch.position === WI_POSITION.atDepth) set('depth', d);
            continue;
        }

        if ((arg = decoratorArg(line, '@@position')) !== null) {
            const p = POSITION_WORDS[arg.toLowerCase()];
            if (p === undefined) continue;
            sawPosition = true;
            set('position', p);
            continue;
        }

        if ((arg = decoratorArg(line, '@@scan_depth')) !== null) {
            const n = wholeNumber(arg);
            if (n === null) continue;
            set('scanDepth', n);
            continue;
        }

        if ((arg = decoratorArg(line, '@@role')) !== null) {
            const r = ROLE_WORDS[arg.toLowerCase()];
            if (r !== undefined && role === null) role = r;
            continue;
        }
    }

    // Applied after the run, not as a write, so the outcome does not depend on where @@role was written.
    if (role !== null) {
        if (patch.position === WI_POSITION.atDepth || (!sawPosition && entry?.position === WI_POSITION.atDepth)) {
            patch.role = role;
        } else if (!sawPosition) {
            patch.role = role;
            patch.position = WI_POSITION.atDepth;
            patch.depth = entry?.depth ?? DEFAULT_WI_DEPTH;
        }
    }

    return patch;
}
