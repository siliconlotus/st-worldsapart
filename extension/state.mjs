// state.mjs — the settings seam shared by every WA module: the settings key, the defaults, and the
// settings() accessor. Feature modules import this instead of reaching into ST's extension_settings, so
// there is one owner of what a setting means and one place to read it.
import { extension_settings } from '../../../../extensions.js';

export const MODULE_NAME = 'worldsApart';

export const defaultSettings = {
    enabled: true,
    /** Suppress keyword matching on entries marked vectorized (🔗). */
    suppressVectorKeys: true,
    /**
     * Also give vectorized (🔗) entries a keyword-over-keys rank, scored against the keys
     * suppressVectorKeys stashed before blanking them. Lets a retrieved vector entry earn the
     * keyword signal too (a double boost) WITHOUT its keys re-enabling core keyword activation.
     * Off by default — a signal to A/B, not a normal knob.
     */
    scoreVectorKeys: false,
    /** Characters per chunk. Entries are chunked for MATCHING only; the whole entry is still inserted. */
    chunkSize: 800,
    /**
     * Weight for BM25-over-KEYS in the layout fusion, separate from lexicalWeight (BM25-over-chunk-text).
     *
     * null = follow lexicalWeight, which is what every install did before this existed and is what keeps an
     * upgrade byte-identical. Set it when a book's keywords deserve different trust than its prose: measured
     * optima across three graded scenes were (text 0.5, keys 3) for a hand-curated book, (1.5, 0) for one
     * whose keys are auto-generated scene detail, and (1.5, 1) for a third — the keys signal correlates
     * 0.79 / 0.11 / 0.39 with human grades on those books, so one weight cannot serve them.
     *
     * Only reaches the layout ranking. fuseRetrieval (what the cutoff cuts) scores vector + text and never
     * sees keys at all.
     */
    keywordWeight: null,
    /** 'paragraph' keeps semantic boundaries; 'length' fills to chunkSize (chunking.mjs splitRecursive). */
    chunkMode: 'paragraph',
    /**
     * 'messages' embeds raw chat text; 'summary' condenses it first.
     * Entries are written as summaries, so a summarized query matches their level of
     * abstraction instead of comparing ground-level prose against it.
     */
    queryMode: 'messages',
    /**
     * Instruction used to build the summarized query.
     *
     * Prose, deliberately: the entries being searched are prose summaries, and a query
     * has to match their register as well as their level of abstraction. Measured on a
     * real corpus, a bare noun list of the same entities failed to clear a threshold
     * that a hand-written prose sentence beat comfortably.
     */
    summaryPrompt: 'Describe the current scene in three or four plain sentences of flowing prose. Name the characters present, the location, and what each group of them is doing, covering every thread that is active. Use concrete names and places. Do not write a list or bullet points. No dialogue, no atmosphere, no commentary. Output only the description.',
    /**
     * Response length cap for the summary, in tokens. A runaway guard, not a budget —
     * models stop when done, so a tight cap only risks truncating mid-output.
     * Generous enough that a reasoning model can finish thinking and still answer.
     */
    summaryLength: 1024,
    /**
     * Connection Manager profile id to summarize with. Empty = the current API.
     * Worth setting: a reasoning model spends its whole budget thinking and returns
     * nothing, and you don't want to pay that latency before every generation.
     */
    summaryProfile: '',
    /**
     * Temperature for the summary call. Empty = leave it to the preset or backend.
     *
     * Low values suit this job: the summary is a retrieval query, and sampling variety
     * only makes the same scene embed differently from one turn to the next.
     *
     * Requires a summary profile. generateRaw takes no generation parameters, so with
     * no profile set this is ignored and the current API's preset governs.
     */
    summaryTemperature: '',
    /**
     * Skip the profile's chat completion preset. Roleplay presets carry system prompts
     * and jailbreaks that push the model back into character voice, which is the
     * opposite of what a summary wants.
     */
    summaryBypassPreset: true,
    /** Paragraphs shorter than this are joined with the next one, so stray lines don't become chunks. */
    minChunkSize: 120,
    /**
     * Minimum cosine similarity for a chunk to count.
     *
     * 0.1, NOT 0.6, BECAUSE meanCentered IS ON BY DEFAULT. Centering subtracts the direction every chunk in a
     * single-story corpus shares, which collapses the cosine range: measured across three real books, centered
     * scores top out at 0.25-0.36 with a p90 of 0.086-0.110, while the same queries uncentered reach 0.62-0.72
     * with a p90 of 0.54-0.61. The old 0.6 was calibrated against uncentered scores, where it sat near the p90
     * and meant "roughly the top decile of chunks". Under centering it is above the entire range, so it
     * admitted ZERO chunks on all three books and every retrieved chunk arrived via the bm25 clause instead.
     * 0.1 is the centered p90 — the same selectivity 0.6 was chosen for.
     *
     * Note what this gates, which is narrower than it looks (see plugin/scoring.mjs scoreCollection): the
     * index only ever contains chunks from VECTORIZED entries, so this is the cosine floor for those. Entries
     * without 🔗 are not in the collection at all and reach the ranking through keyword scoring instead. The
     * one surprise is that a vectorized chunk can also be admitted by `bm25 > 0` on its own text, which
     * bypasses this floor — with long queries that clause admits 80-95% of chunks, so this setting currently
     * only ever WIDENS the candidate set and cannot narrow it.
     *
     * THAT BYPASS IS LOAD-BEARING; DO NOT "FIX" IT INTO A STRICT GATE. It reads like sloppiness — the cosine
     * floor ought to decide for the entries it is named after — and it was measured (eval/paired-arms.mjs
     * `admit=cosine`, three scenes):
     *
     *   strict cosine gate   sommers fell 3/3 -> 1/3 on critical (grade-5) entries in the top 10, and
     *                        time-whore lost a relevant entry from the candidate set entirely (recall 0.88).
     *                        Worse at every threshold tested down to 0, so it is not a calibration problem.
     *   strict AND           byte-identical to the above; there is essentially no chunk with a clearing
     *                        cosine and zero lexical overlap, so the extra conjunct removes nothing.
     *
     * The reason is mean-centering. Centered cosine means "more like the query than the average chunk is", so
     * a chunk can sit BELOW average in embedding space while containing the query's exact terms — and those
     * chunks carry real relevance. Only the lexical clause can admit them, and no cosine floor can. Consistent
     * with the vector signal measuring weakest of the three on these books (cosine-alone ranking missed all
     * three of sommers' grade-5 entries). `admit=cosine` is kept as a standing arm so a future tightening
     * trips a regression instead of shipping.
     */
    scoreThreshold: 0.1,
    /**
     * Use the Worlds Apart server plugin's mean-centered search when it is loaded.
     * Centering removes the direction every chunk in a single-story corpus shares,
     * which is what compresses similarities into a narrow band. Scores come out much
     * lower in absolute terms — recalibrate scoreThreshold when enabling.
     */
    meanCentered: true,
    /**
     * Which retrieval signal to select and rank on: 'hybrid' | 'lexical' | 'vector'.
     *
     * Benchmarked on a real lorebook, 785 trials (query = one chunk, target = any
     * sibling chunk of the same entry):
     *
     *   bm25       0.474 MRR / 63.3% recall@5
     *   vector     0.468 MRR / 64.8%
     *   hybrid     0.515 MRR / 69.7%
     *
     * The two singles are equivalent; fusing them is worth ~9% MRR over either.
     * An earlier 60-trial run appeared to show BM25 clearly ahead of vectors — that
     * was a small non-random subsample and did not survive the larger benchmark.
     */
    retrievalMode: 'hybrid',
    // Removed: baselineQuery/baselineWeight (subtract a hand-crafted "shared background" query's cosine
    // scores). Measured harmful over a 374-trial LOO grid (baseline-grid.mjs) — monotonic decline, no
    // beneficial weight. It was a worse, redundant hand-rolled version of mean-centering (meanCentered),
    // which subtracts the real corpus mean vector and measurably helps (+8.8% nDCG@5, centering-grid.mjs).
    /** Max retrieved entries to force-activate. A hard ceiling in both cutoff modes. */
    maxVectorEntries: 10,
    /**
     * How many of those actually survive:
     *   'count'   — keeps maxVectorEntries every time; predictable.
     *   'elbow'   — cuts at a gap that stands out from the MEAN gap, so the number adapts
     *               to the scene. Sensitive to the window, because the mean shifts with it.
     *   'dropoff' — cuts at a gap larger than a FIXED fraction of the top score. Because the
     *               ranking is RRF (a bounded 1/(k+rank) band), that fraction is comparable
     *               across queries where a raw gap value is not, and it is window-independent
     *               where the mean is not — so it finds a real cliff wherever it sits.
     * Both cliff modes cut at the LAST qualifying gap and are floored/capped the same way.
     *
     * 'elbow' ships because it measures better and it is the ONE tuning result that held across every
     * population and metric the graded harness was run under: over 3 graded scenes it reached 95% of the best
     * possible cut (worst case 92%) against 83%/72% for the old default of count max=10. See selection.mjs
     * cutRetrieved for the table. It is also insensitive between sensitivity 1.2 and 2.0, which is why the
     * switch is safe to make on 3 scenes when the boost/gazetteer knobs are not.
     */
    vectorCutoff: 'elbow',
    /** Cliff modes only: never cut below this many. Guards against the rank 1-2 gap. */
    minVectorEntries: 3,
    /**
     * Elbow mode only: how large a score gap must be, as a multiple of the mean gap, to
     * count as a cliff worth cutting at. Higher keeps fewer (only dramatic drops cut),
     * lower keeps more. Below 1 would treat an average gap as a cliff and is meaningless.
     */
    elbowSensitivity: 1.5,
    /**
     * Dropoff mode only: a gap is a cliff when it erases more than this fraction of the top
     * fused score. ~0.08 was the cliff size measured on two real queries (Orient-Express and
     * Vegas); 0.06 keeps a little margin below that. Higher keeps fewer, lower keeps more.
     */
    dropoffThreshold: 0.06,
    /**
     * Filter raw-text queries down to entity-ish terms before lexical scoring:
     * keep capitalised tokens and anything in the lorebook's own vocabulary, drop
     * the rest. Re-measured over three graded scenes: mean nDCG@5 0.896 filtered vs
     * 0.808 unfiltered — a real win, but far smaller than the old note claimed, and it
     * lands on top-of-list quality rather than mean target rank. See ranking.mjs
     * buildTermWeights for the per-scene table and which old figures did not reproduce.
     * Ignored in summary mode.
     */
    entityFilter: true,
    /** Weight multiplier for capitalised query tokens under the entity filter. */
    properNounBoost: 3,
    /**
     * Corpus-derived stoplist: drop query terms appearing in more than this fraction
     * of chunks. 0 disables. Beats a fixed English stoplist because it also removes
     * the recurring cast — on a real lorebook it strips "kyle" (72.8% of chunks) and
     * "jeffrey" (58.3%) alongside "the" and "and", and no generic list would.
     * Benchmarked at 0.25: all 5 gold targets in the top 5, mean rank 3.0, matching
     * the LLM summary with no model call.
     */
    stopwordDocFreq: 0.25,
    /**
     * How many recent chat messages WA looks at — one depth shared by both the retrieval
     * query (the text embedded / BM25'd, or summarized in summary mode) and the keyword
     * scan window. A per-entry scanDepth still overrides the keyword window (as in core).
     */
    messageDepth: 3,
    /**
     * How surviving entries are laid out in the prompt:
     * 'authored' | 'authored-inverse' | 'best-first' | 'best-last'.
     *
     * Ranking answers WHICH entries survive; this answers where they go, and the two
     * are not the same question. For a lorebook of scene summaries, authored `order`
     * carries chronology — laying them out by relevance instead makes the model read
     * scene 181 before 176 whenever 181 matched the query better.
     */
    presentationOrder: 'order-asc',
    /** Group insertion order into tiers (constant → sticky → …) before the base sort. Off = flat. */
    presentationTiered: false,
    /** Score normal entries by keyword match quality and fuse them with the vector ranking. */
    keywordScoring: true,
    /**
     * BM25 term-frequency saturation, for both the key scorer and the plugin's
     * text scorer. Roughly: how many distinct matching terms one heavily-repeated
     * term is worth. Higher = repetition counts for more.
     */
    bm25K1: 1.2,
    /**
     * BM25 length normalisation, 0..1. At 1 a long chunk must work proportionally
     * harder to score; at 0 length is ignored entirely. Text scorer only.
     */
    bm25B: 0.75,
    /**
     * Reciprocal rank fusion constant: weight is 1/(k + rank). Higher = flatter.
     *
     * The usual 60 assumes thousands of candidates. Over ~90 chunk-level candidates it
     * makes rank 20 worth 76% of rank 1, so entries that are mediocre on both signals
     * outrank ones that are excellent on a single signal. Roughly matching k to the
     * number of entries you keep restores the discrimination.
     */
    rrfK: 20,
    /**
     * Multiplier on the lexical (BM25) contribution to the fused score; vector is
     * always 1. Above 1 favours BM25, below 1 favours the embeddings.
     *
     * Equal weighting benchmarked best when the query is a full chunk of prose. A
     * short entity-dense query — a generated summary — is a different regime: IDF is
     * length-agnostic while embeddings degrade when query and document lengths
     * diverge, so BM25 deserves more weight there.
     */
    lexicalWeight: 1,
    /**
     * Fold each entry's authored Order into the fused score as an extra RRF rank (higher order =
     * higher priority, matching ST where order is budgetPriority). Off by default; for books that
     * use Order as a priority proxy. Order remains the presentation/retention tiebreak regardless.
     */
    weightByOrder: false,
    /**
     * Token budget as a percentage of max prompt tokens. 0 = off.
     *
     * Independent of maxTokens, and both apply — the tighter of the two wins, the same
     * pairing ST uses for world_info_budget and world_info_budget_cap. A percentage
     * scales when you switch models; an absolute value is a hard ceiling that doesn't.
     *
     * On by default, unlike every other cap. Without it a single over-shared key (one
     * trigger listed on most entries) activates the whole book and WA has nothing to cut
     * with, so World Info crowds out the actual conversation. 40% leaves the majority of
     * the context to chat while being generous enough that a normal scan never touches it.
     * Only bites when WA has more entries than budget; set 0 to defer to core entirely.
     */
    maxTokensPercent: 40,
    /**
     * Token budget over ALL activated entries, absolute. 0 = leave it to core.
     * Only meaningful globally — a token cap that exempted constants would report a
     * ceiling the prompt then exceeds by however much those constants weigh.
     */
    maxTokens: 0,
    /**
     * Cap on dynamic entries — keyword and vector, i.e. everything that isn't constant
     * or sticky. 0 = no cap. Constants and stickies are unaffected by this one, so a
     * cap of 10 alongside 7 constants yields 17 entries.
     */
    maxDynamicEntries: 0,
    /**
     * Whether ignoreBudget entries spend maxTokens.
     *
     * Off (default): they are free on every axis, which is what marking an entry
     * "ignore budget" is for — the flag reads as "this is not subject to the budget",
     * not "this is merely uncuttable". The cost is that maxTokens then bounds only the
     * cuttable entries, so the World Info actually sent is exempt tokens PLUS the budget.
     * On: they still can't be cut, but their tokens come off the top and squeeze what
     * fits below, so maxTokens is an honest ceiling on the whole of World Info.
     *
     * Turn this on if a book has enough exempt entries to overrun the context on its own —
     * maxTokensPercent can't guard against exempt entries while this is off.
     */
    maxTokensIncludesExempt: false,
    /**
     * Cap on every activated entry. 0 = no cap. Constants and stickies are walked first
     * and consume it, so a cap of 10 alongside 7 constants yields 10 entries, 3 dynamic.
     *
     * Leaving this at 0 is what guarantees an always-on entry is never dropped. The two
     * caps are independent and both apply — set both to bound each population at once.
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
     * Legacy global ordered book list. Kept only as the migration seed: the first time a
     * character needs an order, this list is copied into `worldPriorityByChar` so existing
     * tuning carries over. New installs leave it empty. Not read by the engine any more.
     * @type {Array<{ world: string, weight: number, offset: number }>}
     */
    worldPriority: [],
    /**
     * Per-character ordered book list, keyed by a stable character/group id so two chats
     * (or branches) of the same character share one order. Position is the tier (sequential);
     * weight/offset/cap ride per book. The current chat's book is stored as the sentinel
     * `'chat'` (resolved at runtime) so the order survives switching chats.
     * @type {Record<string, Array<{ world: string, weight: number, offset: number, cap: number }>>}
     */
    worldPriorityByChar: {},
    /** console.table the ranking every scan. */
    debugLog: true,
};

/** The live WA settings object (extension_settings[MODULE_NAME]). */
export function settings() {
    return extension_settings[MODULE_NAME];
}

/** Merge defaults under any stored settings. Call once at init before reading settings(). */
export function ensureSettings() {
    extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME]);
}

/**
 * Cross-module runtime state (mutable). Holder object so any module can read/write a live value —
 * ESM won't let an imported `let` be reassigned across module boundaries, but object props can.
 * The engine writes the last* / plugin* fields; the hooks write attachedWorlds/generationIsDryRun;
 * the debug commands toggle verboseRun/dryRunInProgress; the panel + debug read them back.
 */
export const runState = {
    lastScores: new Map(),        // vector scores from the last retrieval, keyed `${world}.${uid}`
    lastTextScores: new Map(),    // BM25-over-text scores, same keys
    lastLayout: [],               // final layout of the last scan, for /wa-dry
    lastQuery: '',                // last retrieval query text, bundled by /wa-grade
    lastQueryChat: [],            // the messages that query was joined from, for offline depth ablation
    lastScanText: '',             // last global-depth keyword scan window, bundled by /wa-grade
    gradeCutoff: null,            // /wa-grade widens the cut for its run; null = use the real settings
    lastCutKept: null,            // how many the cutoff kept on the last retrieval, recorded by /wa-grade
    lastCandidates: [],           // selection-candidate rows from the last debug-class run, for /wa-grade
    lastCandidateEntries: [],     // the WI entries behind those rows, aligned by index (for "view text")
    lastDropped: [],              // entries cut by budget
    lastSkipped: [],              // per-entry budget rejections + the cap that caused each
    attachedWorlds: new Set(),    // books ST currently has active for this chat
    verboseRun: false,            // true during a /wa-debug run (noisy per-stage logging)
    dryRunInProgress: false,      // true during either slash-command run (quiets live logging)
    generationIsDryRun: false,    // true while ST's own dry-run generation is in flight
    pluginAvailable: null,        // did the server plugin answer /ping
    pluginRoot: null,             // absolute ST root from /ping (for the deploy command)
    pluginFP: null,               // fingerprint the deployed plugin reports
    sourceFP: null,               // fingerprint of this extension's source plugin files
};
