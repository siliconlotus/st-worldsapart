// relevance.mjs — stage 4's per-entry relevance prediction: the two features the fitted model needs
// that nothing else in the pipeline computes, and the consumer that turns a fitted model file into one
// number per entry.
//
// Stage 4's relevance cut needs a per-entry prediction: each entry gets `E[credit]` and ships if it
// clears the cutoff, so "how many entries does this scene need" falls out of the prediction rather than
// taking a parameter of its own (matcher-design.md, *Stage 4*).
//
// The target is expected gradeCredit, not P(>=3): the score's precision numerator is a sum of credits —
// a delivered 2 scores half — so the quantity to threshold is `E[credit] = 0.5*P(>=2) + 0.5*P(>=3)`.
// That is why a fitted model file carries two coefficient vectors, fitted separately because
// proportional odds measurably does not hold here (F29).
//
// ST-free and node-importable, like the rest of the pure half — the model file is data, the settings and
// the entries are the caller's.
import { normalizeOrthography } from '../plugin/automaton.mjs';
import { entryKey } from './content-lexical.mjs';
import { tokenize } from './lexical.mjs';
import { COMMON_WORDS } from '../plugin/commonwords.js';

/**
 * Which tier an entry belongs to — provenance, not kind. `memory` is STMB-marked, `reference` is
 * everything that is not.
 *
 * It lives here because the tier decides which fit applies: the tiers do not carry the same signals —
 * memory is nearly all vectorized where reference is mostly keyword-only (F18) — and `density` inverts
 * between them, so a shared coefficient would carry the wrong sign.
 */
export const isMemory = e => Boolean(e) && ('stmemorybooks' in e || 'STMB_start' in e);

/**
 * Whether an entry post-dates a point in the chat — a summary of messages that have not happened yet.
 *
 * The boundary is the end, not the start: a summary exists once the messages it covers have happened, so
 * an entry spanning the point (`start <= at < end`) could not be in the book either. Those straddling
 * entries are the scene's own haystack paraphrased, and rank at the top of their scenes far more often
 * than clean positives do (F28).
 *
 * A missing range reads as available, which is right for a reference sheet and wrong for a memory entry
 * that lost the field — the check is inert on exactly those, and cannot tell the two apart.
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

/** Words that live inside a constructed proper noun — "Church of the Sun", "van der Berg", "War and
 *  Peace" — genitive and article particles plus `and`. The authoritative list; the harness's prose-side
 *  span arm derives from it minus `and`, which in running text joins two entities rather than living
 *  inside one. A key is different: its author chose the span, so `and` is part of the name.
 *  ponytail: prepositional titles ("Nightmare on Elm Street") still read as fragments; widen when a
 *  real key hits it. */
export const NAME_PARTICLES = new Set(['of', 'the', 'and', 'de', 'del', 'della', 'di', 'da', 'van', 'von', 'der', 'den', 'du', 'la', 'le', 'el', 'bin', 'ibn']);

/**
 * A line that is entirely a label — an ATX heading, a `**Bold:**` field name, or a bare `Label:` — with
 * nothing after it.
 *
 * Its tokens are layout, not spelling, and the sentence-position rule cannot see that: a label alone on
 * a line makes its first word position 0 and every later word a mid-sentence capital (C9).
 *
 * Only when the label is the whole line. A label with content after it is already correct and must not
 * be touched: `**Location:** Big Sur` works because `Location` absorbs position 0, and stripping the
 * line would take `Sur` with it.
 */
const LABEL_ONLY = /^(?:#{1,6}\s+\S.*|\*\*[^*]+:?\*\*|\p{Lu}[\p{L}' ]{0,30}:)$/u;

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
 * scan window with it. A second regex elsewhere is the drift this exists to prevent.
 *
 * Orthography is the caller's: buildTermWeights normalises once and hands the result to both loops, and
 * a caller comparing two texts must normalise both the same way or the sets cannot intersect.
 */
export function properNounsOf(text) {
    const out = new Set();
    for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+|\n+/)) {
        if (LABEL_ONLY.test(sentence.trim())) continue;
        const tokens = sentence.trim().split(/[^\p{L}\p{N}\p{M}']+/u).filter(x => x.length > 1);
        for (let i = 1; i < tokens.length; i++) {
            if (/^\p{Lu}/u.test(tokens[i])) out.add(tokens[i].toLowerCase());
        }
    }
    return out;
}

/**
 * The names a text uses, as the relevance model counts them.
 *
 * `properNounsOf` decides what a name is — capitalisation somewhere that is not sentence-initial — and
 * this adds the two rules about which names are worth counting: orthography is normalised first so a
 * curly apostrophe and a straight one are one name, and common English words are dropped so a
 * sentence-initial "Then" that also appears mid-sentence cannot join.
 *
 * One function rather than a convention, because both sides must be normalised the same way or the sets
 * cannot intersect.
 */
export function properNames(text) {
    const out = properNounsOf(normalizeOrthography(String(text ?? '')));
    for (const w of [...out]) if (COMMON_WORDS.has(w)) out.delete(w);
    return out;
}

/**
 * The key a fitted relevance model is stored and recalled under: the served model id, normalised.
 *
 * Not the eval-side label, which carries a server stem (`omlx:`, `lms:`) because two servers of the same
 * weights store different vectors — a distinction a collection must make and a fit need not, being
 * coefficients over signals standardised within scene. The runtime has no notion of a server at all
 * (`vectorRequestBody()` yields `{source, model}`), so keying on the label would make every fit
 * unfindable at runtime. The full label rides inside the fit as provenance.
 *
 * `:latest` goes because ollama appends it to an untagged pull, so the same model reads as `bge-m3` from
 * a spec and `bge-m3:latest` from the settings — one model, two keys, and a silent miss.
 */
export const modelKey = name => String(name ?? '').trim().toLowerCase().replace(/:latest$/, '');

/** The fit an embedding model with no fit of its own is scored through. NOT `noCosine`, which is for a
 *  turn with no cosine at all. Chosen for its cosine coefficient sitting low-middle of the seven (E13),
 *  so a refit that moves it invalidates the choice. */
export const UNFITTED_FALLBACK = 'mxbai-embed-large';

/**
 * The key to look a fit up under, from `vectorRequestBody()`'s `{source, model}`.
 *
 * The `transformers` source carries no model: ST resolves it server-side from config.yaml
 * (`extensions.models.embedding`, read at src/endpoints/vectors.js) and its Vector Storage UI offers no
 * way to choose one, so the source names the model. Without this the key is the empty string, no fit is
 * found, and every default install runs with no relevance model.
 *
 * The `transformers` literal is assumed, not read, so a hand-edited `extensions.models.embedding`
 * mis-resolves silently to jina's fit (upstream-st.md); no UI produces that state.
 */
export const fitKey = ({ source, model } = {}) =>
    modelKey(model || (source === 'transformers' ? 'Cohee/jina-embeddings-v2-base-en' : ''));

/**
 * How a model wants to be ASKED. Qwen3-Embedding and mxbai are trained with a task instruction on the
 * query and ollama's template is a bare `{{ .Prompt }}`, so applying it is the caller's job.
 *
 * A model is here only if its prefix is measured to earn one. bge-m3 and ST's default jina document
 * none; EmbeddingGemma documents a pair and applying it measured flat (E7), and its document half would
 * have to be rebuilt into every collection, so gemma has no entry.
 *
 * Keyed by family stem, matched as a substring anchored at neither end: the served id is whoever
 * packaged the model's spelling (`qwen3-embedding:4b`, `Qwen3-Embedding-8B-4bit-DWQ`,
 * `text-embedding-qwen3-embedding-8b`). Anchoring at either end drops the instruction from a model that
 * should have it, which does not fail — it quietly makes the model look worse than it is.
 *
 * Production behaviour that the evals verify, not a measurement setting; reindex.mjs imports this table
 * rather than keeping a second copy.
 */
export const PREFIXES = {
    'mxbai-embed-large': 'Represent this sentence for searching relevant passages: ',
    'qwen3-embedding': 'Instruct: Given a roleplay scene, retrieve lorebook entries relevant to it\nQuery: ',
};

/**
 * The prefix to put on a QUERY before it is embedded, or '' when there is none to apply.
 *
 * Every prefix WA applies is a query prefix, which is why this needs no counterpart for documents and
 * why turning one on costs no rebuild: a query prefix never reaches a stored vector.
 *
 * Qwen3-Embedding's instruction is measured to earn its place (E7), and is what the shipped coefficients
 * were fitted against, so not applying it serves a fit its own signal never produced.
 */
export const queryPrefix = (model) => {
    const fam = modelKey(model);
    return Object.entries(PREFIXES).find(([stem]) => fam.includes(stem))?.[1] ?? '';
};

/**
 * Document frequency of every name in a book, with the entry as the document.
 *
 * The corpus is the book, and `ndoc` counts entries — not chunks. The BM25 index this sits beside counts
 * chunks (`content-lexical` `docCount`), so reading one N for the other would rescale every idf.
 *
 * Disabled entries are included: df asks how distinctive a name is in the book's vocabulary, which a
 * disabled entry contributes to, where `buildContentIndex` excludes them because it asks what can be
 * retrieved. Excluding them here measurably costs, on most books (F27).
 *
 * An entry with no content is not a document: counting one raises `ndoc` while contributing no df, so it
 * inflates every name's idf.
 *
 * The per-entry name sets ride along because this walk already extracted them.
 *
 * @param {object[]} entries Every entry of one book
 * @returns {{df: Map<string, number>, ndoc: number, names: Map<string, Set<string>>}} keyed `world.uid`
 */
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
 * Not a reweighting of `text`: BM25 spreads its mass over every term the two share, so a character name
 * arrives diluted among hundreds of ordinary words, where restricting the vocabulary to names asks
 * whether this entry is about someone on screen.
 *
 * The idf weighting is what makes it work — it beats the unweighted count decisively, so a protagonist
 * named in every scene summary counts for almost nothing. Jaccard measured worse and restricting to the
 * gazetteer lost outright (F6).
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
 * A density, not a count — the count is length wearing another name. Entry-intrinsic, so it never reads
 * the query: it is a prior, and within-scene standardisation still works on it because it varies between
 * the entries of one scene.
 *
 * Memory tier only. It inverts on reference (F19), where an entry thick with names is a roster rather
 * than a subject, so a shared coefficient would carry the wrong sign.
 */
export function properDensity(content) {
    const text = String(content ?? '');
    const toks = tokenize(text);
    // properNounsOf directly, not properNames: the fits' density column counts every detected name with
    // no stoplist subtraction — that filter belongs to the overlap, where a common word must not match
    // across the two sets. The runtime computes the column the coefficients were trained on.
    return (properNounsOf(normalizeOrthography(text)).size / Math.max(1, toks.length)) * 100;
}

const sigmoid = x => 1 / (1 + Math.exp(-x));
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };

/**
 * `E[credit]` for every row of ONE scene, from a fitted model file.
 *
 * Standardised within the scene, as the fit was. The coefficients are per within-scene sd and mean
 * nothing against a raw value — BM25 is not comparable across queries or corpora, so a pooled scale
 * would let a scene's own spread masquerade as a coefficient. That is also why this takes the whole
 * scene at once: an entry has no standardised value by itself.
 *
 * A column constant within the scene standardises to 0, via `sd || 1` — the same guard the fit used, and
 * it must be the same one, or a signal carrying no information here would be divided by ~0 and meet a
 * slope fitted on other books.
 *
 * P(>=3) is clamped to P(>=2): the boundaries are fitted separately, so nothing guarantees the nesting
 * the events have, and `E[credit]` is malformed where they invert. Inversions are rare and tiny (F31),
 * which is why an unclamped one would read as a threshold effect rather than an incoherent pair.
 *
 * The population is a separate argument from the rows, because the two are not always the same set. A
 * fit emitted under `--standardise pooled` took its statistics from every candidate the scene offered,
 * both tiers, while fitting only its own tier's rows, so a consumer must standardise the same way or the
 * slopes meet a different unit. `model.standardise` says which; absent means `scene`, where the
 * population is the rows.
 *
 * Pooled exists because a tier holding two entries gives every z a value of exactly +/-1, erasing the
 * magnitudes before a coefficient sees them, and a tier holding one collapses to the intercept, which is
 * below every fitted cutoff and so can never ship — the state a new book is in. Measured flat on the
 * corpus of record, paired, at three cutoffs: it can say adopting this is free and not what it gains.
 *
 * @param {{features: string[], beta: {ge2: number[], ge3: number[]}}} model A fitted model file
 * @param {object[]} rows One scene's candidates, each carrying a raw value per `model.features`
 * @param {object[]} [population] The rows the mean and sd are taken over. Defaults to `rows`, which is
 *        what a `scene`-standardised fit wants; a `pooled` fit wants every candidate of the scene.
 * @returns {number[]} `E[credit]` per row, in the order given
 */
export function scoreRelevance(model, rows, population = rows) {
    const feats = model?.features ?? [];
    const { ge2, ge3 } = model?.beta ?? {};
    if (!rows?.length || !ge2?.length || !ge3?.length) return (rows ?? []).map(() => NaN);
    // Column order is the contract: [intercept, one standardised column per feature]. A model whose beta
    // is the wrong length is a file from another design, and scoring through it would return plausible
    // numbers rather than an error.
    if (ge2.length !== feats.length + 1 || ge3.length !== feats.length + 1) {
        throw new Error(`relevance model has ${feats.length} features but ${ge2.length}/${ge3.length} coefficients; expected ${feats.length + 1} of each`);
    }
    // The statistics come from the population and the columns from the rows — the same array under
    // `scene`; under `pooled` only the mean and sd come from the extra rows.
    const pop = population?.length ? population : rows;
    const z = feats.map(name => {
        const m = mean(pop.map(r => Number(r?.[name]) || 0));
        const s = sd(pop.map(r => Number(r?.[name]) || 0)) || 1;
        return rows.map(r => ((Number(r?.[name]) || 0) - m) / s);
    });
    return rows.map((_, i) => {
        const eta = beta => feats.reduce((a, _f, fi) => a + z[fi][i] * beta[fi + 1], beta[0]);
        const p2 = sigmoid(eta(ge2));
        const p3 = Math.min(sigmoid(eta(ge3)), p2);
        return 0.5 * p2 + 0.5 * p3;
    });
}
