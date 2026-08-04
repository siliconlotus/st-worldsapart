// bindings.mjs — which chats and characters point at a lorebook that no longer exists.
//
// A binding is a STRING stored away from the thing it names: `chat_metadata.world_info` in line 0 of a
// .jsonl, `data.extensions.world` on a character card. Nothing enforces it, so renaming or deleting a
// book leaves every binding to the old name pointing at nothing — with no error, and no symptom beyond
// the book quietly never reaching that chat again. Both ST's rename and WA's miss closed chats (WA's
// now re-points them; ST's does not), and ST's delete is an unlink with no backup, so orphans are a
// state the system produces routinely and never mentions.
//
// Pure and node-importable on purpose: this is the half worth testing, and the Studio half that renders
// it is not reachable from a test.
/**
 * Book names differ from each other in ways nobody means: `LTM_Isekai_-_Time_Whore` against
 * `LTM Isekai - Time Whore`. Collapse the separators so a rename that only changed punctuation is
 * recognisable as the same book.
 */
export const normalizeWorldName = s => String(s ?? '').toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

/**
 * The existing world most likely to be what a missing name meant, or null.
 *
 * Containment, not edit distance: the case this exists for is a book renamed by adding or removing a
 * qualifier (`… Time Whore` → `… Time Whore updated`), where one normalized name is a prefix of the
 * other. Edit distance would also match two genuinely different books that happen to be spelled alike,
 * which is a worse failure here — the suggestion leads to rewriting chat history.
 *
 * @param {string} missing The name nothing resolves to
 * @param {string[]} worldNames Existing books
 * @returns {string|null}
 */
export function nearestWorld(missing, worldNames) {
    const m = normalizeWorldName(missing);
    if (!m) return null;
    let best = null, bestLen = 0;
    for (const w of worldNames) {
        const n = normalizeWorldName(w);
        if (!n || n === m) continue;
        if (!n.startsWith(m) && !m.startsWith(n)) continue;
        const shared = Math.min(n.length, m.length);
        if (shared > bestLen) { best = w; bestLen = shared; }
    }
    return best;
}

/**
 * Every binding that names a book which does not exist.
 *
 * @param {Array<{char: string, avatar: string, charWorld: string|null, chats: object[]}>} index
 *        loadChatIndex() output — one entry per character, each with its chats and their metadata
 * @param {string[]} worldNames Existing books (ST's world_names)
 * @returns {{missing: Array<{name: string, nearest: string|null, chats: Array<{char: string, avatar: string, file: string}>, cards: string[]}>, chatCount: number, cardCount: number}}
 *          Groups sorted by how many bindings point at each missing name, biggest first.
 */
export function findOrphanBindings(index, worldNames) {
    const exists = new Set(worldNames.map(String));
    const groups = new Map();   // missing name -> { chats, cards }
    const group = name => {
        let g = groups.get(name);
        if (!g) groups.set(name, g = { chats: [], cards: [] });
        return g;
    };

    for (const c of index ?? []) {
        // A character card's primary lorebook. Diagnosable but NOT fixable from here: ST's
        // renameWorldInfo owns that field and is not exported, so the view can only name it.
        if (c?.charWorld && !exists.has(c.charWorld)) group(c.charWorld).cards.push(c.char);
        for (const ch of c?.chats ?? []) {
            const w = ch?.chat_metadata?.world_info;
            if (!w || exists.has(w)) continue;
            group(w).chats.push({ char: c.char, avatar: c.avatar, file: String(ch.file_name ?? '') });
        }
    }

    const missing = [...groups.entries()]
        .map(([name, g]) => ({ name, nearest: nearestWorld(name, worldNames), ...g }))
        .sort((a, b) => (b.chats.length + b.cards.length) - (a.chats.length + a.cards.length) || a.name.localeCompare(b.name));

    return {
        missing,
        chatCount: missing.reduce((n, g) => n + g.chats.length, 0),
        cardCount: missing.reduce((n, g) => n + g.cards.length, 0),
    };
}
