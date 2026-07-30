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

/** Fields of an entry the offline harness actually reads. `content` is NOT one of them, which is what makes
 *  'meta' lossless and ~20x smaller: the chunk text being scored comes from the vector index, and the
 *  gazetteer is built from keys and titles only.
 *
 *  This makes 'meta' lossless for the CURRENT gazetteer but not for experimenting with a wider one, which is
 *  why it is not the default. The widening that motivated keeping content — a gazetteer fed entry bodies —
 *  has since measured WORSE than shipped across three scenes (mean rank 7.20 vs 6.43; see
 *  ranking.mjs buildTermWeights), so 'full' is now just cheap insurance against the next such question
 *  rather than support for a live one. 'meta' is the better default the day sample size starts to hurt. */
const META_FIELDS = ['uid', 'comment', 'key', 'keysecondary', 'vectorized', 'constant', 'sticky', 'order', 'disable', 'caseSensitive', 'matchWholeWords', 'scanDepth', 'ignoreBudget'];

/**
 * Copies a book's entries at the requested fidelity.
 *
 * 'full' — verbatim, including entry content. THE DEFAULT: content is what a widened gazetteer would read,
 *          and that arm measures competitively (see META_FIELDS), so a sample that drops it can't test it.
 *          A book is a couple of MB and eval-data is gitignored, so the size is not worth the foreclosure.
 * 'meta' — every entry, `content` dropped. Lossless for the harness AS IT SCORES TODAY (see META_FIELDS)
 *          at ~1/20th the size. It keeps every entry, which matters: the gazetteer and the keyword scan read
 *          the whole book, so dropping "irrelevant" ENTRIES silently changes the entity filter and ranking.
 * 'none' — no entries; the sample just records which books were attached. graded-scene-grid.mjs REJECTS such
 *          a sample: it has no live-book fallback by design, since reading the current lorebook is what let a
 *          later edit move an already-graded scene's numbers. Provenance only.
 *
 * There is deliberately no "only the candidate entries" mode. It looks like the thrifty choice and is a
 * trap: the entity filter's gazetteer is built from every entry's keys and title, and admitting 2.3x too
 * many query terms was measured to move BM25 by up to 74% (see ranking.mjs buildGazetteer).
 *
 * @param {Record<string, object>|object[]} entries A book's entries (ST stores a uid-keyed object)
 * @param {'full'|'meta'|'none'} mode Fidelity
 * @returns {Record<string, object>} uid-keyed entries
 */
export function trimBook(entries, mode = 'full') {
    const list = Array.isArray(entries) ? entries : Object.values(entries ?? {});

    if (mode === 'none') {
        return {};
    }

    const out = {};
    for (const entry of list) {
        if (mode === 'full') {
            out[entry.uid] = entry;
            continue;
        }
        const kept = {};
        for (const field of META_FIELDS) {
            if (entry[field] !== undefined) {
                kept[field] = entry[field];
            }
        }
        out[entry.uid] = kept;
    }
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
 * @returns {object} captureParams for graded-scene-grid
 */
export function captureParams(s, { caseSensitive, wholeWords, includeNames }) {
    return {
        K: s.rrfK,
        K1: s.bm25K1,
        B: s.bm25B,
        LEXW: s.lexicalWeight,
        boost: s.properNounBoost,
        stopwordDf: s.stopwordDocFreq,
        // Derived from the mode rather than stored (see paramSnapshot): BM25-only runs down-weight
        // general-English words, hybrid does not.
        commonWordWeight: s.retrievalMode === 'lexical' ? 0.7 : 1,
        threshold: s.scoreThreshold,
        maxVectorEntries: s.maxVectorEntries,
        minVectorEntries: s.minVectorEntries,
        suppressVectorKeys: s.suppressVectorKeys,
        scoreVectorKeys: s.scoreVectorKeys,
        entityFilter: s.entityFilter,
        retrievalMode: s.retrievalMode,
        queryMode: s.queryMode,
        weightByOrder: s.weightByOrder,
        vectorCutoff: s.vectorCutoff,
        elbowSensitivity: s.elbowSensitivity,
        dropoffThreshold: s.dropoffThreshold,
        caseSensitive,
        wholeWords,
        includeNames,
    };
}

/**
 * A candidate row is scaffolding — always-on or persist-on-trigger — rather than a relevance result.
 *
 * Tiered off the CONFIGURED sticky value and the runtime constant class, never the runtime sticky state:
 * a sticky entry reads `block: 'dynamic'` on its keyword-activation turn, and a dry run never arms the
 * effect at all. Grading these would drag nDCG down for entries relevance never chose.
 * @param {object} row Candidate row
 * @returns {boolean} True when the row is scaffolding
 */
export const isScaffolding = row => row.block === 'constant' || Number(row.sticky) > 0;

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

/** A candidate row's identity. uid alone is ambiguous across books, so it is world + uid. */
export const rowKey = row => `${row.world ?? ''}${US}${row.uid}`;

/**
 * Unions several arms' candidate rows into one list for the grader.
 *
 * FOR THE UI ONLY. Each arm's SAMPLE keeps its own rows, with its own per-signal scores under its own
 * captureParams — that is what makes a sample re-runnable. A merged row would carry one arm's numbers under
 * another arm's parameters, which is a lie the offline harness would then reproduce faithfully.
 *
 * A duplicate keeps the FIRST arm's row (arms are passed best-understood-first, normally shipped-defaults
 * first) and accumulates the labels that surfaced it, so the grader can see whether a row is consensus or
 * the pet of one configuration. Ordered by best rank achieved across arms, so the strongest candidates are
 * graded while attention is freshest.
 *
 * Scaffolding is dropped here rather than listed-but-disabled as /wa-grade does: across N arms the same
 * constant would appear N times to no purpose, and relevance never chose it in any of them.
 *
 * @param {Array<{arm: string, rows: object[], entries: object[]}>} arms Per-arm captures, aligned rows/entries
 * @returns {{rows: object[], entries: object[]}} Deduped rows (each with `arms` and `bestRank`) + aligned entries
 */
export function unionArms(arms) {
    const seen = new Map();   // rowKey -> { row, entry }
    for (const { arm, rows, entries } of arms ?? []) {
        (rows ?? []).forEach((row, i) => {
            if (isScaffolding(row)) return;
            const key = rowKey(row);
            const hit = seen.get(key);
            const rank = Number(row['#'] ?? Infinity);
            if (hit) {
                hit.row.arms.push(arm);
                hit.row.bestRank = Math.min(hit.row.bestRank, rank);
                return;
            }
            seen.set(key, { row: { ...row, arms: [arm], bestRank: rank }, entry: entries?.[i] });
        });
    }
    const merged = [...seen.values()].sort((a, b) => a.row.bestRank - b.row.bestRank);
    return { rows: merged.map(x => x.row), entries: merged.map(x => x.entry) };
}

/**
 * Splits a union into rows that still need a human and rows an earlier round already judged.
 *
 * Matched on world+uid, never on title: titles get edited, and a retitled entry silently regraded from
 * zero would move the numbers of every arm that surfaced it. Prior rounds carry both fields (every sample
 * /wa-grade has ever written records them), so identity matching costs nothing.
 *
 * @param {object[]} rows Union rows from unionArms
 * @param {Array<{world?: string, uid?: number, grade: number}>} prior Grades from earlier rounds
 * @returns {{fresh: object[], known: object[], priorOf: Map<string, number>}} Split, plus rowKey -> prior grade
 */
export function splitGraded(rows, prior) {
    const priorOf = new Map();
    for (const g of prior ?? []) {
        if (g && g.uid !== undefined && Number.isFinite(Number(g.grade))) {
            priorOf.set(rowKey(g), Number(g.grade));
        }
    }
    return {
        fresh: (rows ?? []).filter(r => !priorOf.has(rowKey(r))),
        known: (rows ?? []).filter(r => priorOf.has(rowKey(r))),
        priorOf,
    };
}

/**
 * Accumulates this round's grades onto the earlier rounds'.
 *
 * Later rounds win on conflict, so a regrade is an overwrite rather than a duplicate. Prior grades are kept
 * even when this round's arms surfaced nothing matching them: they still describe judged entries of the same
 * book and scene, and the harness's pool is the judged set, not one capture's candidate list.
 *
 * @param {Array<object>} prior Grades from earlier rounds
 * @param {Array<object>} fresh This round's grades
 * @returns {object[]} Merged grade list
 */
export function mergeGrades(prior, fresh) {
    const by = new Map();
    for (const g of [...(prior ?? []), ...(fresh ?? [])]) {
        if (g && g.uid !== undefined) by.set(rowKey(g), g);
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
        if (row?.cosine !== null && row?.cosine !== undefined && row.world) {
            counts.set(row.world, (counts.get(row.world) ?? 0) + 1);
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
 * @param {string} args.scanText Keyword scan window
 * @param {number} args.depth messageDepth the query was built at
 * @param {string} args.index Vector index path (recorded, not embedded)
 * @param {string} [args.chat] Chat file path — provenance, and the ONLY way to re-derive the query at another depth
 * @param {string} [args.book] Primary book path — the harness's fallback when no entries are embedded
 * @param {string} args.primaryBook Book whose collection was searched
 * @param {string} [args.embedModel] Embedding model id
 * @param {object} args.params captureParams() output
 * @param {object} args.snapshot Raw grouped paramSnapshot(), for the record
 * @param {object[]} args.candidates Candidate rows, as /wa-debug builds them
 * @param {Record<string, object>} args.books world -> uid-keyed entries (already trimmed)
 * @param {string} args.bookMode Fidelity the books were copied at
 * @param {object[]} args.priority Per-book weight/offset/cap
 * @param {Array<{title: string, grade: number, world?: string, uid?: number}>} args.grades Human grades
 * @param {object} [args.cutoff] What the cutoff did on this run
 * @param {string} [args.now] ISO date (injected so the check is deterministic)
 * @returns {object} The sample manifest
 */
export function buildSample({ name, notes, query, queryChat, scanText, depth, chat, book, index, primaryBook, embedModel, params, snapshot, candidates, books, bookMode, priority, grades, cutoff, gradedCandidates, pluginFP, sourceFP, now }) {
    // Grades for entries outside the searched collection can't be ranked offline: the harness loads one
    // vector collection, so a second book's entries have no cosine and never enter the ranking. Declaring
    // them here means the harness reports "excluded" instead of scoring them as irrelevant — the exact
    // confound the interleaved-books case introduces.
    const foreign = grades.filter(g => g.world && g.world !== primaryBook);

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
        scanText,
        depth,
        // Path only, for provenance and for re-deriving a WIDER window than was captured — the one thing
        // queryChat can't do. A played-on chat invalidates it; queryChat is what's actually frozen.
        chat,
        // Which deployed plugin produced these scores. Retrieval math lives in plugin/ and a redeploy can
        // move every per-entry signal in the sample without touching a single setting — server-side entry
        // pooling did exactly that. `pluginFP` is what served the capture, `sourceFP` what the extension's
        // own copy hashed to; equal means the deploy was current. A harness run against a different plugin
        // is comparing rankings to grades collected under different arithmetic.
        pluginFP,
        sourceFP,
        embedModel,
        primaryBook,
        // Path to the primary book on disk — the harness's fallback when the sample embeds no entries
        // (bookMode 'none'), and provenance otherwise.
        book,
        index,

        captureParams: params,
        paramSnapshot: snapshot,

        bookMode,
        bookPriority: priority,
        books,

        grades,
        excludeTitles: foreign.map(g => g.title),

        // The ranking as it stood, so a later run can be diffed against what was actually graded.
        cutoff,
        // How many rows the grader was actually shown. Rows past it are UNGRADED, not irrelevant, so the
        // harness needs it to know which of its deep cutoff arms it is allowed to believe.
        gradedCandidates,
        candidates,
    };
}

/** Fields that are identical across every arm of one pooled grading, so they are stored ONCE in a bundle.
 *  Everything else — query, candidates, captureParams, cutoff, primaryBook — is per-arm and must not be
 *  hoisted: the summary arm has a different query, and a lexical-only arm can retrieve from a different
 *  book. */
const SHARED_FIELDS = ['name', 'notes', 'createdAt', 'createdBy', 'books', 'bookMode', 'bookPriority', 'grades', 'embedModel', 'pluginFP', 'sourceFP', 'chat'];

/**
 * Packs one sample per arm into a single bundle.
 *
 * ONE FILE, NOT N. The arms of a pooled grading differ only in how they were scored; they share the graded
 * scene, the grades, and — the bulk of the bytes by a wide margin — the embedded copies of every attached
 * book. Writing them separately meant N browser downloads to accept and N duplicate copies of a 300-entry
 * lorebook on disk, which is why the first version of this was annoying enough to replace.
 *
 * @param {Array<{arm: string, sample: object}>} arms Per-arm samples from buildSample
 * @returns {object} Bundle: shared fields once, `arms` carrying the rest
 */
export function bundleSamples(arms) {
    const first = arms[0]?.sample ?? {};
    const bundle = { bundleVersion: 1 };
    for (const f of SHARED_FIELDS) if (first[f] !== undefined) bundle[f] = first[f];
    bundle.arms = arms.map(({ arm, sample }) => {
        const per = { arm };
        for (const [k, v] of Object.entries(sample)) if (!SHARED_FIELDS.includes(k)) per[k] = v;
        return per;
    });
    return bundle;
}

/**
 * Unpacks one arm of a bundle back into an ordinary sample, so every existing tool keeps working unchanged.
 *
 * A plain sample passes through untouched, which is what lets callers open any manifest without knowing
 * which kind it is. An unknown arm name is an error rather than a silent fallback — scoring the wrong
 * configuration and reporting it as the requested one is the failure mode worth being loud about.
 *
 * @param {object} manifest A bundle or a plain sample
 * @param {string} [arm] Arm name; defaults to 'shipped' when present, else the first
 * @returns {object} A plain sample
 */
export function openBundle(manifest, arm = null) {
    if (!Array.isArray(manifest?.arms)) return manifest;
    const names = manifest.arms.map(a => a.arm);
    const wanted = arm ?? (names.includes('shipped') ? 'shipped' : names[0]);
    const hit = manifest.arms.find(a => a.arm === wanted);
    if (!hit) throw new Error(`bundle has no arm "${wanted}" — available: ${names.join(', ')}`);
    const { arms: _drop, bundleVersion: _v, ...shared } = manifest;
    return { ...shared, ...hit, name: `${manifest.name}--${hit.arm}` };
}

/** Sample -> pretty JSON + filename, ready for ST's download(). */
export function sampleFile(sample) {
    const slug = String(sample.name || 'scene').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'scene';
    return { filename: `${slug}.json`, content: `${JSON.stringify(sample, null, 2)}\n` };
}
