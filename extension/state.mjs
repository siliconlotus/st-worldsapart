// state.mjs — the settings seam shared by every WA module: the settings key, the defaults, and the
// settings() accessor. Feature modules import this instead of reaching into ST's extension_settings, so
// there is one owner of what a setting means and one place to read it.

const MODULE_NAME = 'worldsApart';

export const defaultSettings = {
    enabled: true,
    /**
     * Characters per chunk — not tokens. Entries are chunked for matching only; the whole entry is still
     * inserted.
     *
     * It sits above the paragraph distribution: 1750 is the corpus's p90 paragraph length, so the cap
     * fires on the tail (R24). Not a capacity limit — nothing here has ever truncated (R24). Measured
     * ~flat across ceilings (R24). Changing it re-embeds every collection, since every hash changes.
     */
    chunkSize: 1750,
    /** 'paragraph' keeps semantic boundaries; 'length' fills to chunkSize (chunking.mjs splitRecursive). */
    chunkMode: 'paragraph',
    // WA's shared LLM connection. The ✨ keyword suggester (keyword-tools.mjs generateText) is its
    // only reader.
    /**
     * Connection Manager profile id for WA's own generation calls. Empty = the current API.
     * Worth setting: a reasoning model spends its whole budget thinking and returns nothing,
     * and the suggester runs per entry.
     */
    llmProfile: '',
    /**
     * Temperature for those calls. Blank sends none and lets the backend decide.
     *
     * The only sampling control WA has: generateText always bypasses the profile's preset (see
     * keyword-tools.mjs). Needs a profile — generateRaw takes no generation parameters, so the
     * no-profile path ignores it. 1.0 is not a measured optimum; nonzero because the Studio invites
     * a second ✨ click and at 0 a local model returns the identical list forever, and explicit
     * rather than blank so the behaviour does not depend on which backend the profile points at.
     *
     * Treat it as a request, not a control: hosted reasoning models sample under provider settings
     * no client parameter reaches, so reproducible output is something only a local model offers.
     * At no value does it restrict output to terms present in the entry — it rescales logits without
     * removing support, and only constrained decoding could, which is unwanted: buildKeyPrompt asks
     * for the paraphrase that is not in the text (the realizability rule).
     */
    llmTemperature: '1',
    /** Paragraphs shorter than this are joined with the next one, so stray lines don't become chunks. */
    minChunkSize: 120,
    /**
     * Use the Worlds Apart server plugin's mean-centered search. Centering removes the direction every
     * chunk in a single-story corpus shares, which is what compresses similarities into a narrow band;
     * scores come out much lower in absolute terms. Internal, and shipped on.
     *
     * The gate in queryCollections is the PLUGIN's presence, not this flag — this is passed to the
     * plugin as a parameter, so turning it off buys uncentered scores rather than none.
     */
    meanCentered: true,
    // Do not propose back: baselineQuery/baselineWeight (subtracting a hand-crafted "shared background"
    // query's cosine) measured harmful at every weight, and mean-centering subtracts the real corpus
    // mean vector and measurably helps (R12).
    /**
     * The E[credit] a memory entry must clear at stage 4. One value for every embedding model, and the
     * user's to set.
     *
     * It is a budget dial, not a model setting: `E[credit]` is calibrated, so every fitted model delivers
     * nearly the same count at the same cutoff (E4) — the model moves which entries clear the bar, not how
     * many. So it stays one setting, the precision-for-recall trade being the user's call.
     *
     * The usable range is roughly 0.05 to 0.35; past there the dial stops trading and loses both (E5).
     * The default sits at the recall-favouring end, matching F2.
     *
     * The `cutoff` a fit carries in relevance-model-<tier>.json is that model's own F2 optimum, kept as
     * provenance and never read at runtime. Reference is not cut at all (onScanDone).
     */
    relevanceCutoff: 0.10,
    /**
     * Cap on vector entries in the final selection — stage 5, inside applyBudget, nested as
     * vector ⊆ dynamic ⊆ all. At most this many vector entries are added to the layout during the walk;
     * it does not decide what activates.
     *
     * It is the keyword-to-vector ratio knob: vector results are numerous and arrive already ranked, so
     * without it a walk that fills until the budget is gone hands the whole prompt to them and a keyword
     * entry never gets in. It is also an input-token cost the user is choosing, so keep it generous —
     * the tighter it is set the more it does a relevance job it has no signal for, cutting by rank
     * position with no view of the gap it cuts across.
     *
     * Counted off the `vectorized` flag, because the cap is about what an entry is, not how it was
     * retrieved. The value is a judgement, not a measurement: nothing grades stage 4 yet.
     */
    maxVectorEntries: 20,
    /**
     * Filter raw-text queries down to entity-ish terms before lexical scoring: keep capitalised tokens
     * and anything in the lorebook's own vocabulary, drop the rest. A small win, landing on
     * top-of-list quality rather than mean target rank (R19). Ignored in summary mode.
     */
    entityFilter: true,
    /** Weight multiplier for capitalised query tokens under the entity filter. */
    properNounBoost: 3,
    /**
     * Corpus-derived stoplist: drop query terms appearing in more than this fraction of chunks.
     * 0 disables. Beats a fixed English stoplist because it also removes the recurring cast, which no
     * generic list would. 0.25 benchmarked as matching the LLM summary with no model call (R27).
     */
    stopwordDocFreq: 0.25,
    /**
     * How many recent chat messages WA looks at — one depth shared by both the retrieval query and the
     * keyword scan window. A per-entry scanDepth still overrides the keyword window (as in core).
     *
     * 10 sits mid-plateau on the measured dose-response, which dips past 15 as over-widening dilutes
     * the query (R13). Cost is query length.
     */
    messageDepth: 10,
    /**
     * Tag names whose elements are removed — tag and content — from every message before WA reads it.
     * Comma-separated; empty is off. Applies to the retrieval query and the keyword scan window alike.
     *
     * Off by default and never inferred: the same chat renders letters and screens as markup too, and
     * that is scene text. Only the author knows which block is bookkeeping (matcher.mjs `dropTags`).
     */
    dropChatTags: '',
    /**
     * How surviving entries are laid out in the prompt: any of `SORT_FNS`' keys (sort.mjs), plus
     * 'best-first' | 'best-last'.
     *
     * Prompt order, not layout order: ranking answers which entries survive, this answers where they
     * go. For a lorebook of scene summaries, authored `order` carries chronology, which laying them
     * out by relevance destroys.
     */
    presentationOrder: 'order-asc',
    /** Group insertion order into tiers (constant → sticky → …) before the base sort. Off = flat. */
    presentationTiered: false,
    /**
     * Hide memory entries that summarise messages which have not happened yet at this point in the chat.
     *
     * Inert at the latest turn; it bites when you branch back, where the book still holds every summary
     * written later and ranking them is a spoiler rather than a ranking error (F28). A setting rather
     * than a rule, because using an old branch as a writing surface for a story already told may want
     * them.
     *
     * `STMB_end` is the boundary (relevance.mjs `postDates`), and an entry with no range reads as
     * available — right for a reference sheet, silently inert on a memory entry that lost the field.
     */
    dropUnavailable: true,
    /**
     * The unit a key has to match within — `scan` | `message` | `paragraph`.
     *
     * A conjunction over the whole window matches terms a dozen messages apart, and vetoes on a
     * negation five messages back. `scan` is one segment and is what core does, so anything narrower
     * is a deliberate divergence from core's selective logic.
     *
     * Paragraph by default because message is close to a no-op on real prose: most scanned text lives
     * in messages of many paragraphs (R26 — one author's chats, so a default, not a general finding).
     */
    matchWindow: 'paragraph',
    /**
     * What counts as "inside a word" when Match Whole Words is on — `permissive` | `strict`.
     *
     *   permissive  letters, digits, combining marks           `Joe` matches `Joe's`
     *   strict      ...plus hyphen and apostrophes             it does not
     *
     * Strict by default because the escapes are asymmetric: a `/regex/` key with `\b` recovers
     * permissive behaviour for any ASCII key, and from permissive there is no short form.
     *
     * Read by matcher.mjs through setBoundaryMode() rather than as an argument — it is global by
     * construction, and threading it would touch every countKey caller for a value none of them vary.
     */
    wordBoundary: 'strict',
    // Who a typed grade is signed as — a UUIDv4, generated once on first use and kept.
    //
    // Random rather than composed from user and host: grades pool across contributors, and
    // `default-user@localhost` is what nearly every install would sign, merging two raters into one
    // unrecoverably. A real hostname would fix that and ship a person's name in every shared document.
    // Not a security boundary — it prevents collision by accident, nothing more.
    raterId: '',

    /**
     * BM25 term-frequency saturation, for the key scorer (matcher.mjs) and the content text scorer
     * (content-lexical.mjs, in the browser). Roughly: how many distinct matching terms one
     * heavily-repeated term is worth. Higher = repetition counts for more.
     *
     * Not the plugin: stage 1 is cosine-only and server.js ignores this field if a client sends it.
     * For the key scorer this is the rate only; repeatCurve below is the shape.
     */
    bm25K1: 1.2,
    /**
     * Occurrences -> a key's contribution (matcher.mjs repeatCurveOf). k1 above is the rate repeats
     * accrue at; this is the shape.
     *
     * 'bm25' is the classic tf term, `count/(count+k1)`, bounded by 1 and so compressing high counts
     * into the top few percent of the range. 'presence-log' makes presence categorical — a matched key
     * is worth its full weight — and lets only the n-1 repeats accrue, unbounded and ever more slowly.
     * Default because high counts are signal, not noise: a key absent from most of a book's scenes and
     * dominant in one is the book's sharpest evidence about which scene it is, and the bounded curve
     * stops discriminating exactly there (K8).
     *
     * No frequency discount accompanies this, deliberately: a ubiquitous key is an author declaration
     * (keyword-audit.mjs exempts constant entries from the too-common flags on that ground), a badly
     * chosen one is reported by the audit, and a broadly-firing entry whose content does not fit still
     * ranks low on the other two fused signals.
     *
     * Activation is unaffected: stage 2 counts hits, never the score (matcher.mjs), so this moves
     * ranking only and can never admit or refuse an entry.
     */
    repeatCurve: 'presence-log',
    /** What repeats may add, as a multiple of presence. Rate is bm25K1; this is reach. */
    repeatR: 1,
    /**
     * BM25 length normalisation, 0..1. At 1 a long chunk must work proportionally
     * harder to score; at 0 length is ignored entirely. Text scorer only.
     */
    bm25B: 0.75,
    /**
     * Token budget as a percentage of max prompt tokens. 0 = off.
     *
     * Independent of maxTokens, and both apply — the tighter of the two wins, the same pairing ST uses
     * for world_info_budget and world_info_budget_cap.
     *
     * On by default, unlike every other cap: without it one over-shared key activates the whole book
     * and World Info crowds out the conversation. 0 is no token cap, not a handover — core's own budget
     * cannot act once onEntriesLoaded has marked every entry exempt.
     */
    maxTokensPercent: 40,
    /**
     * Token budget over ALL activated entries, absolute. 0 = no cap, as everywhere else here.
     * Only meaningful globally — a token cap that exempted constants would report a
     * ceiling the prompt then exceeds by however much those constants weigh.
     */
    maxTokens: 0,
    /**
     * Token budget slack: an entry may exceed the budget by this percentage of it. Rescues the
     * common case where the last entry misses the cut by a handful of tokens. 0 = exact budget.
     */
    budgetSlackPercent: 0,
    /** 'once' — the slack rescues one entry, then the budget is exact; 'all' — every entry may use it. */
    budgetSlackMode: 'once',
    /**
     * Cap on dynamic entries — keyword and vector, i.e. everything that isn't constant
     * or sticky. 0 = no cap. Constants and stickies are unaffected by this one, so a
     * cap of 10 alongside 7 constants yields 17 entries.
     */
    maxDynamicEntries: 0,
    /**
     * Whether ignoreBudget entries spend maxTokens.
     *
     * Off (default): they are free on every axis, so maxTokens bounds only the cuttable entries and
     * what is sent is exempt tokens plus the budget. On: they still can't be cut, but their tokens come
     * off the top, making maxTokens an honest ceiling on the whole of World Info. Turn it on if a book
     * has enough exempt entries to overrun the context on its own.
     */
    maxTokensIncludesExempt: false,
    /**
     * Cap on every activated entry. 0 = no cap. Constants and stickies are walked first and consume it,
     * so a cap of 10 alongside 7 constants yields 10 entries, 3 dynamic — leaving it at 0 is what
     * guarantees an always-on entry is never dropped. Independent of maxDynamicEntries; both apply.
     */
    maxTotalEntries: 0,
    /**
     * How several active books compete for budget and where they sit in the prompt.
     * 'interleaved' | 'sequential'.
     *   interleaved — all books share one relevance-ranked list. A book's `weight` scales
     *                 its entries' fused score (weight 1 = plain relevance, no per-book
     *                 preference), so a strong entry in a low book can still beat a weak one
     *                 in a high book; `offset` shifts the book in the prompt, independent of
     *                 selection. The default.
     *   sequential  — books are strict tiers: a lower book only gets slots the higher
     *                 books left unused, and its entries render after theirs. A weak
     *                 entry in a high book always beats a strong one in a low book.
     */
    worldPriorityMode: 'interleaved',
    /**
     * The ordered book list, keyed by a stable character/group id so two chats (or branches) of the
     * same character share one order; there is no global list. Position is the tier (sequential);
     * weight/offset/cap ride per book. The current chat's book is stored as the sentinel `'chat'`
     * (resolved at runtime) so the order survives switching chats.
     * @type {Record<string, Array<{ world: string, weight: number, offset: number, cap: number }>>}
     */
    worldPriorityByChar: {},
    /** console.table the ranking every scan. */
    debugLog: true,
};

/**
 * Settings with no UI: measured-stable knobs internalized after tuning. They stay in defaultSettings so
 * every read site and the eval harness keep working, but ensureSettings resets them each init — a knob
 * removed from the panel must not linger at a stale hand-tuned value the user can no longer see.
 */
const INTERNAL_KEYS = [
    'meanCentered', 'entityFilter', 'properNounBoost', 'stopwordDocFreq',
    'bm25K1', 'bm25B', 'repeatCurve', 'repeatR',
    'chunkSize', 'chunkMode', 'minChunkSize',
];

/**
 * ST's settings store, bound rather than imported. This module holds the shipped value of every knob, so
 * the eval harness has to read it under node — importing `extension_settings` would make that impossible
 * and force harness-side copies of the defaults (CLAUDE.md, *Pure vs ST-coupled*).
 */
let store = null;

/** The live WA settings object (ST's `extension_settings[MODULE_NAME]`). */
export function settings() {
    // Loud: returning undefined yields a TypeError somewhere far away, or a falsy read that looks like
    // a user's choice.
    if (!store) throw new Error('Worlds Apart: settings() read before ensureSettings() bound ST\'s store');
    return store[MODULE_NAME];
}

/** Merge defaults under any stored settings and bind ST's store. Call once at init, before reading
 *  settings(), passing ST's `extension_settings`. */
export function ensureSettings(extensionSettings) {
    store = extensionSettings;
    store[MODULE_NAME] = Object.assign({}, defaultSettings, store[MODULE_NAME]);
    for (const k of INTERNAL_KEYS) store[MODULE_NAME][k] = defaultSettings[k];
}

/**
 * Cross-module runtime state (mutable). Holder object so any module can read/write a live value —
 * ESM won't let an imported `let` be reassigned across module boundaries, but object props can.
 */
export const runState = {
    // Keyed `${world}.${uid}` — ST CORE'S format, which onScanDone receives and looks up here. Not a
    // candidate for the US separator; see the note in worldsapart.js syncWorld.
    lastScores: new Map(),        // vector scores from the last retrieval
    lastPromptOrder: [],          // the last scan's PROMPT order, post-cut, for /wa-dry and the panel
    lastQuery: '',                // last retrieval query text, bundled by /wa-grade
    lastQueryChat: [],            // the messages that query was joined from, for offline depth ablation
    scanChat: null,               // the interceptor's chat — core's own scan haystack (regex-scripted,
                                  // files appended); SCAN_DONE consumers read this, not the raw chat
    lastScanChat: [],             // scan-eligible messages at capture depth, bundled by /wa-grade
    gradeCutoff: null,            // /wa-grade's candidate-depth cap; null = no capture in flight
    lastCandidates: [],           // selection-candidate rows from the last debug-class run, for /wa-grade
    lastCandidateEntries: [],     // the WI entries behind those rows, aligned by index (for "view text")
    lastSkipped: [],              // per-entry budget rejections + the cap that caused each
    attachedWorlds: new Set(),    // books ST currently has active for this chat
    waOwnsScan: false,            // WA intercepted the scan now in flight and owns its
                                  // keyword matching — set at the end of selectAndActivate, cleared
                                  // on the scan's final loop / generation end. Gates the
                                  // ENTRIES_LOADED key blanking and the per-loop SCAN_DONE feed.
    waMatched: new Set(),         // `${world}.${uid}` WA has emitted or seen activated this scan —
                                  // never rescanned (the external map persists, once emitted is enough)
    waRecursionTexts: [],         // every pass's recursion-eligible entry content so far, one text per
                                  // entry — the rematch window is chat + all of these
    waMinSkew: 0,                 // how many min-activation passes core has scheduled — widens WA's
                                  // default window one message per pass, mirroring advanceScan
    waCandidates: null,           // the candidate entries WA fetched at intercept (live keys), for the
                                  // SCAN_DONE rematches; null = no owned scan state
    verboseRun: false,            // true during a /wa-debug run (noisy per-stage logging)
    dryRunInProgress: false,      // true during either slash-command run (quiets live logging)
    generationIsDryRun: false,    // true while ST's own dry-run generation is in flight
    pluginAvailable: null,        // did the server plugin answer /ping
    pluginRoot: null,             // absolute ST root from /ping (for the deploy command)
    pluginFP: null,               // fingerprint the deployed plugin reports
    pluginWaVersion: null,        // WA's resolved `<branch>@<git describe>` from /ping — the browser can't read git
    sourceFP: null,               // fingerprint of this extension's source plugin files
};
