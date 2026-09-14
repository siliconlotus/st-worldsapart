// scoring.mjs — stage 1: mean-centered cosine over a collection's chunks, pooled to entries, bounded.
// Cosine only, with no admission test: above admitCeiling the overflow is cosine-only.
import { centeredCosineScores } from './vector.mjs';

export function scoreCollection(collectionId, loaded, queryVector, { centered = true } = {}) {
    const { items, mean } = loaded;
    const vectorScores = centeredCosineScores(items, queryVector, mean, centered);
    return items.map((item, docIndex) => ({ collectionId, score: vectorScores[docIndex], metadata: item.metadata }));
}

export function poolEntries(results) {
    const best = new Map();
    for (const r of results) {
        // metadata.index is the owning entry's uid (syncWorld); US-separated; a chunk with no owner pools as its own entry. Pooled here, not on the client, so topK counts entries (R6).
        const key = `${r.collectionId}${r.metadata?.index ?? `#${r.metadata?.hash}`}`;
        const previous = best.get(key);
        if (!previous || r.score > previous.score) best.set(key, { ...r });
    }
    return [...best.values()];
}

/** topK to request: 1000 entries when the store pooled, else 10000 chunks (~10 chunks/entry, R5); unknown resolves to the chunk ceiling. */
export const admitCeiling = pooledServerSide => (pooledServerSide === true ? 1000 : 10000);

export function selectTopK(results, topK) {
    const byVector = [...results].sort((a, b) => b.score - a.score).slice(0, topK);
    const grouped = {}, emitted = new Set();
    for (const r of byVector) {
        const key = `${r.collectionId}:${r.metadata.hash}`;
        if (emitted.has(key)) continue; emitted.add(key);
        grouped[r.collectionId] ??= { hashes: [], metadata: [] };
        grouped[r.collectionId].hashes.push(Number(r.metadata.hash));
        grouped[r.collectionId].metadata.push({ ...r.metadata, score: r.score });
    }
    return grouped;
}
