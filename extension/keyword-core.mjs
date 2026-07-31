// keyword-core.mjs — the pure half of the keyword tools: the prune classifier (buildKeyPruneScan),
// the TF-IDF suggester (buildKeySuggest), the LLM candidate prompt/parser/filter, and their tuning
// constants. ST-free and node-importable (the ranking.mjs pattern) so eval/keyword-extract-check.mjs
// runs the real shipped code instead of string-slicing it; keyword-tools.mjs layers the ST plumbing
// (popups, saving, generation) on top and injects the world-info match flags.
import { COMMON_WORDS } from '../plugin/commonwords.js';
import { countKey, escapeRegex, isRegexKey } from './ranking.mjs';
import { buildAutomaton, scanAutomaton, createScanScope, primeScan } from './smartkeys.mjs';

export const KEY_TOO_COMMON = 0.5;

/** The df-based lorebook-common flag needs a corpus big enough for the ratio to mean something — in a
 * handful of entries "in >37.5% of them" is a coin flip and mislabels genuinely good keys. Below this
 * many scanned entries, skip lorebook-common (English-common still fires; it doesn't lean on df). */
export const KEY_MIN_COMMON_ENTRIES = 10;

/** Keys shorter than this fire on substrings of longer words (e.g. "un" inside "under"), a common
 * false-positive source. Core trims keys before matching, so this measures the trimmed length. */
export const KEY_MIN_LENGTH = 4;

/** Share of the book that may LIST a key before it's flagged. This is activation breadth, a different
 * defect from KEY_TOO_COMMON's firing rate: a key on most entries drags them all in on one hit, however
 * rarely it fires. Deliberately far above the frequency cut, because a shared trigger is usually
 * intentional — a character name on every entry about that character is how continuous memory is
 * authored — so only near-total sharing (where the key can no longer discriminate at all, making it a
 * constant that fires unpredictably) is worth flagging. */
export const KEY_SHARED = 0.75;

/** English function words. Shared by the suggester (which refuses to PROPOSE candidates containing them)
 *  and the prune classifier (which flags existing keys that do) — one list, so the two tools cannot disagree
 *  about what junk looks like. */
export const FUNCTION_WORDS = new Set('a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those it its he she they them his her their you your i we our my me not no do does did has have had will would can could should'.split(' '));

/**
 * A key that reads as a CLAUSE FRAGMENT rather than a name for something.
 *
 * This is the dominant failure of machine-written keys and nothing else in the audit sees it: an entry's
 * auto-generated keys are lifted verbatim from its own prose, so they sit in that entry's text (df 1, not
 * "dead"), appear nowhere else (not "too common", not "shared") and are long (not "short"). Three uncurated
 * entries were measured with 22 keys between them, all with zero hits across 5473 chat messages, and every
 * single one UNFLAGGED.
 *
 * WHAT IT DELIBERATELY DOES NOT CATCH is over-specificity, because that is not decidable from the key and is
 * not the same defect. "dick flag towels" and "epsom salts" are unlikely to recur but they NAME something
 * concrete, so they might; "web not spoke wheel" and "try stuff and see" name nothing and cannot. Coherence
 * is the tractable question and it is the one worth asking. It also keeps the test safe for non-English
 * named entities — "Dia de los Muertos" survives, since `de`/`los` are not English function words.
 *
 * Single words are never fragments (a bare word is a name or it is caught by the English-common flag).
 *
 * TITLE CASE IS EXEMPT, because a capitalised phrase is a name even when it contains a function word:
 * "No Contact Order" and "The Bali Trip" are things, "no script" and "the extra one" are not. Without this
 * the flag fires on legitimate hand-written keys — which is exactly what the check caught.
 *
 * @param {string} key Raw keyword
 * @returns {boolean} True when the key contains an English function word in a multi-word phrase
 */
export function looksLikeFragment(key) {
    const raw = String(key ?? '').trim();
    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every(t => /^[^\p{L}]*\p{Lu}/u.test(t))) return false;   // Title Case = a name
    const words = raw.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? [];
    return words.length > 1 && words.some(w => FUNCTION_WORDS.has(w));
}

/** Baseline English-frequency cut for the too-common flag. A key this common in general English
 * over-fires against the CHAT, not just other entries — a signal lorebook df alone can't see.
 * Sticky reference sheets tolerate more (a bare-name trigger is meant to be ubiquitous), so they
 * test only the head of the frequency-ordered list; keyword/vector entries test all of it.
 * ponytail: rank cut into COMMON_WORDS; retune if words land the wrong side (magic~1725 spared on
 * sticky, home~137/street~497 flagged everywhere). */
const ENGLISH_COMMON_STICKY_CUT = 1000;
const COMMON_HEAD = new Set([...COMMON_WORDS].slice(0, ENGLISH_COMMON_STICKY_CUT));

/**
 * Flag-aware keyword prune analysis for one loaded lorebook — one classifier shared by the Lorebook
 * Studio audit and the offline eval/keyword-audit.mjs, so the audit and the runtime never drift.
 * Returns live closures (classifyEntry re-reads each entry's flags), so a flag toggle just re-runs
 * them; the caches key on (key, caseSensitive, wholeWord) so re-analysis after a toggle is cheap.
 *
 * @param {object} data       loaded world-info object (from loadWorldInfo)
 * @param {object} opts        scan/prune options (see keyword-tools STUDIO_PRUNE_OPTS)
 * @param {Set<string>} ignoreSet  keys whitelisted for this book (skipped by classifyEntry)
 * @param {{caseSensitiveDefault?: boolean, wholeWordsDefault?: boolean}} [matchDefaults]  book-level
 *        match-flag defaults for entries that don't set their own (the extension injects ST's
 *        world-info globals here; harnesses pass nothing and get false/false)
 * @returns {{entries:object[], nE:number, classifyEntry:Function, reasonOf:Function, defChecked:Function, effCase:Function, effWhole:Function}}
 */
export function buildKeyPruneScan(data, opts, ignoreSet, { caseSensitiveDefault = false, wholeWordsDefault = false } = {}) {
    const RED = '#e06c6c', YEL = '#d9b74a', GRN = '#7bbf6a';
    const looksProper = k => k.split(/\s+/).every(t => /^[A-Z]/.test(t));   // Title Case = a name

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
    // Document frequency is measured over the WHOLE book, not just the scanned subset, so "how common is
    // this term" is stable regardless of scan scope — and a key that lives only in an excluded entry
    // (e.g. a constant) isn't falsely flagged dead.
    const contents = allEntries.map(e => String(e.content ?? ''));
    const nBook = allEntries.length;                            // df denominator

    // Key-share frequency: how many entries LIST each key. Same whole-book denominator as content df,
    // for the same reason — "how widely is this term used as a trigger" shouldn't move with scan scope.
    // Deduped per entry so a key repeated within one entry counts once.
    const dfKeys = new Map();
    for (const e of allEntries) {
        for (const k of new Set((Array.isArray(e.key) ? e.key : []).map(x => String(x).trim().toLowerCase()))) {
            if (k) dfKeys.set(k, (dfKeys.get(k) ?? 0) + 1);
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
        for (const c of contents) {
            primeScan(allKeys, c, scanScope);
            for (const key of allKeys) {
                // Still countKey, deliberately: the audit has to report what the runtime matcher will
                // actually do — flags, regex keys and `?` queries included — so the batch only changes
                // how often the text is walked, never how a hit is decided.
                const n = countKey(key, c, cs, ww, scanScope);
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
    const classify = (key, cs, ww, sticky) => {
        const k = String(key).trim();
        // Smart keys ('?' prefix) are boolean queries, not literals — countKey returns weights,
        // not occurrence counts, and negations match nearly everything, so every substring-era
        // heuristic below (df, length, common-word) would misfire. Exempt them like regex keys.
        if (!k || isRegexKey(k) || k.startsWith('?')) return null;
        const dc = scan(k, cs, ww).df;
        // A common-English single word over-fires against chat regardless of lorebook df, so it
        // outranks dead (a word absent from the book's own text still floods it from the chat).
        // Sticky gets the shorter head-of-list cut; keyword/vector test the whole list.
        if (opts.pruneCommon && !/\s/.test(k) && (sticky ? COMMON_HEAD : COMMON_WORDS).has(k.toLowerCase())) return { flag: 'too common', dc, eng: true };
        if (dc === 0 && opts.pruneUnattested && !(opts.ignoreProper && looksProper(k))) return { flag: 'unattested', dc };
        if (nBook >= KEY_MIN_COMMON_ENTRIES && dc / nBook > opts.tooCommon * 0.75 && opts.pruneCommon) return { flag: 'too common', dc };
        // Activation breadth, checked after firing rate: a key can be rare in the prose yet listed on
        // most entries, which the content-df flags above can't see. Same small-corpus guard, since
        // "75% of 4 entries" is as meaningless here as it is there.
        const dk = dfKeys.get(k.toLowerCase()) ?? 0;
        if (nBook >= KEY_MIN_COMMON_ENTRIES && dk / nBook > opts.sharedKeys * 0.75 && opts.pruneShared) return { flag: 'shared', dc, dk };
        if (opts.pruneFragment !== false && looksLikeFragment(k)) return { flag: 'fragment', dc };
        if (k.length < opts.minLength && !ww && opts.pruneShort) return { flag: 'short', dc, clean: strictClean(k, cs), total: scan(k, cs, false).total };
        return null;
    };
    const classifyEntry = e => {
        if (!inScope(e)) return [];
        const cs = effCase(e), ww = effWhole(e);
        const out = [];
        const sticky = Number(e.sticky) > 0;
        for (const key of (Array.isArray(e.key) ? e.key : [])) {
            if (ignoreSet.has(key)) continue;
            const c = classify(key, cs, ww, sticky);
            // Sticky = a reference sheet whose bare-name trigger is meant to be ubiquitous, so spare
            // the df-based too-common (cross-entry ubiquity is expected). The English-common flag
            // still bites — a genuinely generic word (top-1000) is a bad trigger even here.
            if (c && !(c.flag === 'too common' && !c.eng && sticky && opts.stickySkipCommon)) out.push({ uid: e.uid, key, ...c });
        }
        return out;
    };
    // Severity banding, shared by reasonOf, defChecked and the Studio's badge so a key's colour, its
    // pre-ticked state and whether it is counted as a problem can never disagree. Duplicating this was how
    // the tiers drifted: the popup coloured a key yellow while still pre-ticking it for removal.
    const severityOf = p => {
        if (p.flag === 'unattested') return '';
        if (p.flag === 'too common') {
            if (p.eng) return RED;
            return p.dc / nBook >= opts.tooCommon ? RED : YEL;
        }
        if (p.flag === 'shared') return p.dk / nBook >= opts.sharedKeys ? RED : YEL;
        // RED, not yellow, and not conditioned on who wrote the key: a clause fragment is a bad trigger
        // whoever authored it. Curated books contain them too ("never let an Alpha tie" survived a human
        // pass and still is not a good key), so deferring to the author here would just preserve the
        // mistakes the author already missed. The ignore list is the escape hatch for a deliberate one —
        // classifyEntry skips anything in ignoreSet, permanently and per book.
        if (p.flag === 'fragment') return RED;
        const ratio = p.total ? p.clean / p.total : 0;
        return ratio >= 1 ? GRN : ratio <= 1 / 3 ? RED : YEL;
    };
    // Reason text + severity colour (dead is uncoloured).
    const reasonOf = p => {
        const color = severityOf(p);
        if (p.flag === 'unattested') return { text: 'not in entry text', color };
        if (p.flag === 'too common') return p.eng ? { text: 'common', color } : { text: `frequent (${Math.round(100 * p.dc / nBook)}%)`, color };
        if (p.flag === 'shared') return { text: `shared (${Math.round(100 * p.dk / nBook)}%)`, color };
        if (p.flag === 'fragment') return { text: 'phrase fragment', color };
        return { text: `short (${p.clean}/${p.total} clean)`, color };
    };
    // WHAT GETS PRE-TICKED IS A CLAIM ABOUT CONFIDENCE, so only the red tier is. Yellow is the 0.75x band:
    // "you might consider acting on this, but it is probably not harming" — a warning, which by definition is
    // the author's call rather than the tool's. Pre-ticking it made "accept the defaults" silently agree to
    // both tiers, and with no bulk control in the prune popup that pre-tick WAS the bulk action.
    //
    // Costs nothing measurable either way: removing the whole yellow band was worth +0.036 nDCG on one graded
    // book and 0.000 / -0.0006 on two others. This is about the tool being honest about its own confidence,
    // not about retrieval.
    //
    // Green (a short key whose every hit is a clean standalone match, so it cannot collide) stays exempt too.
    //
    // DEAD IS PRE-TICKED ONLY ON MACHINE-WRITTEN ENTRIES, because the label measures the wrong corpus and
    // "Unattested" means the key appears in no ENTRY's text — NOT that it will never fire, and whether that
    // matters depends on who wrote it, since keys fire against the CHAT. Over three full chat histories:
    //
    //   on STMemoryBooks entries  12% / 39% / 40% ever appear in the chat, so 60-88% are exactly
    //                             what the flag claims — one-off scene furniture the model scraped
    //                             ("waterproof mattress pad", "quart", "canopy bed") plus incidental
    //                             pop-culture off a simile ("Seinfeld", "Galaxy Quest"). Bulk removal is the
    //                             point of the tool for an unpruned memory book.
    //   on hand-written entries   it is far more likely deliberate — an ALIAS, a name the prose does not use
    //                             because prose uses the canonical form. A public Deltarune book showed
    //                             ~90% aliases ("Toriel's House" for "Dreemurr Residence"); the real finds were
    //                             two typos and two apostrophe-form breaks.
    //
    // So the tool decides where the author didn't, and defers where they did. Everything still SHOWS with its
    // colour; this only controls what "accept the defaults" agrees to.
    const generated = e => e?.stmemorybooks !== undefined || e?.STMB_start !== undefined || e?.stmbArc !== undefined;
    const byUid = new Map(allEntries.map(e => [String(e.uid), e]));
    const defChecked = p => severityOf(p) === RED || (p.flag === 'unattested' && generated(byUid.get(String(p.uid))));

    return { entries, nE, classifyEntry, reasonOf, defChecked, severityOf, effCase, effWhole };
}

// Few-shot examples, shared so the LLM post-filter can drop them unconditionally: a cold small model
// sometimes regurgitates them verbatim instead of reading the entry. The good ones are deliberately
// invented, maximally-specific SEMAPHORES (a name, place, group, event, object — spanning the target
// categories) verified absent from every lorebook, so echoing even ONE is unmistakable — no real
// entry coincidentally yields "quillfeather accord". That's why filtering them can be unconditional.
const KEY_GOOD_EXAMPLES = ['Thaddeus Wexler', 'Marrowford almshouse', 'illinois homesteaders', 'Quillfeather accord', 'brass orrery'];
const KEY_BAD_EXAMPLES = ['kyle confesses', 'makes him feel', 'when kyle reveals', 'the meeting', 'feelings'];

/**
 * Prompt for World Info trigger-keyword extraction from one entry. Framed as the retrieval job the
 * keys actually do (fire when chat text contains them): demands referential noun phrases, bans
 * clauses/verbs/generic words, and few-shots good vs bad with the cases we validated. `avoid` is the
 * book's most-ubiquitous terms — worthless as discriminators — so the model doesn't waste picks.
 */
export function buildKeyPrompt(entryText, avoid) {
    return [
        'You extract World Info trigger keywords for a roleplay lorebook.',
        'A keyword ACTIVATES this entry when the chat text contains it, so a good keyword is what a user or character would actually type when this entry becomes relevant: a referential NOUN PHRASE — a name, place, object, event, or concept.',
        '',
        'Rules:',
        '- Output 5 to 10 keywords, each 1 to 4 words, lowercase unless a proper noun or acronym.',
        '- Prefer concrete nouns and named entities. Include the obvious paraphrase a reader would reach for even if those exact words are not in the text.',
        '- NEVER output a full sentence, clause, or verb phrase (bad: "kyle confesses", "makes him feel").',
        '- NEVER output generic filler or a bare ubiquitous name.',
        avoid.length ? `- These appear in almost every entry and are USELESS as keywords — never use them: ${avoid.join(', ')}.` : '',
        '',
        `Good examples: ${KEY_GOOD_EXAMPLES.join(', ')}.`,
        `Bad examples: ${KEY_BAD_EXAMPLES.join(', ')}.`,
        '',
        'Output ONLY the suggested keywords, one per line, no numbering and no commentary.',
        '',
        'ENTRY:',
        entryText,
    ].filter(Boolean).join('\n');
}

/**
 * Tolerant parse of a small model's keyword list: splits on newlines/commas, strips bullets, numbers,
 * quotes and trailing punctuation, drops blanks and anything sentence-length. Never throws.
 */
export function parseKeyList(raw) {
    return String(raw ?? '')
        .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')   // small models emit curly quotes; fold/canon expect straight
        .split(/[\n,]+/)
        .map(line => line.replace(/^[\s\-*•\d.)\]]+/, '').replace(/["'`.;:]+$/, '').trim())
        .filter(t => t && t.split(/\s+/).length <= 6);
}

// A date is a poor trigger keyword (near-zero recall whole, substring-collides split — "august 1"
// also fires "august 10–19"), even though it earns its place in the entry body for chronology. The
// month-name test requires an adjacent digit so a month word alone survives — "may day gala" stays,
// "may 1" goes. Spelled-out days ("december twenty five") slip through; rare enough to ignore.
const MONTH_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/;
export function isDateLike(term) {
    const t = String(term).toLowerCase();
    if (/\b(?:19|20)\d{2}\b/.test(t)) return true;                     // a 4-digit year
    if (/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(t)) return true;    // numeric date 8/1/2024
    return MONTH_RE.test(t) && /\d/.test(t);                          // month name + a digit
}

/**
 * One filter for a raw model key candidate — the suggest popup's ✨ reroll and the Studio's bulk
 * merge must agree on what counts as junk. Cleans the candidate and returns { term, canon, df,
 * reason }: reason null = keep; 'dupe' and 'echo' are distinguished so callers can report them
 * (already-keyed isn't garbage, a prompt echo warrants a reroll hint), everything else is 'junk'.
 * `isDupe(term, canon)` is caller-supplied — each surface tracks its own already-shown set.
 */
export function classifyLlmCand(cand, { canon, exampleCanon, dfSubstr, N, dfCeil, excludeDates = true, isDupe }) {
    const term = cand.replace(/^["'`]+|["'`]+$/g, '').trim();
    const c = canon(term) || term.toLowerCase();
    if (!term || term.length > 60) return { term, canon: c, reason: 'junk' };
    if (isDupe(term, c)) return { term, canon: c, reason: 'dupe' };
    if (exampleCanon.has(c)) return { term, canon: c, reason: 'echo' };     // pure prompt echo
    if (!c.includes(' ') && COMMON_WORDS.has(c)) return { term, canon: c, reason: 'junk' };   // generic single word
    if (excludeDates && isDateLike(term)) return { term, canon: c, reason: 'junk' };
    const df = dfSubstr(term);
    if (df / N > dfCeil) return { term, canon: c, reason: 'junk' };
    return { term, canon: c, df, reason: null };
}

/**
 * Whole-book TF-IDF keyword suggestion for one loaded lorebook. Ranks each entry's own terms by
 * (term frequency in the entry) x (inverse document frequency across the book): terms that recur
 * in this entry but are rare across the corpus float up as discriminators. Extracted from keywordSuggestReport
 * so the suggest popup and Lorebook Studio share one ranker. capsSeen/mixedSeen (acronym detection)
 * scope per call here — resetting per book, which is more correct than the old function-lifetime set
 * that leaked across a Back-to-a-different-book. Returns canon/dfSubstr/avoid/exampleCanon too, which
 * the ✨ local-model path and inline chip edits need.
 *
 * @param {object} data   loaded world-info object (from loadWorldInfo)
 * @param {object} opts    { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap }
 * @returns {{entries:object[], N:number, perEntry:object[], canon:Function, dfSubstr:Function, avoid:string[], exampleCanon:Set<string>}}
 */
export function buildKeySuggest(data, opts) {
    const { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap } = opts;
    const STOP = FUNCTION_WORDS;
    const fold = w => { w = w.replace(/^['-]+|['-]+$/g, ''); return w.endsWith("'s") ? w.slice(0, -2) : w; };
    // Acronym casing (see notes): a token seen only in ALL-CAPS (SDG) is an acronym, exempt from the
    // short-word cut and shown uppercase; one ever seen lowercase isn't.
    const capsSeen = new Set(), mixedSeen = new Set();
    const isAcr = t => t.length <= 6 && capsSeen.has(t) && !mixedSeen.has(t);
    const wordSeq = text => (String(text ?? '').match(/[\p{L}][\p{L}'-]+/gu) ?? []).map(w => {
        const core = fold(w);
        (/^[A-Z]{2,}$/.test(core) ? capsSeen : mixedSeen).add(core.toLowerCase());
        return core.toLowerCase();
    });
    const canon = k => (String(k).match(/[\p{L}][\p{L}'-]+/gu) ?? []).map(w => fold(w).toLowerCase()).join(' ');

    const entries = Object.values(data.entries).filter(e => !(onlyActive && e.disable));
    const N = entries.length;

    // Corpus pre-pass (once): word sequences + derived function words + distributional head-POS.
    const seqs = entries.map(e => wordSeq(e.content));
    const uDF = new Map(), uCF = new Map();
    for (const s of seqs) { for (const t of new Set(s)) uDF.set(t, (uDF.get(t) ?? 0) + 1); for (const t of s) uCF.set(t, (uCF.get(t) ?? 0) + 1); }
    const isFunc = t => STOP.has(t) || ((uDF.get(t) ?? 0) / N > 0.3 && (uCF.get(t) ?? 0) / (uDF.get(t) || 1) < 6);
    const satEntity = t => (uDF.get(t) ?? 0) / N > 0.85;
    const DET = new Set('the a an this that his her its their my your our los la el whole each every some'.split(' '));
    const PRON = new Set('he she they i we you it who'.split(' '));
    const bAll = new Map(), bDet = new Map(), bSubj = new Map();
    for (const s of seqs) for (let i = 1; i < s.length; i++) {
        const t = s[i], p = s[i - 1];
        bAll.set(t, (bAll.get(t) ?? 0) + 1);
        if (DET.has(p)) bDet.set(t, (bDet.get(t) ?? 0) + 1);
        if (PRON.has(p) || satEntity(p)) bSubj.set(t, (bSubj.get(t) ?? 0) + 1);
    }
    const isVerbHead = t => { const tot = bAll.get(t) ?? 0; return tot >= 5 && (bSubj.get(t) ?? 0) / tot > 0.4 && (bDet.get(t) ?? 0) / tot < 0.1; };
    const headBad = term => { const h = term.slice(term.lastIndexOf(' ') + 1); return satEntity(h) || isVerbHead(h); };
    const ngramsOf = seq => {
        const out = [];
        for (let n = 1; n <= maxN; n++)
            for (let i = 0; i + n <= seq.length; i++) {
                const g = seq.slice(i, i + n);
                if (g.some(t => t.length < 2 || isFunc(t))) continue;
                out.push(g.join(' '));
            }
        return out;
    };
    const DF = new Map();
    for (const s of seqs) for (const t of new Set(ngramsOf(s))) DF.set(t, (DF.get(t) ?? 0) + 1);

    // Substring doc-frequency — how ST's countKey sees a key by default, and what the pruner's
    // too-common check counts. Defined here so suggestForEntry can gate on it; reused by the ✨ path.
    //
    // dfCache is the table the automaton warm-up below fills, NOT a memo of this linear scan: every
    // call from suggestForEntry is a guaranteed hit, because the warm-up collects exactly the terms
    // that reach this gate. The scan-on-miss path survives for terms the warm-up never saw — the ✨
    // path hands classifyLlmCand this same function for model-proposed candidates, and answering 0 for
    // those would quietly switch off their too-common filter. (Answering it term-by-term for the whole
    // build was 97% of this function's runtime on a 327-entry book, hence the warm-up.)
    const contentsLc = entries.map(e => String(e.content ?? '').toLowerCase());
    const dfCache = new Map();
    const dfSubstr = t => {
        const q = String(t).toLowerCase();
        let m = dfCache.get(q);
        if (m === undefined) {
            m = 0;
            for (const c of contentsLc) if (c.includes(q)) m++;
            dfCache.set(q, m);
        }
        return m;
    };

    const tfOf = seq => { const tf = new Map(); for (const t of ngramsOf(seq)) tf.set(t, (tf.get(t) ?? 0) + 1); return tf; };
    const tfs = seqs.map(tfOf);   // computed once; the warm-up below and suggestForEntry both read it

    // Warm dfCache for every term that will reach the substring gate, in ONE pass per document.
    //
    // dfSubstr is the gate on every candidate, and answering it term-by-term means re-reading the whole
    // corpus per term — 97% of this function's runtime on a large book, and still the bulk of it once
    // memoized, because most terms are distinct. Aho-Corasick inverts the loop: build one automaton over
    // all candidates, then each document reports every term it contains in a single walk, so the cost is
    // (corpus + patterns) instead of (terms x corpus). Same numbers, just not recomputed per term.
    {
        const wanted = new Set();
        for (const tf of tfs) {
            for (const [term, f] of tf) {
                if (f < 2) continue;
                if ((DF.get(term) ?? 1) / N > dfCeil) continue;   // the cheap gate that precedes it
                wanted.add(term.toLowerCase());
            }
        }
        if (wanted.size) {
            const terms = [...wanted];
            const aut = buildAutomaton(terms);
            const hits = new Int32Array(terms.length);
            for (const c of contentsLc) for (const idx of scanAutomaton(aut, c).keys()) hits[idx]++;
            terms.forEach((t, i) => dfCache.set(t, hits[i]));
        }
    }

    // Per-entry TF-IDF: distinctive terms, ranked, subsumed, split into new vs already-keyed.
    const suggestForEntry = (entry, tf) => {
        const existing = new Set((entry.key ?? []).map(canon));
        const rows = [];
        for (const [term, f] of tf) {
            if (f < 2) continue;
            const df = DF.get(term) ?? 1;
            if (df / N > dfCeil) continue;
            // Too-common guard: never suggest a term the pruner would then flag. Checked on the
            // substring df (the metric countKey uses), against the pruner's danger threshold. Only
            // too-common is cross-checked — dead can't apply (the term is in this entry's text) and
            // short is the toggle below.
            if (dfSubstr(term) / N > KEY_TOO_COMMON * 0.75) continue;
            const n = term.split(' ').length;
            if (excludeShort && n === 1 && term.length <= 3 && !isAcr(term)) continue;
            // Background-frequency cut (unigrams only): a word common in general English is a poor
            // key even when locally rare — a small book makes "street" look distinctive. Phrases
            // keep their specificity, so this is single-word only; acronyms are never common words.
            if (n === 1 && !isAcr(term) && COMMON_WORDS.has(term)) continue;
            if (!isAcr(term) && headBad(term)) continue;
            if (excludeDates && isDateLike(term)) continue;
            rows.push({ term, display: isAcr(term) ? term.toUpperCase() : term, present: existing.has(term), df, f, n, score: f * Math.log((N + 1) / (df + 0.5)) * (1 + 0.5 * (n - 1)) });
        }
        rows.sort((a, b) => b.score - a.score);
        const kept = rows.filter(r => !rows.some(o => o !== r && o.n > r.n && o.f === r.f && ` ${o.term} `.includes(` ${r.term} `)));
        // Batch triage: cap the per-entry paragraph to the strongest few so it stays scannable
        // (a focused entry can pull more via ✨). Score-sorted, so the cut only sheds the weak tail.
        return { existing, newRows: kept.filter(r => !r.present).slice(0, cap), keyedRows: kept.filter(r => r.present) };
    };

    const perEntry = entries.map((entry, i) => ({ entry, ...suggestForEntry(entry, tfs[i]) })).filter(pe => pe.newRows.length);

    // For the ✨ per-entry local-model path (lazy: only fires on click).
    const avoid = [...uDF].filter(([t, c]) => t.length > 2 && !STOP.has(t) && c / N > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 20).map(x => x[0]);
    const exampleCanon = new Set([...KEY_GOOD_EXAMPLES, ...KEY_BAD_EXAMPLES].map(canon));   // drop few-shot echoes

    return { entries, N, perEntry, canon, dfSubstr, avoid, exampleCanon };
}
