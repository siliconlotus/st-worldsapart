// content-lexical.mjs — stage 3's text signal: BM25 over EVERY entry's content, chunked as syncWorld chunks.
// Scoring only, never admission; stage 1 never consults it.
import { buildLexical, bm25Scores, DEFAULT_K1, DEFAULT_B } from './lexical.mjs';
import { chunkEntry } from './chunking.mjs';

/** ST core's key format for an activated entry — `${world}.${uid}`, not our US-separated rowKey. */
export const entryKey = e => `${e.world}.${e.uid}`;

/** Chunks every enabled entry with content (chunkEntry, the split syncWorld uses) and indexes it; `keys[i]` is chunk i's entryKey. */
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

/** BM25 of one query, max-pooled to the best chunk per entry: entryKey -> score, absent when nothing matched. */
export function scoreContent(index, queryText, { k1 = DEFAULT_K1, b = DEFAULT_B, termWeights = null, stopwordDf = 0 } = {}) {
    const out = new Map();
    if (!index?.docCount) return out;
    const scores = bm25Scores(index.lexical, queryText, index.docCount, k1, b, termWeights, stopwordDf);
    for (let i = 0; i < scores.length; i++) {
        if (!(scores[i] > 0)) continue;
        const key = index.keys[i];
        const prev = out.get(key);
        if (prev === undefined || scores[i] > prev) out.set(key, scores[i]);
    }
    return out;
}

/** FNV-1a, 32-bit. `bookIndexes` fingerprints per scan, so the hash must be a cheap sum and never a cryptographic one. */
const fnv1a = s => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
};

export const indexFingerprint = (entries, { chunkMode, chunkSize, minChunkSize }) => {
    let n = 0, chars = 0, hash = 0;
    for (const e of entries ?? []) {
        if (e.disable || typeof e.content !== 'string' || !e.content.trim()) continue;
        n++; chars += e.content.length;
        // Sum, not XOR, with the uid folded in: a delete-and-grow edit and a book rename both move it, a reorder does not.
        hash = (hash + fnv1a(`${e.world}\u001f${e.uid}\u001f${e.content}`)) >>> 0;
    }
    return `${n}:${chars}:${hash.toString(16)}:${chunkMode}:${chunkSize}:${minChunkSize}`;
};
