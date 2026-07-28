// state.mjs — the settings seam shared by every WA module: the settings key, the defaults, and the
// settings() accessor. Feature modules import this instead of reaching into ST's extension_settings, so
// there is one owner of what a setting means and one place to read it.
import { extension_settings } from '../../../extensions.js';

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
    /** 'paragraph' keeps semantic boundaries; 'length' uses ST's splitRecursive (fills to chunkSize). */
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
    /** Minimum cosine similarity for a chunk to count. */
    scoreThreshold: 0.6,
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
     */
    vectorCutoff: 'count',
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
     * the rest. Benchmarked on real chat against a hand-judged gold set — mean
     * target rank 11.2 vs 21.6-28.2 unfiltered. Ignored in summary mode.
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
     */
    maxTokensPercent: 0,
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
     * On (default) they are: exempt from being CUT, but their tokens still come off the
     * top and squeeze what fits below, so maxTokens stays an honest ceiling on the World
     * Info actually sent. Off, they are free on every axis and maxTokens stops bounding
     * anything real — it then caps only the entries that could be cut anyway.
     */
    maxTokensIncludesExempt: true,
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
    lastDropped: [],              // entries cut by budget
    lastSkipped: [],              // per-entry budget rejections + the cap that caused each
    lastQueryText: '',            // last retrieval query, so /wa-debug can re-probe it
    attachedWorlds: new Set(),    // books ST currently has active for this chat
    verboseRun: false,            // true during a /wa-debug run (noisy per-stage logging)
    dryRunInProgress: false,      // true during either slash-command run (quiets live logging)
    generationIsDryRun: false,    // true while ST's own dry-run generation is in flight
    pluginAvailable: null,        // did the server plugin answer /ping
    pluginRoot: null,             // absolute ST root from /ping (for the deploy command)
    pluginFP: null,               // fingerprint the deployed plugin reports
    sourceFP: null,               // fingerprint of this extension's source plugin files
};
