// relevance.mjs — stage 4's per-entry relevance prediction: the two features nothing else in the pipeline
// computes, and the consumer that turns a fitted model file into E[credit] per entry. ST-free.
import { normalizeOrthography } from '../plugin/automaton.mjs';
import { entryKey } from './content-lexical.mjs';
import { tokenize } from './lexical.mjs';
import { COMMON_WORDS } from '../plugin/commonwords.js';

export const isMemory = e => Boolean(e) && ('stmemorybooks' in e || 'STMB_start' in e);

export const postDates = (entry, at) => {
    if (!Number.isFinite(at)) return false;
    const end = Number(entry?.STMB_end);
    if (Number.isFinite(end)) return end >= at;
    const start = Number(entry?.STMB_start);
    return Number.isFinite(start) && start > at;
};

/** Words that live inside a constructed proper noun; the harness's span arm derives from it minus `and`. */
export const NAME_PARTICLES = new Set(['of', 'the', 'and', 'de', 'del', 'della', 'di', 'da', 'van', 'von', 'der', 'den', 'du', 'la', 'le', 'el', 'bin', 'ibn']);

/** A line that is entirely a label (ATX heading, `**Bold:**` field, bare `Label:`). The whole line only: `**Location:** Big Sur` must not match, or `Sur` goes with `Location`. */
const LABEL_ONLY = /^(?:#{1,6}\s+\S.*|\*\*[^*]+:?\*\*|\p{Lu}[\p{L}' ]{0,30}:)$/u;

/** The lowercased tokens a text uses as names: capitalised somewhere that is not sentence-initial. `\p{Lu}`, never `[A-Z]`; the project's one definition of a name, and both sides of a comparison must be normalised the same way first. */
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

export function properNames(text) {
    const out = properNounsOf(normalizeOrthography(String(text ?? '')));
    for (const w of [...out]) if (COMMON_WORDS.has(w)) out.delete(w);
    return out;
}

export const modelKey = name => String(name ?? '').trim().toLowerCase().replace(/:latest$/, '');

/** The fit a model with no fit of its own is scored through. NOT `noCosine`, which is for a turn with no cosine at all (E13). */
export const UNFITTED_FALLBACK = 'mxbai-embed-large';

export const fitKey = ({ source, model } = {}) =>
    modelKey(model || (source === 'transformers' ? 'Cohee/jina-embeddings-v2-base-en' : ''));

/** Query instruction per model family (E7), keyed by stem and matched as an UNANCHORED substring: served ids vary in spelling, and anchoring silently drops the instruction. reindex.mjs imports this table. */
export const PREFIXES = {
    'mxbai-embed-large': 'Represent this sentence for searching relevant passages: ',
    'qwen3-embedding': 'Instruct: Given a roleplay scene, retrieve lorebook entries relevant to it\nQuery: ',
};

export const queryPrefix = (model) => {
    const fam = modelKey(model);
    return Object.entries(PREFIXES).find(([stem]) => fam.includes(stem))?.[1] ?? '';
};

/** Document frequency of every name in a book, entry as document: `ndoc` counts entries, never chunks (content-lexical's `docCount`); disabled entries count (F27); an entry with no content is not a document. `names` is keyed `world.uid`. */
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

export function properShared(entryNames, windowNames, { df, ndoc }) {
    let v = 0;
    for (const w of entryNames ?? []) {
        if (!windowNames?.has(w)) continue;
        v += Math.log((ndoc + 1) / ((df.get(w) ?? 0) + 1));
    }
    return v;
}

export function properDensity(content) {
    const text = String(content ?? '');
    const toks = tokenize(text);
    // properNounsOf, not properNames: the fitted density column has no stoplist subtraction.
    return (properNounsOf(normalizeOrthography(text)).size / Math.max(1, toks.length)) * 100;
}

const sigmoid = x => 1 / (1 + Math.exp(-x));
const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };

/** `E[credit]` per row of ONE scene, standardised over `population` — `rows` for a `scene` fit, every candidate of the scene for a `pooled` one (`model.standardise`). P(>=3) is clamped to P(>=2).
 *  @returns {number[]} in the order given, NaN when the model cannot score */
export function scoreRelevance(model, rows, population = rows) {
    const feats = model?.features ?? [];
    const { ge2, ge3 } = model?.beta ?? {};
    if (!rows?.length || !ge2?.length || !ge3?.length) return (rows ?? []).map(() => NaN);
    // Column order is the contract: [intercept, one standardised column per feature].
    if (ge2.length !== feats.length + 1 || ge3.length !== feats.length + 1) {
        throw new Error(`relevance model has ${feats.length} features but ${ge2.length}/${ge3.length} coefficients; expected ${feats.length + 1} of each`);
    }
    // `sd || 1` must be the fit's own guard, or a column constant here meets a slope fitted elsewhere.
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
