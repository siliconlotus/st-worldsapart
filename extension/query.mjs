// query.mjs — the retrieval query: which messages it is built from, and how they join. ST-free; `substituteParams` is injected.

/** The retrieval query from the tail of the chat; `substituteParams` is ST's macro substitution, identity offline. */
export function buildQuery(chat, { depth, substituteParams = s => s }) {
    return joinQueryMessages(queryMessages(chat, { depth, substituteParams }));
}

export function joinQueryMessages(messages) {
    return messages
        .map(x => (x.name ? `${x.name}: ${x.mes}` : x.mes))
        .join('\n\n')
        .trim();
}

/** The messages buildQuery joins: substituted, attachments stripped, empties dropped, newest `depth`, chronological. `i` is the index in the array handed in, not in any canonical chat. */
export function queryMessages(chat, { depth, substituteParams = s => s }) {
    // slice(0, NaN) returns nothing.
    const take = Number(depth) > 0 ? Number(depth) : Infinity;
    return chat
        .map((x, i) => ({
            name: String(x?.name ?? '').trim(),
            mes: substituteParams(String(x?.mes || '').substring(x?.extra?.fileLength || 0).trim()),
            i,
        }))
        .filter(x => x.mes)
        .reverse()
        .slice(0, take)
        .reverse();
}
