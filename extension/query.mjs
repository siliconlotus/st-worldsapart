// query.mjs — the retrieval query: which messages the query is built from, and how they join into one
// string. What that query is then worth against a term is entity.mjs.
//
// Isomorphic — no DOM, no ST imports. Every SillyTavern dependency (message depth, substituteParams) is
// injected by the caller; the harness passes identity for the substitution ST does live.

/**
 * Builds the retrieval query from the tail of the chat.
 * @param {object[]} chat Chat messages
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to include (settings().messageDepth)
 * @param {(s: string) => string} [cfg.substituteParams] Macro substitution (ST's; identity offline)
 * @returns {string} Query text
 */
export function buildQuery(chat, { depth, substituteParams = s => s }) {
    return joinQueryMessages(queryMessages(chat, { depth, substituteParams }));
}

/**
 * The join half of buildQuery, exported so a caller that already has queryMessages() output (retrieve()
 * stashes it for /wa-grade) can build the query string without running the whole-chat substitution pass
 * a second time.
 * @param {Array<{name: string, mes: string}>} messages queryMessages() output
 * @returns {string} Query text
 */
export function joinQueryMessages(messages) {
    return messages
        .map(x => (x.name ? `${x.name}: ${x.mes}` : x.mes))
        .join('\n\n')
        .trim();
}

/**
 * The messages buildQuery would join: substituted, stripped of file attachments, empties dropped, newest
 * `depth` of them, chronological. Same {name, mes} shape as ST's chat, so the output can be fed straight
 * back in.
 *
 * Exported because /wa-grade freezes this into its sample, which is what makes messageDepth the one
 * query parameter a frozen sample can still sweep: buildQuery over the last d of these is exact for any
 * d <= the captured depth. It has to be the pre-join form — buildQuery joins on '\n\n' and RP messages
 * contain blank lines, so the boundaries cannot be recovered from the joined text.
 *
 * @param {object[]} chat Chat messages
 * @param {object} cfg
 * @param {number} cfg.depth How many recent messages to include
 * @param {(s: string) => string} [cfg.substituteParams] Macro substitution (ST's; identity offline)
 * @returns {Array<{name: string, mes: string}>} Newest `depth` non-empty messages, chronological
 */
export function queryMessages(chat, { depth, substituteParams = s => s }) {
    return chat
        .map((x, i) => ({
            name: String(x?.name ?? '').trim(),
            mes: substituteParams(String(x?.mes || '').substring(x?.extra?.fileLength || 0).trim()),
            // Index in the array handed in, not in any canonical chat — a caller that pre-filtered maps
            // it back itself. It is what lets a capture record the message range it covers rather than
            // approximating it as `last - depth`, which is wrong the moment an empty message is skipped.
            i,
        }))
        .filter(x => x.mes)
        .reverse()
        .slice(0, Math.max(1, depth))
        // Back to chronological: taking the newest N requires reversing first, but a summarizer handed
        // the messages backwards reads the scene in reverse.
        .reverse();
}
