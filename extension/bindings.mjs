// bindings.mjs — which chats and character cards name a lorebook that no longer exists. A binding is
// `chat_metadata.world_info` in line 0 of a chat .jsonl or `data.extensions.world` on a card; ST-free.
// NFC before the fold: a book name from an NFD source (a macOS zip) must match its NFC-written binding exactly, not fall to edit distance.
export const normalizeWorldName = s => String(s ?? '').normalize('NFC').toLowerCase().replace(/[_\-\s]+/g, ' ').trim();

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

/**
 * The books ST has active for one chat: global, the character's own and its charLore extras, the chat's, the persona's.
 * Never through getSortedEntries, which emits WORLDINFO_ENTRIES_LOADED (upstream-st.md #18). In a group this unions
 * the enabled members, where core takes one per generation.
 * @param {object} p ST's globals, injected
 * @param {(avatar: string) => string[]} p.extraBooksOf A character's additional lorebooks, keyed by avatar
 * @param {string[]} p.worldNames Books not in it are dropped — a stale binding names one that no longer exists
 */
export function attachedBooks({ globalBooks = [], characters = [], characterId = null, group = null,
    chatBook = null, personaBook = null, extraBooksOf = () => [], worldNames = [] } = {}) {
    const names = new Set(globalBooks ?? []);
    const addCharacter = (character, avatar) => {
        if (character?.data?.extensions?.world) names.add(character.data.extensions.world);
        for (const b of extraBooksOf(avatar ?? character?.avatar) ?? []) names.add(b);
    };
    if (group) {
        for (const avatar of group.members ?? []) {
            if ((group.disabled_members ?? []).includes(avatar)) continue;
            addCharacter(characters?.find(c => c?.avatar === avatar), avatar);
        }
    } else if (characterId != null) {
        addCharacter(characters?.[characterId]);
    }
    if (chatBook) names.add(chatBook);
    if (personaBook) names.add(personaBook);
    return [...names].filter(Boolean).filter(n => worldNames.includes(n));
}

/**
 * Which chats in `index` bind to `book`, and how. A book binds four ways: chat (chat_metadata.world_info), character
 * (data.extensions.world), the character's additional lorebooks (extraBooks), global.
 * `why` is an English constant the caller translates where it draws it.
 * @param index findOrphanBindings' index shape
 * @param {boolean} opt.all Keep the unbound chats too, each marked 'not bound'
 * @returns {{rows: object[], isGlobal: boolean}}
 */
export function classifyBookChats(index, { book = null, globalBooks = [], all = false } = {}) {
    // No book selected: nothing binds to it. Without this, `undefined === undefined` reads every unbound chat as chat-bound.
    const sel = book || null;
    const isGlobal = !!sel && (globalBooks ?? []).includes(sel);
    const rows = [];
    for (const c of index ?? []) {
        const cardBound = !!sel && c.charWorld === sel;
        const auxBound = !!sel && !cardBound && (c.extraBooks ?? []).includes(sel);
        const charBound = cardBound || auxBound;
        for (const ch of c.chats ?? []) {
            const chatBound = !!sel && ch?.chat_metadata?.world_info === sel;
            if (!chatBound && !charBound && !isGlobal && !all) continue;
            rows.push({
                char: c.char, avatar: c.avatar, file: ch.file_name, size: ch.file_size ?? '?',
                why: chatBound ? 'chat-bound' : cardBound ? 'character-bound'
                    : auxBound ? 'character-bound (additional lorebook)'
                        : isGlobal ? 'global (book is always active)' : 'not bound',
                bound: chatBound || charBound,
            });
        }
    }
    return { rows, isGlobal };
}
