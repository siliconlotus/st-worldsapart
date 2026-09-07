// keyword-audit.mjs — the key audit: does an existing key work, and if not why. The prune classifier
// (buildKeyPruneScan) and the predicates its flags rest on. What to propose for an entry that has no
// keys is keyword-suggest.mjs; the two share a junk vocabulary so they cannot disagree, and the
// dependency runs one way — the suggester declines to propose what this file would flag.
//
// ST-free and node-importable so eval/keyword-extract-check.mjs runs the real shipped code;
// keyword-tools.mjs layers the ST plumbing on top and injects the world-info match flags. It reads the
// pipeline — countKey for how a key fires, the name rules in relevance.mjs — and owns none of it.
import { COMMON_WORDS } from '../plugin/commonwords.js';
// The name primitives live with the other name rules; the audit reads them, it does not own them.
import { NAME_PARTICLES } from './relevance.mjs';
import { ZIPF_EN } from './zipf-en.js';
import { countKey, escapeRegex, isRegexKey, secondaryKeys, segment, usableKeys } from './matcher.mjs';
import { createScanScope, parse, primeScan, tokenize, validateSmartKey } from './smartkeys.mjs';


export const KEY_BOOK_COMMON = 0.5;

/** The df-based lorebook-common flag needs a corpus big enough for the ratio to mean something — in a
 * handful of entries "in >37.5% of them" is a coin flip and mislabels genuinely good keys. Below this
 * many scanned entries, skip lorebook-common (English-common still fires; it doesn't lean on df). */
export const KEY_MIN_BOOK_COMMON_ENTRIES = 10;

/** Keys shorter than this fire on substrings of longer words (e.g. "un" inside "under"), a common
 * false-positive source. Core trims keys before matching, so this measures the trimmed length. */
export const KEY_MIN_LENGTH = 4;

/** Share of the book that may list a key before it's flagged. This is activation breadth, a different
 * defect from KEY_BOOK_COMMON's firing rate: a key on most entries drags them all in on one hit, however
 * rarely it fires. Deliberately far above the frequency cut, because a shared trigger is usually
 * intentional — a character name on every entry about that character is how continuous memory is
 * authored — so only near-total sharing is worth flagging. */
export const KEY_BOOK_SHARED = 0.75;

/** Rare-vocabulary Jaccard at which two entries are reported as near-duplicates by the audit.
 *
 * It sits in an empty band rather than on a slope: across the measured books, duplicates and
 * non-duplicates are separated by a gap with nothing in it (K14). What lives below is a continuum of
 * adjacent scenes sharing material — consecutive entries with overlapping STMB spans.
 *
 * Advisory regardless: it colours, it never pre-ticks, and a duplicate below the band would be missed
 * with nothing to say so. */
export const KEY_DUPE_MIN = 0.35;

/** English function words. Shared by the suggester (which refuses to propose candidates containing them)
 *  and the prune classifier (which flags existing keys that do) — one list, so the two tools cannot
 *  disagree about what junk looks like. */
export const FUNCTION_WORDS = new Set('a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those it its he she they them his her their you your i we our my me not no do does did has have had will would can could should'.split(' '));

/**
 * A key that reads as a clause fragment rather than a name for something.
 *
 * This is the dominant failure of machine-written keys and nothing else in the audit sees it: keys lifted
 * verbatim from an entry's own prose sit in that entry's text (df 1, not "dead"), appear nowhere else
 * (not "book common", not "book shared") and are long (not "short") (K14).
 *
 * It deliberately does not catch over-specificity, which is not decidable from the key and is a different
 * defect: "epsom salts" is unlikely to recur but names something concrete, where "try stuff and see"
 * names nothing. Coherence is the tractable question, and testing it that way keeps non-English named
 * entities safe — "Dia de los Muertos" survives, `de`/`los` not being English function words.
 *
 * Single words are never fragments (a bare word is a name or it is caught by the English-common flag).
 *
 * A constructed proper noun is exempt: capitalised tokens at both ends, and every lowercase token
 * between them a name particle. A non-particle lowercase word anywhere, or a lowercase end, is prose —
 * capitalisation is the author's declaration, so a lowercase "church of the sun" is a fragment.
 *
 * @param {string} key Raw keyword
 * @returns {boolean} True when the key contains an English function word in a multi-word phrase
 */
export function looksLikeFragment(key) {
    const raw = String(key ?? '').trim();
    if (looksProper(raw)) return false;
    const words = raw.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? [];
    return words.length > 1 && words.some(w => FUNCTION_WORDS.has(w));
}

/**
 * A key that reads as a proper name: a capitalised frame with a name-particle interior.
 *
 * One test for both consumers — the fragment flag's exemption above and `ignoreProper`'s reprieve from
 * the unattested flag — since they ask the same question of the same kind of string. `\p{Lu}` (not
 * `[A-Z]`) and the particle frame are what the rest of the project means by a name
 * (`relevance.properNounsOf`, `NAME_PARTICLES`).
 *
 * A single capitalised word qualifies: a bare name IS a key, and only the fragment flag needs more than
 * one token, which it tests for itself.
 */
export function looksProper(key) {
    const tokens = String(key ?? '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    const cap = t => /^[^\p{L}]*\p{Lu}/u.test(t);
    return cap(tokens[0]) && cap(tokens[tokens.length - 1])
        && tokens.every(t => cap(t) || NAME_PARTICLES.has(t.toLowerCase()));
}

/**
 * The term a SmartKey's matching surface reduces to under `isLoose`, or null if it has a selective term.
 *
 * The audit's per-key checks read a key as a string, which is meaningless for a SmartKey: the matching
 * surface of `? fire water` is its terms. Walked per term instead, with the two operators pulling in
 * opposite directions —
 *
 *   OR takes the loosest branch: a group fires when any branch does, so one common word opens it on
 *   almost every window — `(your|my|Kyle's)` is as selective as `your` (matcher-design.md, *Quoting is
 *   the single escape*).
 *
 *   AND takes the tightest conjunct: one selective term gates the whole expression, so `? tortoiseshell
 *   glasses` is a good key however common `glasses` is.
 *
 * So a key is flagged only when it has no selective term anywhere — which makes it equivalent to a bare
 * common word, the thing the literal check already refuses.
 *
 * A NOT contributes no firing and a REGEX cannot be judged as a word; both read as selective, since the
 * flag must claim over-firing rather than merely fail to rule it out.
 *
 * `isLoose` is the caller's question about one term — English-common for the word list, book-df for the
 * "everyone in this family is a Sommers" case — so the OR/AND asymmetry exists once.
 *
 * @param {(term: string) => boolean} isLoose
 * @returns {string|null} the loose term the key reduces to, for the reason text
 */
function commonSurfaceOf(node, isLoose) {
    if (!node) return null;
    switch (node.type) {
        // A quoted phrase is a phrase, whatever its words are: `"your husband"` is selective.
        //
        // A case-sensitive capitalised term cannot be the common word — `? ^Mark` never matches `mark` —
        // so the collision the flag asserts is impossible rather than unlikely. That is matcher
        // semantics, which is why it is read here where `looksProper` is not: the literal path
        // deliberately does not spare a capitalised key, since plain `Mark` does match `mark`.
        case 'TERM': {
            const v = String(node.value ?? '').trim();
            if (node.isCaseSensitive && v !== v.toLowerCase()) return null;
            return v && isLoose(v) ? v : null;
        }
        case 'OR': {
            const l = commonSurfaceOf(node.left, isLoose);
            return l ?? commonSurfaceOf(node.right, isLoose);
        }
        case 'AND': {
            const l = commonSurfaceOf(node.left, isLoose);
            if (!l) return null;
            const r = commonSurfaceOf(node.right, isLoose);
            return r ? l : null;
        }
        default: return null;
    }
}

/** `commonSurfaceOf` from the raw key, or null when it does not parse or is not a SmartKey. */
function commonSmartKey(raw, isLoose) {
    if (!String(raw ?? '').trim().startsWith('?')) return null;
    try { return commonSurfaceOf(parse(tokenize(String(raw))), isLoose); } catch { return null; }
}

/** A single word from the English list — the predicate the English-common flag walks with. */
const isEnglishCommon = (list) => (v) => !/\s/.test(v) && list.has(v.toLowerCase());

/** Share of messages a key must match before chat evidence calls it chat-common. Not a fitted threshold
 * — a bound, sitting above the known-good ceiling a curation event established, with margin (K14).
 * Deliberately loose, because what lives above it is mostly legitimate: keys on vectorized entries and
 * main-cast names on sticky sheets, which is how continuous memory is authored (K16).
 *
 * Used only to confirm another flag, never to raise one on its own, and calibrated for that job. A
 * `chat common` flag that raises would exempt constant (an author declaration that the entry is meant to
 * be ubiquitous) but not sticky or vectorized, so this value wants re-reading against what such a flag
 * surfaces rather than being inherited. */
export const KEY_CHAT_COMMON = 0.20;

/**
 * Flag-aware keyword prune analysis for one loaded lorebook — one classifier shared by the Lorebook
 * Studio audit and the offline eval/keyword-audit.mjs, so the audit and the runtime never drift.
 * Returns live closures (classifyEntry re-reads each entry's flags), so a flag toggle just re-runs
 * them; the caches key on (key, caseSensitive, wholeWord) so re-analysis after a toggle is cheap.
 *
 * Names say which corpus, there being two. `bookContent` and `bookListed` are counts of entries, over
 * `nBook`; `chatRate` is a rate, already divided by the message total. Nothing here holds a book-side
 * rate, so a bare identifier is always a count and anything ending `Rate` is always a share.
 *
 * @param {object} data       loaded world-info object (from loadWorldInfo)
 * @param {object} opts        scan/prune options (see keyword-tools STUDIO_PRUNE_OPTS)
 * @param {Set<string>} ignoreSet  keys whitelisted for this book (skipped by classifyEntry)
 * @param {{caseSensitiveDefault?: boolean, wholeWordsDefault?: boolean}} [matchDefaults]  book-level
 *        match-flag defaults for entries that don't set their own (the extension injects ST's
 *        world-info globals here; harnesses pass nothing and get false/false)
 * @param {{messagesWith: Map<string, number>, messages: number}} [chatScan] Per-key counts of MESSAGES
 *   CONTAINING the key, and the denominator — never occurrences, which is the drift `addMessageHits`
 *   exists to prevent. Absent = no chat evidence, and every flag behaves as it did before the signal
 *   existed: this is opt-in evidence the user asked for, not a verdict the tool imposes.
 * @returns {{entries:object[], nE:number, classifyEntry:Function, reasonOf:Function, defChecked:Function,
 *   severityOf:Function, effCase:Function, effWhole:Function, dupes:Map, unusableKeysOf:Function}}
 */
export function buildKeyPruneScan(data, opts, ignoreSet, { caseSensitiveDefault = false, wholeWordsDefault = false, matchWindow = 'scan', chatScan } = {}) {
    // Share of the chat a key matches. Three states, and the last two must not collapse:
    //   undefined  no scan has been run
    //   undefined  a scan ran, but not over this key — runChatScan collects from visibleEntries(),
    //              so changing the Studio's filter afterwards leaves classified keys it never sent
    //   0          scanned, and genuinely silent
    // `chatChecked` reads this to pick the reason text, so conflating the middle case with the last
    // prints "not in entry text or chat" about a key nobody checked.
    const chatRateOf = key => {
        if (!chatScan?.messages) return undefined;
        const n = chatScan.messagesWith?.get(key);
        return n === undefined ? undefined : n / chatScan.messages;
    };
    const RED = '#e06c6c', YEL = '#d9b74a', GRN = '#7bbf6a';

    // constant / vector / keyword are exclusive; sticky rides orthogonally on any of them.
    // Pure predicate, so classifyEntry can re-test it: callers that iterate their OWN entry list
    // (the Studio explorer) would otherwise keep flagging entry classes the scan was told to skip.
    const inScope = e => {
        if (!opts.includeInactive && e.disable) return false;
        if (e.constant) return opts.scanConstant;
        if (e.vectorized) return opts.scanVectorized;
        return opts.scanKeyword;
    };
    const allEntries = Object.values(data.entries);
    const entries = allEntries.filter(inScope);
    const nE = entries.length;                                  // scan targets (which keys get audited)
    // Document frequency is measured over the whole book, not just the scanned subset, so "how common is
    // this term" is stable regardless of scan scope — and a key that lives only in an excluded entry is
    // not falsely flagged dead.
    const contents = allEntries.map(e => String(e.content ?? ''));
    const nBook = allEntries.length;                            // df denominator

    // How many entries list each key. Same whole-book denominator as content df, for the same reason.
    // Deduped per entry so a key repeated within one entry counts once.
    const bookListedBy = new Map();
    for (const e of allEntries) {
        for (const k of new Set((Array.isArray(e.key) ? e.key : []).map(x => String(x).trim().toLowerCase()))) {
            if (k) bookListedBy.set(k, (bookListedBy.get(k) ?? 0) + 1);
        }
    }

    // Occurrence scan under a key's effective flags — the semantics core activates with (countKey
    // mirrors matchKeys). Cached per (key, caseSensitive, wholeWord), so re-analysis after a flag
    // toggle is cheap and the audit agrees with the runtime.
    const scanCache = new Map();
    // Every key in the book, deduped — the batch below primes all of them against one entry's text at a
    // time, so countKey answers from the automaton instead of re-reading the corpus per key.
    const allKeys = [...new Set(allEntries.flatMap(e => (Array.isArray(e.key) ? e.key : []).map(k => String(k).trim())).filter(Boolean))];
    // Its OWN matching scope: the audit primes a few thousand keys against every entry's text, and
    // sharing the retrieval scope would leave all of that in the live automaton for the session.
    const scanScope = createScanScope();
    const ck = (key, cs, ww) => `${cs ? 1 : 0}${ww ? 1 : 0} ${cs ? key : String(key).toLowerCase()}`;
    // Tallied lazily per flag combination, because the answer differs per combination and most books
    // only ever use one. Content-outer, key-inner: one automaton walk per entry serves every key, which
    // is the whole point — the reverse order re-walks the corpus once per key.
    const batched = new Set();
    const runBatch = (cs, ww) => {
        const combo = `${cs ? 1 : 0}${ww ? 1 : 0}`;
        if (batched.has(combo)) return;
        batched.add(combo);
        // Segmented like the scan window, so attested means "attested in some segment" — the same
        // question the runtime asks. df still counts entries, not segments: "how widely is this term
        // used" is a fact about the book and must not move with paragraph length.
        //
        // Measured inert on every book on disk (K5): a literal key cannot span a paragraph break, so it
        // is slice-invariant, and only a multi-term SmartKey can differ.
        for (const c of contents) {
            const segments = segment([c], matchWindow);
            primeScan(allKeys, segments, scanScope);
            for (const key of allKeys) {
                // Still countKey, deliberately: the audit reports what the runtime matcher will do —
                // flags, regex keys and `?` SmartKeys included — so the batch only changes how often
                // the text is walked, never how a hit is decided.
                let n = 0;
                for (const s of segments) n += countKey(key, s, cs, ww, scanScope);
                if (!n) continue;
                const k = ck(key, cs, ww);
                let r = scanCache.get(k);
                if (!r) scanCache.set(k, r = { df: 0, total: 0 });
                r.df++; r.total += n;
            }
        }
    };
    const scan = (key, cs, ww) => {
        runBatch(cs, ww);
        return scanCache.get(ck(key, cs, ww)) ?? { df: 0, total: 0 };
    };
    // Stricter second pass for short keys. Core's boundary is \W (so "000" counts inside
    // "$80,000" — a comma is a boundary), which flatters junk numeric keys. This counts only
    // matches that are NOT swallowed by a longer number: a boundary hit is rejected if a digit
    // sits within the surrounding run of number punctuation ([\d.,$£€¥]). "007" is clean in
    // "Agent 007." but not in "$10,007.08". Answers "will this key pull in a bunch of numbers?"
    const NUMRUN = /[\d.,$£€¥]/;
    const cleanCache = new Map();
    const strictClean = (key, cs) => {
        const ck = `${cs ? 1 : 0} ${cs ? key : String(key).toLowerCase()}`;
        let n = cleanCache.get(ck);
        if (n !== undefined) return n;
        const needle = String(key);
        n = 0;
        if (needle && !/\s/.test(needle) && !isRegexKey(needle)) {
            const re = new RegExp(`(?<!\\w)${escapeRegex(needle)}(?!\\w)`, cs ? 'g' : 'gi');
            for (const hay of contents) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(hay)) !== null) {
                    const start = m.index, end = start + m[0].length;
                    let embedded = false;
                    for (let j = start - 1; j >= 0 && NUMRUN.test(hay[j]); j--) if (hay[j] >= '0' && hay[j] <= '9') { embedded = true; break; }
                    if (!embedded) for (let j = end; j < hay.length && NUMRUN.test(hay[j]); j++) if (hay[j] >= '0' && hay[j] <= '9') { embedded = true; break; }
                    if (!embedded) n++;
                }
            }
        }
        cleanCache.set(ck, n);
        return n;
    };
    const effCase = e => e.caseSensitive ?? caseSensitiveDefault;
    const effWhole = e => e.matchWholeWords ?? wholeWordsDefault;
    // One key → its recommendation (or null). Priority dead, too-common, short. Short is skipped
    // under whole-word matching (no substring collision) and otherwise reports whole-word/total.
    const classify = (key, cs, ww) => {
        const k = String(key).trim();
        if (!k) return null;
        // A key the matcher refuses to run, checked before anything reads the text: it is a fact about
        // the string and outranks every verdict below, which are all evidence about firing. Otherwise
        // `/[/` reads as a key the prose happens not to use rather than one WA drops. usableKeys rather
        // than a validator call, so which codes are fatal in this position stays a matcher.mjs rule; the
        // validator is re-read only for the wording the author sees.
        if (!usableKeys([k]).length) return { flag: 'unusable', code: validateSmartKey(k).find(f => f.severity === 'error')?.code };
        // Neither a SmartKey nor a regex is exempt from the audit: does this key fire, and how often, is
        // answerable for either, because countKey evaluates them against the same text every literal
        // goes through.
        //
        // What does not apply is the heuristics that read the key as a literal string. The matching
        // surface of `? fire water` is its terms and of `/sal(a|e)/` is its pattern, so English-common,
        // fragment and short-key are meaningless against the raw text and are skipped. `total` is
        // meaningless for a SmartKey too — countKey returns a weight, not an occurrence count — but only
        // the short-key check reads it, and that is one of the skipped ones.
        const literal = !k.startsWith('?') && !isRegexKey(k);
        const bookContent = scan(k, cs, ww).df;
        const chatRate = chatRateOf(k);
        // A common-English single word over-fires against chat regardless of lorebook df, so it
        // outranks dead (a word absent from the book's own text still floods it from the chat).
        //
        // The flag is the assertion that it over-fires; a chat scan is the evidence. Measured on
        // uncurated books, very few English-flagged keys fire broadly (K14) — the rest are proper nouns
        // colliding with common words or generic words this story does not use. So the flag stands when
        // unevidenced and severityOf reads `chatRate` to decide how loudly; it is not suppressed by a
        // quiet chat, since absence of over-firing is not evidence the word denotes anything.
        //
        // A SmartKey is judged on its terms: commonSurfaceOf reports the common word it reduces to, or
        // nothing if any term is selective.
        if (opts.pruneCommon) {
            if (literal && !/\s/.test(k) && COMMON_WORDS.has(k.toLowerCase())) return { flag: 'english common', bookContent, chatRate };
            // `term` only on this path: naming it beside a literal key would just repeat the key.
            const term = literal ? null : commonSmartKey(k, isEnglishCommon(COMMON_WORDS));
            if (term) return { flag: 'english common', term, bookContent, chatRate };
        }
        // ignoreProper spares a capitalised key from the dead flag on the grounds it is a name the chat
        // will use. A SmartKey is not a name, so it gets no such reprieve — one that never evaluates
        // true anywhere is exactly the broken-key case the audit exists to surface.
        //
        // A key the chat uses is not dead, whatever the book's own prose does — so the flag is dropped
        // rather than annotated, which is what reaches the Explorer: an unflagged key renders green
        // there, where a flagged-dead one is dimmed and unlabelled. Still reachable under show-all.
        if (bookContent === 0 && opts.pruneUnattested && !(literal && opts.ignoreProper && looksProper(k)) && !chatRate) return { flag: 'unattested', bookContent, literal, chatChecked: chatRate !== undefined };
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && bookContent / nBook > opts.bookCommon * 0.75 && opts.pruneCommon) return { flag: 'book common', bookContent };
        // The same question per term. A SmartKey's own df is the df of the whole expression, so a
        // conjunction with one ubiquitous branch reads as rare, while every occurrence of that branch in
        // the window enters the score as evidence. The flag names which branch, because "book common"
        // against a whole expression is unactionable.
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && !literal && opts.pruneCommon) {
            const term = commonSmartKey(k, v => scan(v, cs, ww).df / nBook > opts.bookCommon * 0.75);
            if (term) return { flag: 'book common', term, bookContent: scan(term, cs, ww).df };
        }
        // Activation breadth, checked after firing rate: a key can be rare in the prose yet listed on
        // most entries, which the content-df flags above can't see. Same small-corpus guard, since
        // "75% of 4 entries" is as meaningless here as it is there.
        const bookListed = bookListedBy.get(k.toLowerCase()) ?? 0;
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && bookListed / nBook > opts.bookShared * 0.75 && opts.pruneShared) return { flag: 'book shared', bookContent, bookListed };
        if (literal && opts.pruneFragment !== false && looksLikeFragment(k)) return { flag: 'fragment', bookContent };
        if (literal && k.length < opts.minLength && !ww && opts.pruneShort) return { flag: 'short', bookContent, clean: strictClean(k, cs), total: scan(k, cs, false).total };
        return null;
    };
    /** Secondary keys the matcher will not act on, with the validator's own message. Primaries need no
     *  such list — `classify` flags them `unusable` and the Explorer paints that on the key's own chip.
     *  A secondary has no chip to land on, so this is the only way its author learns the entry is gating
     *  on fewer keys than they wrote; neither the Studio's save check nor core's WI editor says so.
     *
     *  A set difference against the matcher's own filter, so which codes are fatal here stays a
     *  matcher.mjs rule — `negation-only` is legitimate on a secondary and fatal on a primary. */
    const unusableKeysOf = (e) => {
        // `selective: false` switches the whole list off by declaration — CCv2's "ignored if selective
        // == false". Nothing there is malformed, so the set difference would report every key with no
        // validator finding behind it.
        if (e?.selective === false) return [];
        const live = new Set(secondaryKeys(e));
        return (Array.isArray(e?.keysecondary) ? e.keysecondary : [])
            .filter(k => String(k ?? '').trim() && !live.has(k))
            .map(k => ({ uid: e?.uid, key: k, ...(validateSmartKey(k).find(f => f.severity === 'error') ?? {}) }));
    };
    const classifyEntry = e => {
        if (!inScope(e)) return [];
        const cs = effCase(e), ww = effWhole(e);
        const out = [];
        // Sticky is not read here: it means an armed entry persists once activated, which says nothing
        // about whether a key is a good trigger, so it earns no reprieve from any flag.
        for (const key of (Array.isArray(e.key) ? e.key : [])) {
            if (ignoreSet.has(key)) continue;
            const c = classify(key, cs, ww);
            if (c) out.push({ uid: e.uid, key, ...c });
        }
        return out;
    };
    // Severity banding, shared by reasonOf, defChecked and the Studio's badge so a key's colour, its
    // pre-ticked state and whether it counts as a problem can never disagree.
    const severityOf = p => {
        if (p.flag === 'unattested') return '';
        // Not a heuristic like the rest of this band — the key cannot run, whoever wrote it.
        if (p.flag === 'unusable') return RED;
        // The English list is an assertion about the WORD; a chat scan is evidence about this book's
        // prose. Red once the evidence agrees, yellow while it is only asserted — the same shape the
        // book-side flags have, where severity reads a measured ratio rather than a list membership.
        // Unevidenced it stays yellow rather than red, because the author's call is the one that matters
        // and the flag's precision as an over-firing predictor is low.
        if (p.flag === 'english common') return p.chatRate >= (opts.chatCommon ?? KEY_CHAT_COMMON) ? RED : YEL;
        if (p.flag === 'book common') return p.bookContent / nBook >= opts.bookCommon ? RED : YEL;
        if (p.flag === 'book shared') return p.bookListed / nBook >= opts.bookShared ? RED : YEL;
        // Red, not yellow, and not conditioned on who wrote the key: a clause fragment is a bad trigger
        // whoever authored it, and curated books contain them too, so deferring to the author would
        // preserve the mistakes they already missed. The ignore list is the escape hatch for a
        // deliberate one — classifyEntry skips anything in ignoreSet, permanently and per book.
        if (p.flag === 'fragment') return RED;
        const ratio = p.total ? p.clean / p.total : 0;
        return ratio >= 1 ? GRN : ratio <= 1 / 3 ? RED : YEL;
    };
    // Reason text + severity colour (dead is uncoloured).
    const reasonOf = p => {
        const color = severityOf(p);
        // A SmartKey or a pattern is not "absent from the text" — it evaluated false everywhere, which is
        // the difference someone deciding whether their SmartKey is wrong needs. Say which evidence was
        // checked: "not in entry text" with no chat scan is a much weaker claim than with one.
        if (p.flag === 'unattested') {
            return { text: !p.literal ? 'never matches' : (p.chatChecked ? 'not in entry text or chat' : 'not in entry text'), color };
        }
        // The validator's own code, not a second phrasing of it: the codes are readable already, and a
        // translation table here would drift from the message the Studio's save check shows.
        if (p.flag === 'unusable') return { text: p.code ? `unusable — ${p.code}` : 'unusable', color };
        if (p.flag === 'book common') return { text: `book common${p.term ? ` · ${p.term}` : ''} (${Math.round(100 * p.bookContent / nBook)}%)`, color };
        if (p.flag === 'english common') {
            // The term is named for a SmartKey, or "english common" reads as a claim about the whole
            // expression and the author cannot see which branch opened it.
            const which = p.term ? ` · ${p.term}` : '';
            return { text: p.chatRate === undefined ? `english common${which}` : `english common${which} · ${Math.round(100 * p.chatRate)}% of chat`, color };
        }
        if (p.flag === 'book shared') return { text: `book shared (${Math.round(100 * p.bookListed / nBook)}%)`, color };
        if (p.flag === 'fragment') return { text: 'phrase fragment', color };
        return { text: `short (${p.clean}/${p.total} clean)`, color };
    };
    // What gets pre-ticked is a claim about confidence, so only the red tier is. Yellow is the 0.75x
    // band — a warning, which is the author's call rather than the tool's — and green (a short key whose
    // every hit is a clean standalone match) is exempt too. Costs nothing measurable in retrieval either
    // way (K14): this is about the tool being honest about its own confidence.
    //
    // Unattested is pre-ticked only on machine-written entries, because the label measures the wrong
    // corpus: it means the key appears in no entry's text, not that it will never fire, and keys fire
    // against the chat. The asymmetry is measured (K14):
    //
    //   on STMemoryBooks entries  most unattested keys are what the flag claims — one-off scene
    //                             furniture the model scraped. Bulk removal is the point of the tool.
    //   on hand-written entries   far more likely deliberate — an alias, or a name the prose does not
    //                             use because it uses the canonical form.
    //
    // So the tool decides where the author didn't, and defers where they did. Everything still shows
    // with its colour; this only controls what "accept the defaults" agrees to.
    const generated = e => e?.stmemorybooks !== undefined || e?.STMB_start !== undefined || e?.stmbArc !== undefined;
    const byUid = new Map(allEntries.map(e => [String(e.uid), e]));
    // Not pre-ticked despite being red: every other red flag says the key fires where it should not and
    // deleting it is the fix, where a malformed key wants a correction — so accepting the defaults must
    // not throw the intent away.
    const defChecked = p => p.flag !== 'unusable' && (severityOf(p) === RED || (p.flag === 'unattested' && generated(byUid.get(String(p.uid)))));

    // Near-duplicate entries. Two summaries of one scene split its relevance: both rank mid, neither
    // wins, and no key can separate them because they say the same thing.
    //
    // Similarity is Jaccard over each entry's rare vocabulary, not its words: scene summaries share
    // boilerplate and a recurring cast, so raw word overlap runs high on unrelated pairs (K14).
    //
    // An arc and its member scene are not duplicates — they cover one span at different levels of detail
    // and both are wanted — so those pairs are skipped. Arc-vs-arc still counts.
    //
    // Advisory only: the threshold is calibrated against a single known instance (K14), so it cannot
    // claim the no-false-positive standard the dead-key diagnostic meets, and nothing here feeds
    // defChecked.
    const isArc = e => e?.stmbArc === true || /^\s*\[?\s*arc\b/i.test(String(e?.comment ?? ''));
    const dupeVocab = e => {
        const out = new Set();
        for (const w of String(e.content ?? '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
            if ((ZIPF_EN.get(w) ?? 0) < 3.0) out.add(w);
        }
        return out;
    };
    // ponytail: O(n^2) over in-scope entries — unmeasurable next to the automaton pass above. If a
    // book ever makes this bite, invert it: index rare term -> entries and only compare pairs sharing one.
    const dupes = new Map();
    {
        const cand = entries.filter(e => String(e.content ?? '').length > 200);
        const vocab = cand.map(dupeVocab);
        for (let i = 0; i < cand.length; i++) {
            for (let j = i + 1; j < cand.length; j++) {
                if (isArc(cand[i]) !== isArc(cand[j])) continue;
                const a = vocab[i], b = vocab[j];
                if (!a.size || !b.size) continue;
                let shared = 0;
                for (const w of a) if (b.has(w)) shared++;
                const sim = shared / (a.size + b.size - shared);
                if (sim < KEY_DUPE_MIN) continue;
                for (const [x, y] of [[i, j], [j, i]]) {
                    const list = dupes.get(cand[x].uid) ?? [];
                    list.push({ uid: cand[y].uid, title: String(cand[y].comment ?? '').trim(), sim, disabled: !!cand[y].disable });
                    dupes.set(cand[x].uid, list);
                }
            }
        }
        for (const list of dupes.values()) list.sort((p, q) => q.sim - p.sim);
    }

    return { entries, nE, classifyEntry, reasonOf, defChecked, severityOf, effCase, effWhole, dupes, unusableKeysOf };
}

// Studio scans every entry (all modes, active + inactive) so every entry's keywords get a verdict;
// suggestions use the pruner's own dfCeil so a suggested key can't be one the pruner would then flag.
export const STUDIO_PRUNE_OPTS = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true, ignoreProper: false, bookCommon: KEY_BOOK_COMMON, minLength: KEY_MIN_LENGTH, bookShared: KEY_BOOK_SHARED, chatCommon: KEY_CHAT_COMMON };
