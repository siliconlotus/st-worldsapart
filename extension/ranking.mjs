// ranking.mjs — the client-side retrieval TUNING layer: entity filter, query building, keyword
// scoring, and RRF fusion. This is the code that gets dialed in as retrieval is tuned, so it lives
// with the extension, NOT the plugin: a change here is a browser refresh, never a plugin redeploy,
// and it is never copied into /plugins, so it stays out of the plugin fingerprint.
//
// Imported by both the extension and the offline harnesses, so it must stay isomorphic — no DOM, no
// ST imports. Every SillyTavern/settings dependency (proper-noun boost, message depth,
// substituteParams, BM25 k1, world-info match defaults, fusion weights) is INJECTED by the caller.
// The extension wraps these with its settings()/ST globals; the harness passes its own values.

import { cachedCount, evaluateSmartKey, fold, normalizeOrthography, primeScan } from './smartkeys.mjs';

/** Escape a string for literal use in a RegExp (same as ST's utils.escapeRegex; inlined to stay ST-free, exported for keyword-core). */
export function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The character class whole-word matching treats as "inside a word". NOT `\w`, which is ASCII-only in
 * JS and silently turns whole-word matching into substring matching for every other script: under `\w`
 * the key `caf` whole-word-matches `café` and `Мари` matches `Марию`, because every non-ASCII letter
 * reads as a boundary. The ASCII control behaves correctly, which is why it goes unnoticed — `Jubile`
 * does not match `Jubilee`.
 *
 * Requires the `u` flag wherever it is used; escapeRegex above is already `u`-safe (it does not emit
 * the `\-` identity escape that core's version does, which `u` rejects).
 *
 * KNOWN LIMIT: scripts written without spaces. In CJK every neighbour is a letter, so a whole-word key
 * matches only in isolation — the mirror of the old bug, where every CJK substring matched. There is no
 * word boundary to find, so whole-word matching is not meaningful there; it defaults off.
 *
 * DIVERGES FROM CORE, which keeps `\W` (world-info.js matchKeys). WA is the stricter side, so the audit
 * under-reports rather than over-reports against what core fires.
 */
export const WORD_CHAR = '[\\p{L}\\p{N}_]';

/** A /pattern/flags regex key, exactly as countKey routes them. THE regex-key test — the audit and
 * the smartkeys registry import this so all three can never disagree on what counts as a regex key. */
export const REGEX_KEY_RE = /^\/(.+)\/([gimsuy]*)$/;
export const isRegexKey = k => REGEX_KEY_RE.test(String(k));

/**
 * Collects the lorebook's own vocabulary — every term appearing in an entry's keys
 * or title. Anything named there is something this corpus treats as a thing worth
 * naming, which is a better salience signal than rarity.
 *
 * DO NOT "fix" the missing keys. At retrieval time this runs AFTER suppressVectorKeys has blanked
 * key/keysecondary on every vectorized entry, so for a mostly-vectorized book the vocabulary is
 * mostly entry TITLES (measured: 1138 terms — 910 from titles, 228 from the 50 non-vectorized
 * entries — where the raw book would give 3131). That looks like a bug and reads like one here.
 * It was A/B'd on the scene1 graded fixture, and feeding the stashed `waKeys` back in is WORSE:
 *
 *   gazetteer            admitted query terms   P/R/F1 @ count max=10     nDCG@5
 *   keys blanked (now)   115                    0.600 / 0.750 / 0.667     0.9510
 *   waKeys restored      243                    0.500 / 0.625 / 0.556     0.9560
 *
 * It buys 0.005 nDCG@5 (a top-5 reshuffle) and costs 0.111 F1 plus one relevant entry inside the
 * shipped cutoff. The keys it restores are triggers like "condom", "grindr", "trash", "utility" —
 * generic words admitted at weight 1 that match broadly, where titles carry entity-ish words and
 * stopwordDocFreq strips the junk they come with ("and", "they", "001"). n=1 scene, so this is a
 * reason to leave it alone, not a proof; re-run the A/B if a second scene gets graded.
 *
 * The offline harnesses must therefore blank vectorized keys before calling this, or they admit
 * 2.3x the terms production does and inflate BM25 by up to 74% (see eval/graded-scene-grid.mjs).
 *
 * @param {object[]} entries All World Info entries
 * @returns {Set<string>} Lowercased gazetteer terms
 */
export function buildGazetteer(entries) {
    const terms = new Set();

    for (const entry of entries) {
        const sources = [...(entry.key ?? []), ...(entry.keysecondary ?? []), entry.comment ?? ''];
        for (const source of sources) {
            for (const token of String(source).split(/[^A-Za-z0-9']+/)) {
                if (token.length > 1) {
                    terms.add(token.toLowerCase());
                }
            }
        }
    }

    return terms;
}

/**
 * Reduces a raw query to entity-ish terms, weighted.
 *
 * Keeps a term only if it is capitalised (a cheap entity proxy) or appears in the
 * lorebook's own vocabulary, and boosts the capitalised ones.
 *
 * MEASURE THIS WITH MEAN TARGET RANK, NOT nDCG@5. Read this before tuning anything here: four successive
 * attempts produced four different answers, and every difference was metric or population, not signal.
 *
 * The original note read "mean target rank 11.2 versus 21.6-28.2 for the unfiltered query", from a 5-target
 * gold set that no longer exists and (on later evidence) a gazetteer built from RAW book keys — 2.3x the
 * terms production admits, see buildGazetteer. Re-measured over three graded scenes via
 * eval/graded-scene-grid.mjs (`--unjudged zero`, mean rank of all judged-relevant entries, lower better):
 *
 *   arm                        mean rank    verdict
 *   production (gaz, boost 3)     6.43      ships
 *   boost 2                       6.40      dead tie; see below
 *   boost 5                       6.53      plateau
 *   boost 8                       6.83      degrades
 *   boost 1                       7.00      degrades
 *   no gazetteer (boost only)     7.00      gazetteer is worth ~0.6 rank
 *   + entry bodies in gazetteer   7.20      worse than shipped on all metrics
 *   NO entity filter              9.07      the filter is worth ~2.6 ranks
 *
 * That reproduces the original note's shape — boost plateaus 2..5, degrades either side, gazetteer is a
 * thin safety net — on a population and metric that can actually see it. Two traps got in the way first:
 *
 * TRAP 1, THE METRIC. nDCG@5 cannot resolve these knobs. Relevance here is sparse and Poisson-shaped, not
 * normal: 5-11 judged-relevant entries per scene, so nDCG@5 sees a handful of placements and has only a few
 * reachable states. It returned an IDENTICAL 0.9322 for boost 1/2/3/5/8 on one scene under every population
 * tried — which is mechanistic, not noise: the boost is a uniform multiplier over proper nouns, so wherever
 * the top-ranked entries match the same entities it cannot reorder them at all. Mean rank pools every judged
 * relevant entry and does not saturate. Anything that looks like a tie on nDCG@5 should be re-read there.
 *
 * TRAP 2, THE POPULATION. Grades exist only for entries production ACTIVATED, so restricting the ranking to
 * that pool means a wrong promotion is INVISIBLE — the promoted entry is filtered out rather than penalised.
 * One scene returned 0.9634 for every arm including no-filter that way. Scoring unjudged rows as 0 over the
 * uncut ranking (`--unjudged zero`) restores the resolution for free, and the sparse shape is what licenses
 * it: past roughly rank 25 the marginal candidate is almost surely irrelevant (measured — one sample's
 * grades bottom out in zeros by rank 24), so "unjudged" and "irrelevant" nearly coincide. Grading deeper
 * would buy mostly the same zeros by hand.
 *
 * WHAT IS STILL UNDERPOWERED: three scenes carry 22 judged-relevant entries between them. boost 2 leads on
 * nDCG@5's mean (0.912 vs 0.888) purely because of ONE scene — it is exactly tied with boost 3 on mean rank,
 * and identical to it on the other two scenes. Do not move the default on that. More SCENES is the lever
 * here; deeper grading is not.
 *
 * The CUTOFF result (see selection.mjs) never needed any of this, because that table already sweeps the
 * UNCUT ranking and needs grades only as deep as the pool goes.
 *
 * Note this is deliberately NOT applied to summarized queries, which are already
 * salience-selected and would only lose context.
 *
 * Do not "improve" this by admitting more terms. Both obvious loosenings were
 * measured on the same (now-lost) gold set and both are worse. These two were NOT re-measured above, so
 * they carry the same caveat as the figures replaced there — but both are directionally corroborated by
 * the re-measurement, where every arm that admitted MORE terms ranked worse:
 *
 *   admit terms with high corpus IDF too   5/5 rank 3.0 -> 4/5 rank 5.2 (IDF>=4)
 *   keep content words (POS-style filter)  5/5 rank 3.0 -> 0/5 rank 27.4
 *
 * A third loosening suggests itself once you notice the gazetteer only reads keys and titles: feed it the
 * entry BODIES too, since that is also "the lorebook's vocabulary". It briefly looked competitive on one
 * scene (mean rank 6.8 against 7.3) and that reading was an artifact of the pooled population; across all
 * three scenes it is 7.20 against 6.43 — worse than shipped, at 5-10x the terms. It does NOT collapse to
 * "no filter" (9.07) despite admitting most of the query's distinct terms, because the boost still weights
 * entities and stopwordDocFreq still strips corpus-common ones — but it loses, so it loses for the same
 * reason as the other two: more terms admitted, worse ranking.
 *
 * IDF measures rarity, and on a single-author narrative corpus rarity is dominated
 * by prose variation, not topic — the high-IDF terms this admits are "grind",
 * "flaring", "nape", "gaze". Adding them adds noise at high weight. A part-of-speech
 * filter keeps all of those and more, so it loses by the same mechanism; retaining
 * only nouns and verbs scored 0/5, and restoring the proper-noun boost on top of it
 * recovered to 4/5 rank 3.6. What discriminates here is identity, which no tagger
 * can see and capitalisation can.
 *
 * The boost is the mechanism, not the gazetteer. Measured: dropping the gazetteer
 * entirely costs half a rank (5/5 3.0 -> 4/5 3.4), while setting the boost to 1 and
 * leaving the gazetteer to do the work collapses to 1/5 rank 17.0. Keys, secondary
 * keys and titles score identically to keys alone, so there is nothing to tune in
 * how it is assembled — it is a thin safety net for entities the query happens to
 * mention in lowercase. The boost plateaus from 3 to 5 and degrades by 8.
 *
 * @param {string} queryText Raw query
 * @param {Set<string>} gazetteer Lorebook vocabulary
 * @param {number} boost Weight for proper nouns (settings().properNounBoost)
 * @returns {Record<string, number>} Term weights for the plugin
 */
export function buildTermWeights(queryText, gazetteer, boost) {
    const weights = {};

    // A capital letter at the start of a sentence says nothing about the word —
    // "Not", "It", "Then", "The" all get capitalised there. Only count a token as
    // an entity if it appears capitalised somewhere that ISN'T sentence-initial.
    const properNouns = new Set();

    for (const sentence of String(queryText).split(/(?<=[.!?])\s+|\n+/)) {
        const tokens = sentence.trim().split(/[^A-Za-z0-9']+/).filter(x => x.length > 1);
        for (let i = 1; i < tokens.length; i++) {
            if (/^[A-Z]/.test(tokens[i])) {
                properNouns.add(tokens[i].toLowerCase());
            }
        }
    }

    for (const token of String(queryText).split(/[^A-Za-z0-9']+/)) {
        if (token.length < 2) {
            continue;
        }

        const lower = token.toLowerCase();
        const isProperNoun = properNouns.has(lower);

        if (!isProperNoun && !gazetteer.has(lower)) {
            continue;
        }

        weights[lower] = Math.max(weights[lower] ?? 0, isProperNoun ? boost : 1);
    }

    return weights;
}

/**
 * Builds the retrieval query from the tail of the chat.
 * @param {object[]} chat Chat messages
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to include (settings().messageDepth)
 * @param {(s: string) => string} [cfg.substituteParams] Macro substitution (ST's; identity offline)
 * @returns {string} Query text
 */
export function buildQuery(chat, { depth, substituteParams = s => s }) {
    return joinQueryMessages(queryMessages(chat, { depth, substituteParams }));
}

/**
 * The join half of buildQuery, exported so a caller that already has queryMessages() output (retrieve()
 * stashes it for /wa-grade) can build the query string without running the whole-chat substitution pass
 * a second time.
 * @param {Array<{name: string, mes: string}>} messages queryMessages() output
 * @returns {string} Query text
 */
export function joinQueryMessages(messages) {
    return messages
        .map(x => (x.name ? `${x.name}: ${x.mes}` : x.mes))
        .join('\n\n')
        .trim();
}

/**
 * The messages buildQuery would join: substituted, stripped of file attachments, empties dropped, newest
 * `depth` of them, chronological. Same {name, mes} shape as ST's chat, so the output can be fed straight
 * back in.
 *
 * Exported because /wa-grade freezes this into its sample. That is what makes messageDepth the one query
 * parameter a frozen sample can still sweep: buildQuery over the last d of these is exact for any
 * d <= the captured depth. It has to be the pre-join form — buildQuery joins on '\n\n' and RP messages
 * contain blank lines, so the boundaries can't be recovered from the joined text.
 *
 * @param {object[]} chat Chat messages
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to include
 * @param {(s: string) => string} [cfg.substituteParams] Macro substitution (ST's; identity offline)
 * @returns {Array<{name: string, mes: string}>} Newest `depth` non-empty messages, chronological
 */
export function queryMessages(chat, { depth, substituteParams = s => s }) {
    return chat
        .map(x => ({
            name: String(x?.name ?? '').trim(),
            mes: substituteParams(String(x?.mes || '').substring(x?.extra?.fileLength || 0).trim()),
        }))
        .filter(x => x.mes)
        .reverse()
        .slice(0, Math.max(1, depth))
        // Back to chronological. Taking the newest N requires reversing first, but
        // handing a summarizer the messages backwards makes it read the scene in
        // reverse — it can't tell what happened after what.
        .reverse();
}

/**
 * The keyword scan window over the last `depth` messages — the ONE copy of the join, shared by the live
 * scan (worldsapart.js, which layers injects/match-sources on top), the depth ablation
 * (graded-scene-grid.mjs) and offline capture tools. Names are included when core includes them, or a
 * keyword that only ever appears as a "Name:" prefix would match in core and silently miss here.
 * @param {Array<{name?: string, mes?: string}>} chat Chat messages (or queryMessages() output)
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to scan
 * @param {boolean} [cfg.includeNames] world_info_include_names
 * @returns {string} Scan window text
 */
export function scanWindow(chat, cfg) {
    return scanSegments(chat, { ...cfg, matchWindow: 'scan' })[0] ?? '';
}

/**
 * A paragraph break: a blank line, tolerating trailing whitespace on the line above.
 *
 * NOT a single newline. Chat prose uses both — measured over one author's chats (392 messages,
 * 780KB), 27.6% of messages carry blank-line breaks AND single newlines within a paragraph, and only
 * 3.8% use single newlines alone. Splitting on `\n` would chop soft-wrapped dialogue into fragments;
 * splitting on a blank line reads the Markdown correctly, and in that 3.8% degenerates to the whole
 * message — never narrower than the author's own structure supports.
 */
const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/**
 * The scan window as SEGMENTS — the unit a key has to match within.
 *
 * WHY THIS AND NOT A JOIN. A conjunction over the whole window matches terms a dozen messages apart:
 * `? apollo astronauts` fires on a window where someone said "Apollo" and, four replies later,
 * someone else said "astronauts". Negation has the same blindness and fails worse — `? fire -drill`
 * is silently vetoed by a drill five messages back, and a false negative never surfaces anywhere,
 * where a false positive is a ranking contribution that competes and loses.
 *
 * The segment boundary is the one thing WA cannot recover after the fact, which is why this returns
 * an array instead of a string with markers in it: a message's own newlines are indistinguishable
 * from the join once flat, so a joined window cannot be split back into messages by any rule. WA
 * builds the window, so it simply keeps what it already knows.
 *
 * `scan` is not a special case — it is the degenerate one-segment array, and reproduces the
 * pre-setting behaviour exactly.
 *
 * @param {Array<{name?: string, mes?: string}>} chat Chat messages (or queryMessages() output)
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to scan
 * @param {boolean} [cfg.includeNames] world_info_include_names
 * @param {'scan'|'message'|'paragraph'} [cfg.matchWindow] Segment granularity
 * @returns {string[]} Scan segments, chronological
 */
export function scanSegments(chat, { depth, includeNames = true, matchWindow = 'scan' }) {
    const messages = chat.slice(-Math.max(1, depth))
        .map(x => (includeNames && x?.name ? `${x.name}: ${x.mes ?? ''}` : String(x?.mes ?? '')));
    return segment(messages, matchWindow);
}

/**
 * Applies the match window to already-separated texts. Split out from scanSegments because the
 * non-chat match sources (character description, scenario, injects) arrive as their own units and
 * need the same treatment — each is one text that paragraph mode may subdivide, and that no mode
 * may merge with a chat message.
 * @param {string[]} texts
 * @param {'scan'|'message'|'paragraph'} matchWindow
 * @returns {string[]}
 */
export function segment(texts, matchWindow) {
    if (matchWindow === 'scan') return [texts.join('\n')];
    const out = matchWindow === 'paragraph'
        ? texts.flatMap(t => String(t).split(PARAGRAPH_BREAK))
        : texts.map(String);
    // An empty segment can only produce zero counts, and every one of them costs a scan.
    return out.filter(t => t.trim());
}

/**
 * One-entry memo per case mode for the folded haystack. Keyed by string identity, which is the case
 * that matters: a scan hands every key the same text object, so this turns N folds into one. A miss
 * just recomputes, so correctness never depends on the hit.
 */
let foldMemoIn = null, foldMemoOut = null, orthMemoIn = null, orthMemoOut = null;
export const foldedHay = (text, caseSensitive) => {
    if (caseSensitive) {
        if (text !== orthMemoIn) { orthMemoIn = text; orthMemoOut = normalizeOrthography(text); }
        return orthMemoOut;
    }
    if (text !== foldMemoIn) { foldMemoIn = text; foldMemoOut = fold(text); }
    return foldMemoOut;
};

/**
 * Counts occurrences of a keyword in text.
 *
 * Follows core's matchKeys for FLAGS — case sensitivity, whole-word boundaries, multi-word fallback,
 * `/regex/` precedence — and deliberately diverges on ORTHOGRAPHY, which core does not normalise at
 * all: apostrophes, curly quotes, en/em dashes, ellipsis, non-breaking space and NFC composition all
 * fold here (see normalizeOrthography in plugin/automaton.mjs) and do not in core. A key carrying any
 * of those can therefore match here and not fire in core's scan, for as long as core owns activation.
 * `?` SmartKeys are a WA extension with no core equivalent at all.
 *
 * KNOWN LIMIT — MARKDOWN IN THE SCAN TEXT. Chat prose is Markdown, and the markup sits in the haystack,
 * so emphasis INSIDE a word cuts both ways against the text a reader actually sees:
 *
 *   "*sister*hood"   `sisterhood` MISSES — the asterisks break the substring
 *   "*sister*hood"   `sister` whole-word MATCHES — the * reads as a word boundary — where the
 *                    unemphasised "sisterhood" correctly does not
 *
 * The false positive is the worse half, and `=`-flagged SmartKey terms inherit it, sharing WORD_CHAR.
 * Emphasis around a WHOLE word is fine in every mode: "*sister*," matches `sister` exactly as it should.
 * This only bites mid-word, and mid-word emphasis turned up rarely in the sample prose available — one
 * author's chats, so that is a weak reason to relax about it rather than evidence it is uncommon.
 *
 * Not fixed, because every option is worse. Making `*` a word character kills the working case — a
 * standalone "*sister*" would then be bounded by word characters and stop matching, so the two cases
 * want opposite answers from the same character. Stripping markup from the haystack destroys the
 * asterisk as CONTENT: M*A*S*H, *B*witched, and the emphasis-markup keys a real book uses to
 * disambiguate Roman currency. Scanning both a raw and a stripped copy fixes only the miss direction,
 * not the false boundary, at two scan passes and a rule for combining the counts.
 *
 * The principled fix is to scan the RENDERED text rather than the source, since that is the only thing
 * which distinguishes markup from content. Much larger than it looks — core scans raw too.
 *
 * @param {string} key Keyword, /regex/flags, or a `?` SmartKey query
 * @param {string} text Text to search
 * @param {boolean} caseSensitive Case sensitivity
 * @param {boolean} wholeWords Whole word matching
 * @returns {number} Occurrence count (a SmartKey returns its weight)
 */
export function countKey(key, text, caseSensitive, wholeWords, scope) {
    const raw = String(key ?? '').trim();

    if (!raw || !text) {
        return 0;
    }

    // SmartKeys sentinel: `?`-prefixed keys are boolean queries (see smartkeys.mjs), overriding
    // the other options like a regex key does. Returns the query's weight (default 1) on match,
    // so it feeds keywordScore's saturation like a single occurrence scaled by :weight.
    if (raw.startsWith('?')) {
        const { matched, scoreBoost } = evaluateSmartKey(raw, text, scope);
        // A matched query built purely from negation (e.g. "? !apollo") carries zero accumulated
        // weight but must still count as a hit — floor ONLY that case, so a sub-1 :weight
        // (e.g. "? whisper:0.3") down-weights as documented.
        return matched ? (scoreBoost > 0 ? scoreBoost : 1) : 0;
    }

    // Regex key (/pattern/flags): count global matches, overriding the other options —
    // same precedence core's matchKeys gives a regex needle.
    const asRegex = raw.match(REGEX_KEY_RE);
    if (asRegex) {
        try {
            const flags = asRegex[2].includes('g') ? asRegex[2] : `${asRegex[2]}g`;
            return (text.match(new RegExp(asRegex[1], flags)) ?? []).length;
        } catch {
            return 0;
        }
    }

    // Aho-Corasick fast path: when keywordScore has primed a scan of this text, the shared
    // automaton already knows this key's folded-substring count. 0 is final under any flags;
    // a positive count is final for plain case-insensitive substring semantics, and otherwise
    // the key is a confirmed candidate that falls through to the exact (naive) walk below.
    const cached = cachedCount(raw, text, scope);
    if (cached === 0) return 0;
    if (cached !== undefined && !caseSensitive && (!wholeWords || /\s/.test(raw))) return cached;

    // Orthography is normalised under BOTH case modes — it is orthogonal to case, and a case-sensitive
    // key is no more likely to have been typed with the same quote or dash characters the prose uses.
    // Must match smartkeys' fold exactly or the trie and this walk disagree (see fold()).
    //
    // The HAYSTACK fold is memoised, the needle's is not. Every key in a pass sees the same text, so
    // folding it per call is the same waste core's matchKeys makes with its per-key toLowerCase — and
    // it costs more here, because the fold does real work now (33x a bare toLowerCase on 15KB).
    // Needles are short, so they stay uncached.
    const hay = foldedHay(text, caseSensitive);
    const needle = caseSensitive ? normalizeOrthography(raw) : fold(raw);

    // Whole-word matching applies only to single-word keys; a multi-word key falls back
    // to substring, exactly as core does (it splits on whitespace and uses includes()).
    if (wholeWords && !/\s/.test(needle)) {
        try {
            // Core's boundary is "not flanked by a word char" — (?:^|\W)…(?:$|\W) — which,
            // unlike \b, still matches keys that start or end with punctuation ("+5", "v2"
            // in "v2s" would not, but "v2" alone does). Lookaround keeps it non-consuming
            // so adjacent occurrences are all counted. WORD_CHAR rather than \w: see above.
            const regex = new RegExp(`(?<!${WORD_CHAR})${escapeRegex(needle)}(?!${WORD_CHAR})`, 'gu');
            return (hay.match(regex) ?? []).length;
        } catch {
            return 0;
        }
    }

    // Substring occurrence count.
    let count = 0;
    for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
        count++;
    }
    return count;
}

/**
 * BM25-style keyword score: a sum of per-key contributions with diminishing returns,
 * so breadth of evidence outweighs repetition without gating repetition out.
 * @param {object} entry World Info entry
 * @param {string} text Scan window
 * @param {string[]} [keys] Keys to score (defaults to entry.key)
 * @param {object} cfg
 * @param {number} cfg.k1 BM25 saturation (settings().bm25K1)
 * @param {boolean} cfg.caseSensitiveDefault world_info_case_sensitive (entry may override)
 * @param {boolean} cfg.wholeWordsDefault world_info_match_whole_words (entry may override)
 * @returns {{score: number, hits: Array<{key: string, count: number}>}} Score and matched keys.
 */
/**
 * `selectiveLogic` values, mirroring core's `world_info_logic` (world-info.js:33). Duplicated rather
 * than imported because this module stays ST-free; the mapping is verified in matcher-check against
 * core's own evaluation.
 */
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

/**
 * Core's secondary-key condition (world-info.js matchSecondaryKeys), over WA's matcher.
 *
 * True when the entry has no secondary keys, so callers can apply it unconditionally. Keys are NOT
 * `substituteParams`-expanded here, matching how primary keys are already treated in this module —
 * that substitution is ST-side and this file is ST-free.
 *
 * @returns {boolean} whether the entry's secondary condition is satisfied by `text`
 */
export function secondaryOk(entry, text, caseSensitive, wholeWords) {
    const sec = Array.isArray(entry?.keysecondary) ? entry.keysecondary.filter(k => String(k ?? '').trim()) : [];
    if (!sec.length) return true;
    if (text) primeScan(sec, text);
    let any = false, all = true;
    for (const k of sec) {
        if (countKey(k, text, caseSensitive, wholeWords) > 0) any = true;
        else all = false;
    }
    switch (entry.selectiveLogic ?? WI_LOGIC.AND_ANY) {
        case WI_LOGIC.NOT_ALL: return !all;
        case WI_LOGIC.NOT_ANY: return !any;
        case WI_LOGIC.AND_ALL: return all;
        default: return any;   // AND_ANY, and core's fallback for an unknown value
    }
}

/**
 * BM25-style keyword score for one entry against the scan window.
 * @param {object} entry
 * @param {string|string[]} text Scan text — a bare string is one segment (`matchWindow: 'scan'`),
 *   an array is the segmented window from scanSegments()
 * @param {string[]} [keys]
 * @returns {{score: number, hits: Array<{key: string, count: number}>}}
 */
export function keywordScore(entry, text, keys = entry.key, { k1, caseSensitiveDefault, wholeWordsDefault } = {}) {
    if (!Array.isArray(keys) || !keys.length) {
        return { score: 0, hits: [] };
    }

    // Inherit the globals exactly as core does (world-info.js matchKeys), or WA matches
    // on different rules than the scan that activated the entry. Core's whole-word
    // default is OFF (substring), so hardcoding true here made WA miss any keyword that
    // only appears inside a larger word.
    const caseSensitive = entry.caseSensitive ?? caseSensitiveDefault;
    const wholeWords = entry.matchWholeWords ?? wholeWordsDefault;

    // A bare string is ONE segment, which is what `matchWindow: 'scan'` means — so every caller that
    // has not been taught about segments keeps the pre-setting behaviour rather than an approximation
    // of it. Only the live scan passes an array.
    const segments = Array.isArray(text) ? text : [text];

    // Register every key and scan each segment ONCE (Aho-Corasick); countKey below then answers
    // from that scan instead of walking the buffer per key. Segments are shared across entries in
    // a retrieval pass — and shared BY VALUE, since the cache keys on the string — so after the
    // first entry this is a no-op, and an entry that appends match sources pays only for those.
    if (segments.length) primeScan(keys, segments);

    let score = 0;
    const hits = [];
    const counts = new Map();

    for (const segment of segments) {
        if (!segment) continue;

        // SECONDARY KEYS GATE THE SCORE, not just activation, and they gate it PER SEGMENT. An entry
        // keyed `cosmonaut` with a secondary `apollo` under AND ANY says it is relevant when both are
        // present; scoring the primary alone credits it for evidence its author said does not count on
        // its own. Whole-window, "both present" degrades to "both mentioned at some point", which is
        // the distance-blindness the match window exists to fix — so a segment that fails its own gate
        // contributes nothing, rather than the whole entry scoring 0 because one segment failed.
        //
        // Core checks this before activating, so for a keyword entry the gate has already passed once —
        // but against CORE's buffer, which is not WA's window (worldsapart.js builds its own), and a
        // force-activated entry was never checked at all. Either way the score is WA's claim about this
        // text, so it is WA's job to make it true of this text.
        if (!secondaryOk(entry, segment, caseSensitive, wholeWords)) continue;

        for (const key of keys) {
            const n = countKey(key, segment, caseSensitive, wholeWords);
            if (n > 0) counts.set(key, (counts.get(key) ?? 0) + n);
        }
    }

    // Occurrences SUM across gate-passing segments and saturate once, rather than saturating per
    // segment: a key is as repeated as the window says it is, and k1 is calibrated against a whole
    // window's counts. At `scan` this is arithmetically identical to the pre-setting code.
    for (const [key, count] of counts) {
        score += count / (count + k1);
        hits.push({ key, count });
    }

    // Most-repeated key first, so the debug column leads with the strongest evidence.
    hits.sort((a, b) => b.count - a.count);
    return { score, hits };
}

/**
 * Fuses the RETRIEVAL ranking: vector score against BM25-over-chunk-text, and nothing else.
 *
 * Deliberately not fuseRanks. This is the list the cutoff cuts (selection.mjs cutRetrieved), and the
 * question there is only "which retrieved entries are strong enough to force-activate" — keyword and
 * authored-order ranks belong to the final layout ranking, over a population that includes entries
 * retrieval never saw. Feeding them in here would let a keyword-only entry displace a retrieved one
 * from a decision it isn't a candidate in.
 *
 * Lives here rather than in worldsapart.js because it is pure rank arithmetic over injected settings,
 * so the offline cutoff harnesses can cut the real ranking instead of a copy of this formula.
 *
 * @param {Map<string, {score: number, bm25?: number, chunk?: string}>} scores Per-entry retrieval results
 * @param {object} cfg
 * @param {number} cfg.rrfK RRF constant (settings().rrfK)
 * @param {string} cfg.retrievalMode 'hybrid' | 'vector' | 'lexical'
 * @param {number} cfg.lexicalWeight BM25 vs vector weight in fusion
 * @returns {Array<{key: string, value: object, fused: number, vectorRank?: number, textRank?: number}>} Fused ranking, best first
 */
export function fuseRetrieval(scores, { rrfK: k, retrievalMode: mode, lexicalWeight }) {
    const entries = [...scores.entries()];
    const useVector = mode !== 'lexical';
    const useText = mode !== 'vector';

    const rankOf = (sortKey) => new Map([...entries]
        .sort((a, b) => (b[1][sortKey] ?? 0) - (a[1][sortKey] ?? 0))
        .map(([key], index) => [key, index + 1]));

    const vectorRanks = rankOf('score');
    const textRanks = rankOf('bm25');

    return entries
        .map(([key, value]) => {
            const vectorRank = useVector ? vectorRanks.get(key) : undefined;
            const textRank = useText && value.bm25 > 0 ? textRanks.get(key) : undefined;
            return {
                key,
                value,
                vectorRank,
                textRank,
                fused: (vectorRank ? 1 / (k + vectorRank) : 0)
                    + (textRank ? lexicalWeight / (k + textRank) : 0),
            };
        })
        .sort((a, b) => b.fused - a.fused);
}

/**
 * Fuses the vector and keyword rankings with reciprocal rank fusion.
 * Only ordering matters to RRF, so the two incomparable score scales never
 * have to be converted into each other.
 * @param {object[]} items Ranking items (mutated: vectorRank/textRank/keywordRank/orderRank/fused set)
 * @param {object} cfg
 * @param {number} cfg.rrfK RRF constant (settings().rrfK)
 * @param {string} cfg.retrievalMode 'hybrid' | 'vector' | 'lexical'
 * @param {boolean} cfg.weightByOrder Fuse an authored-order rank too
 * @param {number} cfg.lexicalWeight BM25-over-TEXT vs vector weight in fusion
 * @param {number|null} [cfg.keywordWeight] BM25-over-KEYS weight; null/unset follows lexicalWeight
 */
export function fuseRanks(items, { rrfK: k, retrievalMode: mode, weightByOrder, lexicalWeight, keywordWeight }) {
    // TEXT AND KEYS GET SEPARATE WEIGHTS, because they are separate signals that disagree about which books
    // they are good on. Measured across three graded scenes, the best (text, keys) pair was (0.5, 3) on a
    // book with tightly curated keywords, (1.5, 0) on one whose keys are auto-generated noise, and (1.5, 1)
    // on a third. A single coupled knob can only slide along the diagonal and cannot express any of them —
    // there is no value of it that means "trust the content, ignore the keys", which is what two of the
    // three want. keys correlate 0.79 / 0.11 / 0.39 with human grades on those same books.
    //
    // Undefined mirrors lexicalWeight, so this is byte-identical for anyone who has not set it. That matters
    // more than a tidy default: a user running lexicalWeight 1.5 would otherwise see their keyword weight
    // silently drop to the shipped 1 on upgrade.
    //
    // isFinite, not `??`: NaN is neither null nor undefined, so a `??` would pass it straight through and
    // every fused score below becomes NaN — which does not throw, it just makes the sort comparator return
    // NaN for every pair and silently leaves the ranking in input order. Settings arrive from persisted
    // JSON and imported configs, not only from the numeric input that produced them.
    const keyW = Number.isFinite(keywordWeight) ? keywordWeight : lexicalWeight;
    const rankMap = (list) => new Map(list.map((item, index) => [item.key, index + 1]));

    const byVector = mode === 'lexical'
        ? new Map()
        : rankMap(items.filter(x => x.score !== undefined).sort((a, b) => b.score - a.score));
    // BM25 over chunk TEXT, from the plugin. Its IDF is what discounts terms that
    // appear in nearly every chunk — the recurring cast — without any tuning.
    const byText = mode === 'vector'
        ? new Map()
        : rankMap(items.filter(x => x.textScore > 0).sort((a, b) => b.textScore - a.textScore));
    // BM25 over entry KEYS. Scores non-vectorized entries; also 🔗 entries when
    // scoreVectorKeys is on (via their stashed keys), otherwise suppressKeys leaves them at 0.
    const byKeyword = rankMap(items.filter(x => x.keywordScore > 0).sort((a, b) => b.keywordScore - a.keywordScore));

    // Optional priority signal: rank every entry by authored Order (descending — higher = higher
    // priority, per ST where order is budgetPriority) and fuse it like any other rank. Scale-free,
    // so no magnitude tuning; it just nudges high-order entries up the fused ranking.
    const orderVal = it => it.entry.waOriginalOrder ?? it.entry.order ?? 0;
    const byOrder = weightByOrder
        ? rankMap([...items].sort((a, b) => orderVal(b) - orderVal(a)))
        : new Map();

    for (const item of items) {
        item.vectorRank = byVector.get(item.key);
        item.textRank = byText.get(item.key);
        item.keywordRank = byKeyword.get(item.key);
        item.orderRank = byOrder.get(item.key);
        item.fused = (item.vectorRank ? 1 / (k + item.vectorRank) : 0)
            + (item.textRank ? lexicalWeight / (k + item.textRank) : 0)
            + (item.keywordRank ? keyW / (k + item.keywordRank) : 0)
            + (item.orderRank ? 1 / (k + item.orderRank) : 0);
    }
}
