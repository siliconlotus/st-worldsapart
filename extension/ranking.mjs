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
 * Orders the RETRIEVAL ranking: cosine, and nothing else.
 *
 * NO LONGER A FUSION, and kept as a named function rather than inlined as a sort because stage 1's
 * ordering is a thing the cutoff harnesses cut and the Studio displays — a second copy of it is the drift
 * the single-scorer rule exists to prevent. It used to RRF the cosine rank against BM25-over-chunk-text;
 * plugin/scoring.mjs's header carries why the lexical half left stage 1 and what that concedes.
 *
 * Deliberately not fuseRanks. The question here is only "which retrieved entries force-activate" — keyword and
 * authored-order ranks belong to the final layout ranking, over a population that includes entries
 * retrieval never saw. Feeding them in here would let a keyword-only entry displace a retrieved one
 * from a decision it isn't a candidate in.
 *
 * `fused` is gone with the fusion. Callers that ranked on it read `vectorRank` (1-based, best first),
 * which is what the returned array is already sorted by — an absent cosine sorts last rather than
 * silently scoring 0, the trap fuseRanks records against null scores.
 *
 * @param {Map<string, {score: number, chunk?: string}>} scores Per-entry retrieval results
 * @returns {Array<{key: string, value: object, vectorRank: number}>} Retrieval ranking, best first
 */
export function fuseRetrieval(scores) {
    const entries = [...scores.entries()];
    const vectorRanks = new Map([...entries]
        .sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0))
        .map(([key], index) => [key, index + 1]));

    return entries
        .map(([key, value]) => ({ key, value, vectorRank: vectorRanks.get(key) }))
        .sort((a, b) => a.vectorRank - b.vectorRank);
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

/**
 * A KEYWORD-ONLY ENTRY WINS THE TIE. Normalisation in fuseRanks makes the two classes comparable — both top
 * out at 1/(k+1) — and this decides which way an otherwise-equal pair falls: a key is an author saying "when
 * this term appears, this entry is relevant", which is a stronger statement of intent than a cosine.
 *
 * A TIE-BREAK, NOT A REORDERING, which is what fixes the size. At k=20 the whole rank curve spans 1/21 to
 * 1/60, so a multiplier buys rank positions fast: 1.25 lets keyword ranks 1-6 clear the BEST vector entry
 * and no further, which is "a strong vector entry still beats a mid keyword entry". 1.4 reaches rank 9,
 * 1.5 reaches 11, and past that the tilt stops being a tie-break and starts being a class preference.
 *
 * Conditioned on SIGNAL TYPE, not entry class. The intuition behind it is that keyword-only entries are
 * reference sheets and vectorized ones are scene memories, which holds one way — 97% of vectorized
 * entries across the books on disk are memory — but only 69% the other, and it inverts on books whose
 * memory entries were never vectorized (Time Whore: 111 of 133 keyword-only entries are memories). So
 * this favours the signal, and a book that keys its memories gets the tilt on those too.
 *
 * THAT INVERTING POPULATION IS AN ARTIFACT, not a case to design for: an STMB entry that is not
 * vectorized is a book in a configuration its author has since abandoned — keys were the workaround
 * for weak vector recall, and the defect is the missing link, not the keys. 289 of 1,393 STMB entries
 * on disk are in that state and 113 of them are one book. Re-vectorizing it removes the tilt from
 * those entries, which is correct. The tilt's own reasoning does not depend on them; only this
 * paragraph's example did.
 *
 * Injectable because anything that gives a keyword-only entry a cosine takes the tilt away as a side
 * effect (eval/scene.mjs denseAllEntries), and a two-part change nobody can split reads as one number.
 *
 * THE VALUE IS MEASURED AND CLOSED. A 13-dose ladder (0.75–3, 70 graded scenes, paired, param-screen
 * `tilt` family) is unimodal on both metrics with a narrow joint plateau at [1.25, 1.3]. The set score's
 * cliff sits between 1.2 and 1.25 — every lower dose pays, −0.008 F@R at 1.2 (9 of the 10 moving scenes
 * worse) down to −0.055 at 0.75 — and nDCG's decline starts at 1.35 (−0.007, p=0.003) and is monotone
 * to −0.081 at 3. Both ends collapse on both metrics at p<=0.005. 1.25 is the plateau's left edge and
 * 1.3 is statistically indistinguishable from it; nothing between them is decidable at this n.
 */
export const KEYWORD_ONLY_TILT = 1.25;

/**
 * Fuses the vector and keyword rankings with reciprocal rank fusion.
 * Only ordering matters to RRF, so the two incomparable score scales never
 * have to be converted into each other.
 * @param {object[]} items Ranking items (mutated: vectorRank/textRank/keywordRank/orderRank/fused set)
 * @param {object} cfg
 * @param {number} cfg.rrfK RRF constant (settings().rrfK)
 * @param {boolean} cfg.weightByOrder Fuse an authored-order rank too
 * @param {number} cfg.lexicalWeight BM25-over-TEXT vs vector weight in fusion
 * @param {number|null} [cfg.keywordWeight] BM25-over-KEYS weight; null/unset follows lexicalWeight
 * @param {number} [cfg.sparseWeight] Learned sparse-lexical weight; 0 (default) makes the column inert
 * @param {number} [cfg.keywordOnlyTilt] Keyword-only tie-break multiplier; defaults to KEYWORD_ONLY_TILT
 */
export function fuseRanks(items, { rrfK: k, weightByOrder, lexicalWeight, keywordWeight, sparseWeight = 0, keywordOnlyTilt = KEYWORD_ONLY_TILT }) {
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

    // isFinite, not `!== undefined` — the same trap the keywordWeight note above records, from the other
    // direction: a caller that marks "no cosine" with null slips past an undefined test, enters this rank
    // list at effectively 0, and takes numerator credit while vectorEligible exempts it from the
    // denominator. Measured: rows carrying score:null shifted a 66-scene mean nDCG@10 baseline by 0.0122,
    // more than the effect that run was trying to measure.
    const byVector = rankMap(items.filter(x => Number.isFinite(x.score)).sort((a, b) => b.score - a.score));
    // BM25 over entry CONTENT, computed in the browser by content-lexical.mjs over extension/lexical.mjs.
    // NOT the plugin: stage 1 is cosine-only and scores no text at all (scoring.mjs header), which is why
    // lexical.mjs no longer lives there. Its IDF is what discounts terms appearing in nearly every chunk
    // — the recurring cast — without any tuning.
    const byText = rankMap(items.filter(x => x.textScore > 0).sort((a, b) => b.textScore - a.textScore));
    // BM25 over entry KEYS. Scores non-vectorized entries; also 🔗 entries when
    // their stashed keys are restored, otherwise suppressKeys leaves them at 0.
    const byKeyword = rankMap(items.filter(x => x.keywordScore > 0).sort((a, b) => b.keywordScore - a.keywordScore));
    // LEARNED SPARSE LEXICAL — a per-token weight from the embedder rather than a corpus statistic, scored
    // as the sum over shared tokens of the two sides' weights. It answers the question IDF answers badly on
    // a single-story corpus (a cast name in most chunks earns almost no IDF, and is exactly what the scene
    // is about) using a prior learned from the model's training data instead of from this book.
    //
    // INERT AT WEIGHT 0, which is the default: with no sparseWeight the column contributes nothing and is
    // in nobody's denominator, so this is byte-identical for a caller that supplies no sparse scores. That
    // matters because the scores need a serving path the extension does not have yet — Ollama returns the
    // dense vector only — so the column exists to be measured offline before anything is built for it.
    // PRESENCE, NOT POSITIVITY. `> 0` reads as "had something to say" only for a score whose zero means
    // absence — a sparse lexical sum with no shared tokens. A centered cosine is SIGNED and its zero is
    // just the corpus mean, so that test silently excluded every below-average entry from the rank list
    // while eligibility still charged it the denominator: the worst possible treatment, and applied to
    // 22 of 335 dense-scored rows here, 9 of them graded relevant. An eligible entry gets ranked; losing
    // is what the last rank is for.
    const bySparse = sparseWeight > 0
        ? rankMap(items.filter(x => Number.isFinite(x.sparseScore)).sort((a, b) => b.sparseScore - a.sparseScore))
        : new Map();

    // Optional priority signal: rank every entry by authored Order (descending — higher = higher
    // priority: ST sorts entries `b.order - a.order` and fills until the budget runs out, so a higher
    // order is served first) and fuse it like any other rank. ST has no priority CONCEPT — `budgetPriority`
    // appears once in its tree, inside an importer mapping a foreign format onto `order` — so this is an
    // emergent property of the sort, the same way sticky becomes priority by being filled first.
    // Scale-free,
    // so no magnitude tuning; it just nudges high-order entries up the fused ranking.
    const orderVal = it => it.entry.waOriginalOrder ?? it.entry.order ?? 0;
    const byOrder = weightByOrder
        ? rankMap([...items].sort((a, b) => orderVal(b) - orderVal(a)))
        : new Map();

    // NORMALISED BY ELIGIBILITY, so an entry is scored against the signals it COULD have earned rather than
    // against all three. A plain RRF sum treats a missing signal as a zero contribution, which is a floor for
    // an entry that competed and lost and a ceiling for one that was never allowed to compete: a keyword-only
    // entry topped out at keyW/(k+1) against (1 + lexicalWeight + keyW)/(k+1) for a vectorized one — 37% of
    // the achievable score at shipped weights, permanently, no matter how well its keys matched. That is 39%
    // of the entries across the books on disk (820 of 2112), and it is most of a reference-heavy book:
    // Foxbridge 84%, Red Dead 85%, Time Whore 55%.
    //
    // ELIGIBILITY, NOT PRESENCE — the distinction is the whole design. A vectorized entry that failed to rank
    // on cosine is still divided by the vector weight, because it had the chance and lost; normalising by
    // signals PRESENT would instead reward it for missing one. A non-vectorized entry has no chunks to embed
    // or BM25, so it is divided by the keyword weight alone.
    //
    // Callers declare eligibility on the item (`vectorEligible`, `keysEligible`) because only they know it:
    // `vectorized` is the entry's, and whether keys are scorable depends on the scan
    // resolution the caller has already done. Absent flags fall back to presence, which keeps a caller that
    // sets neither self-consistent rather than silently capping everything it ranks.
    // ELIGIBILITY, one predicate per signal, each naming the question it answers. The denominator below
    // divides by the signals an entry could have earned, so an entry with one shot at scoring is not
    // ranked against one with three as though it had lost the other two.
    //
    // textEligible no longer consults the vector collection. Every entry with content is in the
    // content-lexical index (content-lexical.mjs), so the honest test is whether the caller found a text
    // score for it — declared through `textEligible` on the item, since only the caller knows whether an
    // index was available at all. A plugin-less run with no index falls back to presence, which keeps the
    // old behaviour rather than declaring everything eligible for a signal nothing computed.
    const vectorEligible = it => inVectorIndex(it);
    const textEligible = it => (it.textEligible ?? it.textScore !== undefined);
    const keyEligible = it => it.keysEligible ?? it.keywordScore > 0;
    // Same rule as text: eligible means the caller could have produced a score for it, declared explicitly
    // because only the caller knows whether the sparse index covered this entry.
    const sparseEligible = it => sparseWeight > 0 && (it.sparseEligible ?? it.sparseScore !== undefined);
    // The tie-break itself is documented at KEYWORD_ONLY_TILT above, where it can be injected.
    const keywordOnly = it => keyEligible(it) && !inVectorIndex(it);

    for (const item of items) {
        item.vectorRank = byVector.get(item.key);
        item.textRank = byText.get(item.key);
        item.keywordRank = byKeyword.get(item.key);
        item.sparseRank = bySparse.get(item.key);
        item.orderRank = byOrder.get(item.key);
        const raw = (item.vectorRank ? 1 / (k + item.vectorRank) : 0)
            + (item.textRank ? lexicalWeight / (k + item.textRank) : 0)
            + (item.keywordRank ? keyW / (k + item.keywordRank) : 0)
            + (item.sparseRank ? sparseWeight / (k + item.sparseRank) : 0)
            + (item.orderRank ? 1 / (k + item.orderRank) : 0);
        const eligible = (vectorEligible(item) ? 1 : 0)
            + (textEligible(item) ? lexicalWeight : 0)
            + (keyEligible(item) ? keyW : 0)
            + (sparseEligible(item) ? sparseWeight : 0)
            + (weightByOrder ? 1 : 0);
        item.fused = eligible > 0 ? raw / eligible : 0;
        if (keywordOnly(item)) item.fused *= keywordOnlyTilt;
    }
}
