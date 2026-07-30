// ranking.mjs — the client-side retrieval TUNING layer: entity filter, query building, keyword
// scoring, and RRF fusion. This is the code that gets dialed in as retrieval is tuned, so it lives
// with the extension, NOT the plugin: a change here is a browser refresh, never a plugin redeploy,
// and it is never copied into /plugins, so it stays out of the plugin fingerprint.
//
// Imported by both the extension and the offline harnesses, so it must stay isomorphic — no DOM, no
// ST imports. Every SillyTavern/settings dependency (proper-noun boost, message depth,
// substituteParams, BM25 k1, world-info match defaults, fusion weights) is INJECTED by the caller.
// The extension wraps these with its settings()/ST globals; the harness passes its own values.

import { cachedCount, evaluateSmartKey, primeScan } from './smartkeys.mjs';

/** Escape a string for literal use in a RegExp (same as ST's utils.escapeRegex; inlined to stay ST-free, exported for keyword-core). */
export function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
 * Counts occurrences of a keyword in text, matching core's matchKeys rules.
 * @param {string} key Keyword or /regex/flags
 * @param {string} text Text to search
 * @param {boolean} caseSensitive Case sensitivity
 * @param {boolean} wholeWords Whole word matching
 * @returns {number} Occurrence count
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

    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? raw : raw.toLowerCase();

    // Whole-word matching applies only to single-word keys; a multi-word key falls back
    // to substring, exactly as core does (it splits on whitespace and uses includes()).
    if (wholeWords && !/\s/.test(needle)) {
        try {
            // Core's boundary is "not flanked by a word char" — (?:^|\W)…(?:$|\W) — which,
            // unlike \b, still matches keys that start or end with punctuation ("+5", "v2"
            // in "v2s" would not, but "v2" alone does). Lookaround keeps it non-consuming
            // so adjacent occurrences are all counted.
            const regex = new RegExp(`(?<!\\w)${escapeRegex(needle)}(?!\\w)`, 'g');
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

    // Register every key and scan the text ONCE (Aho-Corasick); countKey below then answers
    // from that scan instead of walking the buffer per key. Text is shared across entries in
    // a retrieval pass, so after the first entry this is a no-op.
    if (text) primeScan(keys, text);

    let score = 0;
    const hits = [];

    for (const key of keys) {
        const count = countKey(key, text, caseSensitive, wholeWords);
        if (count > 0) {
            score += count / (count + k1);
            hits.push({ key, count });
        }
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
 * @param {number} cfg.lexicalWeight BM25 vs vector weight in fusion
 */
export function fuseRanks(items, { rrfK: k, retrievalMode: mode, weightByOrder, lexicalWeight }) {
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
            + (item.keywordRank ? lexicalWeight / (k + item.keywordRank) : 0)
            + (item.orderRank ? 1 / (k + item.orderRank) : 0);
    }
}
