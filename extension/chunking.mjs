// chunking.mjs — how an entry's text is cut up before it is embedded. Pure and ST-free (settings are passed
// in), so the offline harness can reproduce an index instead of only reading one.
//
// WA owns this rather than importing ST's splitRecursive, for two reasons. It is unreachable offline —
// ST's utils.js is not node-importable — so every tool that wants to know how a book would be chunked
// would need a private copy, and a private copy drifts. And chunking determines the index: nothing about
// a vectra collection records the chunker that produced it, so an upstream edit would leave existing
// indexes full of old chunks with no banner and no way to notice. Owning the splitter makes the chunk
// format WA's own artefact, versioned with WA.
//
// The port is verbatim, and eval/chunking-check.mjs is the oracle: it re-chunks a graded sample's
// embedded books and compares against the `metadata.text` stored in the live index, clean across the
// live collections (P3). It doubles as a staleness detector.
//
// If you touch that check, mirror syncWorld's post-chunking steps or it will invent drift: syncWorld
// re-trims every chunk and drops blanks, and keys the collection by hash, so identical text across
// several entries is stored once (P3).

/**
 * ST's recursive text splitter, ported verbatim from public/scripts/utils.js.
 *
 * Splits on the first delimiter, recurses into any part still too long with the next delimiter down, then
 * greedily merges adjacent parts back together while they fit under `length`. The merge pass is why 'length'
 * mode produces chunks that span unrelated topics: it fills to capacity without regard for structure.
 *
 * Do not "improve" this: its output is baked into every existing vector index, so a change here silently
 * invalidates all of them.
 *
 * @param {string} input Text to split
 * @param {number} length Maximum chunk length
 * @param {string[]} [delimiters] Split hierarchy, coarsest first; '' means split between characters
 * @returns {string[]} Chunks
 */
export function splitRecursive(input, length, delimiters = ['\n\n', '\n', ' ', '']) {
    // Invalid length
    if (length <= 0) {
        return [input];
    }

    const delim = delimiters[0] ?? '';
    const parts = input.split(delim);

    const flatParts = parts.flatMap(p => {
        if (p.length < length) return p;
        return splitRecursive(p, length, delimiters.slice(1));
    });

    // Merge short chunks
    const result = [];
    let currentChunk = '';
    for (let i = 0; i < flatParts.length;) {
        currentChunk = flatParts[i];
        let j = i + 1;
        while (j < flatParts.length) {
            const nextChunk = flatParts[j];
            if (currentChunk.length + nextChunk.length + delim.length <= length) {
                currentChunk += delim + nextChunk;
            } else {
                break;
            }
            j++;
        }
        i = j;
        result.push(currentChunk);
    }
    return result;
}

/**
 * Splits entry text into chunks for matching.
 *
 * 'length' mode uses splitRecursive directly, which splits on paragraph breaks and then greedily merges
 * adjacent paragraphs back together to fill chunkSize — so a chunk routinely spans unrelated topics, and its
 * centroid represents none of them.
 *
 * 'paragraph' mode keeps one paragraph per chunk. Oversized paragraphs are split further; runs of very short
 * ones are joined so stray lines aren't embedded alone.
 *
 * minChunkSize is a merge floor, not a split threshold: a paragraph shorter than it is held and glued
 * onto the next one, so raising it yields fewer, larger chunks and nothing is ever split because of it.
 * Both ends cost something and neither has been measured:
 *
 *   high — a run of short paragraphs accumulates until the total crosses the floor, so the boundary lands
 *          wherever that happens rather than anywhere structural.
 *   low  — many tiny chunks. Two corpus-wide effects, both invisible per-entry: BM25's `avgdl` drops,
 *          re-weighting length normalisation for every chunk in the book, and entry pooling takes the max
 *          over an entry's chunks, so inflating chunk count hands long entries more chances at a high max
 *          (R25).
 *
 * @param {string} content Entry content
 * @param {object} opts Chunking settings (pass `settings()` — the field names match)
 * @param {'paragraph'|'length'} opts.chunkMode Chunking strategy
 * @param {number} opts.chunkSize Maximum chunk length
 * @param {number} opts.minChunkSize Merge floor
 * @returns {string[]} Chunks
 */
export function chunkEntry(content, { chunkMode, chunkSize, minChunkSize }) {
    const maxLength = chunkSize;

    if (chunkMode !== 'paragraph') {
        return splitRecursive(content, maxLength);
    }

    const paragraphs = content
        .split(/\n\s*\n/)
        .map(x => x.trim())
        .filter(x => x);

    const chunks = [];
    let pending = '';

    for (const paragraph of paragraphs) {
        const merged = pending ? `${pending}\n\n${paragraph}` : paragraph;

        // Hold on to fragments until they carry enough signal to embed on their own.
        if (merged.length < minChunkSize) {
            pending = merged;
            continue;
        }

        pending = '';

        if (merged.length <= maxLength) {
            chunks.push(merged);
        } else {
            const parts = splitRecursive(merged, maxLength, ['\n', '. ', ' ', '']);
            // The floor applies to split fragments too: splitRecursive packs greedily from the left, so
            // every run it emits ends in whatever did not fit, which leaks sub-floor chunks (R25). Those
            // enter the corpus mean every centred cosine subtracts, count toward BM25's document total,
            // and are arbitrary enough in direction to win an entry's max-pool.
            //
            // The tail carries into `pending` rather than being glued on here, because that is the
            // faithful join: the tail ends a paragraph, so what follows it in the source is a blank line
            // and the next paragraph — what the loop's `\n\n` merge reconstructs.
            const tail = parts[parts.length - 1];
            if (parts.length > 1 && tail.length < minChunkSize) {
                parts.pop();
                pending = tail;
            }
            chunks.push(...parts);
        }
    }

    if (pending) {
        // Nothing follows it, so the only join left is backwards. Onto the previous chunk when it fits,
        // with the blank line that separated them; alone otherwise, since dropping content is worse than
        // a short chunk.
        const previous = chunks[chunks.length - 1];
        if (pending.length < minChunkSize && previous && previous.length + pending.length + 2 <= maxLength) {
            chunks[chunks.length - 1] = `${previous}\n\n${pending}`;
        } else {
            chunks.push(pending);
        }
    }

    return chunks;
}
