// ranking.mjs — the client-side retrieval TUNING layer: entity filter, query building, and RRF
// fusion — which entries WIN. Match semantics (countKey, the scan window, keyword scoring, the
// activation verdicts) are matcher.mjs; the two change for different reasons. This is the code
// that gets dialed in as retrieval is tuned, so it lives with the extension, NOT the plugin: a
// change here is a browser refresh, never a plugin redeploy, and it is never copied into
// /plugins, so it stays out of the plugin fingerprint.
//
// Imported by both the extension and the offline harnesses, so it must stay isomorphic — no DOM, no
// ST imports. Every SillyTavern/settings dependency (proper-noun boost, message depth,
// substituteParams, BM25 k1, world-info match defaults, fusion weights) is INJECTED by the caller.
// The extension wraps these with its settings()/ST globals; the harness passes its own values.

// The matcher's fold, because the tokens built here are BM25 QUERY TERMS: buildTermWeights' keys feed
// bm25Scores directly, so they must be tokenized exactly as the index is (lexical.mjs tokenize)
// or an accented query term shatters on this side and silently matches nothing. Same word-character
// core too (\p{L}\p{N}\p{M} + apostrophe); a private [^A-Za-z0-9'] split was how "Möbius" indexed as
// "bius" — see the tokenize header for the measurement.
import { fold, normalizeOrthography } from '../plugin/automaton.mjs';


/**
 * Collects the lorebook's own vocabulary — every term appearing in an entry's keys
 * or title. Anything named there is something this corpus treats as a thing worth
 * naming, which is a better salience signal than rarity.
 *
 * READS AT STAGE 3 ONLY. The entity filter's term weights are BM25 query terms, and stage 1 has no BM25
 * (plugin/scoring.mjs) — so this feeds content-lexical alone and can reweight what an activated entry
 * scores, never what gets admitted. Measurements taken against the old pipeline mixed both effects.
 *
 * DO NOT "fix" the missing keys. The one production call site is `queryTermWeights`, inside
 * `contentTextScores` at stage 3, where `waOwnsScan` is true — so the takeover has already blanked
 * key/keysecondary on every keyword-activating entry of the `getSortedEntries()` this is handed, and the
 * vocabulary is entry TITLES plus the keys of constants and `@@activate` entries. That looks like a bug
 * and reads like one here.
 *
 * It is not worth arguing about: the gazetteer SOURCE was swept at n=71 scenes paired and came back flat
 * on every arm INCLUDING an empty gazetteer (`eval/param-screen.mjs` `gaz=*`), with all four returning a
 * byte-identical candidate set and differing only in query terms. The proper-noun boost is carrying the
 * entity filter on its own.
 *
 * The offline harnesses must reproduce whatever production hands this, or they measure a gazetteer
 * nothing builds — a TERM count, never an entry count, and never an admission effect: stage 1 admits
 * every candidate it scores and reads no term weights at all.
 *
 * @param {object[]} entries All World Info entries
 * @returns {Set<string>} Lowercased gazetteer terms
 */
export function buildGazetteer(entries) {
    const terms = new Set();

    for (const entry of entries) {
        const sources = [...(entry.key ?? []), ...(entry.keysecondary ?? []), entry.comment ?? ''];
        for (const source of sources) {
            for (const token of fold(source).split(/[^\p{L}\p{N}\p{M}']+/u)) {
                if (token.length > 1) {
                    terms.add(token);
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
 * TUNED AT STAGE 1, WHICH NO LONGER READS THIS. Its arms ranked the retrieval ranking when that fused
 * BM25 and admission could turn on a query term; today the filter reaches only content-lexical at stage
 * 3, so the tables are gone and what survives them is the DIRECTION — every arm admitting more terms
 * ranked worse — plus the two traps that produced four different answers from four attempts:
 *
 * TRAP 1, THE METRIC. Use mean target rank, not nDCG@5. Relevance here is sparse and OVERDISPERSED
 * (relevant-per-scene mean 9.9, variance 24.5 — var/mean 2.48, where Poisson is 1, which is 71 scenes
 * over 3 stories showing through)
 * (5-11 judged-relevant entries per scene), so nDCG@5 sees a handful of placements and has few reachable
 * states: it returned an IDENTICAL 0.9322 for boost 1/2/3/5/8 on one scene under every population tried.
 * That is mechanistic rather than noise — the boost is a uniform multiplier over proper nouns, so where
 * the top entries match the same entities it cannot reorder them at all. Anything that looks like a tie
 * on nDCG@5 should be re-read on mean rank, which pools every judged-relevant entry and does not saturate.
 *
 * TRAP 2, THE POPULATION. Grades exist only for entries production ACTIVATED, so scoring within that pool
 * makes a wrong promotion INVISIBLE — the promoted entry is filtered out rather than penalised, and one
 * scene returned 0.9634 for every arm including no-filter that way. Score unjudged rows as 0 over the
 * uncut ranking (`--unjudged zero`); the sparse shape licenses it, since past roughly rank 25 the
 * marginal candidate is almost surely irrelevant (measured: one sample's grades bottom out in zeros by
 * rank 24), so "unjudged" and "irrelevant" nearly coincide.
 *
 * WHAT IS MEASURED AT THIS STAGE is the gazetteer SOURCE question, re-run at n=71 scenes paired: flat on
 * every arm, INCLUDING an empty gazetteer (eval/param-screen.mjs `gaz=*`). So the boost is the mechanism
 * and the gazetteer is a thin safety net for entities a query happens to mention in lowercase — treat its
 * assembly as having nothing to tune, and re-measure before moving `properNounBoost` or the filter itself.
 *
 * Deliberately NOT applied to summarized queries, which are already salience-selected and would only lose
 * context.
 *
 * Do not "improve" this by admitting more terms. IDF measures rarity, and on a single-author narrative
 * corpus rarity is dominated by prose variation rather than topic — the high-IDF terms an IDF cutoff
 * admits are "grind", "flaring", "nape", "gaze", noise at high weight. A part-of-speech filter keeps all
 * of those and more and loses by the same mechanism; feeding the gazetteer entry BODIES admits most of the
 * query's distinct terms at 5-10x the vocabulary and loses the same way. What discriminates here is
 * identity, which no tagger can see and capitalisation can.
 *
 * @param {string} queryText Raw query
 * @param {Set<string>} gazetteer Lorebook vocabulary
 * @param {number} boost Weight for proper nouns (settings().properNounBoost)
 * @returns {Record<string, number>} Term weights for the plugin
 */
/**
 * The lowercased tokens a text uses as NAMES.
 *
 * A capital letter at the start of a sentence says nothing about the word — "Not", "It", "Then", "The"
 * all get capitalised there — so a token counts only where it appears capitalised somewhere that is NOT
 * sentence-initial. `\p{Lu}` rather than `[A-Z]`, or an accented-initial name ("Étienne") is never an
 * entity.
 *
 * Exported because it is the project's definition of a name and more than one thing asks: the entity
 * filter weights query terms with it, and stage 4's proper-noun overlap feature reads entries and the
 * scan window with it. A second regex somewhere else is the drift this exists to prevent — the private
 * one it replaced was ASCII-only, counted sentence-initial capitals, and missed any name under three
 * letters.
 *
 * ORTHOGRAPHY IS THE CALLER'S. buildTermWeights normalises once and hands the result to both loops;
 * a caller comparing two texts must normalise both the same way or the sets cannot intersect.
 */
export function properNounsOf(text) {
    const out = new Set();
    for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+|\n+/)) {
        const tokens = sentence.trim().split(/[^\p{L}\p{N}\p{M}']+/u).filter(x => x.length > 1);
        for (let i = 1; i < tokens.length; i++) {
            if (/^\p{Lu}/u.test(tokens[i])) out.add(tokens[i].toLowerCase());
        }
    }
    return out;
}

export function buildTermWeights(queryText, gazetteer, boost) {
    const weights = {};
    // Orthography before anything reads the text, case preserved: the proper-noun test below needs
    // capitals, so this is the fold minus its case half, applied once so both loops see one form.
    const query = normalizeOrthography(queryText);
    const properNouns = properNounsOf(query);

    for (const token of query.split(/[^\p{L}\p{N}\p{M}']+/u)) {
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
        .map((x, i) => ({
            name: String(x?.name ?? '').trim(),
            mes: substituteParams(String(x?.mes || '').substring(x?.extra?.fileLength || 0).trim()),
            // Index in the array HANDED IN, not in any canonical chat — a caller that pre-filtered maps it
            // back itself. It is what lets a capture record the message range it covers rather than
            // approximating it as `last - depth`, which is wrong the moment an empty message is skipped.
            i,
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
 * Whether an item is IN THE VECTOR COLLECTION — not whether it could be embedded, which is true of all
 * text, and not whether it earned a cosine. A vectorized entry that failed to rank is still in, because
 * it competed and lost. Callers may declare it explicitly, since only they know how the scan
 * resolved; absent flags fall back to presence.
 *
 * Named for membership because that is the only question it answers. It used to gate the TEXT signal
 * too, which read as "is a non-vector entry in the vector collection" — a question worth asking of
 * nothing. That was parasitic: text scores could only come from the vector index, so membership stood in
 * for text eligibility. content-lexical.mjs indexes every entry's content, so text no longer asks.
 */
export const inVectorIndex = it => it.vectorEligible ?? it.entry?.vectorized ?? Number.isFinite(it.score);


