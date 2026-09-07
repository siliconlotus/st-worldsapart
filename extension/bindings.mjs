// bindings.mjs — which chats and characters point at a lorebook that no longer exists.
//
// A binding is a string stored away from the thing it names: `chat_metadata.world_info` in line 0 of a
// .jsonl, `data.extensions.world` on a character card. Nothing enforces it, so renaming or deleting a
// book leaves every binding to the old name pointing at nothing — no error, no symptom beyond the book
// quietly never reaching that chat again.
//
// Pure and node-importable on purpose: this is the half worth testing, and the Studio half that renders
// it is not reachable from a test.
/** Collapse separators so a rename that only changed punctuation is recognisable as the same book. */
export const normalizeWorldName = s => String(s ?? '').toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

/** Levenshtein distance, iterative two-row. Short strings only — these are file names. */
export function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length || !b.length) return a.length || b.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * The existing world most likely to be what a missing name meant, or null.
 *
 * Containment leads, because the case this exists for is a book renamed by adding or removing a
 * qualifier, where one normalized name is a prefix of the other. Edit distance alone would also match
 * two genuinely different books spelled alike, and the suggestion leads to rewriting chat history.
 *
 * @param {string} missing The name nothing resolves to
 * @param {string[]} worldNames Existing books
 * @returns {string|null}
 */
export function nearestWorld(missing, worldNames) {
    const m = normalizeWorldName(missing);
    if (!m) return null;
    let best = null, bestLen = 0;
    let near = null, nearDist = Infinity;
    for (const w of worldNames) {
        const n = normalizeWorldName(w);
        // A version bump contains neither name in the other, so an edit-distance pass runs behind
        // containment — never ahead of it, since a contained name is the surer answer.
        if (n && w !== missing) {
            const d = editDistance(m, n);
            if (d < nearDist && d <= Math.max(2, Math.floor(m.length * 0.2))) { near = w; nearDist = d; }
        }
        // Skip only the same raw name: a normalized-equal world is the strongest answer there is, and it
        // cannot be a book suggesting itself — nearestWorld is only asked about names that do not exist.
        if (!n || w === missing) continue;
        if (!n.startsWith(m) && !m.startsWith(n)) continue;
        const shared = Math.min(n.length, m.length);
        if (shared > bestLen) { best = w; bestLen = shared; }
    }
    return best ?? near;
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
        // A character card's primary lorebook, kept separate from chats because repairing it is a
        // different write — /api/characters/merge-attributes rather than a chat save.
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
