// keyword-core.mjs — the pure half of the keyword tools: the prune classifier (buildKeyPruneScan),
// the TF-IDF suggester (buildKeySuggest), the LLM candidate prompt/parser/filter, and their tuning
// constants. ST-free and node-importable (the ranking.mjs pattern) so eval/keyword-extract-check.mjs
// runs the real shipped code instead of string-slicing it; keyword-tools.mjs layers the ST plumbing
// (popups, saving, generation) on top and injects the world-info match flags.
import { COMMON_WORDS } from '../plugin/commonwords.js';
import { ZIPF_EN, POS_VA, POS_VA_STRICT, POS_ADJ } from './zipf-en.js';
import { countKey, escapeRegex, isRegexKey, segment } from './matcher.mjs';
import { buildAutomaton, scanAutomaton, createScanScope, primeScan } from './smartkeys.mjs';

export const KEY_BOOK_COMMON = 0.5;

/**
 * Fold a term into the form the frequency tables are keyed by. SUBTLEX writes contractions with a
 * straight apostrophe ("isn't" z=4.8, "don't" 5.6); roleplay prose writes U+2019, and so does
 * anything that has been through a smart-quote filter, which is most model output. Unfolded,
 * "isn’t" missed ZIPF_EN and every POS set, scored as maximally rare — the exact inverse of the
 * truth — and reached a real book's suggestions as a key firing in 770 of 16,360 messages.
 *
 * Lookup only. The term itself must keep the apostrophe it was written with: "Kal'thas" is a name
 * rather than a contraction, and the elision rule reads both apostrophes on purpose.
 */
const tblKey = w => w.includes('’') ? w.replace(/’/g, "'") : w;

/** The df-based lorebook-common flag needs a corpus big enough for the ratio to mean something — in a
 * handful of entries "in >37.5% of them" is a coin flip and mislabels genuinely good keys. Below this
 * many scanned entries, skip lorebook-common (English-common still fires; it doesn't lean on df). */
export const KEY_MIN_BOOK_COMMON_ENTRIES = 10;

/** Keys shorter than this fire on substrings of longer words (e.g. "un" inside "under"), a common
 * false-positive source. Core trims keys before matching, so this measures the trimmed length. */
export const KEY_MIN_LENGTH = 4;

/** Share of the book that may LIST a key before it's flagged. This is activation breadth, a different
 * defect from KEY_BOOK_COMMON's firing rate: a key on most entries drags them all in on one hit, however
 * rarely it fires. Deliberately far above the frequency cut, because a shared trigger is usually
 * intentional — a character name on every entry about that character is how continuous memory is
 * authored — so only near-total sharing (where the key can no longer discriminate at all, making it a
 * constant that fires unpredictably) is worth flagging. */
export const KEY_BOOK_SHARED = 0.75;

/** Rare-vocabulary Jaccard at which two entries are reported as near-duplicates by the audit.
 *
 * It sits in an empty band rather than on a slope. Across seven books, disabled entries included, the
 * duplicates score 0.52-1.00 and the highest pair that is NOT one scores 0.294; nothing at all falls
 * between. So the cut is not knife-edge and nothing is hiding just beneath it here.
 *
 * What lives below is a continuum of adjacent scenes sharing material — the near-misses are all
 * consecutive entries with overlapping STMB spans, e.g. "Part 16"/"Part 17" of one sequence at 0.200.
 * The flagged consecutive splits are the same shape with far more overlap, which is why they read as
 * one scene cut in two rather than two scenes that touch.
 *
 * Advisory regardless: it colours, it never pre-ticks, and a duplicate below the band would be missed
 * with nothing to say so. */
export const KEY_DUPE_MIN = 0.35;

/** English function words. Shared by the suggester (which refuses to PROPOSE candidates containing them)
 *  and the prune classifier (which flags existing keys that do) — one list, so the two tools cannot disagree
 *  about what junk looks like. */
export const FUNCTION_WORDS = new Set('a an the and or but if then else for to of in on at by with from as is are was were be been being this that these those it its he she they them his her their you your i we our my me not no do does did has have had will would can could should'.split(' '));

/**
 * A key that reads as a CLAUSE FRAGMENT rather than a name for something.
 *
 * This is the dominant failure of machine-written keys and nothing else in the audit sees it: an entry's
 * auto-generated keys are lifted verbatim from its own prose, so they sit in that entry's text (df 1, not
 * "dead"), appear nowhere else (not "book common", not "book shared") and are long (not "short"). Three uncurated
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
/** Share of messages a key must match before chat evidence calls it chat-common. Not a fitted
 * threshold — a bound. Measured on Richard's curation event, no key the author kept fired above 11%,
 * so 20% sits above the known-good ceiling with margin. It is deliberately loose because what lives
 * above it is mostly legitimate: of 20 keys over 20% across seven books, 8 were on vectorized entries
 * (blanked by suppressVectorKeys) and most of the rest were main-cast names on sticky sheets, which is
 * how continuous memory is authored.
 *
 * Used only to CONFIRM another flag, never to raise one on its own — and the value is calibrated for
 * that job. A `chat common` flag that RAISES would first exclude the entries that make the band
 * legitimate (constant, sticky, vectorized), which removes most of the population the 20% was set
 * loose to accommodate, so the threshold wants re-reading against what survives rather than
 * inheriting this one. */
export const KEY_CHAT_COMMON = 0.20;

/**
 * NAMES SAY WHICH CORPUS, because there are two and the old ones did not. `bookContent` and
 * `bookListed` are COUNTS of entries, over `nBook`; `chatRate` is a RATE, already divided by the
 * message total. Nothing here holds a book-side rate — those divisions are inline and read as
 * divisions — so a bare identifier is always a count and anything ending `Rate` is always a share.
 *
 * @param {{messagesWith: Map<string, number>, messages: number}} [chatScan] Per-key counts of MESSAGES
 *   CONTAINING the key, and the denominator — never occurrences, which is the drift `addMessageHits`
 *   exists to prevent. Absent = no chat evidence, and every flag behaves as it did before the signal
 *   existed: this is opt-in evidence the user asked for, not a verdict the tool imposes.
 */
export function buildKeyPruneScan(data, opts, ignoreSet, { caseSensitiveDefault = false, wholeWordsDefault = false, matchWindow = 'scan', chatScan } = {}) {
    // Share of the chat a key matches. THREE states, and the last two must not collapse:
    //   undefined  no scan has been run
    //   undefined  a scan ran, but not over THIS key — runChatScan collects from visibleEntries(),
    //              so changing the Studio's filter afterwards leaves classified keys it never sent
    //   0          scanned, and genuinely silent
    // `chatChecked` reads this to pick the reason text, so conflating the middle case with the last
    // prints "not in entry text or chat" about a key nobody checked — the strong claim on the weak
    // evidence, which is what that label exists to prevent.
    const chatRateOf = key => {
        if (!chatScan?.messages) return undefined;
        const n = chatScan.messagesWith?.get(key);
        return n === undefined ? undefined : n / chatScan.messages;
    };
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

    // How many entries LIST each key. Same whole-book denominator as content df, for the same reason —
    // "how widely is this term used as a trigger" shouldn't move with scan scope.
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
        // Segmented like the scan window, so ATTESTED means "attested in some segment" — the same
        // question the runtime asks. A key whose terms never land in one paragraph will never fire at
        // that setting, and reporting it as attested would be the audit telling the author their key
        // works. df still counts ENTRIES, not segments: "how widely is this term used" is a fact about
        // the book, per the note above, and must not start moving with paragraph length.
        //
        // Measured inert on every book on disk: 8 books, 8,970 distinct keys (6,353 of them multi-word),
        // 0 keys change df and 0 change their occurrence total. A literal key cannot span a paragraph
        // break, so it is slice-invariant; only a multi-term SmartKey can differ, and those are the keys
        // whose unsegmented answer was wrong.
        for (const c of contents) {
            const segments = segment([c], matchWindow);
            primeScan(allKeys, segments, scanScope);
            for (const key of allKeys) {
                // Still countKey, deliberately: the audit has to report what the runtime matcher will
                // actually do — flags, regex keys and `?` SmartKeys included — so the batch only changes
                // how often the text is walked, never how a hit is decided.
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
    const classify = (key, cs, ww, sticky) => {
        const k = String(key).trim();
        if (!k) return null;
        // NEITHER A SMARTKEY NOR A REGEX IS EXEMPT FROM THE AUDIT. Both used to be, and both were the
        // wrong cut for the same reason: the question the audit asks — does this key fire, and how
        // often — is perfectly answerable for either, because countKey already evaluates them against
        // the same text every literal goes through. `runBatch` was in fact computing df for both all
        // along, and this line discarded it. A `/\n/` that fires on every multi-line message drew not
        // one word from any tool WA had.
        //
        // What genuinely does not apply is the heuristics that read the key AS A LITERAL STRING. The
        // matching surface of `? fire water` is its terms and of `/sal(a|e)/` is its pattern, not the
        // characters either is written with, so English-common, fragment and short-key are meaningless
        // against the raw text and are skipped. (Per-TERM versions would be meaningful; separate work.)
        // `total` is meaningless for a SmartKey too — countKey returns a weight, not an occurrence
        // count — but only the short-key check reads it, and that is one of the skipped ones.
        const literal = !k.startsWith('?') && !isRegexKey(k);
        const bookContent = scan(k, cs, ww).df;
        const chatRate = chatRateOf(k);
        // A common-English single word over-fires against chat regardless of lorebook df, so it
        // outranks dead (a word absent from the book's own text still floods it from the chat).
        // Sticky gets the shorter head-of-list cut; keyword/vector test the whole list.
        //
        // `eng` is the ASSERTION that it over-fires; a chat scan is the evidence. Measured across the
        // books curation has not touched, 1 of 38 English-flagged keys actually fires broadly — the rest
        // are proper nouns colliding with common words (River, Blue, Angel, Paris) or generic words this
        // story simply does not use. So the flag stands when unevidenced, and severityOf reads `chatRate`
        // to decide how loudly. It is NOT suppressed by a quiet chat: absence of over-firing here is not
        // evidence the word denotes anything, which is the other half of what this flag is claiming.
        if (literal && opts.pruneCommon && !/\s/.test(k) && (sticky ? COMMON_HEAD : COMMON_WORDS).has(k.toLowerCase())) return { flag: 'english common', bookContent, chatRate };
        // ignoreProper spares a capitalised key from the dead flag on the grounds it is a name the chat
        // will use. A SmartKey is not a name, so it gets no such reprieve — one that never evaluates
        // true anywhere is exactly the broken-key case the audit exists to surface.
        //
        // A key the CHAT uses is not dead, whatever the book's own prose does — so the flag is dropped,
        // not annotated. Dropping it is what reaches the EXPLORER: an unflagged key renders green there,
        // where a flagged-dead one is dimmed and unlabelled, so a chat-attested key used to sit greyed
        // out on the surface curation actually happens on. Cleanup had a local patch for this (a green
        // row plus a hit count) which no other surface could see. Still reachable under show-all, listed
        // as unflagged like any other key.
        if (bookContent === 0 && opts.pruneUnattested && !(literal && opts.ignoreProper && looksProper(k)) && !chatRate) return { flag: 'unattested', bookContent, literal, chatChecked: chatRate !== undefined };
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && bookContent / nBook > opts.bookCommon * 0.75 && opts.pruneCommon) return { flag: 'book common', bookContent };
        // Activation breadth, checked after firing rate: a key can be rare in the prose yet listed on
        // most entries, which the content-df flags above can't see. Same small-corpus guard, since
        // "75% of 4 entries" is as meaningless here as it is there.
        const bookListed = bookListedBy.get(k.toLowerCase()) ?? 0;
        if (nBook >= KEY_MIN_BOOK_COMMON_ENTRIES && bookListed / nBook > opts.bookShared * 0.75 && opts.pruneShared) return { flag: 'book shared', bookContent, bookListed };
        if (literal && opts.pruneFragment !== false && looksLikeFragment(k)) return { flag: 'fragment', bookContent };
        if (literal && k.length < opts.minLength && !ww && opts.pruneShort) return { flag: 'short', bookContent, clean: strictClean(k, cs), total: scan(k, cs, false).total };
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
            if (c && !(c.flag === 'book common' && sticky && opts.stickySkipCommon)) out.push({ uid: e.uid, key, ...c });
        }
        return out;
    };
    // Severity banding, shared by reasonOf, defChecked and the Studio's badge so a key's colour, its
    // pre-ticked state and whether it is counted as a problem can never disagree. Duplicating this was how
    // the tiers drifted: the popup coloured a key yellow while still pre-ticking it for removal.
    const severityOf = p => {
        if (p.flag === 'unattested') return '';
        // The English list is an assertion about the WORD; a chat scan is evidence about this book's
        // prose. Red once the evidence agrees, yellow while it is only asserted — the same shape the
        // book-side flags have, where severity reads a measured ratio rather than a list membership.
        // Unevidenced it stays yellow rather than red, because the author's call is the one that matters
        // and the flag's precision as an over-firing predictor is low.
        if (p.flag === 'english common') return p.chatRate >= (opts.chatCommon ?? KEY_CHAT_COMMON) ? RED : YEL;
        if (p.flag === 'book common') return p.bookContent / nBook >= opts.bookCommon ? RED : YEL;
        if (p.flag === 'book shared') return p.bookListed / nBook >= opts.bookShared ? RED : YEL;
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
        // A SmartKey or a pattern is not "absent from the text" — it evaluated false everywhere, a different
        // sentence and the difference matters when someone is deciding whether their SmartKey is wrong.
        // Say WHICH evidence was checked. "not in entry text" with no chat scan is a much weaker claim
        // than with one, and rendering them identically makes the weak version look authoritative —
        // especially now that a chat hit suppresses the flag, so the surviving rows read as stronger.
        if (p.flag === 'unattested') {
            return { text: !p.literal ? 'never matches' : (p.chatChecked ? 'not in entry text or chat' : 'not in entry text'), color };
        }
        if (p.flag === 'book common') return { text: `book common (${Math.round(100 * p.bookContent / nBook)}%)`, color };
        if (p.flag === 'english common') {
            return { text: p.chatRate === undefined ? 'english common' : `english common · ${Math.round(100 * p.chatRate)}% of chat`, color };
        }
        if (p.flag === 'book shared') return { text: `book shared (${Math.round(100 * p.bookListed / nBook)}%)`, color };
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

    // NEAR-DUPLICATE ENTRIES. Two summaries of one scene split its relevance: both rank mid, neither
    // wins, and no key can separate them because they say the same thing. Found by accident in a
    // 334-entry book — one pair, already disabled by hand, with `duplicate breakfast entry` left as a
    // key on the survivor — so it is invisible without a tool.
    //
    // Similarity is Jaccard over each entry's RARE vocabulary, not its words: scene summaries share
    // boilerplate and a recurring cast, and raw overlap reads ~0.6 on unrelated pairs of the same book.
    //
    // AN ARC AND ITS MEMBER SCENE ARE NOT DUPLICATES — they cover one span at different levels of
    // detail and both are wanted, so those pairs are skipped rather than reported. Arc-vs-arc still
    // counts: one book carries two Arc 05 entries with identical text and different title punctuation.
    //
    // ADVISORY ONLY. The threshold is calibrated against a single known instance (0.584, against a
    // 0.289 ceiling across every other pair in that book), so it cannot claim the no-false-positive
    // standard the dead-key diagnostic meets, and nothing here feeds defChecked.
    const isArc = e => e?.stmbArc === true || /^\s*\[?\s*arc\b/i.test(String(e?.comment ?? ''));
    const dupeVocab = e => {
        const out = new Set();
        for (const w of String(e.content ?? '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
            if ((ZIPF_EN.get(w) ?? 0) < 3.0) out.add(w);
        }
        return out;
    };
    // ponytail: O(n^2) over in-scope entries — 55k set intersections on the largest book here and
    // unmeasurable next to the automaton pass above. If a book ever makes this bite, invert it: index
    // rare term -> entries and only compare pairs sharing one.
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

    return { entries, nE, classifyEntry, reasonOf, defChecked, severityOf, effCase, effWhole, dupes };
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
        // SELF-SELECTING COUNT, not a range. Was "5 to 10". A fixed count is the wrong instrument
        // because entries differ in how much key material they hold: any floor is too high for a
        // sparse entry, where the model pads rather than stops, and too low for a rich one.
        // Chosen on WORST-CASE F over five wordings x six model configurations (three local and
        // seeded, three hosted; eval/count-sweep.mjs and eval/nano-sweep.mjs), not because it won
        // any single cell: 5 wins of 6, best mean rank, best floor. The sixth is a tie inside a
        // measured noise floor. The old wording ranked fourth of five and never won a cell.
        //
        // RE-SCORED ACROSS THE BETA SPREAD from the same cached responses (596, hosted arms): it wins
        // the mean at F1, F1.5, F2 and F4, and the worst cell at every beta except F1, where the
        // lowest-yield wording edges it by 0.006 inside that same noise floor. So the choice does not
        // depend on where recall is weighted against precision — which the old "F2" wording implied it
        // might. Caveat that does not move the verdict but should travel with the number: this scores
        // against the books' own keys, which eval-data/README.md is explicit is not a denominator that
        // establishes quality.
        '- Output as many keywords as you are confident about, each 1 to 4 words, lowercase unless a proper noun or acronym.',
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
export function classifyLlmCand(cand, { canon, exampleCanon, exampleWords, entryText = '', dfSubstr, N, dfCeil, excludeDates = true, isDupe }) {
    const term = cand.replace(/^["'`]+|["'`]+$/g, '').trim();
    const c = canon(term) || term.toLowerCase();
    if (!term || term.length > 60) return { term, canon: c, reason: 'junk' };
    if (isDupe(term, c)) return { term, canon: c, reason: 'dupe' };
    if (exampleCanon.has(c)) return { term, canon: c, reason: 'echo' };     // pure prompt echo
    // A model rarely copies a few-shot cleanly: it mangles it ("Marrowford almshouse" ->
    // "marlowford almshouse") or lifts half of one, and either walks straight past the exact-phrase
    // test above. So reject on any WORD of an example — unless the entry's own text uses that word,
    // which makes it the entry's rather than the prompt's ("brass orrery" is a fine key for an entry
    // that has one). The invented sentinels never survive that hatch; real English words do.
    if (exampleWords?.size) {
        const body = String(entryText).toLowerCase();
        if (c.split(' ').some(w => exampleWords.has(w) && !body.includes(w))) return { term, canon: c, reason: 'echo' };
    }
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
 * @param {object} opts    { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap, bgDocs }
 * @returns {{entries:object[], N:number, perEntry:object[], canon:Function, dfSubstr:Function, avoid:string[], exampleCanon:Set<string>, exampleWords:Set<string>}}
 */
export function buildKeySuggest(data, opts) {
    const { dfCeil, maxN, excludeDates, excludeShort, onlyActive, cap, bgDocs = [] } = opts;
    const STOP = FUNCTION_WORDS;
    const fold = w => { w = w.replace(/^['’-]+|['’-]+$/g, ''); return /['’]s$/i.test(w) ? w.slice(0, -2) : w; };
    // Acronym casing (see notes): a token seen only in ALL-CAPS (SDG) is an acronym, exempt from the
    // short-word cut and shown uppercase; one ever seen lowercase isn't. The counts below feed the
    // same trick for proper nouns (isName, defined once the corpus pass has filled them): capitals
    // are only counted MID-sentence, since a sentence-initial one proves nothing — "Nobody" would
    // be a name in a small book. Proper nouns are exempt from the English-frequency gate below
    // ("Jeffrey" is a common word by z but the right key).
    const capsSeen = new Set(), mixedSeen = new Set(), lowerCount = new Map(), capMidCount = new Map();
    const isAcr = t => t.length <= 6 && capsSeen.has(t) && !mixedSeen.has(t);
    // Sentence enders surface as a one-char '.' sentinel: ngramsOf skips any gram holding a token
    // shorter than 2 chars, so no suggested phrase ever bridges a sentence ("…by comparison. Micah
    // frowned…" must not yield "comparison micah"). Newlines and semicolons count as boundaries too.
    // A possessive is the same kind of boundary on BOTH sides: fold strips its 's, so any phrase
    // through it reads ungrammatical and can't literally match the text ("steal Teddy's bronze
    // minotaur" must yield "teddy" + "bronze minotaur", never "steal teddy" — which sneaks past the
    // attestation check as a prefix of "steal teddy's"). Sentinels around the possessor let its
    // unigram survive while no gram may contain it.
    const wordSeq = text => {
        let atStart = true;   // sentence-initial for CAPITALISATION only; a possessive's sentinels don't reset it
        // The word alternative is STAR, not plus: single-letter words must tokenise or the
        // determiner "a" and pronoun "I" are invisible to the syntax tests below (fDet/bSubj) —
        // "Kyle exchanges a look" read as "kyle exchanges look" and the object-side verb test
        // never saw the determiner. Single-letter tokens are still gram-blocked by ngramsOf's
        // length filter, so they act as boundaries in phrases, never as members.
        // Openers (quotes, brackets, dashes, colons, markdown emphasis) reset atStart WITHOUT emitting
        // a sentinel: a capital after one is the start of something quoted or parenthetical, not
        // evidence of a name, but it is not a phrase boundary either. Roleplay prose is mostly
        // dialogue, so without this every «"What…"» and «"Because…"» counted as evidence that those
        // are proper nouns — which then admitted "Kyle what" / "Arthur because" at f=1 and exempted
        // them from the English gate, since a proper anchor zeroes the phrase's z.
        // ponytail: closing quotes reset it too ("Hi," Marjorie said), costing one observation;
        // properness is a ratio over many, so a real name is unharmed by losing a few.
        return (String(text ?? '').match(/[\p{L}][\p{L}'’-]*|[.!?…;\n]|["“”‘’(\[{*_:—–«»]/gu) ?? []).flatMap(w => {
            if (/^[.!?…;\n]$/.test(w)) { atStart = true; return ['.']; }
            if (!/\p{L}/u.test(w)) { atStart = true; return []; }
            const core = fold(w), lc = core.toLowerCase();
            (/^[A-Z]{2,}$/.test(core) ? capsSeen : mixedSeen).add(lc);
            if (/^[\p{Ll}]/u.test(core)) lowerCount.set(lc, (lowerCount.get(lc) ?? 0) + 1);
            else if (!atStart && /^[\p{Lu}]/u.test(core)) capMidCount.set(lc, (capMidCount.get(lc) ?? 0) + 1);
            atStart = false;
            return /['’]s$/i.test(w.replace(/^['’-]+|['’-]+$/g, '')) ? ['.', lc, '.'] : [lc];
        });
    };
    const canon = k => (String(k).match(/[\p{L}][\p{L}'’-]+/gu) ?? []).map(w => fold(w).toLowerCase()).join(' ');

    const entries = Object.values(data.entries).filter(e => !(onlyActive && e.disable));
    const N = entries.length;

    // Corpus pre-pass (once): word sequences + derived function words + distributional head-POS.
    const seqs = entries.map(e => wordSeq(e.content));
    const uDF = new Map(), uCF = new Map();
    for (const s of seqs) { for (const t of new Set(s)) uDF.set(t, (uDF.get(t) ?? 0) + 1); for (const t of s) uCF.set(t, (uCF.get(t) ?? 0) + 1); }
    // ONE properness test, used by every gate that exempts names, and a RATIO rather than "never
    // seen lowercase". That boolean was brittle in exactly one direction: "Marches" is capitalised
    // 397 times and lowercase twice ("he marches"), and those two occurrences were enough to strip
    // its name status. Measured over two books the classes separate cleanly — real names sit at
    // 99.5-100% (marches, aldric, stearns, jeffrey, kyle), junk at 1.6-16.4% (under, what, because,
    // away, coffee) — with "lord" the nearest miss at 91%, correctly below the bar.
    // Sentence-initial capitals are not counted at all: they are punctuation, not spelling.
    // ponytail: 0.95 sits in a wide empty gap; retune only if a real name lands under it.
    const NAME_CAP_RATIO = 0.95;
    const isName = w => {
        if (isAcr(w)) return true;
        // English capitalises exactly one word for grammar rather than properness, and it is the
        // one word the ratio below cannot survive: "I" is never written lowercase, so "I've" scores
        // a perfect 1.0 properness, counts as maximally rare, and rode every gate into a book's
        // suggestions. Contractions of it are the whole exception — "it's" and "hasn't" appear
        // lowercase constantly and are scored on their real frequency.
        if (w === 'i' || /^i['’]/.test(w)) return false;
        const up = capMidCount.get(w) ?? 0, lo = lowerCount.get(w) ?? 0;
        if (up > 0 && up / (up + lo) >= NAME_CAP_RATIO) return true;
        // Weaker evidence for a narrow case: a word NEVER written lowercase, that English has no
        // word for, is a name even without a mid-sentence capital to prove it. Bullet-led entries
        // ("- Tenzing arrives at camp") put a name at the start of every line, and "Tenzing" is
        // seven letters ending in -ing, so the gerund rule ate it outright. Requiring absence from
        // the frequency table is what keeps ordinary sentence-openers ("Nothing", "Rain") out:
        // they are common words, and they appear lowercase elsewhere anyway.
        return lo === 0 && (capsSeen.has(w) || mixedSeen.has(w)) && !ZIPF_EN.has(tblKey(w));
    };
    // A name is never a function word, however ubiquitous. The distributional test looks for
    // domain stopwords — common across entries, rarely repeated within one — and a place name that
    // half the book mentions has exactly that shape: "marches" (48.6% of entries, 3.0 repeats) was
    // being blocked from every n-gram, so "Governor of the Verenthian Marches" could not form at
    // all. "aldric" escaped only by repeating 6.42 times, a hair over the threshold.
    const isFunc = t => STOP.has(t) || ((uDF.get(t) ?? 0) / N > 0.3 && (uCF.get(t) ?? 0) / (uDF.get(t) || 1) < 6 && !isName(t));
    const satEntity = t => (uDF.get(t) ?? 0) / N > 0.85;
    const DET = new Set('the a an this that his her its their my your our los la el whole each every some'.split(' '));
    const PRON = new Set('he she they i we you it who'.split(' '));
    const bAll = new Map(), bDet = new Map(), bSubj = new Map(), fAll = new Map(), fDet = new Map();
    for (const s of seqs) for (let i = 1; i < s.length; i++) {
        const t = s[i], p = s[i - 1];
        bAll.set(t, (bAll.get(t) ?? 0) + 1);
        if (DET.has(p)) bDet.set(t, (bDet.get(t) ?? 0) + 1);
        if (PRON.has(p) || satEntity(p)) bSubj.set(t, (bSubj.get(t) ?? 0) + 1);
        // forward counts: what follows each token (for the object-side verb test below)
        fAll.set(p, (fAll.get(p) ?? 0) + 1);
        if (DET.has(t)) fDet.set(p, (fDet.get(p) ?? 0) + 1);
    }
    const isVerbHead = t => { const tot = bAll.get(t) ?? 0; return tot >= 5 && (bSubj.get(t) ?? 0) / tot > 0.4 && (bDet.get(t) ?? 0) / tot < 0.1; };
    // Verb/adverb tests, three sources, proper nouns and acronyms outranking all of them:
    //  - SUBTLEX dominant-POS: the head takes the >=85% set ("frowned"/"accepts"/"unfolds" at
    //    ~1.0, killing "Jeffrey accepts"-class fragments; noun-ambiguous "hunt"/"mark"/"drew"
    //    fall under the bar). EVERY word takes the >=95% pure-verb set — a pure verb leading or
    //    inside a phrase marks a clause fragment ("watched jeffrey", "jeffrey watched teddy") —
    //    strict enough to spare participle-adjectives leading real noun phrases ("fallen angel",
    //    fallen at .89). Applies to unigrams (the head is the word itself), closing the rare-verb
    //    leak ("reeked") the frequency table can't see.
    //  - Adverb morphology: an out-of-table word in -ily/-ingly/-edly is an adverb SUBTLEX never
    //    saw ("sulkily", "self-deprecatingly", "comfortingly"), bad as head or alone. Suffixes
    //    chosen for precision: plain -ly would kill -ly ADJECTIVES ("gravelly command" leads
    //    with one, and "gravelly" alone is a plausible key); family/lily are in-table, Emily is
    //    proper.
    //  - The book's own syntax: a word consistently FOLLOWED by a determiner takes objects, i.e.
    //    is a transitive verb in this corpus ("exchanges a look" — SUBTLEX tags "exchanges" Noun
    //    1.00, dialogue never verbs it, so only local evidence can). Object-side mirror of
    //    isVerbHead, precise enough to act from 2 observations where subject-side needs 5.
    const inSetOrStem = (set, w) => set.has(tblKey(w)) || stems(w).some(s => set.has(tblKey(s)));
    const notName = w => !isName(w);
    const posBad = (set, w) => inSetOrStem(set, w) && notName(w);
    const advLy = h => h.length >= 6 && /(?:ily|ingly|edly)$/.test(h) && !ZIPF_EN.has(tblKey(h)) && notName(h);
    const takesObj = t => { const tot = fAll.get(t) ?? 0; return tot >= 2 && (fDet.get(t) ?? 0) / tot > 0.5 && notName(t); };
    //  - Shape, for contractions, because nothing else can see them. SUBTLEX gives no dominant PoS
    //    for a single one ("hasn't", "isn't", "don't", "can't", "won't", "didn't", "wasn't" all miss
    //    POS_VA), and the corpus-side test is actively misled: "hasn't" scored 0.50 on the subject
    //    side in one book — correctly a verb — and was then vetoed by three relative-clause "that"s
    //    counting as determiners, which is how "Boulder hasn't" became a candidate. A clitic is a
    //    closed set and needs no evidence. Never key material in ANY position, so it joins the
    //    interior test too: a contraction anywhere means the gram is a clause, not a name.
    const CLITIC = /(?:n['’]t|['’](?:ve|ll|re|d|m|s))$/;
    const headBad = term => {
        const h = term.slice(term.lastIndexOf(' ') + 1);
        if (satEntity(h) || isVerbHead(h) || posBad(POS_VA, h) || takesObj(h) || advLy(h) || CLITIC.test(h)) return true;
        return term.includes(' ') && term.split(' ').some(w => posBad(POS_VA_STRICT, w) || CLITIC.test(w));
    };
    // Name linkers, and the one rule for where they may sit. Both classes may sit INSIDE a gram —
    // without that, "Duke of Thornhaven" and "Dia de los Muertos" could never form, since a
    // function word disqualifies a gram outright. They differ at the EDGES, which is a fact about
    // naming conventions rather than a heuristic: a nobiliary or toponymic particle binds to what
    // follows it and the pair is a name in its own right ("de Morcaster", "de la Cruz", "ibn
    // Suleiman", "von Furstenheim", "La Marzocco", "Los Angeles"), so a particle may also LEAD.
    // English "of X" is a locative that cannot stand without its title — "of Edinburgh" is not a
    // name, "Duke of Edinburgh" is — so English linkers stay interior. Nothing may TRAIL either
    // way: "Marquis de" and "Art of" are windowing accidents in any language.
    //
    // Every other function word still breaks phrases everywhere. The flood of ordinary of-phrases
    // this admits ("glass of wine") is handled downstream: common-anchored phrases gate to zero.
    // Deliberately broader than any one book needs: measured over 38 books only de/la/los/el/van/
    // del/du/da/der/le actually occur, but a missing particle fails SILENTLY — the name fragments
    // into junk and the good key is never offered — so the cheap side of the trade is coverage.
    const PARTICLES = new Set('de del da di du la las le les los el van von der den bin ibn al af av dos das'.split(' '));
    const ENG_LINKERS = new Set(['of', 'the']);
    // French/Italian elision writes the particle onto the name — "d'Orléans", "dell'Arte" — so the
    // tokeniser sees a single word and the particle rules above never get a look at it.
    //
    // Elision happens ONLY before a vowel, which is what separates it from a name that merely
    // contains an apostrophe: "d'Orléans", "d'Artagnan", "l'École" elide, while "D'Vorah" and
    // "K'tharr" cannot — a consonant follows, so no French or Italian particle produced them.
    // Mute h ("l'homme") is deliberately excluded: in a lorebook "D'Hara" is likelier than a
    // French noun, and treating it as a name only costs a redundant row.
    const ELIDED = /^(?:d|l|dell|dall|nell|sull|all|qu)['’]([aeiouyàáâäæèéêëìíîïòóôöœùúûü].*)$/i;
    const LINKERS = new Set([...PARTICLES, ...ENG_LINKERS]);
    const linkerPosOk = (t, j, n) => PARTICLES.has(t) ? j < n - 1 : (j > 0 && j < n - 1);
    const edgeIllegal = ws => [0, ws.length - 1].some(j => LINKERS.has(ws[j]) && !linkerPosOk(ws[j], j, ws.length));
    // maxN counts CONTENT words: linkers are grammar, not meaning, so they neither consume the
    // phrase budget nor earn the length bonus in the score. "Island of the Dome of the Slate" is
    // seven tokens of which three mean anything, and a budget spent on "of the of the" is how a
    // name like that ends up represented by a window across its middle.
    const contentLen = term => { let n = 0; for (const w of term.split(' ')) if (!LINKERS.has(w)) n++; return n; };
    // Accessor variety, recorded while the grams are enumerated: '' once two different tokens have
    // followed this gram. A gram left holding a single successor is a prefix of something longer,
    // not a unit — "order of the unconquered" is only ever followed by "sun". The '.' sentinel
    // counts as a successor, since a phrase that can end a sentence is complete.
    // Recorded on ONE pass (the df sweep below passes record=true) — the tf pass re-enumerates the
    // same grams, and double counting would make a single occurrence look like corroboration.
    const SUCC = new Map();
    const ngramsOf = (seq, record = false) => {
        const out = [];
        const blocked = t => t.length < 2 || isFunc(t);
        for (let i = 0; i < seq.length; i++) {
            if (blocked(seq[i]) && !PARTICLES.has(seq[i])) continue;   // only a particle may lead
            let content = 0;
            for (let j = i; j < seq.length; j++) {
                const t = seq[j], link = LINKERS.has(t);
                if (blocked(t) && !link) break;        // nothing longer can be valid either
                if (!link) content++;
                if (content > maxN) break;
                if (link) continue;                    // never emit a gram ending on a linker
                const gram = seq.slice(i, j + 1).join(' ');
                if (record) {
                    const nxt = seq[j + 1] ?? '.', rec = SUCC.get(gram);
                    if (rec === undefined) SUCC.set(gram, { s: nxt, n: 1 });
                    else { rec.n++; if (rec.s !== nxt) rec.s = ''; }
                }
                out.push(gram);
            }
        }
        return out;
    };
    const DF = new Map();
    for (const s of seqs) for (const t of new Set(ngramsOf(s, true))) DF.set(t, (DF.get(t) ?? 0) + 1);

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

    // Display casing comes from the TEXT, not from per-word evidence: corpus-global properness
    // cased "Queen Winnifred" as "queen Winnifred" whenever "queen" also appeared lowercase
    // somewhere else in the book. Every surviving candidate is attested as a literal substring, so
    // its own surface span exists — take it verbatim (which also renders "McTavish", "HR" and
    // interior linkers right, for free).
    //
    // Take the form the text uses MOST, not the first one found. Machine-written entries open with
    // a shouted markdown header, so "# THE OFFERING-FISH" was beating the dozen lowercase
    // "offering-fish" in the prose below it purely by being first. Occurrences whose capital is
    // POSITIONAL don't get a vote — after a sentence end or a label colon the capital is
    // punctuation rather than spelling — unless they are all there is.
    const SENT_END = /[.!?…;:\n]/, SKIP_BACK = /[ \t"'“”‘’(\[{*_#>-]/;
    const SHOUTED = /[A-Z]{3,}/;
    const tallyForms = (idx, term, voting, all) => {
        const lc = contentsLc[idx], raw = String(entries[idx].content ?? '');
        const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
        for (let p = lc.indexOf(term); p >= 0; p = lc.indexOf(term, p + 1)) {
            const form = raw.slice(p, p + term.length);
            bump(all, form);
            let j = p - 1;
            while (j >= 0 && SKIP_BACK.test(raw[j])) j--;
            if (j >= 0 && !SENT_END.test(raw[j])) bump(voting, form);
        }
    };
    // Most-used form wins; an exact tie goes to the quieter one, because a term that appears once
    // in a header and once in prose ("LIBERTINE ECONOMY" / "Libertine economy") is a term whose
    // header is shouting, not a term that is spelled in capitals.
    const pickForm = (voting, all) => [...(voting.size ? voting : all)]
        .sort((a, b) => (b[1] - a[1]) || (SHOUTED.test(a[0]) ? 1 : 0) - (SHOUTED.test(b[0]) ? 1 : 0))[0]?.[0] ?? null;
    // The book-wide tally is the union over every entry, so it does not depend on which entry asked
    // — worth caching, since an acronym is shouted by definition and would otherwise re-scan the
    // corpus once per entry that suggests it.
    const wideCache = new Map();
    const wideForm = term => {
        let s = wideCache.get(term);
        if (s === undefined) {
            const voting = new Map(), all = new Map();
            for (let k = 0; k < entries.length; k++) tallyForms(k, term, voting, all);
            wideCache.set(term, s = pickForm(voting, all));
        }
        return s;
    };
    const displayOf = (term, idx) => {
        const voting = new Map(), all = new Map();
        tallyForms(idx, term, voting, all);
        const s = pickForm(voting, all);
        // Widen when this entry has nothing, and when what it has is SHOUTED: a header is a single
        // occurrence, and the prose that spells the term normally is often in OTHER entries —
        // "elemental scales" runs 16 times lowercase across the book against one "# ELEMENTAL
        // SCALES" in the entry that produced the candidate.
        return ((s == null || SHOUTED.test(s)) ? wideForm(term) : s) ?? term;
    };

    // English-frequency gate (zipf-en.js): a word common in general English is a poor key even
    // when locally rare — inside a small book "tub" IS unique, and no corpus-internal statistic
    // (df over entries, the chat pool) can know it's mundane; only the language-wide frequency
    // can. Human-curated keys fall into three classes, and each has its own test: PROPER NOUNS
    // (Jeffrey, Rolex — often common words by z) are exempt via isName, scoring 0;
    // UNCOMMON UNIGRAMS (minotaur, orrery) are any word NOT in the table (its floor is z 3.0, so
    // membership itself is the unigram cut — measured: good unigrams like "jubilee" 3.4 overlap
    // junk like "rut" 3.1, so no finer unigram ramp is honest); CONCRETE PHRASES ride on their
    // rarest anchor word ("brass orrery" on "orrery"), gated on a looser ramp — full weight at
    // z<=2.5, dropped at z>=3.8 — because a phrase can't fire more often than its rarest word,
    // yet is worth more than that word alone (the length boost in the score).
    // ponytail: constants eyeballed off one book's junk band + the class examples; retune there.
    // Gerund budge: a lowercase non-proper -ing word is almost always a verb form ("solidifying",
    // rare by z yet a junk key), so it inherits a junk-band pseudo-z instead of its own. Legit
    // -ing keys are capitalised in prose ("the Reckoning") and exempted before this fires.
    // ponytail: suffix test, no stemming; rare lowercase -ing NOUNS ("bloodletting") are casualties.
    const isGer = w => w.length >= 6 && w.endsWith('ing');
    // Naive de-inflection for the table lookup: "unfolds"/"frowned" are out-of-table while their
    // stems are common — an inflection is as mundane as its stem, so an out-of-table word tries
    // the obvious strippings (-s/-es/-ied, -ing/-ed with e-restore and un-doubling) and inherits
    // the best stem hit. Only consulted on a table miss, so irregulars and real rare words
    // ("olusanmokun") are untouched; rare stems ("reeked" -> reek) still slip through.
    const stems = w => {
        const out = [], undouble = b => (b.length > 2 && b.at(-1) === b.at(-2)) ? b.slice(0, -1) : null;
        const vb = b => { out.push(b, b + 'e'); const u = undouble(b); if (u) out.push(u); };
        if (w.length >= 6 && w.endsWith('ing')) vb(w.slice(0, -3));
        else if (w.length >= 5 && w.endsWith('ed')) vb(w.slice(0, -2));
        else if (w.length >= 5 && w.endsWith('ies')) out.push(w.slice(0, -3) + 'y');
        else if (w.length >= 4 && w.endsWith('s') && !w.endsWith('ss')) { out.push(w.slice(0, -1)); if (w.endsWith('es')) out.push(w.slice(0, -2)); }
        return out;
    };
    const tblZ = w => { let z = ZIPF_EN.get(tblKey(w)); if (z === undefined) { z = 0; for (const s of stems(w)) z = Math.max(z, ZIPF_EN.get(tblKey(s)) ?? 0); } return z; };
    const zEff = w => isName(w) ? 0 : Math.max(tblZ(w), isGer(w) ? 3.8 : 0);
    // Linkers are legal by POSITION (see linkerPosOk above ngramsOf), which is what lets the f=1
    // test admit "Dia de los Muertos" and "de la Cruz" whole instead of killing them and stranding
    // a capitalised anchor ("Muertos" alone).
    // A phrase rides its RAREST word, and a name counts as maximally rare — which is right for
    // "Kyle's Diner" and wrong for "Arthur because", where the name's 0 lets anything ride along.
    // So a phrase also has a ceiling: no word of it may be top-500 English ("because" 6.0, "what"
    // 7.0, "away" 5.9), because those pair with a name only in clause fragments. Names and linkers
    // are exempt — a linker IS a top-500 word, and killing them would take "Duke of Thornhaven" too.
    // ponytail: 5.5 clears the measured junk while sparing content words that key legitimately
    // ("coffee" 5.2 in "Trinity Coffee", "small" 5.1); retune if a real key lands the wrong side.
    const PHRASE_WORD_CEIL = 5.5;
    const engMultOf = term => {
        const words = term.split(' ');
        let minZ = Infinity;
        for (const w of words) {
            minZ = Math.min(minZ, zEff(w));
            if (words.length > 1 && !LINKERS.has(w) && !isName(w) && tblZ(w) >= PHRASE_WORD_CEIL) return 0;
        }
        return (words.length === 1 && minZ >= 3.0) ? 0 : Math.min(1, Math.max(0, (3.8 - minZ) / 1.3));
    };
    // TF is a repetition signal, and a summary-style entry mentions each entity exactly once — on
    // those, f>=2 rejects everything good ("Olusanmokun", "Mobius Industries") before any other
    // gate runs. It predates the English gate and was doing junk control the gate now does better,
    // so single-mention terms are admitted — under a STRICTER test than the f>=2 gate: with no
    // repetition to corroborate, every word must independently look name-like — capitalised
    // mid-sentence ("Corporation" in "Stearns Corporation", even if lowercase elsewhere), an
    // acronym, or absent from the English table. Min-anchor is not enough at f=1: it would let
    // any tail glue onto a rare anchor ("sarah olusanmokun arrived") and then subsume the clean
    // name, since at f=1 every adjacent pair co-occurs trivially.
    const TITLES = new Set('mr mrs ms mx dr st jr sr prof rev sgt capt lt col gen'.split(' '));
    const admit = (term, f) => {
        if (f >= 2) return true;
        const ws = term.split(' ');
        return ws.every((w, i) => (LINKERS.has(w) && linkerPosOk(w, i, ws.length)) || isName(w) || (tblZ(w) < 3.0 && !isGer(w)));
    };

    // Warm dfCache for every term that will reach the substring gate, in ONE pass per document.
    //
    // dfSubstr is the gate on every candidate, and answering it term-by-term means re-reading the whole
    // corpus per term — 97% of this function's runtime on a large book, and still the bulk of it once
    // memoized, because most terms are distinct. Aho-Corasick inverts the loop: build one automaton over
    // all candidates, then each document reports every term it contains in a single walk, so the cost is
    // (corpus + patterns) instead of (terms x corpus). Same numbers, just not recomputed per term.
    // Background pseudo-documents (the open chat's messages, injected by the caller so this stays
    // ST-free) pooled into the IDF denominator. On a small book nearly every candidate has df 1, the
    // IDF is flat, and the ranking degenerates to raw term frequency — which is how "tub, rut,
    // leaking" top a short entry. A few thousand chat messages restore resolution: a term common in
    // ordinary chat prose is demoted (it would over-fire as a trigger anyway), a term genuinely
    // unique to the entry keeps a large IDF. Empty bgDocs = the old book-only behaviour.
    const bgLc = bgDocs.map(d => String(d).toLowerCase());
    const M = bgLc.length;
    const bgDF = new Map();
    {
        const wanted = new Set();
        for (const tf of tfs) {
            for (const [term, f] of tf) {
                if (!admit(term, f)) continue;
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
            if (M) {
                const bg = new Int32Array(terms.length);
                for (const c of bgLc) for (const idx of scanAutomaton(aut, c).keys()) bg[idx]++;
                terms.forEach((t, i) => bgDF.set(t, bg[i]));
            }
        }
    }

    // Cohesion: cover the gram with its LEADING and TRAILING bigram and ask whether those live
    // independently of it. For a trigram the two overlap on the middle word (ABC -> AB + BC), for a
    // tetragram they tile it exactly (ABCD -> AB + CD); either way each covers one occurrence of the
    // whole, so the ratio pins at 0.5 when the parts never appear apart and collapses toward 0 when
    // they do. Counted over the entries AND the chat, because a name's real independence shows up in
    // conversation, not in a 300-entry book. Splitting a trigram down the middle instead (A | BC)
    // measured far worse — a bare leading word is common on its own for reasons that say nothing
    // about the phrase, and the bands muddied to 0/50/55/68% where the bigram pair reads 8/65/100/100%.
    // ponytail: validated at n=3..4; a longer gram compares only its shoulders, which errs toward
    // keeping it. Revisit if maxN above 4 becomes a real setting rather than a knob.
    const bgCache = new Map();
    const bgCount = t => {
        const q = t.toLowerCase();
        let v = bgCache.get(q);
        if (v === undefined) { v = 0; for (const c of bgLc) if (c.includes(q)) v++; bgCache.set(q, v); }
        return v;
    };
    const cohCache = new Map();
    const cohesion = term => {
        let v = cohCache.get(term);
        if (v !== undefined) return v;
        const w = term.split(' ');
        const docs = t => dfSubstr(t) + bgCount(t);
        // Only parts that could THEMSELVES be offered count as alternatives. Measured on two books,
        // 13/84 and 31/102 of the grams this rule dropped were being counted against an illegal
        // part ("Bishop of", "de Montclair" before particles were allowed to lead) and so vanished
        // with nothing put in their place. A gram no legal part can replace is indivisible: keep it,
        // which is precisely the "Bishop of Queensgrace" / "Duke of Edinburgh" case.
        const parts = [w.slice(0, 2), w.slice(-2)].filter(p => !edgeIllegal(p)).map(p => docs(p.join(' ')));
        // Against the BEST alternative, doubled so the ceiling stays 0.5 however many parts qualify:
        // a part that never occurs without the whole counts once per occurrence of it.
        const best = Math.max(0, ...parts);
        cohCache.set(term, v = best ? Math.max(1, docs(term)) / (2 * best) : 1);
        return v;
    };
    // Per-entry TF-IDF: distinctive terms, ranked, subsumed, split into new vs already-keyed.
    //
    // Subsumption used to be "at equal frequency the longer gram wins", on the assumption that longer
    // is more specific. Specificity is worthless if the string never appears: measured over one book
    // and its 5598-message chat, a half of an INCOHESIVE tetragram out-fires the whole 96% of the
    // time (13% when cohesive), so that rule was trading live keys for dead ones — "arthur baxter"
    // (241 chat hits) discarded in favour of "Kyle FaceTimed Arthur Baxter" (0). The longer gram now
    // has to earn the swap by being a unit; otherwise the contained gram wins and IT swallows the
    // long one, so the pair still collapses to a single row.
    // ponytail: measured on n>=3 only, so bigram-over-unigram subsumption keeps the old rule —
    // "Arthur Baxter" beating bare "Arthur" is a call this ratio was never tested on.
    const SUBSUME_COHESION = 0.4;
    const subsume = list => list.filter(r => !list.some(o => {
        if (o === r || o.f !== r.f) return false;
        const [lng, srt] = o.n > r.n ? [o, r] : [r, o];
        if (lng.n === srt.n || !` ${lng.term} `.includes(` ${srt.term} `)) return false;
        if (lng.n < 3 || cohesion(lng.term) >= SUBSUME_COHESION) {
            // A LEADING particle carries almost no meaning, and as a substring key the bare form
            // matches every occurrence of the particle form anyway — "Sacres" catches "de Sacres"
            // and "Marguerite de Sacres" alike. So the particle form gives way to the bare one,
            // but ONLY when what remains is a single distinctive word. "de la Cruz" -> "Cruz" is a
            // bad trade and the frequency table says why: cruz 3.5, santos 3.6, pen 4.4, angeles
            // 4.5 are all common enough to be listed, while sacres, furstenberg, morcaster, vallon
            // and gogh are absent from it entirely. Strip a particle off a name, not off a word.
            const lw = lng.term.split(' ');
            let k = 0; while (k < lw.length && PARTICLES.has(lw[k])) k++;
            if (k > 0 && lw.length - k === 1 && srt.term === lw[k] && !ZIPF_EN.has(tblKey(lw[k]))) return r === lng;
            // Otherwise a unit swallows contained PHRASES, but never a bare word: that word is a
            // different instrument rather than a worse version of the same one — broader, and often
            // the form the chat actually reaches for. Measured, "Ashworth" fires 149 times against
            // 4 for "Evelyn Ashworth", "Raleigh" 134 against 0 for "Raleigh atrium", and roughly a
            // third of swallowed unigrams sat in that band. Both are offered; the choice is the
            // user's.
            if (srt.n === 1) return false;
            return r === srt;
        }
        // Otherwise the long form is an assembly — but only the SHOULDER it decomposes into may
        // take its place. Cohesion judged "chairman of the grain commission" against "grain
        // commission"; the row that displaced it was bare "chairman", which merely happened to
        // share its frequency, and the entry was left with a title reduced to a job word. Anything
        // else contained in it keeps its own row and the pair is offered together, which is what
        // you want from "Governor of the Verenthian Marches" and "Verenthian Marches".
        const w = lng.term.split(' ');
        const isShoulder = srt.term === w.slice(0, 2).join(' ') || srt.term === w.slice(-2).join(' ');
        return isShoulder && r === lng;
    }));
    const suggestForEntry = (entry, tf, idx) => {
        const existing = new Set((entry.key ?? []).map(canon));
        const rows = [];
        for (const [term, f] of tf) {
            if (!admit(term, f)) continue;
            // Edge legality (see PARTICLES/ENG_LINKERS): "marquis de" is a windowing accident either
            // way, "of Edengard" needs its title back, but "de Vallon" is how you actually refer to
            // the man. Whether the full form or the particle form is the better key is then left to
            // the cohesion tiebreak below, on evidence, instead of to a blanket ban.
            const ws = term.split(' ');
            if (edgeIllegal(ws)) continue;
            const df = DF.get(term) ?? 1;
            if (df / N > dfCeil) continue;
            // Pruner cross-checks on the substring df (the metric countKey uses): never suggest a
            // term the pruner would then flag. ZERO hits means the joined gram never occurs
            // literally — token folding bridged punctuation the matcher can't ("Teddy's bronze
            // minotaur" is not the substring "teddy bronze minotaur"), so the key could never fire
            // even on its own source text and would be flagged unattested. Dropping it here also
            // unfolds the recommendation: with the fold-broken long gram gone before subsumption,
            // its legitimate parts ("bronze minotaur", "teddy") surface instead of being swallowed.
            // The high side is the pruner's too-common danger threshold, as before.
            const ds = dfSubstr(term);
            if (!ds || ds / N > KEY_BOOK_COMMON * 0.75) continue;
            const n = term.split(' ').length;
            if (excludeShort && n === 1 && term.length <= 3 && !isAcr(term)) continue;
            if (!isAcr(term) && headBad(term)) continue;
            // Bare adjectives: attributive words over-fire detached from their noun — "voracious"
            // is a poor key while "voracious reader" is fine, so the adjective test applies to
            // unigrams only. Same dominance bar and properness override as the verb sets.
            if (n === 1 && posBad(POS_ADJ, term)) continue;
            // An elided particle gets the same trade as a written one, on the same terms: the bare
            // name matches every elided occurrence as a substring, so prefer it — but only when it
            // is distinctive AND stands on its own IN THIS ENTRY. "d'Orléans" yields to "Orléans"
            // where the entry writes both; "d'Art" keeps its particle because "art" is a common
            // word; "d'Artagnan" keeps it wherever the entry never writes the bare name, since the
            // elided form is a different token and no replacement would appear in its place.
            const el = n === 1 ? term.match(ELIDED) : null;
            if (el && !ZIPF_EN.has(tblKey(el[1])) && tf.has(el[1])) continue;
            // A bare roman numeral is a number, not a name — it reaches here only because an
            // all-caps token looks like an acronym. "Louis XIII" keeps it; "XIII" alone is noise.
            if (n === 1 && /^[ivxlcdm]{2,}$/.test(term)) continue;
            // Bare honorifics: "Mr" passes every capitalisation test (always capitalised, never
            // lowercase — a perfect fake proper noun) yet is junk alone; fine inside "Mr Lansing".
            if (n === 1 && TITLES.has(term)) continue;
            if (excludeDates && isDateLike(term)) continue;
            const engMult = engMultOf(term);   // the three-class English gate — see engMultOf
            if (!engMult) continue;
            // Truncations: a gram with exactly one possible next word is the front of a longer
            // name. Without this the window across a title's middle beats the title — and beats it
            // twice over, because a truncation's shoulders are linker-edged, so cohesion reads it
            // as indivisible while the complete name looks decomposable. Needs two occurrences to
            // say anything: a phrase seen once trivially has one successor, which is how a
            // single-mention name ("Sarah Olusanmokun from Stearns") reads as a truncation.
            const rec = SUCC.get(term);
            if (n > 1 && rec && rec.n >= 2 && rec.s && rec.s !== '.') continue;
            // Un-fold the display (and thus the committed key) from the term's own surface span in
            // the text — see displayOf. Cosmetic under ST's default case-insensitive matching, and
            // matches how humans write keys.
            rows.push({ term, display: displayOf(term, idx), present: existing.has(term), df, f, n,
                score: f * engMult * Math.log((N + M + 1) / (df + (bgDF.get(term) ?? 0) + 0.5)) * (1 + 0.5 * (contentLen(term) - 1)) });
        }
        rows.sort((a, b) => b.score - a.score);
        // A plural adds nothing a substring key can use — "stone-singer" already matches every
        // "stone-singers" — so when both are candidates the singular stands alone. Same shape of
        // argument as the particle rule: prefer the form that matches a superset of the text.
        const have = new Set(rows.map(r => r.term));
        const plural = t => /(?:ies|es|s)$/.test(t) &&
            [t.replace(/ies$/, 'y'), t.replace(/es$/, ''), t.replace(/s$/, '')].find(x => x !== t && have.has(x));
        const kept = subsume(rows.filter(r => !plural(r.term)));
        // Batch triage: cap the per-entry paragraph to the strongest few so it stays scannable
        // (a focused entry can pull more via ✨). Score-sorted, so the cut only sheds the weak tail.
        // Gated-out entries return nothing on purpose. A demoted-rejects fallback used to run here,
        // on the theory that an empty paragraph helps nobody; measured over 38 books / 3466 entries
        // it fired on 1% of them and offered "friend, things, years" — the gate was right and the
        // real emptiness cure was admitting f=1 names, which now covers 98.8% of entries.
        return { existing, newRows: kept.filter(r => !r.present).slice(0, cap), keyedRows: kept.filter(r => r.present) };
    };

    const perEntry = entries.map((entry, i) => ({ entry, ...suggestForEntry(entry, tfs[i], i) })).filter(pe => pe.newRows.length);

    // For the ✨ per-entry local-model path (lazy: only fires on click).
    const avoid = [...uDF].filter(([t, c]) => t.length > 2 && !STOP.has(t) && c / N > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 20).map(x => x[0]);
    const exampleCanon = new Set([...KEY_GOOD_EXAMPLES, ...KEY_BAD_EXAMPLES].map(canon));   // drop few-shot echoes
    const exampleWords = new Set([...exampleCanon].flatMap(x => x.split(' ')));   // ...and mangled/partial ones

    return { entries, N, perEntry, canon, dfSubstr, avoid, exampleCanon, exampleWords };
}

// Studio scans every entry (all modes, active + inactive) so every entry's keywords get a verdict;
// suggestions use the pruner's own dfCeil so a suggested key can't be one the pruner would then flag.
export const STUDIO_PRUNE_OPTS = { scanKeyword: true, scanVectorized: true, scanConstant: true, includeInactive: true, pruneUnattested: true, pruneCommon: true, pruneShort: true, pruneShared: true, pruneFragment: true, ignoreProper: false, stickySkipCommon: true, bookCommon: KEY_BOOK_COMMON, minLength: KEY_MIN_LENGTH, bookShared: KEY_BOOK_SHARED, chatCommon: KEY_CHAT_COMMON };
// dfCeil sits just under the pruner's too-common danger line (KEY_BOOK_COMMON * 0.75 = 0.375): the
// suggester must not pre-reject a term the pruner itself considers fine. It was 0.15 when
// cross-entry df was the only junk signal; the Zipf gate now owns English junk, and 0.15 was
// silently cutting a book's recurring cast and setting names ("Stearns" in ~25% of entries).
// cap is a display budget, not a quality line. Measured uncapped over 39 books / 3405 entries, an
// entry yields a median of 17 candidates and a mean of 27, near-linear in content length (~7 per
// 1000 chars) rather than tailing off — so 8 was discarding ~70% of what survives the gates, and
// what it discarded was not junk. On a 269-candidate entry the top 8 were the entry's own subject
// but the next hundred still held its proper nouns. 30 sits just above the p75 of 29, so most
// entries now return everything they have and only the largest are trimmed.
export const STUDIO_SUGGEST_OPTS = { dfCeil: 0.35, maxN: 4, excludeDates: true, excludeShort: true, onlyActive: false, cap: 30, llmChunk: 5000 };
