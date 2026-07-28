// ranking.mjs — the client-side retrieval TUNING layer: entity filter, query building, keyword
// scoring, and RRF fusion. This is the code that gets dialed in as retrieval is tuned, so it lives
// with the extension, NOT the plugin: a change here is a browser refresh, never a plugin redeploy,
// and it is never copied into /plugins, so it stays out of the plugin fingerprint.
//
// Imported by both the extension and the offline harnesses, so it must stay isomorphic — no DOM, no
// ST imports. Every SillyTavern/settings dependency (proper-noun boost, message depth,
// substituteParams, BM25 k1, world-info match defaults, fusion weights) is INJECTED by the caller.
// The extension wraps these with its settings()/ST globals; the harness passes its own values.

/** Escape a string for literal use in a RegExp (same as ST's utils.escapeRegex; inlined to stay ST-free). */
function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Collects the lorebook's own vocabulary — every term appearing in an entry's keys
 * or title. Anything named there is something this corpus treats as a thing worth
 * naming, which is a better salience signal than rarity.
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
 * lorebook's own vocabulary, and boosts the capitalised ones. Benchmarked on real
 * chat text against a hand-judged gold set: mean target rank 11.2 versus 21.6–28.2
 * for the unfiltered query. The two halves are complementary — the gazetteer drops
 * ordinary vocabulary, the boost promotes entities.
 *
 * Note this is deliberately NOT applied to summarized queries, which are already
 * salience-selected and would only lose context.
 *
 * Do not "improve" this by admitting more terms. Both obvious loosenings were
 * measured on the same gold set and both are worse:
 *
 *   admit terms with high corpus IDF too   5/5 rank 3.0 -> 4/5 rank 5.2 (IDF>=4)
 *   keep content words (POS-style filter)  5/5 rank 3.0 -> 0/5 rank 27.4
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
    return chat
        .map(x => ({
            name: String(x?.name ?? '').trim(),
            text: substituteParams(String(x?.mes || '').substring(x?.extra?.fileLength || 0).trim()),
        }))
        .filter(x => x.text)
        .reverse()
        .slice(0, Math.max(1, depth))
        // Back to chronological. Taking the newest N requires reversing first, but
        // handing a summarizer the messages backwards makes it read the scene in
        // reverse — it can't tell what happened after what.
        .reverse()
        .map(x => (x.name ? `${x.name}: ${x.text}` : x.text))
        .join('\n\n')
        .trim();
}

/**
 * Counts occurrences of a keyword in text, matching core's matchKeys rules.
 * @param {string} key Keyword or /regex/flags
 * @param {string} text Text to search
 * @param {boolean} caseSensitive Case sensitivity
 * @param {boolean} wholeWords Whole word matching
 * @returns {number} Occurrence count
 */
export function countKey(key, text, caseSensitive, wholeWords) {
    const raw = String(key ?? '').trim();

    if (!raw || !text) {
        return 0;
    }

    // Regex key (/pattern/flags): count global matches, overriding the other options —
    // same precedence core's matchKeys gives a regex needle.
    const asRegex = raw.match(/^\/(.+)\/([gimsuy]*)$/);
    if (asRegex) {
        try {
            const flags = asRegex[2].includes('g') ? asRegex[2] : `${asRegex[2]}g`;
            return (text.match(new RegExp(asRegex[1], flags)) ?? []).length;
        } catch {
            return 0;
        }
    }

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
