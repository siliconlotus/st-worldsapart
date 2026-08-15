// content-lexical.mjs — BM25 over EVERY entry's content, not just the vectorized ones.
//
// WHAT IT FIXES. Only vectorized entries reach the vector collection (syncWorld admits
// `vectorized && !disable && content`), and the plugin builds its BM25 index over exactly those chunks.
// So a keyword entry earned `keywordScore` — BM25 over its authored KEYS against the scan window — and
// nothing else, while a vectorized entry earned three signals. fuseRanks equalises the CEILING between
// the two classes but not the evidence behind the estimate, so one noisy signal decided where a keyword
// entry landed. This gives it a second.
//
// THE ORIENTATIONS ARE OPPOSITE AND BOTH ARE WANTED. keywordScore treats the entry's keys as the query
// and the chat as the document; this treats the entry's CONTENT as the document and the query as the
// query, which is what the vector signal already does. They answer different questions, so an entry
// scoring on both is not double-counting one thing.
//
// SCORING ONLY, NEVER ADMISSION. Nothing here may activate an entry. If content-lexical also admitted,
// any lexical overlap would surface any entry in the book and bypass the author's key declarations —
// keys are the activation route and stay it. Structurally enforced by WHERE this is called rather than
// by a flag: it runs at stage 3 over entries that are already activated, and stage 1 never consults it.
//
// ONE INDEX FOR BOTH CLASSES, which is the part that cannot be skipped. BM25 is IDF-weighted, so a score
// only means something relative to the corpus its statistics came from. Scoring keyword entries against
// their own index and vectorized entries against the plugin's would merge two scales into one rank list
// and report the seam as a parameter effect — the same failure the single-gazetteer rule exists to
// prevent. So this index covers every entry with content and is the source for every stage-3 text score.
//
// It also means "common" is no longer defined by the memory entries alone, which moves every BM25 figure
// measured on a vectorized-only corpus (bm25K1, bm25B, lexicalWeight, stopwordDocFreq's 25% bar).
import { buildLexical, bm25Scores, DEFAULT_K1, DEFAULT_B } from '../plugin/lexical.mjs';
import { chunkEntry } from './chunking.mjs';

/** ST core's key format for an activated entry — `${world}.${uid}`, not our US-separated rowKey. */
export const entryKey = e => `${e.world}.${e.uid}`;

/**
 * Chunks every entry with content and indexes it.
 *
 * CHUNKED THE SAME WAY syncWorld CHUNKS, so a vectorized entry's documents here are the documents the
 * vector collection holds. A different split would give the two classes different length normalisation
 * (BM25's `b` term divides by average document length) and quietly favour whichever was chopped finer.
 *
 * Disabled entries are excluded: core never activates one, so a score for it could only ever mislead a
 * reader of the index, and its tokens would still move every other entry's IDF.
 *
 * @param {object[]} entries Live entries, each with `world`, `uid`, `content`, `disable`
 * @param {{chunkMode: string, chunkSize: number, minChunkSize: number}} chunkCfg
 * @returns {{lexical: object, keys: string[], docCount: number, entryCount: number}}
 */
export function buildContentIndex(entries, chunkCfg) {
    const items = [];
    const keys = [];
    for (const entry of entries ?? []) {
        if (entry.disable || typeof entry.content !== 'string' || !entry.content.trim()) continue;
        const key = entryKey(entry);
        for (const chunk of chunkEntry(entry.content, chunkCfg)) {
            const text = chunk.trim();
            if (!text) continue;
            items.push({ metadata: { text } });
            keys.push(key);
        }
    }
    return { lexical: buildLexical(items), keys, docCount: items.length, entryCount: new Set(keys).size };
}

/**
 * BM25 of one query against the index, pooled to the best chunk per entry.
 *
 * MAX, not sum — the same pooling the vector path applies (`poolEntries` keeps an entry's best chunk).
 * Summing would make a long entry outscore a sharper short one for having more places to match, which is
 * the length bias `b` already exists to control.
 *
 * @returns {Map<string, number>} `${world}.${uid}` -> best chunk score. Absent when nothing matched.
 */
export function scoreContent(index, queryText, { k1 = DEFAULT_K1, b = DEFAULT_B, termWeights = null, stopwordDf = 0, commonWordWeight = 1 } = {}) {
    const out = new Map();
    if (!index?.docCount) return out;
    const scores = bm25Scores(index.lexical, queryText, index.docCount, k1, b, termWeights, stopwordDf, commonWordWeight);
    for (let i = 0; i < scores.length; i++) {
        if (!(scores[i] > 0)) continue;
        const key = index.keys[i];
        const prev = out.get(key);
        if (prev === undefined || scores[i] > prev) out.set(key, scores[i]);
    }
    return out;
}

/**
 * Cheap fingerprint of what the index was built from. Rebuilding on every generation would re-tokenize
 * the whole book each turn; trusting a cache forever would keep answering after an edit. Entry count,
 * total content length and the chunk settings move on every change that alters a document — an edit that
 * preserves length exactly is the one case it misses, and that costs a stale score rather than a wrong
 * activation, since nothing here admits.
 */
export const indexFingerprint = (entries, { chunkMode, chunkSize, minChunkSize }) => {
    let n = 0, chars = 0;
    for (const e of entries ?? []) {
        if (e.disable || typeof e.content !== 'string' || !e.content.trim()) continue;
        n++; chars += e.content.length;
    }
    return `${n}:${chars}:${chunkMode}:${chunkSize}:${minChunkSize}`;
};
