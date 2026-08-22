// grading.mjs — assembles a graded-scene SAMPLE: the self-contained bundle /wa-grade writes and
// eval/graded-scene-grid.mjs reads back. Pure and ST-free (settings and candidate rows are injected), so
// eval/grading-check.mjs can exercise the real assembler under node instead of trusting it by eye.
//
// WHY A BUNDLE AND NOT A PILE OF PATHS. A graded scene has to stay comparable months later, and every
// input that lives outside the file is an input that can move underneath it: the chat gets played on, the
// lorebook gets edited, the settings get retuned. All three happened to scene1, and the resulting harness
// numbers were quietly describing a different configuration than the one that was graded. So the sample
// carries the query text, the grades, the settings snapshot, and (optionally) the books themselves.
//
// The one thing deliberately NOT carried is the vector index: it is large, and a stale copy would keep
// answering after the embedding model changed. The index path is recorded; the harness self-checks it by
// re-embedding a stored chunk and comparing cosine.

/** ST's own top-level directories. A stored path is cut at the FIRST of these, which is what makes it
 *  relative to the install root without having to know where that root is — the writer is the browser and
 *  cannot look for `config.yaml`. First rather than last, because a chat or a book may itself be named
 *  `data`, and the leftmost match is the install's. */
const ST_ROOTS = /[\\/](data|public|plugins|backups|default)[\\/]/;

/**
 * A path as a document should store it: relative to the ST install.
 *
 * AN ABSOLUTE PATH IS MACHINE IDENTITY AND NOTHING ELSE. It names a directory no other install has, so no
 * reader can use it — `eval/scene.mjs` skips a stored `index` that does not exist locally and derives its
 * own, which is the normal case for a scene somebody else captured. What it does carry is the author's OS
 * username, in a document meant to be shared. Measured before this existed: 97 of 107 documents held one,
 * across two different usernames.
 *
 * The reader half already assumed this — `stInstall().resolve` maps a `data/` prefix through config.yaml's
 * own `dataRoot` and anything else through the install root, and returns an absolute path untouched, which
 * is how absolutes went on working locally while defeating the design.
 *
 * Separators are normalised to `/` so a document written on Windows reads the same everywhere.
 *
 * @param {string} path
 * @returns {string} The path from the install root down, or the input if it names no ST directory
 */
export function stRelative(path) {
    if (typeof path !== 'string') return path;
    const m = ST_ROOTS.exec(path);
    return m ? path.slice(m.index + 1).replace(/\\/g, '/') : path;
}

/**
 * Copies a book's entries, keyed by uid.
 *
 * VERBATIM, AND THE WHOLE BOOK. A bundle that does not embed its books is malformed — there is no live-book
 * fallback anywhere by design, because reading the current lorebook is what let a later edit move an
 * already-graded scene's numbers.
 *
 * There is deliberately no "only the candidate entries" mode. It looks like the thrifty choice and is a
 * trap: the entity filter's gazetteer is built from every entry's keys and title, and admitting 2.3x too
 * many query terms moves content-lexical's BM25 at stage 3 (see ranking.mjs buildGazetteer; the 74%
 * figure that used to sit here was stage-1 BM25, which no longer exists).
 *
 * @param {Record<string, object>|object[]} entries A book's entries (ST stores a uid-keyed object)
 * @returns {Record<string, object>} uid-keyed entries
 */
export function keyByUid(entries) {
    const out = {};
    for (const entry of (Array.isArray(entries) ? entries : Object.values(entries ?? {}))) out[entry.uid] = entry;
    return out;
}

/**
 * Maps WA's live settings onto the harness's parameter names.
 *
 * The two vocabularies differ (settings are user-facing, the harness's are the scorers' own argument
 * names), and hand-transcribing them is how scene1 ended up with a partly reverse-engineered snapshot.
 * Whole-word/case-sensitivity come from ST globals, not WA settings, so they are injected.
 *
 * @param {object} s WA settings
 * @param {object} wi ST world-info globals
 * @param {boolean} wi.caseSensitive world_info_case_sensitive
 * @param {boolean} wi.wholeWords world_info_match_whole_words
 * @param {boolean} wi.includeNames world_info_include_names
 * @param {boolean} wi.allowWIScan extension_settings.note.allowWIScan
 * @returns {object} An arm's `params` for the harness
 */
export function captureParams(s, { caseSensitive, wholeWords, includeNames, allowWIScan }) {
    return {
        K: s.rrfK,
        K1: s.bm25K1,
        B: s.bm25B,
        // Recorded so a sample scores under the curve it was captured under. A bundle taken before
        // this existed has no field and falls back to sceneParams' 'bm25', which is what it ran under.
        repeatCurve: s.repeatCurve,
        repeatR: s.repeatR,
        LEXW: s.lexicalWeight,
        // null = follows LEXW; recorded as-is so a sample says which of the two it was captured under.
        KEYW: s.keywordWeight ?? null,
        boost: s.properNounBoost,
        stopwordDf: s.stopwordDocFreq,
        meanCentered: s.meanCentered,
        maxVectorEntries: s.maxVectorEntries,
        scoreVectorKeys: s.scoreVectorKeys,
        entityFilter: s.entityFilter,
        queryMode: s.queryMode,
        weightByOrder: s.weightByOrder,
        caseSensitive,
        wholeWords,
        // The boundary class whole-word matching used. Recorded here rather than only in
        // paramSnapshot's matchText block, because this is the half a harness reads back: without it
        // a permissive capture is re-scored at the default and the gap reads as a parameter effect.
        wordBoundary: s.wordBoundary,
        includeNames,
        // "Include in World Info Scanning" on the Author's Note panel. An ST global that changes what the
        // haystack CONTAINS, so it belongs with the other three rather than in the snapshot: with it on,
        // the Author's Note and the character's depth prompt enter the scan through the inject buffer.
        //
        // THE DEPTH PROMPT ENTERS FOR EVERY ENTRY when this is on, bypassing `matchCharacterDepthPrompt` —
        // which is the same text's per-entry opt-in. So an entry that never asked to scan it still does,
        // and two captures of one scene under different settings of this flag activate differently.
        allowWIScan,
    };
}

/** Median of an odd or even count; even falls back to the LOWER middle rather than averaging, so the
 *  result is always a grade a rater actually gave rather than a 2.5 the scale has no anchor for. */
const median = v => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) / 2)];

/**
 * The grade in force on a row, whoever set it. NaN when nothing has graded it, so a caller's existing
 * `|| 0` or `Number.isFinite` guard keeps its meaning.
 *
 * THE FILE CARRIES THE RECORD; THIS RESOLVES IT. A row holds every verdict ever passed, in the order
 * passed, and no reduced value beside them (bundle-schema.md, *The bundle presents the record*) — so which
 * one counts is decided here and two readers may answer differently without either being wrong about what
 * the file says.
 *
 * A HUMAN OUTRANKS AN LLM, and among humans the LATEST wins: a person re-grading a row has looked at the
 * earlier verdict and replaced it, which is a revision rather than a second opinion.
 *
 * AMONG LLM VERDICTS THE MEDIAN WINS once three exist, and latest-wins is the fallback below that.
 * Newest-first is only defensible when a later pass is known to be better, and it is not: re-grading the
 * same rows with the same model under a corrected rubric moved ~30% of the relevant set out and a smaller
 * number in, the same magnitude as the contract's own non-reproduction rate (CLAUDE.md, graded scenes).
 * At three the median is the majority on the >= 3 line whenever a majority exists, stays on the 0-4 scale
 * and needs no tie policy for an odd count. Two disagreeing verdicts cannot be resolved by any rule over
 * themselves; those keep the latest and want a third pass.
 *
 * MEASURED: this rule reproduces all 11,946 of the stored `llmGrade` scalars in eval-data exactly, which
 * is what makes moving the resolution out of the file lossless rather than a silent re-labelling.
 *
 * EVERY VERDICT NAMES ITS RATER, and the rater's `kind` is the provenance — a verdict of kind `human` is
 * "a person set this", and a row with only `llm` verdicts is "no human has looked". The two used to be one
 * column written at the same value, which made an unreviewed row indistinguishable from one a human
 * reviewed and agreed with; at 87.7% self-agreement most reviews DO agree, so that collision would have
 * arrived silently on first use of the review flow.
 *
 * Provenance cannot be inferred from anything else here: an llm-graded document and a human-graded one are
 * structurally identical, and a filename convention is enforced by nothing.
 */
export const gradeValue = (g) => {
    const of = kind => (g?.grades ?? []).filter(v => v?.kind === kind).map(v => Number(v.grade)).filter(Number.isFinite);
    const human = of('human');
    if (human.length) return human[human.length - 1];
    const llm = of('llm');
    if (llm.length >= 3) return median(llm);
    if (llm.length) return llm[llm.length - 1];
    // A BARE `grade` IS A VERDICT NOT YET WRITTEN DOWN — what a human has just typed into the grading
    // table, before `gradeEntries` turns it into a record naming its rater. `splitGraded` and
    // `makeGradeOf` read rows in that state, so this is the live path rather than a legacy one.
    return Number(g?.grade);
};

/**
 * A candidate row is DURABLE — always-on or persist-on-trigger — rather than a relevance result.
 *
 * Two different authorial acts land in the same bucket: `constant` is play scaffolding, a configured
 * `sticky` is a standing sheet about a character or place. Both are injected by intent rather than chosen
 * by relevance, so both are excluded from grading — but only the first is scaffolding, which is why the
 * predicate is named for what the rows ARE and not for one of the two reasons.
 *
 * Tiered off the CONFIGURED sticky value and the runtime constant class, never the runtime sticky state:
 * a sticky entry reads `block: 'dynamic'` on its keyword-activation turn, and a dry run never arms the
 * effect at all. Grading these would drag nDCG down for entries relevance never chose.
 * DURABLE, not "reference": reference is the TIER (not STMB-marked — world rules, settings), and the two
 * cross-cut. A keyword-activated reference entry is not durable, and a durable entry may be either tier.
 * This predicate is about how the row got into the prompt, not what kind of thing it is.
 *
 * Takes a capture ROW (`block`/`sticky`). eval/scene.mjs `isDurableEntry` is the same question asked of a
 * raw entry (`constant`/`sticky`), which is a different shape and cannot share this one.
 *
 * @param {object} row Candidate row
 * ARMED, not configured. A sticky entry is only in the prompt by intent once an earlier turn armed the
 * effect; before that it is ordinary content competing for selection like anything else, and excluding it
 * deletes real entries from the population — 34 of sommers' 45 reference entries are sticky: 1 with
 * constant false, so the configured reading removed that book's whole reference tier. `block` is what the
 * runtime classified the row as, which is where the armed effect shows; `sticky` is the setting and says
 * nothing about this turn. A dry run arms nothing, so on a /wa-grade capture this reduces to constant.
 *
 * @returns {boolean} True when the row is durable — constant, or sticky with the effect armed
 */
export const isDurable = row => row.block === 'constant' || row.block === 'sticky';

// --- delta pooling (/wa-super-grade) -----------------------------------------------------------------
//
// WHY THIS EXISTS. A single sample's pool is whatever ONE configuration surfaced — 15-20 entries out of a
// 145-334 entry book. Score a configuration far from that one and its top rows are unjudged, so they count
// as irrelevant and it is penalised for surfacing entries nobody looked at. That is textbook pool bias, and
// it is fatal to a zero-based defaults review, which exists precisely to score distant configurations.
//
// The fix is iterative pooling: capture several population-changing configurations, union what they
// surfaced, grade the union once, and keep going until the configurations the grid actually favours have
// fully-judged top rows. That only stays cheap if each round grades the DELTA, which is what these do —
// otherwise round four re-grades everything from rounds one through three and the loop dies of tedium.
//
// So arm count is deliberately not a constant anywhere in this module. It is whatever the coverage number
// in graded-scene-grid.mjs says it needs to be.

/** Unit Separator — see CLAUDE.md. A composite key git diffs, grep matches and awk doesn't truncate. */
const US = '';

/**
 * A row's identity. uid alone is ambiguous across books, so it is book + uid.
 *
 * `book`, never `world`. `entry.world` is ST's own field on an ST entry — set by core as `entry.world =
 * file`, "required by the timed effects manager" — and WA reads it exactly where an ST entry is turned
 * into a WA row. Past that boundary the name is `book` everywhere: in the schema, in a row, in a key. One
 * name per concept is what makes either of them greppable.
 */
export const rowKey = row => `${row.book ?? ''}${US}${row.uid}`;

/**
 * Unions several arms' candidate rows into one list for the grader.
 *
 * FOR THE UI ONLY. Each arm's SAMPLE keeps its own rows, with its own per-signal scores under its own
 * `params` — that is what makes a capture re-runnable. A merged row would carry one arm's numbers under
 * another arm's parameters, which is a lie the offline harness would then reproduce faithfully.
 *
 * A duplicate keeps the FIRST arm's row (arms are passed best-understood-first, normally shipped-defaults
 * first) and accumulates the labels that surfaced it, so the grader can see whether a row is consensus or
 * the pet of one configuration. Ordered by best rank achieved across arms, so the strongest candidates are
 * graded while attention is freshest.
 *
 * REFERENCE ROWS ARE KEPT, deduped like any other. They were dropped here — on the grounds that the same
 * constant appearing N times serves no grader — which quietly made capture a function of what the UI
 * intended to display: a super-grade sample recorded ZERO constant or sticky rows, while a plain /wa-grade
 * of the same scene recorded them listed-but-ungraded. A sample is the complete package of what the run
 * selected; whether a row is offered for grading is the UI's call, made downstream from this. Dedup already
 * solves the N-times problem the old rule was aimed at.
 * ABSENT SIGNALS ARE FILLED FROM AN ARM THAT HAS THEM; competing ones never are. The two are different
 * operations and only the second is the blend this function refuses. `keys` on a vectorized entry with
 * `scoreVectorKeys` off is not a low score, it is a quantity that arm cannot express — so such an entry
 * showed no keys signal on every row except the one `keys-live` happened to surface first, which made the
 * arm's entire purpose invisible in the UI that exists to motivate running it. Filling the hole is honest; picking a winner
 * between two arms that both measured a value would not be.
 *
 * ONLY THE RAW PER-SIGNAL MEASUREMENTS ARE FILLABLE (cosine, text, keys). `score` is fused and the ranks
 * are positions within one arm's ranking, so both are arm-relative — a value copied from elsewhere would
 * mean something different in its new row. Those stay as the supplying arm left them.
 *
 * `from` names the arm the base row came from and `filled` maps each borrowed signal to its source, so the
 * table can say where every number originated. A row whose columns come from two configurations without
 * saying so is the failure this replaces, not a smaller version of it.
 *
 * ONE CAVEAT ON LEGACY SAMPLES: captures written before `Number.isFinite` replaced a truthiness test in
 * worldsapart.js recorded a measured 0 as null, so a fill can overwrite a real zero there. New captures
 * distinguish the two.
 *
 * @param {Array<{arm: string, rows: object[], entries: object[]}>} arms Per-arm captures, aligned rows/entries
 * @returns {{rows: object[], entries: object[]}} Deduped rows (each with `arms`, `bestRank`, `from`, `filled`) + aligned entries
 */
const FILLABLE = ['cosine', 'text', 'keys'];

export function unionArms(arms) {
    const seen = new Map();   // rowKey -> { row, entry }
    for (const { arm, rows, entries } of arms ?? []) {
        (rows ?? []).forEach((row, i) => {
            const key = rowKey(row);
            const hit = seen.get(key);
            const rank = Number(row.index ?? Infinity);
            if (hit) {
                hit.row.arms.push(arm);
                hit.row.bestRank = Math.min(hit.row.bestRank, rank);
                for (const sig of FILLABLE) {
                    if (hit.row[sig] == null && row[sig] != null) {
                        hit.row[sig] = row[sig];
                        (hit.row.filled ??= {})[sig] = arm;
                        // `why` — the matched keys and their excerpts — travels with the keys value it
                        // explains, from the SAME arm. An arm that could not score keys also had no hits
                        // to report, so this is the same absence, and leaving it behind produced a score
                        // with no visible cause on every filled row.
                        if (sig === 'keys' && !(hit.row.why ?? []).length && (row.why ?? []).length) hit.row.why = row.why;
                    }
                }
                return;
            }
            seen.set(key, { row: { ...row, arms: [arm], bestRank: rank, from: arm }, entry: entries?.[i] });
        });
    }
    const merged = [...seen.values()].sort((a, b) => a.row.bestRank - b.row.bestRank);
    return { rows: merged.map(x => x.row), entries: merged.map(x => x.entry) };
}

/**
 * Splits a union into rows that still need a human and rows an earlier round already judged.
 *
 * Matched on book+uid, never on title: titles get edited, and a retitled entry silently regraded from
 * zero would move the numbers of every arm that surfaced it. Prior rounds carry both fields (every sample
 * /wa-grade has ever written records them), so identity matching costs nothing.
 *
 * @param {object[]} rows Union rows from unionArms
 * @param {Array<{book?: string, uid?: number, grade: number}>} prior Verdict rows from earlier rounds
 * @returns {{fresh: object[], known: object[], priorOf: Map<string, number>}} Split, plus rowKey -> prior grade
 */
export function splitGraded(rows, prior) {
    const priorOf = new Map();
    for (const g of prior ?? []) {
        // THE VALUE IN FORCE, through the one function that decides it. Reading a human field alone made
        // the reviewer blind to every judge-graded row, which is most of the corpus: the table rendered as
        // if nothing had ever been graded. Writing stays human-only; only the pre-fill reads both.
        const v = gradeValue(g);
        if (g && g.uid !== undefined && Number.isFinite(v)) {
            priorOf.set(rowKey(g), v);
        }
    }
    return {
        fresh: (rows ?? []).filter(r => !priorOf.has(rowKey(r))),
        known: (rows ?? []).filter(r => priorOf.has(rowKey(r))),
        priorOf,
    };
}

/**
 * Accumulates this round's verdicts onto the earlier rounds'.
 *
 * NOTHING IS EVER OVERWRITTEN. A regrade APPENDS to the row's `grades`; it does not replace the row,
 * and it does not replace the verdict it disagrees with. This used to be last-writer-wins, which meant a
 * second pass over an already-graded scene silently deleted the first pass's verdict — the one comparison
 * that says whether a rater or a rubric moved.
 *
 * The exemption is a repeated PASS, not a repeated value — `passKey`: same rater, same knobs, same day is
 * one sitting, and a second Save of the same table must not stack a duplicate. Another day is a person
 * looking again, which is an event even when they land on the same grade. The same rule apply-review.mjs
 * and grade-pending.mjs apply, so all three writers agree about what a repeat is.
 *
 * Prior grades are kept even when this round's arms surfaced nothing matching them: they still describe
 * judged entries of the same book and scene, and the harness's pool is the judged set, not one capture's
 * candidate list.
 *
 * @param {Array<object>} prior Rows from earlier rounds
 * @param {Array<object>} fresh This round's rows, each a bare `grade` a human just typed
 * @param {{user?: string, now?: string}} [who] The rater, as v3 names them
 * @returns {object[]} Merged rows
 */
export function mergeGrades(prior, fresh, who = {}) {
    const by = new Map();
    for (const g of prior ?? []) if (g && g.uid !== undefined) by.set(rowKey(g), g);
    for (const g of fresh ?? []) {
        if (!g || g.uid === undefined) continue;
        const seen = by.get(rowKey(g));
        const lifted = gradeEntries([g], who)[0];
        if (!seen) { by.set(rowKey(g), lifted); continue; }
        const verdict = lifted?.grades?.slice(-1)[0];
        if (!verdict) continue;
        if ((seen.grades ?? []).some(v => v.kind === 'human' && passKey(v) === passKey(verdict))) continue;
        by.set(rowKey(g), { ...seen, grades: [...(seen.grades ?? []), verdict] });
    }
    return [...by.values()];
}

/**
 * The book whose vector collection this scene's ranking came out of — the sample's `primaryBook`.
 *
 * NOT ST's chat book, and not "a world". Both of those are ST's own concepts with ST's own semantics (the
 * lorebook bound to the chat via METADATA_KEY; the book an entry belongs to) and neither answers the
 * question the sample actually asks, which is "which collection must the harness load". They coincide most
 * of the time and diverge exactly where it matters: retrieval spans every attached vectorized book, so the
 * chat's bound book can easily be one that contributed nothing — or, if it has no entries at all, one ST
 * never reports as attached, leaving the sample keyed to a collection that does not exist.
 *
 * So it is read off the ranking instead: the book contributing the MOST retrieved rows. Most rather than
 * top-ranked, because the harness loads one collection and declares the other books' grades out of scope
 * (excludeTitles) — picking a book with one lucky top hit over one with twenty would throw the twenty away.
 * Ties break toward the higher-ranked book (Map keeps insertion order and sort is stable).
 *
 * `cosine` is the retrieval marker: null means the entry was never retrieved, and it must be compared
 * against null, not tested for truthiness — a genuine 0.00000 cosine is a retrieved row.
 *
 * @param {object[]} rows Candidate rows, ranked best-first, as /wa-debug builds them
 * @returns {string|null} Book name, or null when nothing was retrieved (a keyword-only scene)
 */
export function searchedBook(rows) {
    const counts = new Map();
    for (const row of rows ?? []) {
        if (row?.cosine !== null && row?.cosine !== undefined && row.book) {
            counts.set(row.book, (counts.get(row.book) ?? 0) + 1);
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * Assembles the sample.
 *
 * @param {object} args
 * @param {string} args.name Sample name (used for the filename)
 * @param {string} [args.notes] Free text
 * @param {string} args.query Retrieval query, verbatim
 * @param {Array<{name: string, mes: string}>} args.scanChat Scan-eligible messages at capture depth
 * @param {Array<{key: string, text: string, ambient: boolean, depth: number}>} [args.injects] Scan-enabled injects
 * @param {object} [args.sources] Scan sources some entry opted into (matcher.usedMatchSources)
 * @param {number} args.depth messageDepth the query was built at
 * @param {string} args.index Vector index path (recorded, not embedded)
 * @param {string} [args.chat] Chat file path — provenance, and the ONLY way to re-derive the query at another depth
 * @param {string} [args.book] Primary book path — the harness's fallback when no entries are embedded
 * @param {string} args.primaryBook Book whose collection was searched
 * @param {string} [args.embedModel] Embedding model id
 * @param {object} args.params The arm's knobs, from captureParams()
 * @param {object} args.snapshot Raw grouped paramSnapshot(), for the record
 * @param {object[]} args.candidates Candidate rows, as /wa-debug builds them (flat signals, `book`, `index`)
 * @param {Record<string, object>} args.books world -> uid-keyed entries (already trimmed)
 * @param {object[]} args.priority Per-book weight/offset/cap
 * @param {Array<{title: string, grade: number, book?: string, uid?: number}>} args.grades Human grades
 * @param {object} [args.cutoff] The grading depth this run captured to, and the live cap it overrode
 * @param {string} [args.now] ISO date (injected so the check is deterministic)
 * @returns {object} The sample manifest
 */
export function buildSample({ name, notes, query, queryChat, scanChat, injects, sources, depth, chat, book, index, primaryBook, embedModel, params, snapshot, candidates, books, priority, grades, cutoff, gradedCandidates, pluginFP, sourceFP, waVersion, stVersion, now }) {
    // `budget` leaves the snapshot and becomes a field of its own, so the document-level hoist carries it.
    const { budget, ...rest } = snapshot ?? {};
    // Grades for entries outside the searched collection can't be ranked offline: the harness loads one
    // vector collection, so a second book's entries have no cosine and never enter the ranking. Declaring
    // them here means the harness reports "excluded" instead of scoring them as irrelevant — the exact
    // confound the interleaved-books case introduces.
    const foreign = grades.filter(g => g.book && g.book !== primaryBook);

    return {
        name,
        notes: notes || `Graded ${now} from a live /wa-grade run.`,
        createdAt: now,
        createdBy: 'wa-grade',

        // Frozen inputs — everything needed to re-rank this scene with no live state.
        query,
        // The messages `query` was joined from, macros resolved, ST's {name, mes} shape. This is what makes
        // messageDepth sweepable from a frozen sample: buildQuery over the last d of these reproduces the
        // query at any depth <= the capture depth exactly, so ONE capture at a deliberately-too-wide depth
        // (20) ablates down to 15/10/5 with no chat file and no live state.
        //
        // Splitting `query` back apart cannot substitute for this. buildQuery joins with '\n\n' and RP
        // messages routinely contain blank lines, so the boundaries are not recoverable from the blob.
        queryChat,
        // THE HAYSTACK'S INPUTS, NOT THE HAYSTACK. `scanChat` is the scan-eligible MESSAGES as core
        // transformed them; `injects` are the scan-enabled extension prompts beside them, each with the
        // position and depth that decide which windows admit it. A reader builds the window for any depth,
        // matchWindow and includeNames from these (matcher.mjs `makeWindowFor`) — the only direction that
        // works, since a joined window cannot be narrowed and cannot be re-segmented.
        //
        // Same shape as `queryChat`, which freezes the query's messages for the same reason.
        scanChat,
        injects,
        sources,
        depth,
        // Path only, for provenance and for re-deriving a WIDER window than was captured — the one thing
        // queryChat can't do. A played-on chat invalidates it; queryChat is what's actually frozen.
        chat: stRelative(chat),
        // Which deployed plugin produced these scores. Retrieval math lives in plugin/ and a redeploy can
        // move every per-entry signal in the sample without touching a single setting — server-side entry
        // pooling did exactly that. `pluginFP` is what served the capture, `sourceFP` what the extension's
        // own copy hashed to; equal means the deploy was current. A harness run against a different plugin
        // is comparing rankings to grades collected under different arithmetic.
        pluginFP,
        sourceFP,
        // WHAT PRODUCED THIS CAPTURE, resolved rather than declared: `<branch>@<git describe>`. Undefined
        // where the writer cannot resolve it — the browser has no git, and ST's own /version reports a
        // branch and a short HEAD with no tags and no dirty flag, which is the honest resolution available
        // there. A missing field reads as an older or thinner capture, never as a broken file; `sourceFP`
        // is the stronger drift signal for WA anyway, being a hash of the code rather than a name for it.
        waVersion,
        stVersion,
        embedModel,
        // STAGE 4'S CAPS, DOCUMENT-LEVEL, split out of the snapshot beside `embedModel` for the same
        // reason that one is: an arm never varies them. `tokenizer` is ST's `getTokenizerModel()`, an
        // environment fact WA cannot change. The maxes and the token budget are WA's own, but a budget
        // arm is never CAPTURED — every cap is a prefix cut over the layout ranking, and the per-entry
        // `tokens` counts are recorded, so it is swept offline through `applyBudget` instead. Measured:
        // 0 of 106 multi-arm documents vary any of it.
        budget,
        primaryBook,
        // Path to the primary book on disk. PROVENANCE ONLY, never a fallback: no reader may open it,
        // because reading the live lorebook is what let a later edit move an already-graded scene's numbers.
        // RELATIVE TO THE ST INSTALL, both of them — see stRelative. An absolute path is the author's home
        // directory, which no reader can use and every reader can be identified by.
        book: stRelative(book),
        index: stRelative(index),

        // The arm's knobs, under the name the schema gives them. `captureParams` was the v2 name and is
        // gone: one name for the concept, so a grep for `params` finds the schema, the writer and every
        // reader at once.
        params,
        paramSnapshot: rest,

        bookPriority: priority,
        books,

        grades,
        gradeScale: GRADE_SCALE,
        excludeTitles: foreign.map(g => g.title),

        // The grading depth, under its historical name — samples on disk predate the cliff's removal and
        // carry its settings here too. A later run diffs against what was actually graded.
        cutoff,
        // How many rows the grader was actually shown. Rows past it are UNGRADED, not irrelevant, so the
        // harness needs it to know which of its deep cutoff arms it is allowed to believe.
        gradedCandidates,
        candidates,
    };
}

/** Fields that are identical across every arm of one graded scene, so they are stored ONCE at the top of
 *  the document. Everything else — query, candidates, params, cutoff, primaryBook — is per-arm and must
 *  not be hoisted: the summary arm has a different query, and a lexical-only arm can retrieve from a
 *  different book. `budget` is here rather than in `paramSnapshot` because stage 4's caps are replayed
 *  OFFLINE from the recorded layout order and per-entry token counts, so no arm ever captures a variant. `books` and the haystacks are shared too but are NOT here: they are the bulk, and the
 *  schema puts them last (bundle-schema.md, *Field order is part of the schema*). */
const SHARED_FIELDS = ['name', 'notes', 'createdAt', 'createdBy', 'bookPriority', 'gradeScale', 'embedModel', 'budget', 'pluginFP', 'sourceFP'];

/** Per-arm fields that are the SCENE's, not the arm's, and so move onto the scene rather than repeating. */
const SCENE_FIELDS = ['chat', 'scanChat', 'injects', 'sources'];   // a sample's names for sceneChat / sceneChats / sceneInjects / sceneSources

/** Every field `bundleSamples` reads off a sample and places itself. A caller assembling samples out of an
 *  older document uses this to tell the document's own fields from an arm's: anything NOT here and not
 *  already on the arm is document-level and belongs in `extra`, or it repeats once per arm. */
export const DOC_FIELDS = [...SHARED_FIELDS, ...SCENE_FIELDS, 'books', 'grades'];

/** Per-candidate fields that are numeric SIGNAL VALUES, and so live under `scores`. Everything else on a
 *  candidate — identity, index, tokens, the fused score, the ranks, the budget verdict — stays flat beside
 *  it, because `scores` is "whatever the capture recorded, keyed by the feature's own name" and a fitted
 *  model indexes into it by that name (bundle-schema.md, *`scores` is a capture record*). A rank is not a
 *  feature and the fused score is not one either: both are arm-relative positions, not measurements. */
const SIGNAL_FIELDS = ['cosine', 'text', 'keys', 'properNouns', 'length'];

/** The schema this writer emits and this reader accepts. One version exists; nothing on disk predates it. */
export const SCHEMA_VERSION = 3;

/**
 * A scene's id: `<normalized chat>-msg-<start>-<end>`.
 *
 * Composed rather than opaque, so a reader reasons from the id alone and can check it against the fields it
 * was built from. Normalized is the chat's basename without extension, with every run of anything outside
 * `[A-Za-z0-9_]` collapsed to `-` — which is also what makes the id safe to compose at all, chat names
 * being filenames.
 *
 * @param {string} chat Chat file path or name
 * @param {number} end The message the scene ends at — the graded moment
 * @returns {string} Scene id
 */
export const sceneId = (chat, end) => {
    const base = String(chat ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
    return `${base.replace(/[^A-Za-z0-9_]+/g, '-')}-msg-${end}`;
};

/**
 * A rater's canonical id: ONE field, so grouping is a plain key comparison.
 *
 * A RATER IS WHOEVER PASSED A VERDICT, and `kind` says which sort — `human` or `llm`. A human is
 * identified by a UUID and that is the whole id. An llm is identified by three things, US-joined:
 *
 *   model         the reference as invoked, e.g. `gemma4:31b-mlx`
 *   modelDigest   what that reference RESOLVED to; empty when nothing can resolve it
 *   rubric        the contract it graded under, e.g. `scene-relevance@8460b922`
 *
 * THE DIGEST IS IN THE ID BECAUSE THE NAME IS NOT AN IDENTITY. `bge-m3:latest` is whatever was pulled
 * most recently, so two captures months apart record one string for different weights — the same failure
 * as reading a declared version instead of a resolved one. Ollama's API returns a manifest digest per
 * model; a hosted model has none to give, and an empty component says so rather than implying stability
 * nothing provides.
 *
 * US, NOT A PRINTABLE SEPARATOR. **Measured** on this machine: 11 of 11 Ollama models carry a `:`
 * (`gemma4:31b-mlx`, `bge-m3:latest`) and every MLX model is a HuggingFace repo id carrying a `/`, while
 * `@` already appears inside a rubric — so a printable join cannot be decomposed. US is a control
 * character and cannot occur in either component, which is why CLAUDE.md makes it the project's composite
 * key everywhere else.
 */
export const raterKey = r => (r?.kind === 'human'
    ? String(r.id ?? '')
    : [r?.modelDigest || r?.modelName || '', r?.rubric ?? ''].join(US));

/** The inverse. A human's id has no components; an llm's decomposes into the two above. `isDigest` says
 *  whether the model half is a resolved content digest or a name standing in for one. */
export const raterParts = r => (r?.kind === 'human'
    ? { id: r.id }
    : (([modelId, rubric]) => ({ modelId, rubric, isDigest: /^[0-9a-f]{64}$/.test(modelId) }))(String(r?.id ?? '').split(US)));

/**
 * A PASS's identity: the rater, the knobs it ran under, and the day. This is what a writer deduplicates
 * on, and it is NOT the rater — that was the confusion this replaces.
 *
 * SETTINGS ARE NOT IDENTITY. Seed, effort, temperature, context length and thinking change the SAMPLE, not
 * who produced it: the same weights under the same rubric sampled twice is one rater giving two verdicts,
 * which is exactly the third vote the median rule wants. Folding a seed into the rater would also assert a
 * determinism nothing has — a model without one is nondeterministic, one with it frequently still is, and
 * CLAUDE.md records hosted reasoning models honouring neither seed nor temperature (measured: identical
 * requests, same seed, 1815 vs 935 reasoning tokens).
 *
 * WHO AND WHEN, and nothing else. Dedup runs over ONE entry's verdicts and a pass grades each row exactly
 * once, so two verdicts on a row always came from two dispatches — which differ in their millisecond
 * stamp. `params` therefore never disambiguates, and putting it in the key would only make identity
 * sensitive to a writer's completeness: start recording one more knob and an old verdict stops matching
 * its own re-merge. A description does not belong inside an identity, which is the same mistake as
 * folding effort into the rater.
 */
export const passKey = v => [v?.id ?? '', v?.gradedAt ?? ''].join(US);

/** Provenance a person reads, carried beside the id and never part of it. */
const RATER_DESC = ['modelName', 'family', 'quant', 'modelParams'];

/**
 * The distinct raters across a scene's verdicts, as one table plus the index each verdict carries.
 *
 * ONE `grades` ARRAY, NOT ONE PER KIND. The file promises every verdict "in the order it was passed"
 * (bundle-schema.md), and two arrays cannot express that across kinds — a human grading, an llm
 * re-grading under a corrected rubric, then the human revising is exactly the sequence the review flow
 * produces, and split arrays record it as two unrelated orders. Provenance is not lost by merging them:
 * it moves from which array a verdict sits in to which rater it names, which is structural either way.
 * The collapse the split guarded against was one FIELD holding both kinds at one value with nothing
 * saying which; here nothing can be written without naming a rater.
 *
 * A VERDICT NAMES ITS RATER BY INDEX. Spelled out per verdict these are the same handful of strings
 * repeated tens of thousands of times — measured on the corpus, 645KB of llm identity across 3 models and
 * 4 rubrics — and unreadable by eye, which is most of what anyone does with a bundle.
 *
 * DEREFERENCING IS NOT TRANSLATING. `openBundle` resolves the index back to the whole rater, so every
 * reader and writer works in identities and only the file is indexed. Unlike a joined blob, an index can
 * always be followed.
 *
 * The table is per DOCUMENT, so an index is document-local. Pooling several documents means remapping
 * through each one's own table — which is why the id, not the index, is the identity.
 */
function indexVerdicts(entries) {
    const raters = [];
    const at = new Map();
    const index = (v) => {
        const kind = v.kind === 'human' ? 'human' : 'llm';
        const id = raterKey({ kind, ...v });
        const key = `${kind}${US}${id}`;
        if (!at.has(key)) {
            // Provenance is recorded from the FIRST verdict that named this rater. A later verdict with
            // the same id and a different recorded name is the same rater under another alias, which is
            // exactly what keying on the digest is for — so the alias is not a second row.
            const desc = {};
            for (const k of RATER_DESC) if (v[k]) desc[k] = v[k];
            at.set(key, raters.length);
            raters.push({ rater: raters.length, kind, id, ...desc });
        }
        return at.get(key);
    };
    /** Splits a verdict into WHO passed it and WHAT it says; only the second stays on the row. */
    // WHO passed it against WHAT it says. `params` stays with the verdict: it is how this sample was
    // drawn, not who drew it.
    const who = ({ kind, id, modelDigest, rubric, modelName, family, quant, modelParams, ...rest }) =>
        [{ kind, id, modelDigest, rubric, modelName, family, quant, modelParams }, rest];
    const out = (entries ?? []).map(e => ({
        ...e,
        ...((e.grades ?? []).length
            ? { grades: e.grades.map(g => { const [r, v] = who(g); return { rater: index(r), ...v }; }) }
            : {}),
    }));
    return { entries: out, raters };
}

/** The inverse: an index back to the rater it names, so a reader never handles indices. */
const deref = (entries, raters = []) => (entries ?? []).map(e => ({
    ...e,
    ...(e.grades ? { grades: e.grades.map(({ rater, ...v }) => { const { rater: _i, ...who } = raters[rater] ?? {}; return { ...who, ...v }; }) } : {}),
}));

/**
 * A live grade row -> the scene entry that carries its verdicts.
 *
 * THE RECORD, NOT A RESOLUTION. A human's verdict appends to `humanGrades` and a judge's to `llmGrades`,
 * both in the order taken, and nothing writes a reduced value beside them — which verdict counts is the
 * reader's question (metrics.mjs `gradeValue`). A reduced value stored beside the record is
 * indistinguishable from a verdict someone gave, which is the collision `grade`/`llmGrade` used to be.
 *
 * Rows arriving from an earlier round already carry arrays; a freshly typed one carries a bare `grade`,
 * which is a human's by definition (only a human writes `grade` — CLAUDE.md, graded scenes).
 *
 * @param {object[]} grades Live grade rows: {title, book, uid, grade?, grades?}
 * @param {{user?: string, now?: string}} [who] Rater identity for a bare `grade`, and the date to stamp
 * @returns {object[]} Scene entries
 */
export function gradeEntries(grades, { user, now } = {}) {
    const out = [];
    for (const g of grades ?? []) {
        if (!g || g.uid === undefined) continue;
        const verdicts = [...(g.grades ?? [])];
        if (Number.isFinite(Number(g.grade))) {
            verdicts.push({ kind: 'human', ...(user ? { id: user } : {}), grade: Number(g.grade), ...(now ? { gradedAt: now } : {}) });
        }
        out.push({
            book: g.book ?? '',
            uid: g.uid,
            // Duplicated from the entry for triage: reading a bundle by eye is most of what anyone does
            // with one, and a list of uids is unreadable.
            title: g.title,
            ...(verdicts.length ? { grades: verdicts } : {}),
        });
    }
    return out;
}


/**
 * A DEBUG ROW -> a v3 candidate: signals gathered under `scores`, everything else carried across as-is.
 *
 * THE ONE TRANSFORMATION, and it runs in one direction only. `/wa-debug`'s row exists to be handed to
 * `console.table`, which is why its signals are flat — a nested `scores` renders as `[object Object]` and
 * the table is the row's whole purpose. So the runtime keeps the display shape, the file keeps the schema
 * shape, and this is the named crossing between them.
 *
 * GATHERING IS ALL IT DOES. Every other field keeps its name on both sides, so a row and a candidate are
 * the same thing seen twice rather than two vocabularies — `book`, `index`, `block`, `tokens`, `cut` read
 * the same in the console table and in the file.
 *
 * There is deliberately no inverse. A reader gets the candidate as the file holds it: flattening `scores`
 * on the way out would put a superseded shape in front of every reader, and then no grep could tell a v2
 * leftover from a live runtime field.
 */
const toCandidate = (row, i) => {
    const scores = {};
    const flat = {};
    for (const [k, v] of Object.entries(row)) {
        if (SIGNAL_FIELDS.includes(k)) scores[k] = v; else flat[k] = v;
    }
    return { book: row.book ?? '', uid: row.uid, index: Number(row.index ?? i), ...flat, scores };
};

/**
 * A book's content identity, stable across installs.
 *
 * WHAT IS HASHED IS THE STORED BOOK, not the book on someone's disk — which is the honest answer to "did
 * these two captures grade the same thing", since a capture can only speak for what it froze.
 *
 * KEY ORDER IS NORMALISED because it carries no meaning and two installs need not agree on it: ST builds
 * an entry object however its own code happens to, and `JSON.stringify` preserves insertion order. Without
 * the sort, the same book captured by two people would hash apart and the field would answer nothing.
 *
 * Web Crypto rather than `node:crypto`, because this module is imported by the browser half too. That
 * makes it async, which is why `bundleSamples` is.
 */
const canonical = v => {
    if (v === undefined || typeof v === 'function') return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.keys(v).sort()
        .filter(k => v[k] !== undefined && typeof v[k] !== 'function')
        .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)
        .join(',')}}`;
};

const sha256Hex = async text => [...new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(b => b.toString(16).padStart(2, '0')).join('');

/** A field that restates WHERE an entry is stored is not part of what the entry IS. `entry.world` is ST's
 *  own back-pointer to the book name — which is already the key of the `books` map holding it — and it is
 *  present or absent depending on which ST path produced the entries, so leaving it in made one lorebook
 *  hash two ways. Measured across the corpus: 21,077 entries carry it, 0 disagree with their book's name. */
const withoutLocation = e => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
    const { world, ...rest } = e;
    return rest;
};

/**
 * Content hashes for a `books` map, keyed by the same book names.
 *
 * SITS BESIDE `books` RATHER THAN INSIDE IT: a book is a uid-keyed map of entries and every reader walks
 * it with `Object.values`, so a `hash` key would arrive as a phantom entry in all of them. That is safe
 * because A CAPTURE'S BOOKS ARE IMMUTABLE — one document is one capture, and nothing rewrites the books it
 * froze. The two things that cut a book both do it away from disk: `scene.mjs` `dropUnavailable` filters a
 * loaded copy in memory, and `slice-bundles.mjs` cuts into a disposable review pack, which DROPS this field
 * rather than recomputing it — a subset of a book has no business claiming that book's identity.
 *
 * @param {Record<string, object>} books book name -> uid-keyed entries
 * @returns {Promise<Record<string, string>>} book name -> lowercase hex SHA-256
 */
export async function hashBooks(books) {
    return Object.fromEntries(await Promise.all(Object.entries(books ?? {}).map(
        async ([name, bk]) => [name, await sha256Hex(canonical(Object.fromEntries(
            Object.entries(bk ?? {}).map(([uid, e]) => [uid, withoutLocation(e)]))))])));
}

/**
 * Packs one sample per arm into one graded-scene document.
 *
 * ONE FILE, NOT N. The arms of a pooled grading differ only in how they were scored; they share the graded
 * scene, the verdicts, and — the bulk of the bytes by a wide margin — the embedded copies of every attached
 * book. Writing them separately meant N browser downloads to accept and N duplicate copies of a 300-entry
 * lorebook on disk, which is why the first version of this was annoying enough to replace.
 *
 * ONE SCENE IS A ONE-ELEMENT `scenes` LIST. There is no single-scene shape, so a reader that handles the
 * list handles everything and a writer never chooses between two layouts.
 *
 * @param {Array<{arm: string, sample: object}>} arms Per-arm samples from buildSample
 * @param {object} scene The scene's identity
 * @param {number} scene.start First message index covered
 * @param {number} scene.end Last message index covered
 * @param {string} [scene.user] Rater id for freshly typed grades — a UUID, see state.mjs `raterId`
 * @param {object} [extra] Document-level fields to carry (generatedFrom, population, grading, …)
 * @returns {Promise<object>} A schemaVersion 3 document
 */
export async function bundleSamples(arms, scene = {}, extra = {}) {
    const first = arms[0]?.sample ?? {};
    const doc = { schemaVersion: SCHEMA_VERSION };
    // WHAT IDENTIFIES THIS CAPTURE, surviving a rename. Nothing content-derived can: `name` and the scene
    // id both collide — two captures of one turn under different books share them, and the corpus has such
    // a pair whose only distinguishing mark was its filename. Minted by the caller so this module stays
    // ST-free; absent on a capture taken before the field existed.
    if (scene.captureId) doc.captureId = scene.captureId;
    for (const f of SHARED_FIELDS) if (first[f] !== undefined) doc[f] = first[f];
    Object.assign(doc, extra);

    const id = sceneId(first.chat, scene.end);
    const indexed = indexVerdicts(gradeEntries(first.grades, { user: scene.user, now: first.createdAt }));

    // A SCENE IS THE GRADED MOMENT — a chat and the message it ends at. Not a span: the span is what an
    // arm chose to read, and `graded-scene-grid`'s depth sweep holds the grades fixed while it varies
    // that, because widening the window reaches further back from the SAME moment. So `sceneStart` and
    // `depth` belong to the arm's capture of this scene, not to the scene.
    doc.scenes = [{ id, sceneChat: first.chat ?? '', sceneEnd: scene.end, entries: indexed.entries }];

    // ARMS AT DOCUMENT LEVEL, because an arm is a CONFIGURATION and a configuration spans scenes — that is
    // what a grid search is. Nesting them inside a scene records `params`, `waVersion` and `stVersion`
    // once per scene, so a fifteen-scene run repeats one arm's knobs fifteen times.
    doc.arms = arms.map(({ arm, sample }) => {
        const per = { name: arm };
        if (sample.waVersion !== undefined) per.waVersion = sample.waVersion;
        if (sample.stVersion !== undefined) per.stVersion = sample.stVersion;
        per.params = { ...(sample.params ?? {}), ...(sample.scoredBy ? { scoredBy: sample.scoredBy } : {}) };
        // THE CELL: this arm's capture of that scene. Everything varying with BOTH coordinates lives here
        // — the span it read, the query it built, the rows it surfaced. What varies with the
        // configuration alone stays on the arm; what varies with the moment alone stays on the scene.
        const cell = { sceneStart: scene.start, depth: sample.depth };
        for (const [k, v] of Object.entries(sample)) {
            if (SHARED_FIELDS.includes(k) || SCENE_FIELDS.includes(k) || k in extra) continue;
            if (['arm', 'grades', 'candidates', 'params', 'depth', 'waVersion', 'stVersion', 'scoredBy', 'books'].includes(k)) continue;
            if (v === undefined) continue;
            cell[k] = v;
        }
        // IN LAYOUT ORDER, which is load-bearing: every stage-4 cap is a prefix cut, so a reader can
        // replay the budget walk over the array as it stands.
        cell.candidates = (sample.candidates ?? []).map(toCandidate);
        per.scenes = { [id]: cell };
        return per;
    });

    // WHO THE INDICES NAME. Ahead of the bulk, because a verdict is unreadable without them.
    if (indexed.raters.length) doc.raters = indexed.raters;

    // THE BULK, LAST. Anything ahead of these is reachable with `head` — every scene, every param, every
    // verdict — and anything behind them is not.
    // CONTENT IDENTITY AHEAD OF THE BULK, because it is two lines and the trailing block is ordered by
    // size. It is also what a reader wants without inflating a 2MB book: "same book?" is answerable here.
    const books = first.books ?? {};
    doc.bookHashes = await hashBooks(books);

    // THE MESSAGES THE HAYSTACK IS BUILT FROM, once per scene — not a window. A window is fixed at one
    // depth, one matchWindow and one includeNames; these rebuild any of them, so arms reading the same
    // moment at different depths share one stored input instead of needing one blob each.
    doc.sceneChats = { [id]: first.scanChat ?? [] };
    // ONCE PER SCENE, beside the chat half they are admitted into. Every arm of a capture scans the same
    // injects — they are a property of the moment, not of a configuration — so hoisting them here is what
    // stops a six-arm document carrying six copies of an Author's Note.
    if ((first.injects ?? []).length) doc.sceneInjects = { [id]: first.injects };
    // THE CARD AND PERSONA TEXT AN ENTRY OPTED INTO, once per scene for the same reason as the injects:
    // they are a property of the moment, not of a configuration. Only the fields some entry's `matchXxx`
    // names are here (matcher.usedMatchSources) — the rest determined nothing, and a persona description
    // is the most personal thing a shareable document could carry.
    if (Object.keys(first.sources ?? {}).length) doc.sceneSources = { [id]: first.sources };
    doc.books = books;
    return doc;
}

/**
 * Selects one arm of one scene, as a flat view.
 *
 * FLAT, BUT NOT TRANSLATED. The document, the scene and the arm are three nesting levels and a caller
 * almost always wants one field from each, so the view merges them — but every field keeps the name the
 * SCHEMA gives it. A reader says `S.entries`, `S.params`, `c.book`, `c.scores.cosine`, which are the names
 * in `bundle-schema.md`, so a grep for any of them finds the schema and the readers together.
 *
 * The v2 view this replaces handed back `grades`, `captureParams`, `world` and `#`. Those are superseded
 * SCHEMA names, and manufacturing them for readers meant nothing downstream could be traced to the format
 * it was reading — and `world` in particular became unsearchable, since ST's own `entry.world` is spelled
 * the same and is a different thing.
 *
 * `arm` is the arm's `name` under a key that does not collide with the document's. It is the one field
 * here whose key differs from the schema's, and only because two levels both spell it `name`.
 *
 * @param {object} doc A schemaVersion 3 document
 * @param {string} [arm] Arm name; defaults to 'shipped' when present, else the first
 * @param {string} [scene] Scene id; defaults to the only scene, and is required past the first
 * @returns {object} The merged view
 */
export function openBundle(doc, arm = null, scene = null) {
    if (!Array.isArray(doc?.scenes)) {
        throw new Error('not a graded-scene document — no `scenes`');
    }
    const ids = doc.scenes.map(s => s.id);
    const sc = scene ? doc.scenes.find(s => s.id === scene) : doc.scenes[0];
    if (!sc) throw new Error(`document has no scene "${scene}" — available: ${ids.join(', ')}`);

    // An arm only counts here if it CAPTURED this scene: a grid is not guaranteed rectangular, and an arm
    // added in a later round may have run over some scenes and not others.
    const over = (doc.arms ?? []).filter(a => a.scenes?.[sc.id]);
    const names = over.map(a => a.name);
    const wanted = arm ?? (names.includes('shipped') ? 'shipped' : names[0]);
    const hit = over.find(a => a.name === wanted);
    // An unknown arm is an error rather than a silent fallback — scoring the wrong configuration and
    // reporting it as the requested one is the failure mode worth being loud about.
    if (!hit) throw new Error(`scene "${sc.id}" has no arm "${wanted}" — available: ${names.join(', ')}`);

    const { scenes: _s, arms: _a, sceneChats, sceneInjects, sceneSources, raters, schemaVersion: _v, ...docFields } = doc;
    const { entries, ...sceneFields } = sc;
    const { name: armName, scenes: _cells, params, ...armFields } = hit;
    const { depth, ...cell } = hit.scenes[sc.id];
    return {
        ...docFields,
        ...sceneFields,
        // The scene's haystack INPUTS, singular. `scanChat` is the messages; `injects` are admitted
        // beside them per depth by matcher.mjs `makeWindowFor`, which is how a reader builds a window.
        scanChat: sceneChats?.[sc.id] ?? [],
        injects: sceneInjects?.[sc.id] ?? [],
        sources: sceneSources?.[sc.id] ?? {},
        // Indices resolved back to whole identities: every reader and writer works in those, and only the
        // file is indexed. Lossless both ways — an index can always be followed.
        entries: deref(entries, raters),
        ...armFields,
        // The arm's knobs, and its capture of THIS scene flattened in beside them — the three nesting
        // levels a caller wants one field from each of, merged with every name the schema gives them.
        params,
        depth,
        ...cell,
        arm: armName,
    };
}

/** Every arm name in a scene. The handle a caller passes back to openBundle, which is how a tool that
 *  must see all the arms reads them without touching the file layout itself. */
export const armNames = (doc, scene = null) => {
    const sc = scene ? doc?.scenes?.find(s => s.id === scene) : doc?.scenes?.[0];
    return sc ? (doc.arms ?? []).filter(a => a.scenes?.[sc.id]).map(a => a.name) : [];
};

/**
 * Writes verdict rows back onto a single-scene document — the mirror of the `entries` openBundle hands
 * out, and the ONLY writer of the file layout besides bundleSamples. A tool that grafts, merges or
 * reviews grades reads through openBundle, works in that row shape, and lands its result here; none of
 * them needs to know where in a document a verdict lives.
 *
 * Single-scene only, and loud about it: every producer writes one scene per file today, and silently
 * putting one pass's verdicts on the first of fifteen scenes is not a failure anyone would see.
 *
 * @param {object} doc A schemaVersion 3 document
 * @param {object[]} rows Rows in the entry shape — book, uid, title, verdict arrays
 * @param {{user?: string, now?: string}} [who] Rater identity for any bare `grade` among them
 * @returns {object} The same document, mutated
 */
export function setGrades(doc, rows, who = {}) {
    if (!Array.isArray(doc?.scenes)) throw new Error('setGrades expects a schemaVersion 3 document');
    if (doc.scenes.length !== 1) throw new Error(`setGrades is for single-scene documents; this one has ${doc.scenes.length}`);
    const indexed = indexVerdicts(gradeEntries(rows, who));
    doc.scenes[0].entries = indexed.entries;
    if (indexed.raters.length) doc.raters = indexed.raters; else delete doc.raters;
    return doc;
}

/**
 * The grading scale: 0-4, each grade an INCLUSION DECISION rather than a magnitude. Anchored wording is
 * what inter-rater agreement hangs on — measured on one scene, restating the rubric alone nearly doubled
 * weighted kappa between two raters — so the anchors are data here and the grading UIs show them verbatim.
 */
export const GRADE_ANCHORS = [
    'Definitely not relevant',
    'Most likely not relevant; include only as filler',
    'Weakly relevant; 50/50 on inclusion',
    'Fairly relevant; should likely be included',
    'Directly relevant; should absolutely be included',
];
/** Top of the scale. Derived from the anchors so the two cannot drift apart. */
export const GRADE_SCALE = GRADE_ANCHORS.length - 1;

/** Sample -> pretty JSON + filename, ready for ST's download(). */
export function sampleFile(sample) {
    const slug = String(sample.name || 'scene').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
    return { filename: `${slug}.json`, content: `${JSON.stringify(sample, null, 2)}\n` };
}
