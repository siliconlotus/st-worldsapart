// matcher.mjs — the matcher: does this key match this text, and where. countKey and everything a
// match verdict rests on — the fold, word boundaries, regex keys, SmartKeys dispatch, secondary-key
// logic, the scan window and its segmentation, and the stage-2 activation verdicts built on them.
// "Which entries win" is tuning and lives elsewhere (entity.mjs, query.mjs); "did this key match"
// is semantics and lives here.
//
// Anything that reports on how a key behaves (the audit, the pruner, the Studio's colouring, the
// runtime scan) calls countKey here rather than re-deriving the rules, so a report can never drift
// from what fires. Imported by both the extension and the offline harnesses, so it must stay
// isomorphic — no DOM, no ST imports; every ST/settings dependency is injected by the caller.
// Checks: core-matcher-check.mjs owns parity with core and the named divergences;
// matcher-check.mjs owns WA's own semantics.

import { cachedCount, evaluateAst, evaluateSmartKey, fold, normalizeOrthography, parse, primeScan, synthesizeSecondary, tokenize, validateSmartKey } from './smartkeys.mjs';

/** Escape a string for literal use in a RegExp (same as ST's utils.escapeRegex; inlined to stay ST-free, exported for keyword-audit). */
export function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The character class whole-word matching treats as "inside a word". Never `\w`, which is ASCII-only in
 * JS and so turns whole-word matching into substring matching for every other script — every non-ASCII
 * letter reads as a boundary.
 *
 * Both readings of "word" are defensible, so which one applies is a setting rather than a rule:
 *
 *   permissive  [\p{L}\p{N}\p{M}]        letters, digits, combining marks — `Joe` matches `Joe's`
 *   strict      [\p{L}\p{N}\p{M}\-'’]    ...plus hyphen and apostrophes — it does not
 *
 * A doubled hyphen is excepted in both directions — see boundaryBefore/boundaryAfter below, which is
 * what the whole-word assertions actually use.
 *
 * Strict is the default because the escapes are asymmetric: a `/regex/` key with `\b` recovers
 * permissive behaviour for any ASCII key, while permissive has no short form for strict. `_` is in
 * neither; combining marks are in both, so a decomposed spelling matches wherever its precomposed twin
 * does. Requires the `u` flag wherever it is used; escapeRegex above is already `u`-safe.
 *
 * Known limit: in scripts written without spaces every neighbour is a letter, so a whole-word key
 * matches only in isolation. The Studio flags an entry that asks for it; the matcher does not guess.
 *
 * Diverges from core, which keeps `\W` (world-info.js matchKeys). WA is the stricter side, so the audit
 * under-reports rather than over-reports against what core fires.
 */
const BOUNDARY_CLASSES = {
    permissive: '[\\p{L}\\p{N}\\p{M}]',
    strict: '[\\p{L}\\p{N}\\p{M}\\-\'’]',
};
let boundaryMode = 'strict';

/**
 * Injects the resolved `wordBoundary` setting. Module-level rather than an argument because the value
 * is global by construction (one user setting, never per-entry). Called by the ST side at init and on
 * change; the offline harnesses get the shipped default, which is what makes their numbers claims
 * about what ships.
 * @param {'permissive'|'strict'} mode Unknown values fall back to the default.
 */
// Own-property, not `in`: `in` walks the prototype chain, so 'constructor' would resolve wordChar() to
// a Function that template-literals into a regex that throws inside countKey's catch.
export const setBoundaryMode = mode => { boundaryMode = Object.hasOwn(BOUNDARY_CLASSES, mode) ? mode : 'strict'; };

/** The live boundary class, as a regex-source string. A function, not a const, so a mode change
 *  cannot leave a stale class baked into a caller's template literal. */
export const wordChar = () => BOUNDARY_CLASSES[boundaryMode];

/**
 * The whole-word assertions: the neighbour is not a word character, or it is a doubled hyphen.
 *
 * A doubled hyphen is always a boundary. `normalizeOrthography` folds an em dash to `--`, and strict
 * counts `-` as inside a word so `Sara-shaped` does not match `Sara`; without this exception a folded
 * em dash would read as word-internal. A single hyphen joins a compound; `--` is the ASCII spelling of
 * a dash and is never inside a word. Permissive has no hyphen in its class, so the branch is dead there.
 *
 * Zero-width, not a consumed character class: the pattern runs under `g` to count occurrences and
 * keyExcerpts reads the match offsets, so eating a boundary character would both hide the next adjacent
 * match and mis-highlight the span.
 */
export const boundaryBefore = () => `(?:(?<!${wordChar()})|(?<=--))`;
export const boundaryAfter = () => `(?:(?!${wordChar()})|(?=--))`;

/**
 * Scripts written without word separators, in the order a key is tested against them. Kana first, so
 * a Japanese key is named Japanese rather than by the Han it also contains.
 *
 * Hangul is not here — modern Korean is spaced. Tibetan is out of scope: the tsheg may function as the
 * separator this class is defined by the absence of.
 */
const SPACELESS_SCRIPTS = [
    ['Japanese', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
    ['Chinese', /\p{Script=Han}/u],
    ['Thai', /\p{Script=Thai}/u],
    ['Lao', /\p{Script=Lao}/u],
    ['Khmer', /\p{Script=Khmer}/u],
    ['Burmese', /\p{Script=Myanmar}/u],
];

/**
 * What an author needs told about Match Whole Words on this entry — structural, so it needs the keys
 * and the resolved flag and no text, no scan and no second matcher.
 *
 * Two triggers, both only when the box is on: a key containing a space (WA applies the flag to it and
 * core does not, so it narrows a key already authored) and a key in a spaceless script (advisory, not
 * diagnostic — it fires on mixed-language entries that work fine, so the copy says when it works).
 *
 * `?` and `/re/` keys are excluded from both: entry flags do not reach inside them, since countKey
 * returns from those branches before it reads the flag arguments.
 *
 * @param {string[]} keys entry.key
 * @param {boolean} wholeWords The RESOLVED flag (entry ?? global)
 * @returns {string[]} Messages, empty when there is nothing to say
 */
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

/** A /pattern/flags regex key, exactly as countKey routes them. The regex-key test — the audit and
 * the smartkeys registry import this so all three can never disagree on what counts as a regex key.
 *
 * `[\s\S]`, not `.`, so a body may hold a literal newline, as core's own `[\w\W]` admits. */
export const REGEX_KEY_RE = /^\/([\s\S]+)\/([gimsuy]*)$/;
export const isRegexKey = k => REGEX_KEY_RE.test(String(k));

/**
 * Core's own reading of the same string — `parseRegexFromString` in `world-info.js`, mirrored. One
 * difference remains, and it is core's rule rather than ours: a pattern carrying an unescaped `/` is
 * refused outright.
 *
 * Not a second matcher — nothing counts with this. It exists so `validateSmartKey` can say that core
 * will not activate a key WA is willing to run. `isRegexKey` stays the matcher's test.
 */
const CORE_REGEX_KEY_RE = /^\/([\w\W]+?)\/([gimsuy]*)$/;
export function coreReadsAsRegex(k) {
    const m = String(k).match(CORE_REGEX_KEY_RE);
    return !!m && !/(^|[^\\])\//.test(m[1]);
}

/**
 * Occurrences of a `/pattern/flags` key. Its own function because a regex key appears in two places —
 * a bare key (countKey) and a REGEX node inside a synthesised selective expression (smartkeys'
 * evaluate) — and the one-matcher rule applies to the regex path as much as the literal one.
 * An unparseable pattern counts 0, as core's matchKeys does.
 * @returns {number}
 */
export function countRegexKey(raw, text) {
    const m = String(raw).match(REGEX_KEY_RE);
    if (!m) return 0;
    try {
        // NFC, and nothing else. A regex is otherwise fold-exempt: fold the haystack and a pattern
        // written against real text stops working (`/—/` could never match a copy holding `--`). Case
        // and orthography stay raw, and the author has `/i` and `['’]` for the wider reading.
        //
        // The rule: fold where the distinction is not one a writer means, and leave it where they might.
        // Encoding form is never meant; punctuation is. Diverges from core, which does not normalise.
        return (String(text).normalize('NFC').match(new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`)) ?? []).length;
    } catch {
        return 0;
    }
}

/**
 * The keyword scan window over the last `depth` messages — the one copy of the join, shared by the live
 * scan (worldsapart.js, which layers injects/match-sources on top), the depth ablation
 * (graded-scene-grid.mjs) and offline capture tools. Names are included when core includes them, or a
 * keyword that only ever appears as a "Name:" prefix would match in core and miss here.
 * @param {Array<{name?: string, mes?: string}>} chat Chat messages (or queryMessages() output)
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to scan
 * @param {boolean} [cfg.includeNames] world_info_include_names
 * @returns {string} Scan window text
 */
export function scanWindow(chat, cfg) {
    return scanSegments(chat, { ...cfg, matchWindow: 'scan' })[0];
}

/**
 * A paragraph break: a blank line, tolerating trailing whitespace on the line above.
 *
 * Not a single newline: chat prose mixes blank-line breaks with single newlines inside a paragraph, and
 * messages using single newlines alone are rare (K7). Splitting on `\n` would chop soft-wrapped dialogue
 * into fragments; a blank line reads the Markdown correctly and, where there are none, degenerates to the
 * whole message — never narrower than the author's own structure supports.
 */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/**
 * Removes named elements — tag and content — from one message's text, before anything else reads it.
 *
 * A list, empty by default, rather than a rule: a preset's state tracker and a rendered letter or email
 * are both elements carrying prose, so nothing structural separates bookkeeping from scene text and the
 * tag name is the only evidence available. Tag and content, because the tracker's text is what fires.
 *
 * An unclosed tag runs to its parent's close, or to the end of the text — presets write these blocks
 * unclosed, ending where the message does (K6). The parent is found by balance, not by parsing: scanning
 * forward, the first close tag with no matching open inside the span belongs to an ancestor, so no DOM,
 * void-element list or well-formed markup is needed. The cost is a truncated reply cut inside a named
 * element with no enclosing tag: its tail leaves the haystack, bounded to one message. A stray close tag
 * is left alone, and nesting of the same tag is tracked so an inner copy does not end the outer element
 * early.
 *
 * @param {string} text One message's text
 * @param {string|string[]} spec Tag names — a comma/space-separated list, or an array
 * @returns {string} The text with every named element gone
 */
export function dropTags(text, spec) {
    const tags = (Array.isArray(spec) ? spec : String(spec ?? '').split(/[\s,]+/))
        // A tag name, or nothing: the setting is free text, and a stray `<`, `/` or `>` from someone
        // pasting the tag as they wrote it must not reach the RegExp as syntax.
        .map(t => String(t).replace(/[^\w:-]/g, '')).filter(Boolean);
    let out = String(text ?? '');
    if (!out || !tags.length) return out;

    // `(?=[\s/>])` so `<div>` is not matched by the tag `di`, and the attributes come along.
    for (const tag of tags) {
        const re = new RegExp(`<(/?)${tag}(?=[\\s/>])[^>]*>`, 'gi');
        // Re-run after an unclosed one, on what is left: its parent's close is where the next copy of the
        // same tag can start, and that copy is its own element with its own verdict.
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

/** Every tag in a string, for the ancestor scan. Deliberately not a parser: names and offsets only. */
const ANY_TAG = /<(\/?)([A-Za-z][\w:-]*)(?=[\s/>])[^>]*>/g;

/**
 * Where an unclosed element ends: the offset of the first close tag after `from` that has no matching
 * open inside the span, which can only be an ancestor's — or `text.length` when there is none.
 * @param {string} text
 * @param {number} from Offset just past the unclosed opening tag
 * @param {string} tag The unclosed tag's own name, which cannot be its own parent
 * @returns {number}
 */
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

/**
 * The scan window as segments — the unit a key has to match within.
 *
 * Not a join: a conjunction over the whole window matches terms a dozen messages apart, and negation has
 * the same blindness and fails worse — a false negative never surfaces anywhere, where a false positive
 * is a ranking contribution that competes and loses.
 *
 * Returns an array rather than a string with markers because the segment boundary cannot be recovered
 * after the fact: a message's own newlines are indistinguishable from the join once flat.
 *
 * `scan` is not a special case — it is the degenerate one-segment array.
 *
 * @param {Array<{name?: string, mes?: string}>} chat Chat messages (or queryMessages() output)
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to scan
 * @param {boolean} [cfg.includeNames] world_info_include_names
 * @param {'scan'|'message'|'paragraph'} [cfg.matchWindow] Segment granularity
 * @returns {string[]} Scan segments, chronological
 */
export function scanSegments(chat, { depth, includeNames = true, matchWindow = 'scan' }) {
    // 0 is authored, not degenerate: core's per-entry scanDepth 0 means "match nothing from chat"
    // (the entry lives on injects/sources/recursion), and WA mirrors it. NaN keeps its accidental
    // whole-chat reading so no existing caller shifts.
    const take = Number(depth);
    const messages = (take <= 0 ? [] : chat.slice(-take))
        .map(x => (includeNames && x?.name ? `${x.name}: ${x.mes ?? ''}` : String(x?.mes ?? '')));
    return segment(messages, matchWindow);
}

/**
 * Applies the match window to already-separated texts. The non-chat match sources (character
 * description, scenario, injects) arrive as their own units: each is one text that paragraph mode may
 * subdivide, and that no mode may merge with a chat message.
 * @param {string[]} texts
 * @param {'scan'|'message'|'paragraph'} matchWindow
 * @returns {string[]}
 */
export function segment(texts, matchWindow) {
    if (matchWindow === 'scan') return [texts.join('\n')];
    const out = matchWindow === 'paragraph'
        ? texts.flatMap(t => String(t).split(PARAGRAPH_BREAK))
        : texts.map(String);
    // An empty segment can only produce zero counts, and every one of them costs a scan.
    return out.filter(t => t.trim());
}

/** Maps each entry match-flag to the scan-sources field it pulls in, as core's buffer does. */
export const MATCH_SOURCE_FIELDS = {
    matchPersonaDescription: 'personaDescription',
    matchCharacterDescription: 'characterDescription',
    matchCharacterPersonality: 'characterPersonality',
    matchCharacterDepthPrompt: 'characterDepthPrompt',
    matchScenario: 'scenario',
    matchCreatorNotes: 'creatorNotes',
};

/**
 * The subset of `scanSources()` that any entry actually opted into.
 *
 * A capture freezes what determined the result, and a source no entry names determined nothing. Gated on
 * the books rather than on the candidates, since activation could have reached any entry; and on the
 * books rather than capturing all six, because these are a persona description and a character card —
 * the most personal text a bundle could carry, in a format meant to be shared.
 *
 * @param {object} sources scanSources() output, keyed as MATCH_SOURCE_FIELDS' values
 * @param {object[]} entries Every entry of every attached book
 * @returns {object} Only the fields some entry's flag pulls in; empty when none do
 */
export function usedMatchSources(sources, entries) {
    const out = {};
    const list = entries ?? [];
    for (const [flag, field] of Object.entries(MATCH_SOURCE_FIELDS)) {
        if (sources?.[field] && list.some(e => e?.[flag])) out[field] = sources[field];
    }
    return out;
}

/**
 * Appends the extra scan sources an entry opted into, so a verdict or score is over the same text
 * core matched against — not just the chat window.
 *
 * Re-segmenting is what makes `scan` still mean one segment: the window arrives pre-split and this
 * collapses it back together with the sources. Idempotent for the other two modes — splitting an
 * already-split paragraph yields itself — while the appended sources get split for the first time.
 *
 * A source is its own text, never a continuation of the last message: nothing may merge a character
 * description onto the end of chat prose and let a conjunction span the seam.
 *
 * @param {string[]} chatWindow The depth-limited chat segments
 * @param {object} entry World Info entry
 * @param {object} sources Source texts keyed as MATCH_SOURCE_FIELDS' values
 * @param {'scan'|'message'|'paragraph'} matchWindow
 * @returns {string[]} chatWindow plus any opted-in source texts, segmented
 */
export function withMatchSources(chatWindow, entry, sources, matchWindow) {
    const texts = [...chatWindow];

    for (const [flag, field] of Object.entries(MATCH_SOURCE_FIELDS)) {
        if (entry[flag] && sources[field]) {
            texts.push(sources[field]);
        }
    }

    return segment(texts, matchWindow);
}

/**
 * The `windowFor(depth, entry)` the activation verdicts consume, from data already extracted from
 * ST: the transformed chat, the joined scan-enabled inject text, and the scanSources() fields.
 * Memoises the chat window per resolved depth — sources are per-entry, so they append after the
 * memo. Pure assembly: the caller extracts, this builds, so the check can exercise the real window
 * construction instead of a stand-in.
 *
 * An inject at a chat depth is bounded by the window, which diverges from core: core appends every
 * `scan: true` extension prompt outside its depth slice (`WorldInfoBuffer.get`), having dropped the
 * depth at `addInject`, so an at-depth-100 inject is matched by a depth-10 scan and no scan depth can
 * reach past it. Recorded as `upstream-st.md` #16. Here an inject placed in the chat is scanned only
 * when its depth falls inside the window; one with no chat position (`IN_PROMPT`, before/after story
 * string) has no depth to test and stays ambient, exactly as core treats it. Depth 0 keeps an at-depth
 * inject in every window, which is what "always" means everywhere else in the buffer.
 *
 * `ambient` rather than a position constant, so this stays ST-free: the caller resolves
 * `position !== extension_prompt_types.IN_CHAT` and hands over a boolean.
 *
 * @param {Array<{name?: string, mes?: string}>} chat Scan-eligible messages (is_system removed)
 * @param {{injects?: Array<{text: string, ambient?: boolean, depth?: number}>, sources?: object, matchWindow?: string, includeNames?: boolean}} cfg
 * @returns {(depth: number, entry: object) => string[]}
 */
export function makeWindowFor(chat, { injects = [], sources = {}, matchWindow = 'scan', includeNames = true } = {}) {
    const windows = new Map();
    const windowFor = (depth, entry) => {
        if (!windows.has(depth)) windows.set(depth, scanSegments(chat, { depth, includeNames, matchWindow }));
        // Each admitted inject is its own text, never a continuation of the last message. Passed raw:
        // withMatchSources re-segments the whole array, so splitting here would do it twice.
        const admitted = injects
            // `<`, matching core's own `#depthBuffer.slice(startDepth, depth)`: a message at depth d is
            // inside a scan of depth D when d < D, and an inject placed at d sits in the same place.
            .filter(i => i?.text && (i.ambient || Number(i.depth ?? 0) < depth))
            .map(i => i.text);
        return withMatchSources([...windows.get(depth), ...admitted], entry, sources, matchWindow);
    };
    // The memoised chat windows, per depth — chat only, before injects and any entry's opted-in sources.
    // That is the half a capture freezes: injects are recorded beside it as their own list, so a reader
    // reconstructs the haystack by admitting them at a depth rather than picking them back out of a blob.
    windowFor.windows = windows;
    return windowFor;
}

/**
 * A `windowFor` with extra texts appended and the whole re-segmented — the recursion rematch window:
 * the entry's chat window plus each pass's new entry content. Re-segmenting keeps the semantics per
 * mode: at `scan` everything collapses back to one segment (core's one-buffer behaviour, so a
 * conjunction may span chat and recursion text as core's would), while `message`/`paragraph` keep the
 * chat/recursion seam — a recursion text is its own segment, never a continuation of the last message.
 * @param {(depth: number, entry: object) => string[]} windowFor
 * @param {string[]} texts Extra texts (recursion contents), each its own unit
 * @param {'scan'|'message'|'paragraph'} matchWindow
 * @returns {(depth: number, entry: object) => string[]}
 */
export function withExtraTexts(windowFor, texts, matchWindow) {
    return (depth, entry) => segment([...windowFor(depth, entry), ...texts], matchWindow);
}

/**
 * One-entry memo per case mode for the folded haystack. Keyed by string identity: a scan hands every key
 * the same text object, so this turns N folds into one. A miss just recomputes, so correctness never
 * depends on the hit.
 */
let foldMemoIn = null, foldMemoOut = null, orthMemoIn = null, orthMemoOut = null;
export const foldedHay = (text, caseSensitive) => {
    if (caseSensitive) {
        if (text !== orthMemoIn) { orthMemoIn = text; orthMemoOut = normalizeOrthography(text); }
        return orthMemoOut;
    }
    if (text !== foldMemoIn) { foldMemoIn = text; foldMemoOut = fold(text); }
    return foldMemoOut;
};

/**
 * Counts occurrences of a keyword in text.
 *
 * Follows core's matchKeys for flags — case sensitivity, whole-word boundaries, multi-word fallback,
 * `/regex/` precedence — and deliberately diverges on orthography, which core does not normalise at
 * all: apostrophes, curly quotes, en/em dashes, ellipsis, non-breaking space and NFC composition all
 * fold here (see normalizeOrthography in plugin/automaton.mjs) and do not in core. `?` SmartKeys are a
 * WA extension with no core equivalent.
 *
 * Known limit — Markdown in the scan text. The markup sits in the haystack, so emphasis inside a word
 * cuts both ways: in "*sister*hood" the key `sisterhood` misses, and `sister` whole-word matches because
 * the `*` reads as a boundary. `=`-flagged SmartKey terms inherit it, sharing wordChar(). Emphasis
 * around a whole word is fine in every mode. Not fixed because every option is worse: making `*` a word
 * character kills the working case, and stripping markup destroys the asterisk as content (M*A*S*H, and
 * the emphasis-markup keys a real book uses). The principled fix is to scan the rendered text rather
 * than the source — much larger than it looks, and core scans raw too.
 *
 * @param {string} key Keyword, /regex/flags, or a `?` SmartKey
 * @param {string} text Text to search
 * @param {boolean} caseSensitive Case sensitivity
 * @param {boolean} wholeWords Whole word matching
 * @returns {number} Occurrence count (a SmartKey returns its weight)
 */
export function countKey(key, text, caseSensitive, wholeWords, scope) {
    const raw = String(key ?? '').trim();

    if (!raw || !text) {
        return 0;
    }

    // SmartKeys sentinel: `?`-prefixed keys are boolean expressions (see smartkeys.mjs), overriding
    // the other options like a regex key does. Returns the SmartKey's weight (default 1) on match,
    // so it feeds keywordScore's saturation like a single occurrence scaled by :weight.
    if (raw.startsWith('?')) {
        const { matched, scoreBoost } = evaluateSmartKey(raw, text, scope);
        // A matched SmartKey built purely from negation ("? !apollo") carries zero accumulated weight
        // but must still count as a hit — floor only that case, so a sub-1 :weight down-weights.
        return matched ? (scoreBoost > 0 ? scoreBoost : 1) : 0;
    }

    // Regex key (/pattern/flags): count global matches, overriding the other options —
    // same precedence core's matchKeys gives a regex needle.
    if (isRegexKey(raw)) return countRegexKey(raw, text);

    // Aho-Corasick fast path: when keywordScore has primed a scan of this text, the shared
    // automaton already knows this key's folded-substring count. 0 is final under any flags;
    // a positive count is final for plain case-insensitive substring semantics, and otherwise
    // the key is a confirmed candidate that falls through to the exact (naive) walk below.
    const cached = cachedCount(raw, text, scope);
    if (cached === 0) return 0;
    if (cached !== undefined && !caseSensitive && !wholeWords) return cached;

    // Orthography is normalised under both case modes — it is orthogonal to case. Must match smartkeys'
    // fold exactly or the trie and this walk disagree (see fold()).
    //
    // The haystack fold is memoised, the needle's is not: every key in a pass sees the same text, and
    // the fold costs many times a bare toLowerCase (K9). Needles are short, so they stay uncached.
    const hay = foldedHay(text, caseSensitive);
    const needle = caseSensitive ? normalizeOrthography(raw) : fold(raw);

    // Whole-word matching applies to every key, including multi-word ones. Core exempts them — it splits
    // the key on whitespace and uses includes() — so its own checkbox is a no-op for any key with a
    // space in it. A named divergence, upstream-st.md.
    if (wholeWords) {
        try {
            // Core's boundary is "not flanked by a word char" — (?:^|\W)…(?:$|\W) — which, unlike \b,
            // still matches keys that start or end with punctuation. Lookaround keeps it non-consuming
            // so adjacent occurrences are all counted. wordChar() rather than \w: see above.
            const regex = new RegExp(`${boundaryBefore()}${escapeRegex(needle)}${boundaryAfter()}`, 'gu');
            return (hay.match(regex) ?? []).length;
        } catch {
            return 0;
        }
    }

    // Substring occurrence count.
    let count = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
        count++;
    }
    return count;
}

/**
 * An excerpt rendered as plain text with the match in guillemets.
 *
 * For places that cannot carry markup — a `title` tooltip, a console table, a check's expectation. The
 * ambiguity offsets exist to avoid is cosmetic here: nothing downstream parses this back out.
 *
 * @param {{text: string, start: number, end: number}} ex One keyExcerpts result
 * @returns {string} The excerpt with «the match» marked
 */
export const markExcerptText = ex => (ex
    ? `${ex.text.slice(0, ex.start)}«${ex.text.slice(ex.start, ex.end)}»${ex.text.slice(ex.end)}`
    : null);

/**
 * Every place a key matched — up to `limit` — as folded-text excerpts with the match offsets, for
 * display. The spread is the point as much as the first hit: one excerpt cannot distinguish a term
 * firing thirteen times on the same phrase from one firing across thirteen scenes.
 *
 * Shares countKey's exact machinery (foldedHay/fold, wordChar() boundary, regex precedence) rather than
 * re-deriving match rules — but it is display, not a matcher: only ever called for keys countKey already
 * counted, so a disagreement can misplace an excerpt, never invent or hide a firing. Excerpts read from
 * the original text: matches are found in the folded haystack, then the offsets are walked back through
 * a per-character fold, so the author sees the sentence they wrote.
 *
 * A single-term SmartKey gets excerpts; a compound one does not — a conjunction, alternation or negation
 * has no single answer, so it returns nothing rather than picking a limb and implying it was the reason.
 * The term's own flags apply, never the entry's: a `?` key is self-describing, so `? nasa` in a
 * caseSensitive entry is still insensitive.
 *
 * Capped because it is display: twenty is more than a reader will scan and bounds what a sample carries.
 *
 * @param {string} key The key that matched
 * @param {string|string[]} text Scan window — a string or segments
 * @param {boolean} caseSensitive Resolved entry flag
 * @param {boolean} wholeWords Resolved entry flag
 * @param {number} [context] Characters of context either side
 * @param {number} [limit] Most excerpts to return
 * @returns {Array<{text: string, start: number, end: number}>} Excerpts with match offsets, in scan order
 */
export function keyExcerpts(key, text, caseSensitive, wholeWords, context = 28, limit = 20) {
    const out = [];
    let raw = String(key ?? '').trim();
    if (!raw || limit < 1) return out;
    if (raw.startsWith('?')) {
        // Resolve to the single term, or give up. `parse` returns one node for a lone term and a
        // tree for anything else, so "is this excerptable" is just the node type.
        let node = null;
        try { node = parse(tokenize(raw)); } catch { return out; }
        if (!node || (node.type !== 'TERM' && node.type !== 'REGEX')) return out;
        raw = String(node.value ?? '').trim();
        if (!raw) return out;
        caseSensitive = node.type === 'REGEX' ? caseSensitive : !!node.isCaseSensitive;
        wholeWords = node.type === 'REGEX' ? wholeWords : !!node.isExact;
    }
    // Excerpts come from the original text; matches are found in the folded one. Mapping back is possible
    // because the fold is per character — walking the source and folding a character at a time yields
    // folded-offset → source-offset exactly. Derived by calling the real fold per character rather than
    // restating its rules, so there is no second copy to drift.
    //
    // NFC first, then walk: normalizeOrthography composes combining marks over the whole string, which a
    // per-character walk cannot reproduce, so every offset past such a sequence would drift. Normalising
    // the source first makes the per-character fold equal to the whole-string one.
    const srcIndex = (src, target) => {
        let acc = 0;
        for (let i = 0; i < src.length; i++) {
            if (acc >= target) return i;
            acc += (caseSensitive ? normalizeOrthography(src[i]) : fold(src[i])).length;
        }
        return src.length;
    };
    // Offsets, not delimiters: an entry whose own text contains guillemets would be indistinguishable
    // from the marker. Whitespace is collapsed before measuring, or the offsets would describe a string
    // the caller never sees.
    //
    // Two offset spaces, and they must not be conflated. The literal paths search the folded haystack, so
    // their offsets need walking back through the fold; the regex path runs on the raw segment, as
    // countRegexKey does, so its offsets are already source offsets and must not be mapped again.
    const markAt = (src, start, end) => {
        const from = Math.max(0, start - context);
        const to = Math.min(src.length, end + context);
        const head = `${from > 0 ? '…' : ''}${src.slice(from, start)}`.replace(/\s+/g, ' ');
        const hit = src.slice(start, end).replace(/\s+/g, ' ');
        const tail = `${src.slice(end, to)}${to < src.length ? '…' : ''}`.replace(/\s+/g, ' ');
        return { text: head + hit + tail, start: head.length, end: head.length + hit.length };
    };
    /** Offsets in FOLDED space — walk them back to the source first. */
    const mark = (raw0, index, length) => {
        const src = raw0.normalize('NFC');
        return markAt(src, srcIndex(src, index), srcIndex(src, index + length));
    };
    // A zero-length match would spin forever, so every loop advances by at least one.
    const push = (segment, index, length) => { out.push(mark(segment, index, length)); return out.length >= limit; };
    const pushAt = (segment, start, end) => { out.push(markAt(segment, start, end)); return out.length >= limit; };
    for (const segment of Array.isArray(text) ? text : [text]) {
        if (!segment) continue;
        const asRegex = raw.match(REGEX_KEY_RE);
        if (asRegex) {
            try {
                // Same NFC as countRegexKey, and marked against the same string it was searched in:
                // normalising one and slicing the other drifts the offsets.
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

/**
 * `selectiveLogic` values, mirroring core's `world_info_logic` (world-info.js:33). Duplicated rather
 * than imported because this module stays ST-free; the mapping is verified in matcher-check against
 * core's own evaluation.
 */
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

/** A fatal validator finding, minus one code the caller tolerates. Shared so the primary and secondary
 *  positions cannot drift about what "unusable" means — they differ by exactly one code. */
const fatalKey = (key, except) => validateSmartKey(key).some(f => f.severity === 'error' && f.code !== except);

/** The entry's usable secondary keys, or []. Blanks and keys with a fatal validator error are dropped,
 *  as core drops blanks, so an entry whose secondaries are all unusable is ungated, not impossible.
 *
 *  A negation-only key is tolerated as a secondary under AND_ALL and the NOT_* pair, where it reads as
 *  an exclusion or a requirement core cannot express; it is dropped under AND_ANY, where an OR of a key
 *  satisfied by absence opens the gate on nearly any text, the same ground that makes it fatal as a
 *  primary. Dropping loosens, so nothing that fired stops firing.
 *
 *  `selective === false` means "ignore this list" and core reads it (world-info.js); only a
 *  character-embedded book reaches that value, via convertCharacterBook. Tested with `=== false` so an
 *  absent field keeps core's default and the Studio's write gate can pass logic alone.
 *
 *  Keys are not substituteParams-expanded; that is ST-side, same as primaries. */
export const secondaryKeys = (entry) => {
    if (entry?.selective === false) return [];
    const except = (entry?.selectiveLogic ?? WI_LOGIC.AND_ANY) === WI_LOGIC.AND_ANY ? undefined : 'negation-only';
    return (Array.isArray(entry?.keysecondary) ? entry.keysecondary : [])
        .filter(k => String(k ?? '').trim() && !fatalKey(k, except));
};

/**
 * One primary key evaluated under the entry's selective logic — countKey's machinery, with core's
 * secondary-key condition folded into the same expression rather than evaluated beside it. One
 * expression, not two evaluators: the one-matcher rule applies to selective logic as much as to key
 * matching, and only the synthesis can carry the entry flags.
 *
 * Score-neutral by construction: the gate's nodes carry weight 0, so what comes back is the primary's
 * own contribution exactly as countKey computes it, and nothing when the gate fails.
 *
 * The cache id joins every input the tree depends on with US, because registerTerms stamps
 * scope-local pattern indices onto it and a mis-keyed hit would evaluate the wrong expression.
 */
const SELECTIVE_SEP = '\u001f';
function selectiveEval(entry, key, text, caseSensitive, wholeWords, sec) {
    const logic = entry?.selectiveLogic ?? WI_LOGIC.AND_ANY;
    const id = [key, logic, caseSensitive ? 1 : 0, wholeWords ? 1 : 0, ...sec].join(SELECTIVE_SEP);
    return evaluateAst(id, () => synthesizeSecondary(key, sec, logic, { caseSensitive, wholeWords }), text);
}

/**
 * One key's scoring units against one segment (smartkeys.mjs `evaluate` for the shape of a unit).
 *
 * A plain or regex key is one unit by construction: the key itself, seen n times. Only a SmartKey has
 * internal structure, and only there can a key be several units (AND) or several spellings of one (OR).
 *
 * The `id` is what pools a unit across segments, so it must be stable across them: AST nodes are
 * interned per (cache id, scope) and the key string is a constant, so both are.
 *
 * A matched expression with no units still counts as one — countKey's negation-only floor, kept
 * identical here rather than re-derived.
 */
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

/**
 * Occurrences -> a key's contribution. `bm25` is the BM25 tf term, `count/(count+k1)`, bounded by 1: the
 * gap between present-once and present-often is as large as the gap between absent and present.
 *
 * The other two split those apart: presence is categorical and worth the key's full weight, and only the
 * n-1 repeats accrue. `presence` bounds what repeats can add at R (R=1 caps a key at 2x); `presence-log`
 * never bounds it, which is the only shape that still separates 20 mentions from 200.
 *
 * Bounded is the default because keywordScore has no IDF — core BM25 bounds tf because the per-term IDF
 * factor is what stops a common term dominating, so here the bound is load-bearing rather than
 * principled. An unbounded curve wants a df discount on keys first.
 *
 * @param {number} n Occurrences (weight x count, as evaluate accumulates it)
 * @param {number} k1 Saturation rate — how fast repeats accrue, never how far they go
 * @param {'bm25'|'presence'|'presence-log'} curve
 * @param {number} R What repeats may add, as a multiple of presence
 */
export function repeatCurveOf(n, k1, curve = 'presence-log', R = 1) {
    if (!(n > 0)) return 0;
    if (curve === 'presence') return 1 + R * (n - 1) / ((n - 1) + k1);
    if (curve === 'presence-log') return 1 + R * Math.log(1 + (n - 1) / k1);
    return n / (n + k1);
}

/**
 * BM25-style keyword score for one entry against the scan window: a sum of per-key contributions with
 * diminishing returns, so breadth of evidence outweighs repetition without gating repetition out.
 * @param {object} entry World Info entry
 * @param {string|string[]} text Scan text — a bare string is one segment (`matchWindow: 'scan'`),
 *   an array is the segmented window from scanSegments()
 * @param {string[]} [keys] Keys to score (defaults to entry.key)
 * @param {object} cfg
 * @param {number} cfg.k1 Saturation (settings().bm25K1)
 * @param {boolean} cfg.caseSensitiveDefault world_info_case_sensitive (entry may override)
 * @param {boolean} cfg.wholeWordsDefault world_info_match_whole_words (entry may override)
 * @returns {{score: number, hits: Array<{key: string, count: number, score: number}>}}
 */
export function keywordScore(entry, text, keys = entry.key, { k1, caseSensitiveDefault, wholeWordsDefault, repeatCurve = 'presence-log', repeatR = 1 } = {}) {
    if (!Array.isArray(keys) || !keys.length) {
        return { score: 0, hits: [] };
    }

    // Inherit the globals exactly as core does (world-info.js matchKeys), or WA matches on different
    // rules than the scan that activated the entry. Core's whole-word default is off (substring).
    const caseSensitive = entry.caseSensitive ?? caseSensitiveDefault;
    const wholeWords = entry.matchWholeWords ?? wholeWordsDefault;

    // A key carrying a fatal validator error scores nothing, the same rule stage 2 applies to
    // activation. Cheap because it is per entry per pass, not per segment, and a plain key returns
    // from validateSmartKey before it tokenises anything.
    keys = usableKeys(keys);
    if (!keys.length) {
        return { score: 0, hits: [] };
    }

    // A bare string is one segment, which is what `matchWindow: 'scan'` means. Only the live scan
    // passes an array.
    const segments = Array.isArray(text) ? text : [text];

    // Register every key and scan each segment once (Aho-Corasick); countKey below then answers from
    // that scan instead of walking the buffer per key. Segments are shared by value across entries in a
    // retrieval pass, since the cache keys on the string. Secondaries are primed alongside the
    // primaries, not on first use: the synthesised tree interns their folded literals, and doing that
    // mid-loop would dirty the automaton and throw away every scan already cached for this window.
    const sec = secondaryKeys(entry);
    if (segments.length) primeScan(sec.length ? [...keys, ...sec] : keys, segments);

    let score = 0;
    const hits = [];
    // key -> (unit id -> pooled unit). Two levels because a key reports one hit count to the debug
    // column and the audit, while its score is the sum over however many units it turned out to be.
    const byKey = new Map();

    for (const segment of segments) {
        if (!segment) continue;

        // Secondary keys gate the score, not just activation, and they gate it per segment: scoring the
        // primary alone would credit evidence the author said does not count on its own, and whole-window
        // "both present" degrades to "both mentioned at some point". A segment that fails its own gate
        // contributes nothing, rather than the whole entry scoring 0 because one segment failed.
        //
        // Core checks this before activating, but against core's buffer, which is not WA's window, and a
        // force-activated entry was never checked at all. The score is WA's claim about this text.
        //
        // The gate is inside selectiveEval's expression rather than a separate pass over the segment,
        // so "did this key match" stays one question with one evaluator (see there).
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

    // Occurrences sum across gate-passing segments and saturate once per unit, rather than per segment
    // or per key: a unit is as repeated as the whole window says it is, and k1 is calibrated against a
    // whole window's counts.
    //
    // A unit's weight is its mean, `wsum/n`, and it multiplies the curve rather than feeding it — the
    // difference between `::2` meaning "twice as important" and "as if seen twice". Repetition still
    // saturates; the author's weight does not.
    //
    // Two numbers per key, because they answer different questions and one field cannot:
    //
    //   count — how many times this key's terms appeared, and nothing else. What `×3` in the debug
    //           column and the WI panel means.
    //   score — what the key contributed to the entry. Weights and saturation live here.
    for (const [key, pooled] of byKey) {
        let count = 0, keyScore = 0;
        for (const u of pooled.values()) {
            keyScore += (u.wsum / u.n) * repeatCurveOf(u.n, k1, repeatCurve, repeatR);
            count += u.n;
        }
        score += keyScore;
        hits.push({ key, count, score: keyScore });
    }

    // Strongest evidence first, which is the score: the debug column exists to say which key earned the
    // entry its place, and a raw count cannot answer that once weights exist.
    hits.sort((a, b) => b.score - a.score);
    return { score, hits };
}

// ---------------------------------------------------------------------------
// Stage 2 — activation verdicts.
//
// WA's matcher decides activation outright: it force-activates every entry whose keys match over WA's
// own window — which core cannot reproduce (`?` SmartKeys have no core semantics; the fold and depth
// are supersets) — and core's own matcher is blanked, so there is no second verdict to reconcile. The
// verdict is `keywordScore` hits over the entry's resolved-depth window, so activation, scoring and the
// audit can never disagree about whether a key matched.
// ---------------------------------------------------------------------------

/**
 * The decorator lines of a raw content string, by core's rules (world-info.js parseDecorators):
 * read only when content STARTS with `@@`, one decorator per leading line, stopping at the first
 * non-`@@` line. Returned RAW, because withPromote rewrites the run and must preserve the spelling of
 * the lines it keeps; `bareDecorator` is the unescape every reader of a NAME wants first.
 *
 * ponytail: the `@@@` fallback-chain nuance (it only applies after an unknown decorator) is not
 * mirrored, so callers over-detect fallback lines — which errs safe in all three: over-detecting
 * `@@dont_activate` under-adds, over-detecting `@@activate` under-deletes, and over-detecting
 * `@@promote` only drops a line a toggle is rewriting anyway.
 */
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

/**
 * Whether the entry carries a decorator.
 *
 * Two entry shapes reach this: raw entries (the ENTRIES_LOADED buckets, fixtures) carry the `@@` lines
 * in `content`; parsed entries (getSortedEntries output — what activationAdds sees at runtime) carry
 * them in a `decorators` array with content stripped, so the content walk below would always miss. The
 * array is authoritative when present, or the runtime guards are inert.
 */
export function hasDecorator(entry, name) {
    if (Array.isArray(entry?.decorators)) {
        return entry.decorators.some(d => String(d).startsWith(name));
    }
    return leadingDecorators(entry?.content).some(l => bareDecorator(l).startsWith(name));
}

/**
 * `@@promote`: the author declaring that activation alone is sufficient for this entry.
 *
 * Not known to core, which is what makes it work: `parseDecorators` strips every leading `@@` line from
 * the injected content but records only the names it knows, so this is stripped for free and never
 * reaches `entry.decorators`. WA reads it at WORLDINFO_ENTRIES_LOADED, before that map, and stashes it.
 *
 * Exact, not `startsWith`: this namespace is open, so a prefix test would claim every future
 * `@@promote_*`. A trailing argument is allowed.
 */
const isPromoteDecorator = line => /^@@promote(\s|$)/.test(String(line ?? ''));

/** Whether the author promoted this entry, read off RAW content (the ENTRIES_LOADED shape). Returns
 *  false for a parsed entry, whose content core has already stripped — the runtime reads the stash. */
export function hasPromoteDecorator(entry) {
    return leadingDecorators(entry?.content).some(l => isPromoteDecorator(bareDecorator(l)));
}

/**
 * Content with `@@promote` added or removed — what a Studio toggle writes.
 *
 * A content edit, there being no field: core keeps the line in the stored book and strips it only from
 * the copy it injects. Removal touches the leading run only, and adding prepends — order within the run
 * means nothing to core, and a stable position keeps a toggle's diff to one line.
 */
export function withPromote(content, on) {
    const run = leadingDecorators(content);
    const head = run.filter(l => !isPromoteDecorator(bareDecorator(l)));
    if (on) head.unshift('@@promote');
    return [...head, ...String(content ?? '').split('\n').slice(run.length)].join('\n');
}

/**
 * Keys WA will act on at all: non-blank, and no validator error — `negation-only` matches on absence
 * (nearly everywhere), `no-terms` never, `stray-quote` on a phrase whose opening delimiter was
 * swallowed into the first word, so on nothing the author wrote.
 *
 * Gates scoring as well as activation, or a key WA declared unfit to fire on still contributes a full
 * hit to the layout order. The Studio refuses to write such a key, but core's WI editor knows nothing
 * about `?` keys and an imported book was never asked, so the runtime is where the gate has to hold.
 */
export const usableKeys = keys => (Array.isArray(keys) ? keys : [])
    .filter(k => String(k ?? '').trim() && !fatalKey(k));

/**
 * The depth an entry's chat window is scanned at: per-entry `scanDepth`, then `messageDepth`, then
 * `fallbackDepth` (core's world_info_depth, injected).
 *
 * Nullish, not truthy — `scanDepth: 0` is core's authored "match nothing from chat", so it must not fall
 * through to the globals, and an unaltered book has to behave under WA as it does under core.
 *
 * A per-entry `scanDepth` is never skewed: core's min-activations skew widens the default window only.
 *
 * @param {object} entry World Info entry
 * @param {number} [messageDepth] WA's own scan depth
 * @param {number} [fallbackDepth] Core's world_info_depth, injected
 * @param {number} [depthSkew] Widening applied to the global depth only
 * @returns {number}
 */
export const scanDepthFor = (entry, messageDepth, fallbackDepth = 0, depthSkew = 0) =>
    Number(entry?.scanDepth ?? ((messageDepth || fallbackDepth) + (depthSkew || 0)));

/**
 * Entries WA force-activates, judged over WA's own window. WA owns activation, so this is the whole
 * keyword verdict for the scan rather than an addition to core's — core's matcher is blanked.
 *
 * `windowFor(depth, entry)` returns the scan segments for a resolved depth — injected because the
 * window is ST-side (chat, injects, per-entry match sources); the caller memoises per depth.
 *
 * Skips: disabled; `constant` (core activates them without keys — forcing again is provenance noise);
 * `@@dont_activate` (core's own exclusion, which a force-activate would override).
 *
 * Vectorized entries are ordinary candidates: stage 1 admits every vectorized entry it scores, so what a
 * key hit decides here is the residue — an entry the wrong-book gate zeroed, or one with no chunk in the
 * collection, which its author keyed.
 *
 * `delayUntilRecursion` is not skipped: WA emits blindly and lets core reject. Core's gate order checks
 * the delay level before external activations, and the external-activation map persists for the whole
 * scan, so emitting a delayed entry early is how it activates when its level arrives — and under the
 * takeover WA is the only route in.
 *
 * @param {object[]} entries Candidate entries (getSortedEntries shape)
 * @param {(depth: number, entry: object) => string[]} windowFor
 * @param {{messageDepth?: number, fallbackDepth?: number,
 *          caseSensitiveDefault?: boolean, wholeWordsDefault?: boolean, depthSkew?: number}} opts
 * @returns {object[]} entries to force-activate
 */
export function activationAdds(entries, windowFor, opts = {}) {
    const out = [];
    for (const entry of entries ?? []) {
        if (!entry || entry.disable || entry.constant) continue;
        if (hasDecorator(entry, '@@dont_activate')) continue;
        const keys = usableKeys(entry.key);
        if (!keys.length) continue;
        const depth = scanDepthFor(entry, opts.messageDepth, opts.fallbackDepth, opts.depthSkew);
        // hits, not score: the verdict must not depend on k1, and hits are counted only in
        // segments that pass the entry's own secondary-key gate (keywordScore).
        if (keywordScore(entry, windowFor(depth, entry) ?? [], keys, opts).hits.length) {
            out.push(entry);
        }
    }
    return out;
}


