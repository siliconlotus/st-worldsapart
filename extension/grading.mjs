// grading.mjs — assembles a graded-scene sample: the self-contained bundle /wa-grade writes and
// eval/graded-scene-grid.mjs reads back. Pure and ST-free (settings and candidate rows are injected), so
// eval/grading-check.mjs can exercise the real assembler under node.
//
// A bundle, not a pile of paths: a graded scene has to stay comparable months later, and every input
// living outside the file can move underneath it — the chat gets played on, the lorebook edited, the
// settings retuned. So the sample carries the query text, the grades, the settings snapshot and the
// books themselves. The one thing deliberately not carried is the vector index: it is large, and a
// stale copy would keep answering after the embedding model changed. The index path is recorded; the
// harness self-checks it by re-embedding a stored chunk and comparing cosine.

// The scene guard below compares scan messages through the shipped window builder rather than a second
// copy of the segmentation rule. matcher.mjs is ST-free and imports nothing from here, so this stays
// node-importable and acyclic.
import * as matcher from './matcher.mjs';

/** ST's own top-level directories. A stored path is cut at the FIRST of these, which is what makes it
 *  relative to the install root without having to know where that root is — the writer is the browser and
 *  cannot look for `config.yaml`. First rather than last, because a chat or a book may itself be named
 *  `data`, and the leftmost match is the install's. */
const ST_ROOTS = /[\\/](data|public|plugins|backups|default)[\\/]/;

/**
 * A path as a document should store it: relative to the ST install.
 *
 * An absolute path is machine identity and nothing else: no other reader can use it, and it carries the
 * author's OS username in a document meant to be shared (G8). The reader half already assumes relative —
 * `stInstall().resolve` maps a `data/` prefix through config.yaml's own `dataRoot` and anything else
 * through the install root.
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
 * Verbatim, and the whole book. A bundle that does not embed its books is malformed — there is no
 * live-book fallback anywhere, because reading the current lorebook is what let a later edit move an
 * already-graded scene's numbers. There is deliberately no "only the candidate entries" mode: the entity
 * filter's gazetteer is built from every entry's keys and title, so a trimmed book admits far too many
 * query terms and moves content-lexical's BM25 at stage 3 (R22).
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
 * The two vocabularies differ — settings are user-facing, the harness's are the scorers' own argument
 * names — so the mapping lives here rather than being hand-transcribed per capture. Whole-word and
 * case-sensitivity come from ST globals, not WA settings, so they are injected.
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
    // No fusion params: K, LEXW, KEYW and weightByOrder described RRF over the layout, which no longer
    // exists — E[credit] orders the dynamic block and reads the signals directly. Not recorded as null
    // either, which would claim the capture ran with fusion disabled. Older bundles carry them and
    // sceneParams ignores what it has no use for.
    return {
        K1: s.bm25K1,
        // The chunker determines the index, so a sample that does not record it cannot be re-chunked
        // faithfully — `chunkConfig` would fall back to the shipped defaults and re-chunk a capture taken
        // at other settings wrong.
        chunkMode: s.chunkMode,
        chunkSize: s.chunkSize,
        minChunkSize: s.minChunkSize,
        B: s.bm25B,
        // Recorded so a sample scores under the curve it was captured under. A bundle taken before
        // this existed has no field and falls back to sceneParams' 'bm25', which is what it ran under.
        repeatCurve: s.repeatCurve,
        repeatR: s.repeatR,
        boost: s.properNounBoost,
        stopwordDf: s.stopwordDocFreq,
        meanCentered: s.meanCentered,
        maxVectorEntries: s.maxVectorEntries,
        entityFilter: s.entityFilter,
        caseSensitive,
        wholeWords,
        // The boundary class whole-word matching used. Recorded here rather than only in
        // paramSnapshot's matchText block, because this is the half a harness reads back: without it
        // a permissive capture is re-scored at the default and the gap reads as a parameter effect.
        wordBoundary: s.wordBoundary,
        includeNames,
        // "Include in World Info Scanning" on the Author's Note panel. An ST global that changes what the
        // haystack contains, so it belongs with the other three rather than in the snapshot: with it on,
        // the Author's Note and the character's depth prompt enter the scan through the inject buffer.
        // The depth prompt then enters for every entry, bypassing `matchCharacterDepthPrompt` — the same
        // text's per-entry opt-in — so two captures of one scene under different settings activate
        // differently.
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
 * The file carries the record; this resolves it. A row holds every verdict ever passed, in order, and no
 * reduced value beside them (bundle-schema.md, *The bundle presents the record*).
 *
 * A human outranks an llm, and among humans the latest wins: a person re-grading has looked at the
 * earlier verdict and replaced it, which is a revision rather than a second opinion.
 *
 * Among llm verdicts the median wins once three exist, and latest-wins is the fallback below that —
 * newest-first is only defensible when a later pass is known to be better, and it is not (G7). At three
 * the median is the majority on the >= 3 line whenever a majority exists, stays on the 0-4 scale and
 * needs no tie policy. This rule reproduces every stored `llmGrade` scalar in eval-data exactly (G7).
 *
 * Every verdict names its rater, and the rater's `kind` is the provenance: a row with only `llm`
 * verdicts is "no human has looked". Nothing else here can carry that — an llm-graded document and a
 * human-graded one are structurally identical, and a filename convention is enforced by nothing.
 */
export const gradeValue = (g) => {
    const of = kind => (g?.grades ?? []).filter(v => v?.kind === kind).map(v => Number(v.grade)).filter(Number.isFinite);
    const human = of('human');
    if (human.length) return human[human.length - 1];
    const llm = of('llm');
    if (llm.length >= 3) return median(llm);
    if (llm.length) return llm[llm.length - 1];
    // A bare `grade` is a verdict not yet written down — what a human has just typed into the grading
    // table, before `gradeEntries` turns it into a record naming its rater. `splitGraded` and
    // `makeGradeOf` read rows in that state, so this is a live path rather than a legacy one.
    return Number(g?.grade);
};

/**
 * A candidate row is durable — always-on or persist-on-trigger — rather than a relevance result.
 *
 * Two authorial acts land in the same bucket: `constant` is play scaffolding, a configured sticky is a
 * standing sheet about a character or place. Both are in the prompt by intent rather than chosen by
 * relevance, so both are excluded from grading — hence a name for what the rows are rather than for one
 * of the two reasons.
 *
 * Durable, not "reference": reference is the tier (not STMB-marked — world rules, settings) and the two
 * cross-cut. A keyword-activated reference entry is not durable, and a durable entry may be either tier.
 *
 * Armed, not configured. `block` is what the runtime classified the row as, which is where the armed
 * effect shows; `sticky` is the setting and says nothing about this turn. A sticky entry is ordinary
 * content competing for selection until an earlier turn arms it, so excluding on the configured value
 * deletes real entries from the population. A dry run arms nothing, so on a /wa-grade capture this
 * reduces to constant.
 *
 * Takes a capture row (`block`/`sticky`). eval/scene.mjs `isDurableEntry` is the same question asked of a
 * raw entry (`constant`/`sticky`), a different shape that cannot share this one.
 *
 * @param {object} row Candidate row
 * @returns {boolean} True when the row is durable — constant, or sticky with the effect armed
 */
export const isDurable = row => row.block === 'constant' || row.block === 'sticky';

// --- delta pooling (/wa-super-grade) -----------------------------------------------------------------
//
// A single sample's pool is whatever one configuration surfaced — a small fraction of the book (G10) —
// so a configuration far from it has unjudged top rows that count as irrelevant. That pool bias is fatal
// to a zero-based defaults review, which exists to score distant configurations.
//
// The fix is iterative pooling: capture several population-changing configurations, union what they
// surfaced, grade the union once, and keep going until the configurations the grid favours have
// fully-judged top rows. That only stays cheap if each round grades the delta, which is what these do.
//
// So arm count is deliberately not a constant anywhere in this module. It is whatever the coverage number
// in graded-scene-grid.mjs says it needs to be.

/** Unit Separator — see CLAUDE.md. A composite key git diffs, grep matches and awk doesn't truncate. */
const US = '';

/**
 * Whether two captures hold the same scene, by the three fields that define one: the query text, the scan
 * messages, and the depth they were read at. Returns the fields that differ; empty means the same scene.
 *
 * A grade is a verdict about a (scene, entry) pair, so a row may only be carried between two documents
 * that hold the same scene — and neither half is checkable by name. The scene id is a position in a file
 * that gets branched, edited and replayed, and `rowKey` is book + uid, which two scenes of one book share
 * for almost every row; a same-book carry-over is the commoner failure (G9).
 *
 * Depth is part of the scene, not metadata beside it: relevance is a property of the (entry, window)
 * pair, so ablating turns can remove the very reference that earned the grade. Two captures agreeing on
 * query and messages while disagreeing on depth are two scenes. (Assertion about the construct.)
 *
 * On the scan messages, never a joined window: the messages are what a document stores, and the window an
 * arm builds also depends on `matchWindow` and `includeNames`, which are the arm's knobs rather than the
 * scene's — sweeping those re-derives a window over the same frozen input, as `graded-scene-grid
 * --depths` does deliberately.
 *
 * Arms of one capture differ in `query` (the summary arm builds its own), so a caller holding several
 * arms of one scene asks whether any of them matches rather than picking one.
 *
 * @param {{query?: string, scanChat?: object[], depth?: number}} a
 * @param {{query?: string, scanChat?: object[], depth?: number}} b
 * @param {{ignoreTrailingWhitespace?: boolean}} [opts] See graft-grades.mjs for why that escape exists
 * @returns {string[]} Differing field names
 */
export function sceneDiff(a, b, { ignoreTrailingWhitespace = false } = {}) {
    const scanOf = v => matcher.scanWindow(v?.scanChat ?? [], { depth: v?.depth, includeNames: true });
    const read = (v, f) => (f === 'scanChat' ? scanOf(v) : f === 'depth' ? Number(v?.depth) : v?.[f]);
    // Trailing whitespace per LINE, matching what the capture/rebuild drift actually is.
    const flat = x => (typeof x === 'string' ? x.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n') : x);
    const norm = ignoreTrailingWhitespace ? flat : (x => x);
    return ['query', 'scanChat', 'depth'].filter(f => norm(read(a, f)) !== norm(read(b, f)));
}

/**
 * A row's identity. uid alone is ambiguous across books, so it is book + uid.
 *
 * `book`, never `world`. `entry.world` is ST's own field on an ST entry, and WA reads it exactly where an
 * ST entry becomes a WA row. Past that boundary the name is `book` everywhere — in the schema, in a row,
 * in a key — so either name stays greppable.
 */
export const rowKey = row => `${row.book ?? ''}${US}${row.uid}`;

/**
 * Unions several arms' candidate rows into one list for the grader.
 *
 * For the UI only. Each arm's sample keeps its own rows, with its own per-signal scores under its own
 * `params` — that is what makes a capture re-runnable. A merged row would carry one arm's numbers under
 * another arm's parameters, which the offline harness would then reproduce faithfully.
 *
 * A duplicate keeps the first arm's row (arms are passed best-understood-first) and accumulates the
 * labels that surfaced it, so the grader can see whether a row is consensus or the pet of one
 * configuration. Ordered by best rank achieved across arms.
 *
 * Reference rows are kept, deduped like any other: a sample is the complete package of what the run
 * selected, and whether a row is offered for grading is the UI's call, made downstream from this.
 *
 * Absent signals are filled from an arm that has them; competing ones never are. An arm that could not
 * score keys reports not a low score but a quantity it cannot express, so filling the hole is honest
 * where picking a winner between two measured values would not be.
 *
 * It unions candidates, so signals are read and written under `scores` — the shape the file holds and the
 * one `toCandidate` produces. A caller holding live /wa-debug rows converts them first rather than being
 * accommodated here.
 *
 * Only the raw per-signal measurements are fillable (cosine, text, keys). `score` is fused and the ranks
 * are positions within one arm's ranking, so both are arm-relative and a copied value would mean
 * something different in its new row.
 *
 * `from` names the arm the base row came from and `filled` maps each borrowed signal to its source, so
 * the table can say where every number originated.
 *
 * Caveat on legacy samples: captures written before `Number.isFinite` replaced a truthiness test in
 * worldsapart.js recorded a measured 0 as null, so a fill can overwrite a real zero there.
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
                    if (hit.row.scores?.[sig] == null && row.scores?.[sig] != null) {
                        (hit.row.scores ??= {})[sig] = row.scores[sig];
                        (hit.row.filled ??= {})[sig] = arm;
                        // `why` — the matched keys and their excerpts — travels with the keys value it
                        // explains, from the same arm: an arm that could not score keys also had no hits
                        // to report, so leaving it behind gives a score with no visible cause.
                        if (sig === 'keys' && !(hit.row.why ?? []).length && (row.why ?? []).length) hit.row.why = row.why;
                    }
                }
                return;
            }
            // `scores` is cloned, not shared: the fill writes into it, and a shallow copy would reach back
            // through the caller's row and mutate the arm it came from.
            seen.set(key, { row: { ...row, scores: { ...(row.scores ?? {}) }, arms: [arm], bestRank: rank, from: arm }, entry: entries?.[i] });
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
        // The value in force, through the one function that decides it — a human field alone would be
        // blind to every judge-graded row, which is most of the corpus. Writing stays human-only.
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
 * Nothing is ever overwritten. A regrade appends to the row's `grades`; it does not replace the row, and
 * it does not replace the verdict it disagrees with — that comparison is the only thing that says whether
 * a rater or a rubric moved.
 *
 * The exemption is a repeated pass, not a repeated value — `passKey`: same rater, same knobs, same day is
 * one sitting, so a second Save of the same table must not stack a duplicate. Another day is a person
 * looking again, which is an event even at the same grade. apply-review.mjs and grade-pending.mjs apply
 * the same rule, so all three writers agree about what a repeat is.
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
 * Not ST's chat book, and not "a world": both are ST's own concepts and neither answers "which collection
 * must the harness load". Retrieval spans every attached vectorized book, so the chat's bound book can be
 * one that contributed nothing, or one ST never reports as attached.
 *
 * So it is read off the ranking: the book contributing the most retrieved rows. Most rather than
 * top-ranked, because a book with one lucky top hit would win over one with twenty. Ties break toward the
 * higher-ranked book (Map keeps insertion order and sort is stable).
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
    return {
        name,
        notes: notes || `Graded ${now} from a live /wa-grade run.`,
        createdAt: now,
        createdBy: 'wa-grade',

        // Frozen inputs — everything needed to re-rank this scene with no live state.
        query,
        // The messages `query` was joined from, macros resolved, ST's {name, mes} shape — what makes
        // messageDepth sweepable from a frozen sample: buildQuery over the last d of these reproduces the
        // query at any depth <= the capture depth. Splitting `query` back apart cannot substitute, since
        // buildQuery joins with '\n\n' and RP messages routinely contain blank lines.
        queryChat,
        // The haystack's inputs, not the haystack. `scanChat` is the scan-eligible messages as core
        // transformed them; `injects` are the scan-enabled extension prompts beside them, each with the
        // position and depth that decide which windows admit it. A reader builds the window for any depth,
        // matchWindow and includeNames from these (matcher.mjs `makeWindowFor`) — the only direction that
        // works, since a joined window cannot be narrowed or re-segmented.
        scanChat,
        injects,
        sources,
        depth,
        // Path only, for provenance and for re-deriving a window wider than was captured — the one thing
        // queryChat can't do. A played-on chat invalidates it; queryChat is what's actually frozen.
        chat: stRelative(chat),
        // Which deployed plugin produced these scores: retrieval math lives in plugin/, so a redeploy can
        // move every per-entry signal without touching a setting. `pluginFP` is what served the capture,
        // `sourceFP` what the extension's own copy hashed to; equal means the deploy was current.
        pluginFP,
        sourceFP,
        // What produced this capture, resolved rather than declared: `<branch>@<git describe>`. Undefined
        // where the writer cannot resolve it — the browser has no git, and ST's /version reports a branch
        // and short HEAD with no tags. A missing field reads as a thinner capture, never a broken file.
        waVersion,
        stVersion,
        embedModel,
        // Stage 5's caps, document-level beside `embedModel` for the same reason: an arm never varies
        // them. `tokenizer` is ST's `getTokenizerModel()`, an environment fact WA cannot change. A budget
        // arm is never captured — every cap is a prefix cut over the layout order and the per-entry
        // `tokens` counts are recorded, so it is swept offline through `applyBudget` (G8).
        budget,
        primaryBook,
        // Path to the primary book on disk. Provenance only, never a fallback: no reader may open it,
        // because reading the live lorebook is what let a later edit move an already-graded scene's
        // numbers. Both paths relative to the ST install — see stRelative.
        book: stRelative(book),
        index: stRelative(index),

        // The arm's knobs, under the name the schema gives them, so a grep for `params` finds the schema,
        // the writer and every reader at once.
        params,
        paramSnapshot: rest,

        bookPriority: priority,
        books,

        grades,
        gradeScale: GRADE_SCALE,
        // No `excludeTitles`: the harness ranks every embedded book (eval/scene.mjs loadScene), so a
        // reader honouring such a list would discard valid verdicts. Scope is a fact about the document —
        // is the row's book in `books` — so nothing needs declaring.

        // The grading depth, under its historical name — samples on disk predate the cliff's removal and
        // carry its settings here too. A later run diffs against what was actually graded.
        cutoff,
        // How many rows the grader was actually shown. Rows past it are ungraded, not irrelevant, so the
        // harness needs it to know which of its deep cutoff arms it is allowed to believe.
        gradedCandidates,
        candidates,
    };
}

/** Fields identical across every arm of one graded scene, so they are stored once at the top of the
 *  document. Everything else — query, candidates, params, cutoff, primaryBook — is per-arm and must not
 *  be hoisted: the summary arm has a different query, and a lexical-only arm can retrieve from a
 *  different book. `budget` is here rather than in `paramSnapshot` because stage 5's caps are replayed
 *  offline, so no arm ever captures a variant. `books` and the haystacks are shared too but are not here:
 *  they are the bulk, and the schema puts them last (bundle-schema.md, *Field order is part of the
 *  schema*). */
const SHARED_FIELDS = ['name', 'notes', 'createdAt', 'createdBy', 'bookPriority', 'gradeScale', 'embedModel', 'budget', 'pluginFP', 'sourceFP'];

/** Per-arm fields that are the SCENE's, not the arm's, and so move onto the scene rather than repeating. */
const SCENE_FIELDS = ['chat', 'scanChat', 'injects', 'sources'];   // a sample's names for sceneChat / sceneChats / sceneInjects / sceneSources

/** Per-candidate fields that are numeric signal values, and so live under `scores`. Everything else on a
 *  candidate — identity, index, tokens, the fused score, the ranks, the budget verdict — stays flat beside
 *  it, because `scores` is "whatever the capture recorded, keyed by the feature's own name" and a fitted
 *  model indexes into it by that name (bundle-schema.md, *`scores` is a capture record*). A rank is not a
 *  feature and neither is the fused score: both are arm-relative positions, not measurements. */
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
const sceneId = (chat, end) => {
    const base = String(chat ?? '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
    return `${base.replace(/[^A-Za-z0-9_]+/g, '-')}-msg-${end}`;
};

/**
 * A rater's canonical id: one field, so grouping is a plain key comparison.
 *
 * A rater is whoever passed a verdict, and `kind` says which sort — `human` or `llm`. A human is
 * identified by a UUID and that is the whole id. An llm is identified by three things, US-joined:
 *
 *   model         the reference as invoked, e.g. `gemma4:31b-mlx`
 *   modelDigest   what that reference resolved to; empty when nothing can resolve it
 *   rubric        the contract it graded under, e.g. `scene-relevance@8460b922`
 *
 * The digest is in the id because the name is not an identity: `bge-m3:latest` is whatever was pulled
 * most recently, so two captures months apart record one string for different weights. A hosted model has
 * no digest to give, and an empty component says so rather than implying stability nothing provides.
 *
 * US, never a printable separator: model ids routinely carry `:` and `/`, and `@` already appears inside
 * a rubric, so no printable join can be decomposed (G8, P6).
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
 * A pass's identity: the rater and the day. This is what a writer deduplicates on, and it is not the
 * rater.
 *
 * Settings are not identity. Seed, effort, temperature, context length and thinking change the sample,
 * not who produced it: the same weights under the same rubric sampled twice is one rater giving two
 * verdicts, which is the third vote the median rule wants. Folding a seed in would also assert a
 * determinism nothing has — hosted reasoning models honour neither seed nor temperature (H1).
 *
 * Who and when, and nothing else. Dedup runs over one entry's verdicts and a pass grades each row exactly
 * once, so two verdicts on a row came from two dispatches, which differ in their millisecond stamp.
 * `params` therefore never disambiguates, and putting it in the key would make identity sensitive to a
 * writer's completeness: record one more knob and an old verdict stops matching its own re-merge.
 */
export const passKey = v => [v?.id ?? '', v?.gradedAt ?? ''].join(US);

/** Provenance a person reads, carried beside the id and never part of it. */
const RATER_DESC = ['modelName', 'family', 'quant', 'modelParams'];

/**
 * The distinct raters across a scene's verdicts, as one table plus the index each verdict carries.
 *
 * One `grades` array, not one per kind. The file promises every verdict "in the order it was passed"
 * (bundle-schema.md), and two arrays cannot express that across kinds. Provenance is not lost by merging
 * them: it moves from which array a verdict sits in to which rater it names, and nothing can be written
 * without naming a rater.
 *
 * A verdict names its rater by index — spelled out per verdict these are the same handful of strings
 * repeated tens of thousands of times (G8), and unreadable by eye. `openBundle` resolves the index back
 * to the whole rater, so every reader and writer works in identities and only the file is indexed.
 *
 * The table is per document, so an index is document-local. Pooling several documents means remapping
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
    /** Splits a verdict into who passed it and what it says; only the second stays on the row. `params`
     *  stays with the verdict: it is how this sample was drawn, not who drew it. */
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

/**
 * One stored rater record, expanded back into the fields `raterKey` composed it from.
 *
 * Without this the round trip is lossy and silent: the record keeps the joined `id` plus the descriptive
 * fields a person reads (RATER_DESC), while the components of an llm's id — the model half and the rubric
 * — live only inside the string, so re-indexing `{id, modelName}` recomposes a different id and deletes
 * the pass identity from every document that goes through openBundle -> setGrades (G9).
 *
 * Through raterParts, the inverse raterKey documents, rather than a second rule about how an id
 * decomposes. grading-check.mjs asserts the invariant: indexVerdicts(deref(entries, raters)) reproduces
 * `raters`.
 */
const expandRater = (who) => {
    if (who?.kind !== 'llm') return who;
    const { modelId, rubric, isDigest } = raterParts(who);
    return {
        ...who,
        // Under the right name: raterKey reads `modelDigest || modelName`, so restoring a NAME as a digest
        // would recompose correctly and lie to every reader of the verdict.
        ...(isDigest ? { modelDigest: modelId } : { modelName: who.modelName ?? modelId }),
        ...(rubric ? { rubric } : {}),
    };
};

/** The inverse: an index back to the rater it names, so a reader never handles indices. */
const deref = (entries, raters = []) => (entries ?? []).map(e => ({
    ...e,
    ...(e.grades ? { grades: e.grades.map(({ rater, ...v }) => { const { rater: _i, ...who } = raters[rater] ?? {}; return { ...expandRater(who), ...v }; }) } : {}),
}));

/**
 * A live grade row -> the scene entry that carries its verdicts.
 *
 * The record, not a resolution: verdicts append in the order taken and nothing writes a reduced value
 * beside them — which verdict counts is the reader's question (metrics.mjs `gradeValue`). A reduced value
 * stored beside the record is indistinguishable from a verdict someone gave.
 *
 * Rows arriving from an earlier round already carry arrays; a freshly typed one carries a bare `grade`,
 * which is a human's by definition (only a human writes `grade` — CLAUDE.md, graded scenes).
 *
 * @param {object[]} grades Live grade rows: {title, book, uid, grade?, grades?}
 * @param {{user?: string, now?: string}} [who] Rater identity for a bare `grade`, and the date to stamp
 * @returns {object[]} Scene entries
 */
function gradeEntries(grades, { user, now } = {}) {
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
 * A debug row -> a v3 candidate: signals gathered under `scores`, everything else carried across as-is.
 *
 * The one transformation, and it runs in one direction only. `/wa-debug`'s row is handed to
 * `console.table`, where a nested `scores` renders as `[object Object]`, so the runtime keeps the display
 * shape, the file keeps the schema shape, and this is the named crossing between them.
 *
 * Gathering is all it does: every other field keeps its name on both sides, so a row and a candidate are
 * the same thing seen twice rather than two vocabularies.
 *
 * There is deliberately no inverse. A reader gets the candidate as the file holds it; flattening `scores`
 * on the way out would put a superseded shape in front of every reader.
 */
export const toCandidate = (row, i) => {
    const scores = { ...(row.scores ?? {}) };
    const flat = {};
    for (const [k, v] of Object.entries(row)) {
        if (SIGNAL_FIELDS.includes(k)) scores[k] = v; else flat[k] = v;
    }
    // Idempotent: a row that is already a candidate keeps its `scores`. The UI converts at its own
    // boundary and `bundleSamples` converts again on the way to disk, so this runs twice on the same row
    // whenever a live capture is graded and then saved.
    delete flat.scores;
    return { book: row.book ?? '', uid: row.uid, index: Number(row.index ?? i), ...flat, scores };
};

/**
 * A book's content identity, stable across installs.
 *
 * What is hashed is the stored book, not the book on someone's disk — a capture can only speak for what
 * it froze.
 *
 * Key order is normalised because it carries no meaning and two installs need not agree on it:
 * `JSON.stringify` preserves insertion order, so without the sort the same book captured by two people
 * would hash apart.
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

/** A field that restates where an entry is stored is not part of what the entry is. `entry.world` is ST's
 *  own back-pointer to the book name — already the key of the `books` map holding it — and is present or
 *  absent depending on which ST path produced the entries, so leaving it in hashes one lorebook two ways.
 *  Corpus-wide it never disagrees with the book's name (G8). */
const withoutLocation = e => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
    const { world, ...rest } = e;
    return rest;
};

/**
 * Content hashes for a `books` map, keyed by the same book names.
 *
 * Sits beside `books` rather than inside it: a book is a uid-keyed map of entries and every reader walks
 * it with `Object.values`, so a `hash` key would arrive as a phantom entry. Safe because a capture's
 * books are immutable — the two things that cut a book both do it away from disk, and
 * `slice-bundles.mjs` drops this field rather than recomputing it, a subset of a book having no business
 * claiming that book's identity.
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
 * One file, not N. The arms of a pooled grading differ only in how they were scored; they share the graded
 * scene, the verdicts, and — the bulk of the bytes by a wide margin — the embedded copies of every
 * attached book.
 *
 * One scene is a one-element `scenes` list. There is no single-scene shape, so a reader that handles the
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
    // What identifies this capture, surviving a rename. Nothing content-derived can: `name` and the scene
    // id both collide, two captures of one turn under different books sharing them. Minted by the caller
    // so this module stays ST-free; absent on a capture taken before the field existed.
    if (scene.captureId) doc.captureId = scene.captureId;
    for (const f of SHARED_FIELDS) if (first[f] !== undefined) doc[f] = first[f];
    Object.assign(doc, extra);

    const id = sceneId(first.chat, scene.end);
    const indexed = indexVerdicts(gradeEntries(first.grades, { user: scene.user, now: first.createdAt }));

    // A scene is the graded moment — a chat and the message it ends at. Not a span: the span is what an
    // arm chose to read, and `graded-scene-grid`'s depth sweep holds the grades fixed while it varies
    // that. So `sceneStart` and `depth` belong to the arm's capture of this scene, not to the scene.
    doc.scenes = [{ id, sceneChat: first.chat ?? '', sceneEnd: scene.end, entries: indexed.entries }];

    // Arms at document level, because an arm is a configuration and a configuration spans scenes.
    // Nesting them inside a scene would repeat `params`, `waVersion` and `stVersion` once per scene.
    const whyBlock = {};
    doc.arms = arms.map(({ arm, sample }) => {
        const per = { name: arm };
        if (sample.waVersion !== undefined) per.waVersion = sample.waVersion;
        if (sample.stVersion !== undefined) per.stVersion = sample.stVersion;
        per.params = { ...(sample.params ?? {}), ...(sample.scoredBy ? { scoredBy: sample.scoredBy } : {}) };
        // On the arm, by the same rule as `params` above it: a snapshot is the settings the configuration
        // ran under, and one capture reads one settings object, so every scene of an arm sees the same
        // values.
        if (sample.paramSnapshot !== undefined) per.paramSnapshot = sample.paramSnapshot;
        // The cell: this arm's capture of that scene. Everything varying with both coordinates lives here
        // — the span it read, the query it built, the rows it surfaced. What varies with the configuration
        // alone stays on the arm; what varies with the moment alone stays on the scene.
        const cell = { sceneStart: scene.start, depth: sample.depth };
        for (const [k, v] of Object.entries(sample)) {
            if (SHARED_FIELDS.includes(k) || SCENE_FIELDS.includes(k) || k in extra) continue;
            if (['arm', 'grades', 'candidates', 'params', 'paramSnapshot', 'depth', 'waVersion', 'stVersion', 'scoredBy', 'books'].includes(k)) continue;
            if (v === undefined) continue;
            cell[k] = v;
        }
        // In layout order, which is load-bearing: every stage-5 cap is a prefix cut, so a reader can
        // replay the budget walk over the array as it stands.
        //
        // `why` leaves the candidate here, into the trailing block, aligned by position: a row's
        // matched-key excerpts are the heaviest thing in the file after the books themselves (G8), and
        // inline they would put the bulk ahead of what field order keeps reachable with `head`.
        // `openBundle` puts them back.
        const cands = (sample.candidates ?? []).map(toCandidate);
        cell.candidates = cands.map(({ why: _why, ...c }) => c);
        const whys = cands.map(c => c.why ?? []);
        if (whys.some(w => w.length)) whyBlock[arm] = { [id]: whys };
        per.scenes = { [id]: cell };
        return per;
    });

    // One copy when nothing moved it. `query` and `queryChat` are produced by a configuration
    // (`queryMode` moves them), so they cannot hoist unconditionally the way the haystack does: hoisted
    // onto the scene when the arms agree and left on the cell when they do not. `openBundle` spreads the
    // scene first and the cell last, so a per-arm value still wins.
    const cells = doc.arms.map(a => a.scenes[id]);
    const key = c => JSON.stringify([c.query ?? null, c.queryChat ?? null]);
    if (cells.length && cells.every(c => key(c) === key(cells[0]))) {
        const { query, queryChat } = cells[0];
        for (const c of cells) { delete c.query; delete c.queryChat; }
        // After `entries`, because `queryChat` is frozen messages and the scene's own fields are what a
        // reader wants first.
        if (query !== undefined) doc.scenes[0].query = query;
        if (queryChat !== undefined) doc.scenes[0].queryChat = queryChat;
    }

    // Who the indices name. Ahead of the bulk, because a verdict is unreadable without them.
    if (indexed.raters.length) doc.raters = indexed.raters;

    // The bulk, last: anything ahead of these is reachable with `head`, anything behind is not. Content
    // identity stays ahead of it — two lines, and it answers "same book?" without inflating a 2MB book.
    const books = first.books ?? {};
    doc.bookHashes = await hashBooks(books);

    // arm -> scene -> per-candidate excerpts, positionally aligned with that cell's `candidates`. Down
    // here because it is bulk; see the arms walk above.
    if (Object.keys(whyBlock).length) doc.candidateWhy = whyBlock;

    // The messages the haystack is built from, once per scene — not a window. A window is fixed at one
    // depth, one matchWindow and one includeNames; these rebuild any of them, so arms reading the same
    // moment at different depths share one stored input.
    doc.sceneChats = { [id]: first.scanChat ?? [] };
    // Once per scene, beside the chat half they are admitted into: injects are a property of the moment,
    // not of a configuration, so every arm of a capture scans the same ones.
    if ((first.injects ?? []).length) doc.sceneInjects = { [id]: first.injects };
    // The card and persona text an entry opted into, once per scene for the same reason. Only the fields
    // some entry's `matchXxx` names are here (matcher.usedMatchSources) — the rest determined nothing,
    // and a persona description is the most personal thing a shareable document could carry.
    if (Object.keys(first.sources ?? {}).length) doc.sceneSources = { [id]: first.sources };
    doc.books = books;
    return doc;
}

/**
 * Selects one arm of one scene, as a flat view.
 *
 * Flat, but not translated. The document, the scene and the arm are three nesting levels and a caller
 * almost always wants one field from each, so the view merges them — but every field keeps the name the
 * schema gives it, so a grep for `S.entries`, `S.params`, `c.book` or `c.scores.cosine` finds the schema
 * and the readers together.
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

    // An arm only counts here if it captured this scene: a grid is not guaranteed rectangular, and an arm
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
    const whys = doc.candidateWhy?.[armName]?.[sc.id];
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
        // `why` rejoins the candidate it came off, by position — the writer split it out to keep the bulk
        // behind the fields a reader heads the file for, and no reader should have to know that.
        ...(whys ? { candidates: (cell.candidates ?? []).map((c, i) => (whys[i]?.length ? { ...c, why: whys[i] } : c)) } : {}),
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
 * out, and the only writer of the file layout besides bundleSamples. A tool that grafts, merges or
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
 * The grading scale: 0-4, each grade an inclusion decision rather than a magnitude. Anchored wording is
 * what inter-rater agreement hangs on — restating the question alone nearly doubled agreement between
 * two raters (G5) — so the anchors are data here and the grading UIs show them verbatim.
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
