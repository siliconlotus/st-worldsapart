// state.mjs — the settings seam shared by every WA module: the settings key, the defaults, and the
// settings() accessor. Feature modules import this instead of reaching into ST's extension_settings, so
// there is one owner of what a setting means and one place to read it.
import { extension_settings } from '../../../../extensions.js';

export const MODULE_NAME = 'worldsApart';

export const defaultSettings = {
    enabled: true,
    /**
     * WA owns keyword activation (matcher-design.md, bucket 2). On the scans WA intercepts, every
     * keyword-activating entry's keys are stashed and blanked before core scans, so core's own
     * keyword matcher never fires — WA's matcher answers "did a key match" for the initial pass,
     * every recursion pass and min-activation widening, and force-emits the winners into core's
     * loop. Constants and @@activate entries keep their keys: core activates them without keys
     * (they short-circuit before its key path), and the inclusion-group filter's getScore reads
     * them. Core keeps everything else: gates, timers, group filtering, probability rolls,
     * recursion control, prompt assembly.
     * Off = bucket 1.5 behaviour (core matches, WA unions what core cannot and prunes what WA
     * rejects). Dry-run scans always keep 1.5 behaviour — ST skips interceptors for them, so WA is
     * never offered the scan. Quiet generations (Summarize, SD prompts, the LLM expression
     * classifier) are ordinary generations here and get the takeover like any other.
     */
    ownActivation: true,
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
    /** 'paragraph' keeps semantic boundaries; 'length' fills to chunkSize (chunking.mjs splitRecursive). */
    chunkMode: 'paragraph',
    /**
     * 'messages' embeds raw chat text; 'summary' condenses it first with an LLM call.
     *
     * WITHDRAWN FROM PRODUCTION — internalized, so this is always 'messages' for a user. It never
     * measured better than raw messages, and the one head-to-head on record went the other way on
     * cost: the corpus-derived stoplist (stopwordDocFreq 0.25) put all 5 gold targets in the top 5
     * at mean rank 3.0, "matching the LLM summary with no model call". Against that it charges an
     * LLM call per generation and buys nothing back — the query is embedded and BM25'd, never sent
     * in the prompt, so it cannot reduce prompt tokens; the only input it shortens is the
     * embedder's, which is the cheapest and usually free stage. Since WA also runs on quiet
     * generations, that charge is now per background call (Summarize, image prompts, LLM
     * expression classification) as well.
     *
     * Kept reachable because `summary` is a /wa-super-grade POOL ARM and a pool arm's job is to
     * change the population, not to be good — dropping it would permanently narrow the pool every
     * defaults review is graded against (CLAUDE.md, "pool first, then pair"). captureArm overrides
     * live settings at runtime, so the arm still reaches it; nothing else can.
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
    // The next three are WA's SHARED LLM connection, not the summarizer's — the ✨ keyword
    // suggester (keyword-tools.mjs generateText) is their only production reader now that
    // queryMode is internalized. Renamed off `summary*` with no migration: prerelease, single
    // user, so a stored `summaryProfile` is worth less than a name that says what it configures.
    /**
     * Connection Manager profile id for WA's own generation calls. Empty = the current API.
     * Worth setting: a reasoning model spends its whole budget thinking and returns nothing,
     * and the suggester runs per entry.
     */
    llmProfile: '',
    /**
     * Temperature for those calls. Blank sends none and lets the backend decide.
     *
     * The only sampling control WA has: the profile's preset normally holds these, and
     * generateText always bypasses it (see keyword-tools.mjs). Needs a profile — generateRaw takes
     * no generation parameters, so the no-profile path ignores it.
     *
     * 1.0 because that is roughly where instruction tuning assumes sampling happens, not because
     * it measured better: temperature showed no effect on suggestion quality on any model tried.
     * Nonzero rather than 0 for one concrete reason — the Studio invites the user to click ✨ again,
     * and at 0 a local model returns the identical list forever. Explicit rather than blank so the
     * behaviour does not depend on which backend the profile points at.
     *
     * EXPECT IT TO BE IGNORED, increasingly. Hosted reasoning models sample their own reasoning
     * under provider settings that no client parameter reaches, so neither temperature nor seed
     * pins their output. Treat this as a request, not a control, and treat reproducible output as
     * something only a local model can offer (there, a seed pins it at any temperature).
     *
     * What it cannot do at any value is restrict output to terms present in the entry: it rescales
     * logits before the softmax (p_i ∝ exp(z_i/T)), reshaping a distribution over the whole
     * vocabulary without reordering it or removing support. Only constrained decoding could, and
     * that is unwanted — buildKeyPrompt asks for the paraphrase that is NOT in the text on purpose
     * (keyword-suggest-design.md's realizability rule: presence confirms, absence does not
     * disqualify).
     */
    llmTemperature: '1',
    // Removed: llmBypassPreset. Bypassing is unconditional now (keyword-tools.mjs generateText).
    // Its rationale had also been wrong — presets contribute samplers here, not the system prompt
    // and jailbreak it claimed to be guarding against; the prompt manager never runs on this path.
    /** Paragraphs shorter than this are joined with the next one, so stray lines don't become chunks. */
    minChunkSize: 120,
    /**
     * Minimum cosine similarity for a chunk to count.
     *
     * 'auto' = the p90 of the query's own centered score distribution, computed per collection per query in
     * plugin/scoring.mjs. Internal (no UI). The history that led here: the original 0.6 was calibrated
     * against UNCENTERED scores (raw cosines reach 0.62-0.72, p90 0.54-0.61), and under centering — which
     * collapses the range to a 0.25-0.36 top with a p90 of 0.086-0.110 — it sat above the entire range and
     * admitted ZERO chunks. The fix, 0.1, was "the centered p90 measured on three books with bge-m3" — an
     * embedder-specific constant. 'auto' computes that same p90 from the scores actually in play, so the
     * selectivity transfers to any embedder with no recalibration. Verified a no-op where they overlap:
     * paired vs 0.1 over 80 bge-m3 scenes, 78 byte-identical, mean Δ -0.0001 (eval/paired-arms.mjs
     * `thr=auto`). The stock-ST fallback path cannot run 'auto' (the server quantiles nothing) and pins
     * 0.1 raw — permissive by design there; client-side selection does the narrowing.
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
    scoreThreshold: 'auto',
    /**
     * Wrong-book failsafe: a chunk must also reach this RAW (uncentered) cosine to be admitted at all.
     * 0 = off. Plugin path only — the stock-ST fallback never sees it.
     *
     * This is a different job from scoreThreshold, which gates the CENTERED score and so can only rank
     * within a book — centering subtracts the book's shared direction, which is exactly the information
     * "is this even the right book?" needs. Raw cosine keeps it: measured over 4 graded scenes and 3
     * deliberately unrelated books (bge-m3), every relevant entry scored >= 0.538 raw while wrong-genre
     * books topped out at 0.47-0.54. At 0.5 the gate cost NOTHING on any real scene (identical nDCG,
     * identical entries kept) and cut wrong-book contamination from 10-19 entries to 0-2 in 7 of 9
     * query x book pairings.
     *
     * Two measured limits: a same-genre wrong book (same author, same idiom) clears any raw-cosine gate —
     * only lexical mismatch can catch those, and this knob does not try; and 0.5 is calibrated on bge-m3,
     * whose relevant-vs-wrong margin here was ~0.04, so a different embedder may need a different value
     * (or 0 until measured).
     */
    uncenteredGate: 0.5,
    /**
     * Use the Worlds Apart server plugin's mean-centered search when it is loaded.
     * Centering removes the direction every chunk in a single-story corpus shares,
     * which is what compresses similarities into a narrow band. Scores come out much
     * lower in absolute terms — scoreThreshold is calibrated for centered scores.
     * Internal (always true): the plugin check in queryCollections is the real gate,
     * so centering is simply on whenever the plugin is present.
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
     *
     * Measured failure mode, WEAK scenes (isekai-time-whore msg3728: 4 relevant of 106 candidates, none
     * grade-5): when relevance is sparse the score surface is noise and a large early gap reads as a cliff —
     * every sensitivity 1.2-2.5 cut at 8 and missed 3 of the 4 relevant entries (31% of oracle F1) where
     * count max=10 reached 80%. Elbow still wins 3 of the 4 graded scenes, and it does NOT collapse on a
     * wrong book either (kept 10-19 junk entries across 10 null cells — see uncenteredGate for the failsafe
     * that actually handles those), so the honest claim is narrower than it once was: the elbow adapts
     * within a scene that HAS a relevance cliff, and does nothing useful when there isn't one.
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
     *
     * 10 sits mid-plateau on the measured dose-response (n=80 graded scenes, paired vs each
     * scene's own depth-10 capture): nDCG@10 climbs monotonically 1→10 (depth 3 −0.098,
     * p=0.001; depth 5 −0.053, p=0.020), is flat 10–15, and dips slightly at 20 (−0.009,
     * p=0.044) — over-widening dilutes the query. Cost is query length (~6k chars at 10).
     */
    messageDepth: 10,
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
     * The unit a key has to match WITHIN — `scan` | `message` | `paragraph`.
     *
     * A conjunction over the whole window matches terms a dozen messages apart, and the same
     * blindness silently vetoes on a negation five messages back. `scan` is the pre-setting
     * behaviour (one segment) and reproduces it exactly; core has no equivalent, so anything
     * narrower is a deliberate divergence from what core's selective logic does.
     *
     * Paragraph by default because message is close to a no-op on real prose: measured over one
     * author's chats, p90 is 19 paragraphs per message and 81.6% of scanned text lives in messages
     * of six or more. One corpus, so this is a default, not a finding about everyone.
     */
    matchWindow: 'paragraph',
    /**
     * What counts as "inside a word" when Match Whole Words is on — `permissive` | `strict`.
     *
     *   permissive  letters, digits, combining marks           `Joe` matches `Joe's`
     *   strict      ...plus hyphen and apostrophes             it does not
     *
     * Strict by default because the escapes are asymmetric: a `/regex/` key with `\b` recovers
     * permissive behaviour for any ASCII key, and `\b` is what core's own boundary approximates,
     * so one escape hatch returns both. From permissive there is no short form. Land in the mode
     * that is cheap to leave.
     *
     * Read by matcher.mjs through setBoundaryMode() rather than as an argument — it is global by
     * construction, and threading it would touch every countKey caller for a value none of them vary.
     */
    wordBoundary: 'strict',
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
     * Weight for BM25-over-KEYS in the layout fusion, separate from lexicalWeight (BM25-over-chunk-text).
     *
     * 1 is the measured optimum of the dose ladder (83 graded scenes, paired; 8 of them contribute only
     * ties, being reference-only books the tier rule empties): 1 helps 40/22 (+0.011 nDCG@10, p=0.030),
     * 0 hurts (−0.048, p=0.009), 3 hurts (−0.029, p=0.006). 2 is NOT distinguishable (−0.009, p=0.350) —
     * an earlier reading of it as harmful predates the reference-tier exclusion reaching nDCG at all, and
     * did not survive it. Consistent in sign across book types, and not an artifact of books that key
     * their memory entries: the gain is largest on Sommers (+0.021) and Richard (+0.020), which have none
     * of those, and smallest on Time Whore (+0.005), which is half of them.
     *
     * READ THE SIZE AGAINST THE NOISE FLOOR: the same grader re-scoring one scene moved its nDCG@10 by
     * 0.058, larger than any arm mean here. Pairing is what rescues these — the same grades sit on both
     * sides of every contrast — but no unpaired or cross-capture comparison at this size means anything.
     * null = follow lexicalWeight (the pre-split
     * behavior); pinning a number decouples the two so raising lexicalWeight no longer silently
     * drags the keys weight past its optimum.
     *
     * Only reaches the layout ranking. fuseRetrieval (what the cutoff cuts) scores vector + text and never
     * sees keys at all.
     */
    keywordWeight: 1,
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

/**
 * Settings with no UI: measured-stable knobs internalized after tuning (the measurements live on
 * their defaultSettings comments). They stay in defaultSettings so every read site and the eval
 * harness keep working, but ensureSettings resets them each init — a knob removed from the panel
 * must not linger at a stale hand-tuned value the user can no longer see.
 */
const INTERNAL_KEYS = [
    'meanCentered', 'scoreThreshold', 'entityFilter', 'properNounBoost', 'stopwordDocFreq',
    'bm25K1', 'bm25B', 'rrfK', 'scoreVectorKeys', 'keywordScoring',
    'chunkSize', 'chunkMode', 'minChunkSize',
    // Withdrawn with the query summarizer. queryMode in particular MUST be reset rather than
    // merely un-surfaced: anyone who had it on 'summary' would otherwise keep paying an LLM call
    // per generation with no control left in the panel to see it or turn it off.
    'queryMode', 'summaryPrompt', 'summaryLength',
];

/** The live WA settings object (extension_settings[MODULE_NAME]). */
export function settings() {
    return extension_settings[MODULE_NAME];
}

/** Merge defaults under any stored settings. Call once at init before reading settings(). */
export function ensureSettings() {
    extension_settings[MODULE_NAME] = Object.assign({}, defaultSettings, extension_settings[MODULE_NAME]);
    for (const k of INTERNAL_KEYS) extension_settings[MODULE_NAME][k] = defaultSettings[k];
}

/**
 * Cross-module runtime state (mutable). Holder object so any module can read/write a live value —
 * ESM won't let an imported `let` be reassigned across module boundaries, but object props can.
 * The engine writes the last* / plugin* fields; the hooks write attachedWorlds/generationIsDryRun;
 * the debug commands toggle verboseRun/dryRunInProgress; the panel + debug read them back.
 */
export const runState = {
    // Keyed `${world}.${uid}` — ST CORE'S format, which rankActivated receives and looks up here. Not a
    // candidate for the US separator; see the note in worldsapart.js syncWorld.
    lastScores: new Map(),        // vector scores from the last retrieval
    lastTextScores: new Map(),    // BM25-over-text scores, same keys
    lastLayout: [],               // final layout of the last scan, for /wa-dry
    lastQuery: '',                // last retrieval query text, bundled by /wa-grade
    lastQueryChat: [],            // the messages that query was joined from, for offline depth ablation
    scanChat: null,               // the interceptor's chat — core's own scan haystack (regex-scripted,
                                  // files appended); SCAN_DONE consumers read this, not the raw chat
    lastKeywordAdds: new Set(),   // `${world}.${uid}` of the last union's keyword-only force-activations
    forcedActivations: new Set(), // every `${world}.${uid}` force-activated this generation — WA's own
                                  // AND other extensions' (FORCE_ACTIVATE is a broadcast; WA listens).
                                  // The prune's ownership exemption: forced entries are never WA's to revoke.
    lastPruned: [],               // `${world}.${uid}` the prune deleted last scan, for /wa-debug
    lastScanText: '',             // last global-depth keyword scan window, bundled by /wa-grade
    gradeCutoff: null,            // /wa-grade widens the cut for its run; null = use the real settings
    lastCutKept: null,            // how many the cutoff kept on the last retrieval, recorded by /wa-grade
    lastCandidates: [],           // selection-candidate rows from the last debug-class run, for /wa-grade
    lastCandidateEntries: [],     // the WI entries behind those rows, aligned by index (for "view text")
    lastDropped: [],              // entries cut by budget
    lastSkipped: [],              // per-entry budget rejections + the cap that caused each
    attachedWorlds: new Set(),    // books ST currently has active for this chat
    waOwnsScan: false,            // bucket 2: WA intercepted the scan now in flight and owns its
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
    sourceFP: null,               // fingerprint of this extension's source plugin files
};
