// bindings.mjs — which chats and character cards name a lorebook that no longer exists. A binding is
// `chat_metadata.world_info` in line 0 of a chat .jsonl or `data.extensions.world` on a card; ST-free.
export const normalizeWorldName = s => String(s ?? '').toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

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

/** The existing world a missing name most likely meant, or null. */
export function nearestWorld(missing, worldNames) {
    const m = normalizeWorldName(missing);
    if (!m) return null;
    let best = null, bestLen = 0;
    let near = null, nearDist = Infinity;
    for (const w of worldNames) {
        const n = normalizeWorldName(w);
        if (n && w !== missing) {
            const d = editDistance(m, n);
            if (d < nearDist && d <= Math.max(2, Math.floor(m.length * 0.2))) { near = w; nearDist = d; }
        }
        // Skip the same raw name only: a normalized-equal world is the best answer, not a self-match.
        if (!n || w === missing) continue;
        if (!n.startsWith(m) && !m.startsWith(n)) continue;
        const shared = Math.min(n.length, m.length);
        if (shared > bestLen) { best = w; bestLen = shared; }
    }
    return best ?? near;
}

/** Every binding that names a book which does not exist.
 * @param index [{char, avatar, charWorld, extraBooks, chats: [{chat_metadata, file_name}]}] — charWorld is the card's own book, extraBooks the character's additional lorebooks */
export function findOrphanBindings(index, worldNames) {
    const exists = new Set(worldNames.map(String));
    const groups = new Map();   // missing name -> { chats, cards }
    const group = name => {
        let g = groups.get(name);
        if (!g) groups.set(name, g = { chats: [], cards: [] });
        return g;
    };

    for (const c of index ?? []) {
        if (c?.charWorld && !exists.has(c.charWorld)) group(c.charWorld).cards.push(c.char);
        for (const b of c?.extraBooks ?? []) if (b && !exists.has(b)) group(b).cards.push(c.char);
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
