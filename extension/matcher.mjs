// matcher.mjs — THE matcher: does this key match this text, and where. countKey and everything a
// match verdict rests on — the fold, word boundaries, regex keys, SmartKeys dispatch, secondary-key
// logic, the scan window and its segmentation, and the stage-2 activation verdicts built on them.
// Split from what is now entity.mjs and query.mjs, which keep the gazetteer and the query:
// "which entries win" is tuning, "did this key match" is semantics, and the two change for
// different reasons.
//
// Anything that reports on how a key behaves (the audit, the pruner, the Studio's colouring, the
// runtime scan) calls countKey here rather than re-deriving the rules, so a report can never drift
// from what fires. Imported by both the extension and the offline harnesses, so it must stay
// isomorphic — no DOM, no ST imports; every ST/settings dependency is INJECTED by the caller.

import { cachedCount, evaluateAst, evaluateSmartKey, fold, normalizeOrthography, parse, primeScan, synthesizeSecondary, tokenize, validateSmartKey } from './smartkeys.mjs';

/** Escape a string for literal use in a RegExp (same as ST's utils.escapeRegex; inlined to stay ST-free, exported for keyword-audit). */
export function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The character class whole-word matching treats as "inside a word". NOT `\w`, which is ASCII-only in
 * JS and silently turns whole-word matching into substring matching for every other script: under `\w`
 * the key `caf` whole-word-matches `café` and `Мари` matches `Марию`, because every non-ASCII letter
 * reads as a boundary. The ASCII control behaves correctly, which is why it goes unnoticed — `Jubile`
 * does not match `Jubilee`.
 *
 * BOTH READINGS OF "WORD" ARE DEFENSIBLE, so which one applies is a SETTING rather than a rule:
 *
 *   permissive  [\p{L}\p{N}\p{M}]        letters, digits, combining marks — `Joe` matches `Joe's`
 *   strict      [\p{L}\p{N}\p{M}\-'’]    ...plus hyphen and apostrophes — it does not
 *
 * A DOUBLED hyphen is excepted in both directions — see boundaryBefore/boundaryAfter below, which is
 * what the whole-word assertions actually use.
 *
 * Strict is the default because THE ESCAPES ARE ASYMMETRIC. A `/regex/` key with `\b` recovers
 * permissive behaviour for any ASCII key, and `\b` is what core's own boundary approximates, so one
 * escape hatch returns both. From permissive there is no short form — strict needs the explicit class
 * written twice. Land in the mode that is cheap to leave. (`\b` fails for non-ASCII keys, as in core.)
 *
 * `_` is in NEITHER, and is not part of the toggle. It is in `\w` for programming identifiers, and
 * `_Joe_` failing to match `Joe` has no defender under either reading — presets that instruct
 * underscore emphasis put it around whole words exactly as asterisks do.
 *
 * Combining marks are in both: a mark is part of the letter it sits on, and treating one as a boundary
 * would make a decomposed spelling match where its precomposed twin does not.
 *
 * Requires the `u` flag wherever it is used; escapeRegex above is already `u`-safe (it does not emit
 * the `\-` identity escape that core's version does, which `u` rejects OUTSIDE a class — inside one,
 * which is the only place this class puts it, `\-` is valid).
 *
 * KNOWN LIMIT: scripts written without spaces. In CJK every neighbour is a letter, so a whole-word key
 * matches only in isolation — the mirror of the old bug, where every CJK substring matched. There is no
 * word boundary to find, so whole-word matching is not meaningful there; the Studio flags an entry that
 * asks for it, and the matcher does not guess.
 *
 * DIVERGES FROM CORE, which keeps `\W` (world-info.js matchKeys). WA is the stricter side, so the audit
 * under-reports rather than over-reports against what core fires.
 */
const BOUNDARY_CLASSES = {
    permissive: '[\\p{L}\\p{N}\\p{M}]',
    strict: '[\\p{L}\\p{N}\\p{M}\\-\'’]',
};
let boundaryMode = 'strict';

/**
 * Injects the resolved `wordBoundary` setting. Module-level rather than an argument because every
 * caller of countKey would otherwise have to thread it — the audit, the pruner, the Studio's
 * colouring and the runtime scan — for a value that is global by construction (one user setting,
 * never per-entry). Called by the ST side at init and on change; the offline harnesses get the
 * shipped default, which is what makes their numbers claims about what ships.
 * @param {'permissive'|'strict'} mode Unknown values fall back to the default.
 */
// Own-property, not `in`: `in` walks the prototype chain, so 'constructor' and 'toString' passed as
// modes and wordChar() then returned a Function, which template-literals into a regex that throws
// inside countKey's own catch — whole-word matching silently answering 0 for every key.
export const setBoundaryMode = mode => { boundaryMode = Object.hasOwn(BOUNDARY_CLASSES, mode) ? mode : 'strict'; };

/** The live boundary class, as a regex-source string. A function, not a const, so a mode change
 *  cannot leave a stale class baked into a caller's template literal. */
export const wordChar = () => BOUNDARY_CLASSES[boundaryMode];

/**
 * The whole-word assertions: the neighbour is not a word character, OR it is a doubled hyphen.
 *
 * A DOUBLED HYPHEN IS ALWAYS A BOUNDARY. `normalizeOrthography` folds an em dash to `--` so that
 * `wait--no` matches `wait—no`; strict counts `-` as inside a word so that `Sara-shaped` does not match
 * `Sara`. Both are right alone and their product was not: an ordinary em dash read as word-internal, so
 * `Sara— catch` and `Hey—Sara` stopped matching `Sara` — four of the seven spacings prose uses. A single
 * hyphen joins a compound; `--` is the ASCII spelling of the dash the fold just rewrote, and is never
 * inside a word. Permissive has no hyphen in its class, so the second branch is dead there and costs it
 * nothing.
 *
 * ZERO-WIDTH, not a consumed character class: the pattern runs under `g` to COUNT occurrences and
 * keyExcerpt reads the match offsets, so eating a boundary character would both hide the next adjacent
 * match and mis-highlight the span.
 */
export const boundaryBefore = () => `(?:(?<!${wordChar()})|(?<=--))`;
export const boundaryAfter = () => `(?:(?!${wordChar()})|(?=--))`;

/**
 * Scripts written without word separators, in the order a key is tested against them. Kana first, so
 * a Japanese key is named Japanese rather than by the Han it also contains; a kanji-only key is the
 * one ambiguous case and reads as Chinese, where the advice is identical either way.
 *
 * Hangul is NOT here — modern Korean is spaced. Tibetan is deliberately out of scope: the tsheg may
 * function as the separator this class is defined by the absence of, so including it would flag a
 * script that possibly does not belong.
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
 * What an author needs told about Match Whole Words on THIS entry — structural, so it needs the keys
 * and the resolved flag and no text, no scan and no second matcher.
 *
 * Exactly two triggers, both only when the box is on:
 *
 *   a key contains a space   WA applies the flag to it and core does not, so this is a NARROWING of
 *                            a key already authored — the expensive direction, and silent otherwise.
 *   a key is in a spaceless  ADVISORY, not diagnostic: it fires on mixed-language entries that work
 *   script                   fine, so the copy says WHEN it works rather than THAT it is broken.
 *
 * `?` and `/re/` keys are excluded from both: entry flags do not reach inside them (countKey returns
 * from those branches before it reads the flag arguments), so neither trigger is true of them.
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

/** A /pattern/flags regex key, exactly as countKey routes them. THE regex-key test — the audit and
 * the smartkeys registry import this so all three can never disagree on what counts as a regex key.
 *
 * `[\s\S]`, not `.`, so a body may hold a literal newline. `.` excluded one and there was never a
 * reason: `new RegExp("a\nb")` is a valid pattern, core's own `[\w\W]` admits it, and the exclusion
 * was an artifact of the character class rather than a rule anyone chose. It was also the one
 * divergence from core running the wrong way — core read such a key as a pattern and WA as a plain
 * literal — and the only one nothing warned about. */
export const REGEX_KEY_RE = /^\/([\s\S]+)\/([gimsuy]*)$/;
export const isRegexKey = k => REGEX_KEY_RE.test(String(k));

/**
 * Core's OWN reading of the same string — `parseRegexFromString` in `world-info.js`, mirrored. One
 * difference remains, and it is core's rule rather than ours: a pattern carrying an unescaped `/` is
 * refused outright, core's comment giving portability to other regex engines as the reason rather
 * than meaning. (There were two. The other was our `.` against core's `[\w\W]` over a newline, which
 * was an artifact and is gone — `REGEX_KEY_RE` spans one now.)
 *
 * Not a second matcher — nothing counts with this. It exists so `validateSmartKey` can say that core
 * will not activate a key WA is willing to run, which is a fact about the two implementations and
 * needs no theory of what the author meant. `isRegexKey` stays the matcher's test.
 */
const CORE_REGEX_KEY_RE = /^\/([\w\W]+?)\/([gimsuy]*)$/;
export function coreReadsAsRegex(k) {
    const m = String(k).match(CORE_REGEX_KEY_RE);
    return !!m && !/(^|[^\\])\//.test(m[1]);
}

/**
 * Occurrences of a `/pattern/flags` key. Its own function because a regex key can now appear in TWO
 * places — a bare key (countKey) and a REGEX node inside a synthesised selective expression (smartkeys'
 * evaluate) — and CLAUDE.md's one-matcher rule applies to the regex path as much as the literal one.
 * An unparseable pattern counts 0, as core's matchKeys does.
 * @returns {number}
 */
export function countRegexKey(raw, text) {
    const m = String(raw).match(REGEX_KEY_RE);
    if (!m) return 0;
    try {
        // NFC, AND NOTHING ELSE. A regex is otherwise fold-exempt on purpose: fold the haystack and a
        // pattern written against real text stops working — `/—/` could never match, because the folded
        // copy holds `--`. Case and orthography stay raw for that reason, and the author has `/i` and
        // `['’]` when they want the wider reading.
        //
        // NFC is least surprise, not a divergence bought with an excuse. Two encodings of `é` are the
        // same letter to anyone not implementing Unicode; a key that visibly matches the text, reports
        // zero, and has no spelling that fixes it is the astonishing outcome. Core's raw-text behaviour
        // is the surprising one, so matching it would have been the cost.
        //
        // The rule that separates this from the exemptions above: fold where the distinction is not one
        // a writer means, and leave it where they might. Encoding form is never meant; punctuation is.
        return (String(text).normalize('NFC').match(new RegExp(m[1], m[2].includes('g') ? m[2] : `${m[2]}g`)) ?? []).length;
    } catch {
        return 0;
    }
}

/**
 * The keyword scan window over the last `depth` messages — the ONE copy of the join, shared by the live
 * scan (worldsapart.js, which layers injects/match-sources on top), the depth ablation
 * (graded-scene-grid.mjs) and offline capture tools. Names are included when core includes them, or a
 * keyword that only ever appears as a "Name:" prefix would match in core and silently miss here.
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
 * NOT a single newline. Chat prose mixes blank-line breaks with single newlines inside a paragraph,
 * and messages using single newlines alone are rare (K7). Splitting on `\n` would chop soft-wrapped
 * dialogue into fragments; splitting on a blank line reads the Markdown correctly, and in the
 * single-newline-only case degenerates to the whole message — never narrower than the author's own
 * structure supports.
 */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/**
 * Removes named elements — TAG AND CONTENT — from one message's text, before anything else reads it.
 *
 * WHY A TAG LIST AND NOT A RULE. A preset that keeps machine-readable state in the reply writes it as
 * markup, and every name, place and object the story has ever touched sits in it on every turn: keys
 * fire on the tracker rather than on the scene, permanently, and no scan depth can reach past it. But
 * the same chat renders letters, screens and emails as markup too, and that IS scene text. Nothing
 * structural separates the two — both are elements carrying prose — so the tag name is the only
 * evidence available, and it comes from the author, who knows which of their blocks is bookkeeping.
 * Hence a list, empty by default: WA does not guess at this.
 *
 * TAG AND CONTENT, because the content is the whole problem. Stripping markup alone would leave the
 * tracker's text in the haystack, which is exactly what fires.
 *
 * AN UNCLOSED TAG RUNS TO ITS PARENT'S CLOSE, or to the end of the text. Presets really do write
 * these blocks unclosed, the block ending where the message does (K6). Reading an unclosed tag as
 * "removes nothing" made the setting a no-op on exactly the block it exists for.
 *
 * The parent is found by BALANCE, not by parsing: scanning forward from the unclosed tag, the first close
 * tag with no matching open inside the span has to belong to an ancestor, so the element ends there.
 * Nothing needs a DOM, a void-element list or well-formed markup — an unclosed `<br>` is simply an open
 * that never balances anything, and a close it never had cannot end anything either. Falling back to
 * end-of-text is the same rule with no ancestor to find.
 *
 * The cost is a TRUNCATED reply cut inside a named element with no enclosing tag: its tail leaves the
 * haystack. Bounded to one message, since this runs per message and never across the join — and a reply
 * cut mid-block was going to be scanned as half a block either way. A stray CLOSE tag is still left
 * alone; a lone `</x>` makes no claim on any text. Nesting of the SAME tag is tracked, so an inner copy
 * does not end the outer element early.
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
 * The scan window as SEGMENTS — the unit a key has to match within.
 *
 * WHY THIS AND NOT A JOIN. A conjunction over the whole window matches terms a dozen messages apart:
 * `? apollo astronauts` fires on a window where someone said "Apollo" and, four replies later,
 * someone else said "astronauts". Negation has the same blindness and fails worse — `? fire -drill`
 * is silently vetoed by a drill five messages back, and a false negative never surfaces anywhere,
 * where a false positive is a ranking contribution that competes and loses.
 *
 * The segment boundary is the one thing WA cannot recover after the fact, which is why this returns
 * an array instead of a string with markers in it: a message's own newlines are indistinguishable
 * from the join once flat, so a joined window cannot be split back into messages by any rule. WA
 * builds the window, so it simply keeps what it already knows.
 *
 * `scan` is not a special case — it is the degenerate one-segment array, and reproduces the
 * pre-setting behaviour exactly.
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
 * Applies the match window to already-separated texts. Split out from scanSegments because the
 * non-chat match sources (character description, scenario, injects) arrive as their own units and
 * need the same treatment — each is one text that paragraph mode may subdivide, and that no mode
 * may merge with a chat message.
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
 * WHAT A CAPTURE FREEZES IS WHAT DETERMINED THE RESULT, and a source no entry names determined nothing.
 * Gating on the books rather than on the candidates because activation could have reached any entry, and
 * on the books rather than capturing all six because these are a persona description and a character
 * card — the most personal text a bundle could carry, in a format meant to be shared.
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
 * Re-segmenting is what makes `scan` still mean ONE segment: the window arrives pre-split, and this
 * collapses it back together with the sources rather than leaving two segments where the pre-setting
 * code had one string. It is idempotent for the other two modes — splitting an already-split
 * paragraph yields itself — while the appended sources get split for the first time.
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
 * AN INJECT AT A CHAT DEPTH IS BOUNDED BY THE WINDOW, which is where this DIVERGES FROM CORE. Core
 * collects every `scan: true` extension prompt and appends the lot outside its depth slice
 * (`WorldInfoBuffer.get`), having dropped the depth at `addInject` — so a persona description or an
 * Author's Note placed "In-chat @ Depth 100" is matched by a depth-10 scan exactly as if it sat in the
 * current turn. That makes the text permanently present in the haystack and removes the only lever a
 * user has over distant matches, since lowering scan depth cannot reach something that was never in the
 * depth-bounded half. Recorded as `upstream-st.md` #16.
 *
 * WA owns activation, so reproducing that faithfully would make WA wrong in the same way rather than
 * compatible. An inject placed IN the chat is scanned only when its depth falls inside the window; one
 * with no chat position (`IN_PROMPT`, before/after story string) has no depth to test and stays ambient,
 * exactly as core treats it. Depth 0 keeps an at-depth inject in every window, which is what "always" already
 * means everywhere else in the buffer.
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
    // The memoised CHAT windows, per depth — chat only, before injects and before any entry's opted-in
    // sources. That is the half a capture freezes: injects are recorded beside it as their own list, so a
    // reader RECONSTRUCTS the haystack by admitting them at a depth rather than trying to pick them back
    // out of a joined blob. Recomputing the admitted set per call is a filter over a handful of items.
    windowFor.windows = windows;
    return windowFor;
}

/**
 * A `windowFor` with extra texts appended and the whole re-segmented — the recursion
 * rematch window: the entry's chat window plus each pass's new entry content. Re-segmenting is
 * what keeps the semantics per mode: at `scan` everything collapses back to one segment (core's
 * one-buffer behaviour, so a conjunction may span chat and recursion text exactly as core's
 * would), while `message`/`paragraph` keep the chat/recursion seam — a recursion text is its own
 * segment, never a continuation of the last message.
 * @param {(depth: number, entry: object) => string[]} windowFor
 * @param {string[]} texts Extra texts (recursion contents), each its own unit
 * @param {'scan'|'message'|'paragraph'} matchWindow
 * @returns {(depth: number, entry: object) => string[]}
 */
export function withExtraTexts(windowFor, texts, matchWindow) {
    return (depth, entry) => segment([...windowFor(depth, entry), ...texts], matchWindow);
}

/**
 * One-entry memo per case mode for the folded haystack. Keyed by string identity, which is the case
 * that matters: a scan hands every key the same text object, so this turns N folds into one. A miss
 * just recomputes, so correctness never depends on the hit.
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
 * Follows core's matchKeys for FLAGS — case sensitivity, whole-word boundaries, multi-word fallback,
 * `/regex/` precedence — and deliberately diverges on ORTHOGRAPHY, which core does not normalise at
 * all: apostrophes, curly quotes, en/em dashes, ellipsis, non-breaking space and NFC composition all
 * fold here (see normalizeOrthography in plugin/automaton.mjs) and do not in core. A key carrying any
 * of those can therefore match here and not fire in core's scan, for as long as core owns activation.
 * `?` SmartKeys are a WA extension with no core equivalent at all.
 *
 * KNOWN LIMIT — MARKDOWN IN THE SCAN TEXT. Chat prose is Markdown, and the markup sits in the haystack,
 * so emphasis INSIDE a word cuts both ways against the text a reader actually sees:
 *
 *   "*sister*hood"   `sisterhood` MISSES — the asterisks break the substring
 *   "*sister*hood"   `sister` whole-word MATCHES — the * reads as a word boundary — where the
 *                    unemphasised "sisterhood" correctly does not
 *
 * The false positive is the worse half, and `=`-flagged SmartKey terms inherit it, sharing wordChar().
 * Emphasis around a WHOLE word is fine in every mode: "*sister*," matches `sister` exactly as it should.
 * This only bites mid-word, and mid-word emphasis turned up rarely in the sample prose available — one
 * author's chats, so that is a weak reason to relax about it rather than evidence it is uncommon.
 *
 * Not fixed, because every option is worse. Making `*` a word character kills the working case — a
 * standalone "*sister*" would then be bounded by word characters and stop matching, so the two cases
 * want opposite answers from the same character. Stripping markup from the haystack destroys the
 * asterisk as CONTENT: M*A*S*H, *B*witched, and the emphasis-markup keys a real book uses to
 * disambiguate Roman currency. Scanning both a raw and a stripped copy fixes only the miss direction,
 * not the false boundary, at two scan passes and a rule for combining the counts.
 *
 * The principled fix is to scan the RENDERED text rather than the source, since that is the only thing
 * which distinguishes markup from content. Much larger than it looks — core scans raw too.
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
        // A matched SmartKey built purely from negation (e.g. "? !apollo") carries zero accumulated
        // weight but must still count as a hit — floor ONLY that case, so a sub-1 :weight
        // (e.g. "? whisper:0.3") down-weights as documented.
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

    // Orthography is normalised under BOTH case modes — it is orthogonal to case, and a case-sensitive
    // key is no more likely to have been typed with the same quote or dash characters the prose uses.
    // Must match smartkeys' fold exactly or the trie and this walk disagree (see fold()).
    //
    // The HAYSTACK fold is memoised, the needle's is not. Every key in a pass sees the same text, so
    // folding it per call is the same waste core's matchKeys makes with its per-key toLowerCase — and
    // it costs more here, because the fold does real work now, many times a bare toLowerCase (K9).
    // Needles are short, so they stay uncached.
    const hay = foldedHay(text, caseSensitive);
    const needle = caseSensitive ? normalizeOrthography(raw) : fold(raw);

    // Whole-word matching applies to EVERY key, including multi-word ones. Core exempts them — it
    // splits the key on whitespace and uses includes() — so its own checkbox is a silent no-op for
    // any key with a space in it, which is the same shape as the \W boundary bug rather than a
    // considered semantic. A named divergence, upstream-st.md.
    if (wholeWords) {
        try {
            // Core's boundary is "not flanked by a word char" — (?:^|\W)…(?:$|\W) — which,
            // unlike \b, still matches keys that start or end with punctuation ("+5", "v2"
            // in "v2s" would not, but "v2" alone does). Lookaround keeps it non-consuming
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
 * WHERE a key matched, for display — the first occurrence as a folded-text excerpt with the match
 * marked «so». Exists for /wa-grade's "why did this pop": a substring key's surface form ("thread"
 * inside "threadbare") is what the author needs to see to tune it, and countKey only counts.
 *
 * Shares countKey's exact machinery (foldedHay/fold, wordChar() boundary, regex precedence) rather
 * than re-deriving match rules — but it is DISPLAY, not a matcher: only ever called for keys
 * countKey already counted, so a disagreement can misplace an excerpt, never invent or hide a
 * firing. Excerpts read from the ORIGINAL text: matches are found in the folded haystack, then the
 * offsets are walked back through a per-character fold, so the author sees the sentence they wrote.
 *
 * A SINGLE-TERM SmartKey gets an excerpt; a compound one does not. `? =rut` or `? /Cap'n/i` has exactly
 * one thing that can have matched, and it is the case where the excerpt is worth most — a bare count
 * cannot tell an author where `=rut` landed, and for a regex the surface form is not deducible from the
 * key at all. A conjunction, alternation or negation has no single answer, so it keeps returning null
 * rather than picking a limb and implying it was the reason. The term's OWN flags apply, never the
 * entry's: a `?` key is self-describing, so `? nasa` in a caseSensitive entry is still
 * insensitive.
 * @param {string} key The key that matched
 * @param {string|string[]} text Scan window — a string or segments, as keywordScore takes
 * @param {boolean} caseSensitive Resolved entry flag
 * @param {boolean} wholeWords Resolved entry flag
 * @param {number} [context] Characters of context either side
 * @returns {string|null} One marked excerpt, or null (no match found / smartkey)
 */
export function keyExcerpt(key, text, caseSensitive, wholeWords, context = 28) {
    const first = keyExcerpts(key, text, caseSensitive, wholeWords, context, 1)[0];
    return first ? markExcerptText(first) : null;
}

/**
 * An excerpt rendered as plain text with the match in guillemets.
 *
 * For places that cannot carry markup — a `title` tooltip, a console table, a check's expectation. The
 * ambiguity that offsets exist to avoid is cosmetic here: a reader may not be able to tell the author's
 * guillemets from the marker, but nothing downstream parses this back out.
 *
 * @param {{text: string, start: number, end: number}} ex One keyExcerpts result
 * @returns {string} The excerpt with «the match» marked
 */
export const markExcerptText = ex => (ex
    ? `${ex.text.slice(0, ex.start)}«${ex.text.slice(ex.start, ex.end)}»${ex.text.slice(ex.end)}`
    : null);

/**
 * EVERY place a key matched, for vetting rather than diagnosis — up to `limit`.
 *
 * keyExcerpt answers "did this land where I think"; this answers "is this key any good", which needs the
 * spread: one excerpt cannot distinguish a term that fires thirteen times on the same phrase from one
 * firing across thirteen different scenes, and that difference is the whole judgement about a key.
 *
 * Capped because it is display: twenty is more than a reader will scan and bounds what a sample carries.
 * Same machinery and same rules as the single-excerpt path, which is the point of it being one function.
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
    // EXCERPTS COME FROM THE ORIGINAL TEXT, matches are FOUND in the folded one. The fold lowercases and
    // rewrites typography (— → --, … → ..., curly quotes → straight), so an excerpt sliced from it showed
    // the author a sentence they never wrote — wrong case, wrong punctuation — while asking them to judge
    // a key against it.
    //
    // Mapping back is possible because the fold is per character: every rule is one char to one or more,
    // so walking the source and folding a character at a time yields folded-offset → source-offset exactly.
    // Derived by CALLING the real fold per character rather than restating its rules, so there is no second
    // copy to drift. Display-only and called for a handful of hits, so the walk is affordable where it
    // would not be in the scan.
    // NFC FIRST, then walk. normalizeOrthography composes combining marks over the WHOLE string, which a
    // per-character walk cannot reproduce: "e + ́" is two characters alone and one after composition, so
    // every offset past the first such sequence drifts and the mark lands left of the match — `H«e kno»ts`
    // for a hit on `knots`. Normalising the source first makes the per-character fold exactly equal to the
    // whole-string one, since every remaining rule is one character to one or more.
    const srcIndex = (src, target) => {
        let acc = 0;
        for (let i = 0; i < src.length; i++) {
            if (acc >= target) return i;
            acc += (caseSensitive ? normalizeOrthography(src[i]) : fold(src[i])).length;
        }
        return src.length;
    };
    // OFFSETS, NOT DELIMITERS. Marking the span with «…» put a signal in band with the data: an entry
    // whose own text contains guillemets — French dialogue, a quoted aside — produced `«no «rut»»`, and a
    // reader (or the display regex) cannot tell the author's from ours. Whitespace is collapsed BEFORE
    // measuring, or the offsets would describe a string the caller never sees.
    // TWO OFFSET SPACES, and conflating them is what this function got wrong. The literal paths search the
    // FOLDED haystack, so their offsets need walking back through the fold. The regex path runs on the raw
    // segment — as countRegexKey does — so its offsets are already source offsets and mapping them again
    // drags the mark left by one per em-dash and two per ellipsis before the match. `/knot(s|ting)?/` over
    // RP prose rendered as `«  He k»nots`.
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
                // Same NFC as countRegexKey, and marked against the SAME string it was searched in —
                // normalising one and slicing the other is how the offsets drifted before.
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
 * BM25-style keyword score: a sum of per-key contributions with diminishing returns,
 * so breadth of evidence outweighs repetition without gating repetition out.
 * @param {object} entry World Info entry
 * @param {string} text Scan window
 * @param {string[]} [keys] Keys to score (defaults to entry.key)
 * @param {object} cfg
 * @param {number} cfg.k1 BM25 saturation (settings().bm25K1)
 * @param {boolean} cfg.caseSensitiveDefault world_info_case_sensitive (entry may override)
 * @param {boolean} cfg.wholeWordsDefault world_info_match_whole_words (entry may override)
 * @returns {{score: number, hits: Array<{key: string, count: number}>}} Score and matched keys.
 */
/**
 * `selectiveLogic` values, mirroring core's `world_info_logic` (world-info.js:33). Duplicated rather
 * than imported because this module stays ST-free; the mapping is verified in matcher-check against
 * core's own evaluation.
 */
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

/** A fatal validator finding, minus one code the caller tolerates. Shared so the primary and secondary
 *  positions cannot drift about what "unusable" means — they differ by exactly one code. */
const fatalKey = (key, except) => validateSmartKey(key).some(f => f.severity === 'error' && f.code !== except);

/** The entry's usable secondary keys, or an empty array. Blanks are dropped before the logic runs, as
 *  core does, and a key carrying a fatal validator error is dropped the same way — so an entry whose
 *  secondaries are all unusable is ungated rather than impossible, and a malformed one loosens the gate
 *  rather than silently killing the entry (`? (apollo` used to make every scan of it fail).
 *
 *  `negation-only` IS TOLERATED HERE, and only here. It is fatal for a primary because such a key fires
 *  on absence alone; a secondary never fires, since the primary gates activation. `astronaut` with
 *  `["cosmonaut", "? -gagarin"]` under AND_ALL reads "both crews, but not the Gagarin entry's territory"
 *  — an exclusion an author reaches for whenever two entries cover overlapping ground, and one core
 *  cannot express at all.
 *
 *  WHAT SUCH A KEY DOES DEPENDS ON THE OPERATOR, and AND_ALL is the only one it does the above under.
 *  so the tolerance does too — AND_ANY is excluded from it, on the ground that made the key fatal as
 *  a primary. A negation is satisfied by ABSENCE, and AND_ANY ORs its secondaries: the branch is open
 *  on nearly any text, so the gate stops gating and the key has negated the purpose of writing a gate,
 *  exactly as a negation-only primary negates the purpose of writing a keyword. No author intent
 *  survives the test — an entry meant to match everything is a Constant entry, which is a field, not
 *  a key.
 *
 *  The NOT_* pair keeps the tolerance. There the operator's own negation cancels the key's, so it
 *  reads as a REQUIREMENT — `["b", "c", "? -d"]` is `? a && (-b || -c || d)` under NOT_ALL and
 *  `? a && -b && -c && d` under NOT_ANY — and both are conditions an author can mean and core cannot
 *  write. Surprising to read, which is the Studio's job to flag at the moment the operator changes,
 *  not a reason to drop the key.
 *
 *  Dropping under AND_ANY LOOSENS, as every drop here does: the surviving secondaries gate alone, and
 *  an entry whose whole list was negations is ungated rather than impossible. That is the direction
 *  the key was already pushing — its branch was open — so nothing that used to fire stops.
 *
 *  `selective: false` MEANS "ignore this list", and core reads it — `entry.selective && ...`
 *  (world-info.js). The comment there, "all entries are selective now", is about the field DEFAULTING
 *  to true, not about it going unread. CCv2 is where the switch is specified: `secondary_keys` is
 *  "ignored if selective == false", which is the off position ST's own editor has no control for.
 *  Only a character-embedded book reaches the combination — `convertCharacterBook` writes
 *  `keysecondary: entry.secondary_keys || []` beside `selective: entry.selective || false`, and
 *  `addMissingWorldInfoFields` fills only ABSENT fields, so that false survives the save and every
 *  later load. Without this WA gated an entry core ungates, and no lorebook on disk shows the
 *  difference; the card does.
 *
 *  The test is `=== false` so a missing field keeps core's `default: true`, and so the Studio's write
 *  gate can go on probing without one — it passes the entry's LOGIC, which the negation rule needs,
 *  and deliberately not its `selective`, which asks a different question.
 *
 *  Keys are NOT `substituteParams`-expanded — that is ST-side, and primary keys are treated the same. */
export const secondaryKeys = (entry) => {
    if (entry?.selective === false) return [];
    const except = (entry?.selectiveLogic ?? WI_LOGIC.AND_ANY) === WI_LOGIC.AND_ANY ? undefined : 'negation-only';
    return (Array.isArray(entry?.keysecondary) ? entry.keysecondary : [])
        .filter(k => String(k ?? '').trim() && !fatalKey(k, except));
};

/**
 * One primary key's occurrences under the entry's selective logic — countKey, with core's
 * secondary-key condition folded into the same expression rather than evaluated beside it.
 *
 * WHY ONE EXPRESSION AND NOT TWO EVALUATORS. `secondaryOk` was a second WA implementation of core's
 * matchSecondaryKeys, standing next to the one in `synthesizeSecondary`, and CLAUDE.md's one-matcher
 * rule applies to selective logic as much as to key matching: two implementations drift, and the
 * drift surfaces as an entry that activates and does not score, or the reverse. The synthesis is the
 * survivor because it is the one that can carry the ENTRY FLAGS — the string route returned from
 * countKey's `?` branch before the flag arguments were ever read.
 *
 * Score-neutral by construction: the gate's nodes carry weight 0, so the value here is the primary's
 * own contribution exactly as countKey computes it, and 0 when the gate fails. The floor mirrors
 * countKey's `?` branch — a matched expression built purely from negation accumulates no weight and
 * must still count as one hit.
 *
 * The cache id joins every input the tree depends on with US, because registerTerms stamps
 * scope-local pattern indices onto it and a mis-keyed hit would evaluate the wrong expression.
 */
const SELECTIVE_SEP = '\u001f';
export function countSelective(entry, key, text, caseSensitive, wholeWords, sec = secondaryKeys(entry)) {
    const { matched, scoreBoost } = selectiveEval(entry, key, text, caseSensitive, wholeWords, sec);
    return matched ? (scoreBoost > 0 ? scoreBoost : 1) : 0;
}

/** countSelective's evaluation, undivided — countKey's caller wants the scalar, keywordScore wants
 *  the units, and building the tree twice would be two cache entries for one expression. */
function selectiveEval(entry, key, text, caseSensitive, wholeWords, sec) {
    const logic = entry?.selectiveLogic ?? WI_LOGIC.AND_ANY;
    const id = [key, logic, caseSensitive ? 1 : 0, wholeWords ? 1 : 0, ...sec].join(SELECTIVE_SEP);
    return evaluateAst(id, () => synthesizeSecondary(key, sec, logic, { caseSensitive, wholeWords }), text);
}

/**
 * One key's SCORING UNITS against one segment (smartkeys.mjs `evaluate` for the shape of a unit).
 *
 * A plain or regex key is one unit by construction: the key itself, seen n times. Only a SmartKey has
 * internal structure, and only there can a key be several units (AND) or several spellings of one
 * (OR). So this is where the two kinds stop being the same question, and everything below is the
 * SmartKey case — which is also why plain keys score identically to before the split.
 *
 * The `id` is what pools a unit across segments, so it must be stable across them: AST nodes are
 * interned per (cache id, scope) and the key string is a constant, so both are.
 *
 * A MATCHED EXPRESSION WITH NO UNITS still counts as one. That is countKey's negation-only floor
 * (`? -apollo` accumulates no weight and must not read as absent), kept identical here rather than
 * re-derived — the two would disagree about whether such a key scored at all.
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
 * BM25-style keyword score for one entry against the scan window.
 * @param {object} entry
 * @param {string|string[]} text Scan text — a bare string is one segment (`matchWindow: 'scan'`),
 *   an array is the segmented window from scanSegments()
 * @param {string[]} [keys]
 * @returns {{score: number, hits: Array<{key: string, count: number}>}}
 */
/**
 * Occurrences -> a key's contribution. `bm25` is what has always shipped: `count/(count+k1)`, the BM25
 * tf term, bounded by 1 and approached from below — so a key present once scores 1/(1+k1) (0.455 at the
 * shipped k1) and the gap between present-once and present-often is as large as the gap between absent
 * and present.
 *
 * The other two split those apart: PRESENCE is categorical and worth the key's full weight, and only the
 * n-1 REPEATS accrue. `presence` bounds what repeats can add at R (so R=1 caps a key at 2x, R=2 at 3x);
 * `presence-log` never bounds it, which is the only shape that still separates 20 mentions from 200.
 *
 * WHY BOUNDED IS THE DEFAULT and unbounded is the arm: keywordScore has no IDF. Core BM25 bounds tf
 * because the per-term IDF factor is what stops a common term dominating; nothing here does that job, so
 * the bound is load-bearing rather than principled. An unbounded curve wants a df discount on keys first.
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

export function keywordScore(entry, text, keys = entry.key, { k1, caseSensitiveDefault, wholeWordsDefault, repeatCurve = 'presence-log', repeatR = 1 } = {}) {
    if (!Array.isArray(keys) || !keys.length) {
        return { score: 0, hits: [] };
    }

    // Inherit the globals exactly as core does (world-info.js matchKeys), or WA matches
    // on different rules than the scan that activated the entry. Core's whole-word
    // default is OFF (substring), so hardcoding true here made WA miss any keyword that
    // only appears inside a larger word.
    const caseSensitive = entry.caseSensitive ?? caseSensitiveDefault;
    const wholeWords = entry.matchWholeWords ?? wholeWordsDefault;

    // A key carrying a fatal validator error scores nothing, the same rule stage 2 applies to
    // activation. Cheap because it is per entry per pass, not per segment, and a plain key returns
    // from validateSmartKey before it tokenises anything.
    keys = usableKeys(keys);
    if (!keys.length) {
        return { score: 0, hits: [] };
    }

    // A bare string is ONE segment, which is what `matchWindow: 'scan'` means — so every caller that
    // has not been taught about segments keeps the pre-setting behaviour rather than an approximation
    // of it. Only the live scan passes an array.
    const segments = Array.isArray(text) ? text : [text];

    // Register every key and scan each segment ONCE (Aho-Corasick); countKey below then answers
    // from that scan instead of walking the buffer per key. Segments are shared across entries in
    // a retrieval pass — and shared BY VALUE, since the cache keys on the string — so after the
    // first entry this is a no-op, and an entry that appends match sources pays only for those.
    // Secondaries are primed alongside the primaries, not on first use: the synthesised tree interns
    // their folded literals, and doing that mid-loop would dirty the automaton and throw away every
    // scan already cached for this window.
    const sec = secondaryKeys(entry);
    if (segments.length) primeScan(sec.length ? [...keys, ...sec] : keys, segments);

    let score = 0;
    const hits = [];
    // key -> (unit id -> pooled unit). Two levels because a key reports ONE hit count to the debug
    // column and the audit, while its score is the sum over however many units it turned out to be.
    const byKey = new Map();

    for (const segment of segments) {
        if (!segment) continue;

        // SECONDARY KEYS GATE THE SCORE, not just activation, and they gate it PER SEGMENT. An entry
        // keyed `cosmonaut` with a secondary `apollo` under AND ANY says it is relevant when both are
        // present; scoring the primary alone credits it for evidence its author said does not count on
        // its own. Whole-window, "both present" degrades to "both mentioned at some point", which is
        // the distance-blindness the match window exists to fix — so a segment that fails its own gate
        // contributes nothing, rather than the whole entry scoring 0 because one segment failed.
        //
        // Core checks this before activating, so for a keyword entry the gate has already passed once —
        // but against CORE's buffer, which is not WA's window (worldsapart.js builds its own), and a
        // force-activated entry was never checked at all. Either way the score is WA's claim about this
        // text, so it is WA's job to make it true of this text.
        //
        // The gate is INSIDE countSelective's expression rather than a separate pass over the segment,
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

    // Occurrences SUM across gate-passing segments and saturate once PER UNIT, rather than per segment
    // or per key: a unit is as repeated as the whole window says it is, and k1 is calibrated against a
    // whole window's counts. For a plain key — one unit — this is arithmetically identical to every
    // version before units existed.
    //
    // A UNIT'S WEIGHT IS ITS MEAN, `wsum/n`, and it multiplies the curve rather than feeding it. That
    // is the difference between `::2` meaning "twice as important" and meaning "as if seen twice":
    // inside the curve a doubling survives as 1.38x, outside it survives as 2x, which is what the
    // author wrote. Repetition still saturates; the author's weight does not.
    // TWO NUMBERS PER KEY, because they answer different questions and one field cannot.
    //
    //   count — how many times this key's terms actually appeared. A COUNT, so `×3` in the debug
    //           column and the WI panel means the text said it three times and nothing else.
    //   score — what the key contributed to the entry. Weights and saturation live here.
    //
    // Σ weighted occurrences, which used to be reported as `count`, is neither: it reads as repetition
    // while carrying weight and expression size, so `? fire::3` on ONE mention displayed the same `×3`
    // as `fire` on three, and a grading row recorded a score under a count's name.
    for (const [key, pooled] of byKey) {
        let count = 0, keyScore = 0;
        for (const u of pooled.values()) {
            keyScore += (u.wsum / u.n) * repeatCurveOf(u.n, k1, repeatCurve, repeatR);
            count += u.n;
        }
        score += keyScore;
        hits.push({ key, count, score: keyScore });
    }

    // Strongest evidence first, which is the SCORE — the debug column exists to say which key earned
    // the entry its place, and a raw count cannot answer that once weights exist.
    hits.sort((a, b) => b.score - a.score);
    return { score, hits };
}

// ---------------------------------------------------------------------------
// Stage 2 — activation verdicts.
//
// WA's matcher decides activation outright: it force-activates every entry whose keys match over WA's
// own window — which core cannot reproduce (`?` SmartKeys have no core semantics; the fold and depth
// are supersets) — and core's own matcher is blanked, so there is no second verdict to reconcile. The
// deletion direction that existed while core still matched went with the ruling. The verdict is
// `keywordScore` hits over the entry's resolved-depth window, so activation, scoring and the audit
// can never disagree about whether a key matched.
// ---------------------------------------------------------------------------

/**
 * Whether the entry carries a decorator, by core's rules (world-info.js parseDecorators):
 * read only when content STARTS with `@@`, one decorator per leading line, stopping at the first
 * non-`@@` line; a `@@@name` line is the fallback form of `@@name`, and core's own test is a
 * bare startsWith on the name.
 *
 * Two entry shapes reach this: raw entries (the ENTRIES_LOADED buckets, fixtures) carry the `@@`
 * lines in `content`; parsed entries (getSortedEntries output — what activationAdds/Prunes see at
 * runtime) carry them in a `decorators` array with content STRIPPED, so the content walk below
 * would always miss. The array is authoritative when present — without this check the runtime guards
 * are inert: `activationAdds` stops seeing `@@dont_activate`, and the takeover blanks a keyed
 * `@@activate` entry's keys, which core's inclusion-group filter reads through `getScore`.
 * ponytail: the `@@@` fallback-chain nuance (it only applies after an unknown decorator) is not
 * mirrored, so this over-detects fallback lines — which errs safe in both callers: over-detecting
 * `@@dont_activate` under-adds, over-detecting `@@activate` under-deletes.
 */
export function hasDecorator(entry, name) {
    if (Array.isArray(entry?.decorators)) {
        return entry.decorators.some(d => String(d).startsWith(name));
    }
    const content = String(entry?.content ?? '');
    if (!content.startsWith('@@')) return false;
    for (const line of content.split('\n')) {
        if (!line.startsWith('@@')) break;
        const bare = line.startsWith('@@@') ? line.slice(1) : line;
        if (bare.startsWith(name)) return true;
    }
    return false;
}

/**
 * `@@promote`: the author declaring that activation alone is sufficient for this entry.
 *
 * NOT KNOWN TO CORE, which is what makes it work: `parseDecorators` strips every leading `@@` line from
 * the injected content but records only the names it knows, so this is stripped for free and never
 * reaches `entry.decorators`. WA reads it at WORLDINFO_ENTRIES_LOADED, before that map, and stashes it.
 *
 * EXACT, not `startsWith`. Core tests its own closed list by prefix; this namespace is open, so a prefix
 * test would claim every future `@@promote_*`. A trailing argument is allowed.
 */
export const isPromoteDecorator = line => /^@@promote(\s|$)/.test(String(line ?? ''));

/** Whether the author promoted this entry, read off RAW content (the ENTRIES_LOADED shape). Returns
 *  false for a parsed entry, whose content core has already stripped — the runtime reads the stash. */
export function hasPromoteDecorator(entry) {
    const content = String(entry?.content ?? '');
    if (!content.startsWith('@@')) return false;
    for (const line of content.split('\n')) {
        if (!line.startsWith('@@')) break;
        if (isPromoteDecorator(line.startsWith('@@@') ? line.slice(1) : line)) return true;
    }
    return false;
}

/**
 * Content with `@@promote` added or removed — what a Studio toggle writes.
 *
 * A CONTENT EDIT, there being no field: core keeps the line in the stored book and strips it only from
 * the copy it injects. REMOVAL TOUCHES THE LEADING RUN ONLY, and adding prepends — order within the run
 * means nothing to core, and a stable position keeps a toggle's diff to one line.
 */
export function withPromote(content, on) {
    const text = String(content ?? '');
    const lines = text.split('\n');
    let end = 0;
    while (end < lines.length && lines[end].startsWith('@@')) end += 1;
    const head = lines.slice(0, end).filter(l => !isPromoteDecorator(l.startsWith('@@@') ? l.slice(1) : l));
    const rest = lines.slice(end);
    if (on) head.unshift('@@promote');
    return [...head, ...rest].join('\n');
}

/**
 * Keys WA will act on at all: non-blank, and no validator ERROR — `negation-only` matches on absence
 * (nearly everywhere), `no-terms` never, `stray-quote` on a phrase whose opening delimiter was
 * swallowed into the first word, so on nothing the author wrote.
 *
 * GATES SCORING AS WELL AS ACTIVATION, which is why it is not called `activatableKeys` any more.
 * Filtering only the stage-2 verdicts left a key WA had declared unfit to fire on still contributing
 * a full hit to the layout ranking — `? -zebra` scoring 1 on every scan where "zebra" is absent,
 * which is nearly all of them. The Studio refuses to write such a key, but core's WI editor knows
 * nothing about `?` keys and an imported book was never asked, so two of the three ways a key enters
 * a book bypass that gate and the runtime is where it has to hold.
 */
export const usableKeys = keys => (Array.isArray(keys) ? keys : [])
    .filter(k => String(k ?? '').trim() && !fatalKey(k));

/**
 * Entries WA force-activates, judged over WA's own window. WA owns activation, so this is the whole
 * keyword verdict for the scan rather than an addition to core's — core's matcher is blanked.
 *
 * `windowFor(depth, entry)` returns the scan segments for a resolved depth — injected because the
 * window is ST-side (chat, injects, per-entry match sources); the caller memoises per depth.
 * Depth resolves as stage 3 already rules it: per-entry `scanDepth`, then `messageDepth`, then
 * `fallbackDepth` (core's world_info_depth, injected) — core's depth is otherwise not consulted.
 *
 * Skips: disabled; `constant` (core activates them without keys — forcing again is provenance
 * noise); `@@dont_activate` (core's own exclusion, which a force-activate would override).
 *
 * VECTORIZED ENTRIES ARE ORDINARY CANDIDATES. A keyword hit on one used to be refused, on the grounds
 * that its cosine had not earned it — but stage 1 admits every vectorized entry it scores, so retrieval
 * has already activated them and the refusal decided nothing. What it decides now is the residue: an
 * entry the wrong-book gate zeroed, or one with no chunk in the collection, which its author keyed and
 * which a key hit is evidence for.
 *
 * `delayUntilRecursion` is NOT skipped: WA emits blindly and lets core reject. Core's gate order checks
 * the delay level before external activations, and the external-activation map persists for the whole
 * scan, so emitting a delayed entry early is exactly how it activates when its level arrives — and under
 * the takeover WA is the only route in, so skipping it would mean the entry never activates at all.
 *
 * `depthSkew` widens the resolved GLOBAL depth, mirroring core's min-activations
 * advanceScan one message per pass. A per-entry `scanDepth` is authored and never skewed, as in
 * core, where the buffer skew only moves the default window.
 *
 * @param {object[]} entries Candidate entries (getSortedEntries shape)
 * @param {(depth: number, entry: object) => string[]} windowFor
 * @param {{messageDepth?: number, fallbackDepth?: number,
 *          caseSensitiveDefault?: boolean, wholeWordsDefault?: boolean, depthSkew?: number}} opts
 * @returns {object[]} entries to force-activate
 */
/**
 * The depth an entry's chat window is scanned at.
 *
 * NULLISH, NOT TRUTHY. `scanDepth: 0` is core's authored "match nothing from chat", so it must not fall
 * through to the globals — an unaltered book has to behave under WA as it does under core. That one
 * distinction is the whole reason this is a named rule rather than an inline `||`.
 *
 * A per-entry `scanDepth` is never skewed: core's min-activations skew widens the DEFAULT window only.
 *
 * @param {object} entry World Info entry
 * @param {number} [messageDepth] WA's own scan depth
 * @param {number} [fallbackDepth] Core's world_info_depth, injected
 * @param {number} [depthSkew] Widening applied to the global depth only
 * @returns {number}
 */
export const scanDepthFor = (entry, messageDepth, fallbackDepth = 0, depthSkew = 0) =>
    Number(entry?.scanDepth ?? ((messageDepth || fallbackDepth) + (depthSkew || 0)));

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


