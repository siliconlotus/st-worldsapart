// vector.mjs — vector similarity: L2 norm, the corpus mean (for mean-centering), and mean-centered
// cosine of a query against a collection's item vectors. Pure and isomorphic (no DOM/fs/vectra), shared
// by the server plugin, the extension, and the offline harnesses.

export function norm(vector) { let sum = 0; for (const x of vector) sum += x * x; return Math.sqrt(sum); }

/** Mean vector of a collection's items — the corpus centroid mean-centering subtracts. */
export function corpusMean(items) {
    const dim = items[0].vector.length;
    const mean = new Float64Array(dim);
    for (const it of items) for (let i = 0; i < dim; i++) mean[i] += it.vector[i];
    for (let i = 0; i < dim; i++) mean[i] /= items.length;
    return mean;
}

/**
 * Per-item cosine of the query against each item vector, both optionally mean-centered (subtract the
 * corpus mean before comparing — removes the large shared direction that otherwise compresses a
 * single-corpus's similarities into a narrow band). Returns a Float64Array aligned with `items`.
 */
export function centeredCosineScores(items, queryVector, mean, centered = true) {
    const dim = mean.length;
    const q = new Float64Array(dim);
    for (let i = 0; i < dim; i++) q[i] = centered ? queryVector[i] - mean[i] : queryVector[i];
    const qNorm = norm(q);
    const scores = new Float64Array(items.length);
    items.forEach((item, docIndex) => {
        let dot = 0, itemNorm = 0;
        for (let i = 0; i < dim; i++) { const v = centered ? item.vector[i] - mean[i] : item.vector[i]; dot += q[i] * v; itemNorm += v * v; }
        scores[docIndex] = dot / (qNorm * Math.sqrt(itemNorm) || 1);
    });
    return scores;
}
