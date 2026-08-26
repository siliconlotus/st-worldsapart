// relevance.mjs — stage 4's per-entry relevance prediction: the two features the fitted model needs
// that nothing else in the pipeline computes, and the consumer that turns a fitted model file into one
// number per entry.
//
// WHAT THIS IS FOR. Stage 4 has two cuts (entry maxes, token budget) and no relevance decision, so the
// delivered set is everything activated and the score of record is invariant to every layout parameter
// (matcher-design.md, *Evidence → Two scores*). This is the missing decision: each entry gets
// `E[credit]` and ships if it clears the tier's cutoff, so "how many entries does this scene need" falls
// out of the prediction rather than taking a parameter of its own.
//
// THE TARGET IS EXPECTED gradeCredit, NOT P(>=3). The layout score's precision numerator is a sum of
// credits — a delivered 2 scores half — so the quantity to threshold is the one that sum is built from:
// `E[credit] = 0.5*P(>=2) + 0.5*P(>=3)`. That is why a fitted model file carries TWO coefficient vectors.
// The boundaries are fitted separately because proportional odds does not hold here (measured: cosine
// runs +0.682, +0.625, +0.468, +0.901 across the four boundaries), so neither vector derives from the
// other.
//
// ST-FREE AND NODE-IMPORTABLE, like the rest of the pure half — the model file is data, the settings and
// the entries are the caller's. `worldsapart.js` wires it; nothing here reads a global.
import { properNounsOf } from './ranking.mjs';
import { normalizeOrthography } from '../plugin/automaton.mjs';
import { entryKey } from './content-lexical.mjs';
import { tokenize } from './lexical.mjs';
import { COMMON_WORDS } from '../plugin/commonwords.js';

/**
 * Which TIER an entry belongs to — provenance, not kind. `memory` is STMB-marked, `reference` is
 * everything that is not.
 *
 * IT LIVES HERE BECAUSE THE TIER DECIDES WHICH FIT APPLIES. The tiers do not carry the same signals
 * (99.8% of memory rows are vectorized against 84% of reference rows keyword-only) and `density`
 * INVERTS between them, so a shared coefficient would carry the wrong sign — the model is per tier, and
 * the predicate that selects one is part of reading it. It was defined in the harness alone, which is
 * one copy short of what the runtime now needs.
 */
export const isMemory = e => Boolean(e) && ('stmemorybooks' in e || 'STMB_start' in e);

/**
 * Whether an entry POST-DATES a point in the chat — a summary of messages that have not happened yet.
 *
 * THE BOUNDARY IS THE END, NOT THE START. A summary exists once the messages it covers have happened, so
 * an entry spanning the point (`start <= at < end`) could not be in the book either, and a start-only
 * test keeps every one of them. Measured on the graded corpus, those straddling entries are the scene's
 * own haystack paraphrased: 66 of 446 memory positives, within-scene z 2.795 against clean positives'
 * 0.800, ranking FIRST in 53% of their scenes against 7%.
 *
 * A MISSING RANGE READS AS AVAILABLE, which is right for a reference sheet and wrong for a memory entry
 * that lost the field — the check is silently inert on exactly those, and cannot tell the two apart.
 *
 * Shared so the harness's `dropUnavailable` and the runtime's setting cannot drift on what "not yet
 * written" means.
 */
export const postDates = (entry, at) => {
    if (!Number.isFinite(at)) return false;
    const end = Number(entry?.STMB_end);
    if (Number.isFinite(end)) return end >= at;
    const start = Number(entry?.STMB_start);
    return Number.isFinite(start) && start > at;
};

/**
 * The names a text uses, as the relevance model counts them.
 *
 * `ranking.properNounsOf` decides what a name IS — capitalisation somewhere that is not sentence-initial
 * — and this adds the two rules that are about which names are worth COUNTING: orthography is normalised
 * first so a curly apostrophe and a straight one are one name, and common English words are dropped so a
 * sentence-initial "Then" that also appears mid-sentence cannot join.
 *
 * NORMALISE BOTH SIDES OR THE SETS CANNOT INTERSECT, which is why this is one function rather than a
 * convention. The entry and the scan window are compared as sets of these strings.
 */
export function properNames(text) {
    const out = properNounsOf(normalizeOrthography(String(text ?? '')));
    for (const w of [...out]) if (COMMON_WORDS.has(w)) out.delete(w);
    return out;
}

/**
 * Document frequency of every name in a book, with the ENTRY as the document.
 *
 * THE CORPUS IS THE BOOK, and `ndoc` counts ENTRIES — not chunks. The BM25 index this sits beside counts
 * chunks (`content-lexical` `docCount`), so the two Ns are different numbers over the same walk; reading
 * one for the other would silently rescale every idf.
 *
 * DISABLED ENTRIES ARE INCLUDED. df asks how distinctive a name is in the book's vocabulary, which a
 * disabled entry still contributes to — where `buildContentIndex` excludes them because it is asking
 * what can be RETRIEVED. Measured, memory tier held out by book: excluding them costs F2 0.5160 -> 0.5105
 * and loses on 4 books of 5 (matcher-design.md, *Stage 4 predicts per-entry relevance*).
 *
 * AN ENTRY WITH NO CONTENT IS NOT A DOCUMENT, which is the separate question: counting one raises `ndoc`
 * while contributing no df, so it inflates every name's idf by pretending the corpus is larger than the
 * text in it.
 *
 * The per-entry name sets ride along because this walk already extracted them, and the caller needs
 * exactly those to score against the window.
 *
 * @param {object[]} entries Every entry of ONE book
 * @returns {{df: Map<string, number>, ndoc: number, names: Map<string, Set<string>>}} keyed `world.uid`
 */
/**
 * The key a fitted relevance model is stored and recalled under: the SERVED MODEL ID, normalised.
 *
 * NOT the eval-side label. That carries a server stem (`omlx:`, `lms:`) because two servers of the same
 * weights store different vectors, which a COLLECTION must distinguish — it compares stored vectors
 * against a query bit for bit. A FIT is coefficients over signals standardised within scene, far less
 * sensitive to that, and the runtime has no notion of a server at all: `vectorRequestBody()` yields
 * `{source, model}`. Keying on the label would make every fit unfindable at runtime, which is the one
 * thing the key exists to prevent. The full label rides inside the fit as provenance instead.
 *
 * `:latest` goes because ollama appends it to an untagged pull, so the same model reads as `bge-m3` from
 * a spec and `bge-m3:latest` from the settings — one model, two keys, and a silent miss.
 */
export const modelKey = name => String(name ?? '').trim().toLowerCase().replace(/:latest$/, '');

/**
 * How a model wants to be ASKED. Qwen3-Embedding and mxbai are trained with a task instruction on the
 * query and ollama's template is a bare `{{ .Prompt }}`, so applying it is the caller's job.
 *
 * A MODEL IS HERE ONLY IF ITS PREFIX IS MEASURED TO EARN ONE. bge-m3 and ST's default jina document none.
 * EmbeddingGemma documents a pair — an instruction on the query and `title: none | text: ` on every
 * document — and **measured** (5585 rows, 99 scenes, memory tier, leave-one-book-out) applying the pair
 * against applying neither is flat: 0.7976 vs 0.7982 held-out AUC. Flat is not a reason to carry a
 * special case, and the document half would additionally have to be rebuilt into every collection, so
 * gemma has no entry.
 *
 * KEYED BY FAMILY STEM, matched as a substring at neither end: the served id is whoever packaged the
 * model's spelling — `qwen3-embedding:4b` from ollama, `Qwen3-Embedding-8B-4bit-DWQ` from oMLX,
 * `text-embedding-qwen3-embedding-8b` from LM Studio, which prepends its own type tag. Anchoring the match
 * at either end drops the instruction from a model that should have it, and that does not fail — it
 * quietly makes the model look worse than it is. It has bitten at both ends, hence neither.
 *
 * Lives here rather than in eval/ because it is PRODUCTION behaviour that the evals verify, not a
 * measurement setting; reindex.mjs imports this table rather than keeping a second copy of it.
 */
export const PREFIXES = {
    'mxbai-embed-large': 'Represent this sentence for searching relevant passages: ',
    'qwen3-embedding': 'Instruct: Given a roleplay scene, retrieve lorebook entries relevant to it\nQuery: ',
};

/**
 * The prefix to put on a QUERY before it is embedded, or '' when there is none to apply.
 *
 * EVERY PREFIX WA APPLIES IS A QUERY PREFIX, which is why this needs no counterpart for documents and why
 * turning one on costs no rebuild: a query prefix never reaches a stored vector.
 *
 * **Measured** (5585 rows, 99 scenes, memory tier, leave-one-book-out, same collections so only the query
 * vector moves): applying Qwen3-Embedding-8B's instruction is worth +0.0131 held-out AUC and +0.0235 F2 at
 * its best cutoff, on 4 of 5 books. It is also what the shipped coefficients were fitted against, so
 * NOT applying it served a fit its own signal never produced.
 */
export const queryPrefix = (model) => {
    const fam = modelKey(model);
    return Object.entries(PREFIXES).find(([stem]) => fam.includes(stem))?.[1] ?? '';
};

export function buildNameDf(entries) {
    const df = new Map();
    const names = new Map();
    let ndoc = 0;
    for (const entry of entries ?? []) {
        if (typeof entry?.content !== 'string' || !entry.content.trim()) continue;
        ndoc++;
        const found = properNames(entry.content);
        names.set(entryKey(entry), found);
        for (const w of found) df.set(w, (df.get(w) ?? 0) + 1);
    }
    return { df, ndoc, names };
}

/**
 * The `properNouns` signal: idf-weighted count of names an entry shares with the scan window.
 *
 * NOT A REWEIGHTING OF `text`. BM25 spreads its mass over every term the two share, so a character name
 * arrives diluted among hundreds of ordinary words; restricting the vocabulary to names asks whether
 * this entry is about someone who is ON SCREEN, which is the axis the three older signals do not have.
 *
 * THE WEIGHTING IS WHAT MAKES IT WORK — measured against the unweighted count, 45 scenes up against 14,
 * p 0.0001 — so a protagonist named in every scene summary counts for almost nothing. Jaccard measured
 * worse and restricting to the gazetteer lost outright, so it is neither the normalisation nor the
 * vocabulary restriction that matters.
 */
export function properShared(entryNames, windowNames, { df, ndoc }) {
    let v = 0;
    for (const w of entryNames ?? []) {
        if (!windowNames?.has(w)) continue;
        v += Math.log((ndoc + 1) / ((df.get(w) ?? 0) + 1));
    }
    return v;
}

/**
 * The `density` signal: names per 100 tokens of the entry.
 *
 * A DENSITY, NOT A COUNT — the count is length wearing another name, and the two would be one column.
 * Entry-intrinsic, so it never reads the query: it is a prior, and within-scene standardisation still
 * works on it because it varies between the entries of one scene.
 *
 * MEMORY TIER ONLY. Measured, this INVERTS on reference (-0.935 against +0.215), where an entry thick
 * with names is a roster rather than a subject — so a shared coefficient would carry the wrong sign.
 */
export function properDensity(content) {
    const text = String(content ?? '');
    const toks = tokenize(text);
    return (properNames(text).size / Math.max(1, toks.length)) * 100;
}

const sigmoid = x => 1 / (1 + Math.exp(-x));
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };

/**
 * `E[credit]` for every row of ONE scene, from a fitted model file.
 *
 * STANDARDISED WITHIN THE SCENE, as the fit was. The coefficients are per within-scene sd and mean
 * nothing against a raw value — BM25 is not comparable across queries or corpora, so a pooled scale
 * would let a scene's own spread masquerade as a coefficient. That is also why this takes the whole
 * scene at once rather than scoring an entry alone: an entry has no standardised value by itself.
 *
 * A COLUMN CONSTANT WITHIN THE SCENE STANDARDISES TO 0, via `sd || 1` — the same guard the fit used, and
 * it has to be the same one or a signal that carries no information here would be divided by ~0 and meet
 * a slope fitted on other books.
 *
 * P(>=3) IS CLAMPED TO P(>=2). The boundaries are fitted separately, so nothing guarantees the nesting
 * the events have, and `E[credit]` is malformed where they invert. Measured: 39 of 8975 rows invert, by
 * at most 0.0002 — trivial in size, which is exactly why leaving it out would read as a threshold effect
 * rather than as the incoherent probability pair it is.
 *
 * @param {{features: string[], beta: {ge2: number[], ge3: number[]}}} model A fitted model file
 * @param {object[]} rows One scene's candidates, each carrying a raw value per `model.features`
 * @returns {number[]} `E[credit]` per row, in the order given
 */
export function scoreRelevance(model, rows) {
    const feats = model?.features ?? [];
    const { ge2, ge3 } = model?.beta ?? {};
    if (!rows?.length || !ge2?.length || !ge3?.length) return (rows ?? []).map(() => NaN);
    // COLUMN ORDER IS THE CONTRACT: [intercept, one standardised column per feature]. A model whose beta
    // is the wrong length is a file from another design, and scoring through it would return plausible
    // numbers rather than an error — the one failure mode here that produces a result.
    if (ge2.length !== feats.length + 1 || ge3.length !== feats.length + 1) {
        throw new Error(`relevance model has ${feats.length} features but ${ge2.length}/${ge3.length} coefficients; expected ${feats.length + 1} of each`);
    }
    const z = feats.map(name => {
        const col = rows.map(r => Number(r?.[name]) || 0);
        const m = mean(col), s = sd(col) || 1;
        return col.map(x => (x - m) / s);
    });
    return rows.map((_, i) => {
        const eta = beta => feats.reduce((a, _f, fi) => a + z[fi][i] * beta[fi + 1], beta[0]);
        const p2 = sigmoid(eta(ge2));
        const p3 = Math.min(sigmoid(eta(ge3)), p2);
        return 0.5 * p2 + 0.5 * p3;
    });
}
