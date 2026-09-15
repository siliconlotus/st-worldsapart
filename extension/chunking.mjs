// chunking.mjs — how an entry's text is cut up before it is embedded. Pure; settings are passed in. A change
// here silently invalidates every existing vector index; eval/chunking-check.mjs is the oracle (P3).

/** ST's recursive text splitter, ported verbatim from public/scripts/utils.js; do not "improve" it. `delimiters` is coarsest first, '' splits between characters. */
export function splitRecursive(input, length, delimiters = ['\n\n', '\n', ' ', '']) {
    if (length <= 0) {
        return [input];
    }

    const delim = delimiters[0] ?? '';
    const parts = input.split(delim);

    const flatParts = parts.flatMap(p => {
        if (p.length < length) return p;
        return splitRecursive(p, length, delimiters.slice(1));
    });

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

/** Entry text -> chunks. 'length' is splitRecursive; 'paragraph' keeps one paragraph per chunk, splitting oversized ones and
 *  holding sub-`minChunkSize` fragments for the next (a merge floor, never a split threshold). `opts` is `settings()`. */
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

        if (merged.length < minChunkSize) {
            pending = merged;
            continue;
        }

        pending = '';

        if (merged.length <= maxLength) {
            chunks.push(merged);
        } else {
            const parts = splitRecursive(merged, maxLength, ['\n', '. ', ' ', '']);
            // The tail carries into `pending`, not glued here: what follows it in the source is a blank line and the next paragraph (R25).
            const tail = parts[parts.length - 1];
            if (parts.length > 1 && tail.length < minChunkSize) {
                parts.pop();
                pending = tail;
            }
            chunks.push(...parts);
        }
    }

    if (pending) {
        // Nothing follows, so the only join left is backwards; alone when it does not fit.
        const previous = chunks[chunks.length - 1];
        if (pending.length < minChunkSize && previous && previous.length + pending.length + 2 <= maxLength) {
            chunks[chunks.length - 1] = `${previous}\n\n${pending}`;
        } else {
            chunks.push(pending);
        }
    }

    return chunks;
}
