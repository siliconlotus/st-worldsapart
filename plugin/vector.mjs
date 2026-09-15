// vector.mjs — L2 norm, corpus mean, and mean-centered cosine of a query against item vectors. Pure; shared by plugin, extension and harnesses.

export function norm(vector) { let sum = 0; for (const x of vector) sum += x * x; return Math.sqrt(sum); }

/** A usable vector: an array or typed array of positive length. A string has a length and is not one. */
export const rowDim = v => ((Array.isArray(v) || ArrayBuffer.isView(v)) && v.length ? v.length : 0);

/** Mean of every row sharing the first valid row's dimension; rows without a vector, empty, or of another dimension
 *  are skipped — one misshapen row must not NaN the whole corpus. An all-invalid input yields a zero-length mean. */
export function corpusMean(items) {
    let dim = -1, n = 0, mean = null;
    for (const it of items ?? []) {
        const d = rowDim(it?.vector);
        if (!d || (dim !== -1 && d !== dim)) continue;
        if (dim === -1) { dim = d; mean = new Float64Array(d); }
        n++;
        for (let i = 0; i < dim; i++) mean[i] += it.vector[i];
    }
    if (mean) for (let i = 0; i < dim; i++) mean[i] /= n;
    return mean ?? new Float64Array(0);
}

/** Cosine per item, query and items both centred on `mean` when `centered`; aligned with `items`. A row of another
 *  dimension scores 0, never NaN; a query of another dimension throws — that is the caller's (the provider's) failure. */
export function centeredCosineScores(items, queryVector, mean, centered = true) {
    const dim = mean.length;
    if (!dim) return new Float64Array(items?.length ?? 0);   // an empty corpus scores everything at 0, as an empty mean always has
    if (rowDim(queryVector) !== dim) {
        throw new Error(`vector.mjs: query has ${rowDim(queryVector) || 'no'} dimensions, the corpus has ${dim}`);
    }
    const q = new Float64Array(dim);
    for (let i = 0; i < dim; i++) q[i] = centered ? queryVector[i] - mean[i] : queryVector[i];
    const qNorm = norm(q);
    const scores = new Float64Array(items.length);
    items.forEach((item, docIndex) => {
        const v = item?.vector;
        if (rowDim(v) !== dim) { scores[docIndex] = 0; return; }
        let dot = 0, itemNorm = 0;
        for (let i = 0; i < dim; i++) { const c = centered ? v[i] - mean[i] : v[i]; dot += q[i] * c; itemNorm += c * c; }
        scores[docIndex] = dot / (qNorm * Math.sqrt(itemNorm) || 1);
    });
    return scores;
}
