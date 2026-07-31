// chunking.mjs — how an entry's text is cut up before it is embedded. Pure and ST-free (settings are passed
// in), so the offline harness can reproduce an index instead of only reading one.
//
// WHY WA OWNS THIS INSTEAD OF IMPORTING ST's splitRecursive.
//
// Two reasons, and the second is the one that bites.
//
// 1. It is unreachable offline. `splitRecursive` lives in ST's utils.js, which is not node-importable — its
//    import graph resolves browser-absolute paths. So every tool that wants to know how a book WOULD be
//    chunked (the reindexer, any sweep of chunkSize/chunkMode/minChunkSize) either can't exist or has to
//    keep a private copy, and a private copy is a copy that drifts.
//
// 2. CHUNKING DETERMINES THE INDEX, so an upstream change to it silently invalidates every stored vector.
//    Nothing about a vectra collection records the chunker that produced it. If ST edits splitRecursive in a
//    release, WA's existing indexes are still full of the OLD chunks while the new code chunks differently —
//    a query is then matched against text that no longer corresponds to how the book would be cut today,
//    with no banner, no version bump and no way to notice. Owning the splitter makes the chunk format WA's
//    own artefact, versioned with WA.
//
// The port is verbatim, and its exactness is not taken on trust: eval/chunking-check.mjs re-chunks a graded
// sample's embedded books and compares against the `metadata.text` actually stored in the live index — a
// real-data oracle for byte-identity, currently clean across three collections (983 + 640 + 1049 chunks).
// It doubles as a staleness detector, since a book edited after it was vectorized stops reproducing what is
// stored.
//
// If you touch that check, mirror syncWorld's POST-chunking steps or it will invent drift that isn't there.
// It re-trims every chunk and drops blanks (splitRecursive splitting on '. ' leaves edge whitespace), and it
// keys the collection by hash, so identical text across several entries is stored once. Comparing raw chunk
// output per-entry and positionally against a hash-keyed, insertion-ordered store reported a perfectly synced
// collection as 70% stale.

/**
 * ST's recursive text splitter, ported verbatim from public/scripts/utils.js.
 *
 * Splits on the first delimiter, recurses into any part still too long with the next delimiter down, then
 * greedily merges adjacent parts back together while they fit under `length`. The merge pass is why 'length'
 * mode produces chunks that span unrelated topics: it fills to capacity without regard for structure.
 *
 * DO NOT "improve" this. Its output is baked into every existing vector index; a change here silently
 * invalidates all of them, and the check that guards it compares against real stored chunks.
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
 * minChunkSize IS A MERGE FLOOR, NOT A SPLIT THRESHOLD, and the direction surprises people. A paragraph
 * shorter than it is held and glued onto the NEXT one, so raising it yields fewer, larger chunks and lowering
 * it yields more, paragraph-aligned ones. Nothing is ever split because of it. Both ends cost something and
 * neither has been measured:
 *
 *   high — a run of short paragraphs accumulates until the total crosses the floor, so the boundary lands
 *          wherever that happens rather than anywhere structural; observed gluing a document title, a `---`
 *          rule and a subheading onto the start of unrelated content.
 *   low  — many tiny chunks. Two corpus-wide effects, both invisible per-entry: BM25's `avgdl` drops, which
 *          re-weights length normalisation for EVERY chunk in the book, and entry pooling takes the max over
 *          an entry's chunks, so inflating chunk count hands long entries more chances at a high max than
 *          short ones get. On one real book, 20 vs 120 was 4572 vs 4027 chunks and 738 vs 156 chunks under
 *          120 chars, with the longest entry going from 64 chunks to 102.
 *
 * That trade is exactly what eval/paired-arms.mjs is for, once a reindexer can rebuild a collection per arm.
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
            chunks.push(...splitRecursive(merged, maxLength, ['\n', '. ', ' ', '']));
        }
    }

    if (pending) {
        chunks.push(pending);
    }

    return chunks;
}
