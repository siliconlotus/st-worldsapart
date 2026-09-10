// keyedit.mjs — the key-list edits behind the Studio's keyword chips: rename, delete, replace, add a variant, across
// whatever entries the caller hands over. ST-free; every function mutates the entries given and reports what it touched.

/** Core's default scan is case-insensitive, so two keys differing only in case are the same key to it. */
export const kwNorm = k => String(k ?? '').toLowerCase().trim();

/** Whether `entry` already carries `term` in `list`, under that same reading. */
export const hasKey = (entry, term, list = 'key') =>
    Array.isArray(entry?.[list]) && entry[list].some(k => kwNorm(k) === kwNorm(term));

/** The entries of `entries` that carry `key` in `list`. */
export const keyHolders = (entries, key, list = 'key') =>
    (entries ?? []).filter(e => Array.isArray(e?.[list]) && e[list].some(k => kwNorm(k) === kwNorm(key)));

/** Renames one entry's key. A rename onto a key the entry already has is a merge, not a duplicate — and the collision test
 *  skips the key being renamed, or a case fix collides with itself and deletes the key away. */
export function renameKeyOn(entry, oldKey, next, list = 'key') {
    const list_ = entry?.[list];
    if (!Array.isArray(list_)) return false;
    const idx = list_.indexOf(oldKey);
    if (idx < 0) return false;
    if (list_.some((k, i) => i !== idx && kwNorm(k) === kwNorm(next))) list_.splice(idx, 1);
    else list_[idx] = next;
    return true;
}

/** Removes `key` from every entry that has it. Returns how many entries changed. */
export function deleteKey(entries, key, list = 'key') {
    let touched = 0;
    for (const e of keyHolders(entries, key, list)) {
        const before = e[list].length;
        e[list] = e[list].filter(k => kwNorm(k) !== kwNorm(key));
        if (e[list].length !== before) touched++;
    }
    return touched;
}

/** Rewrites `key` to `next` in every entry that has it, merging where the entry already carries `next`. */
export function replaceKey(entries, key, next, list = 'key') {
    let touched = 0;
    for (const e of keyHolders(entries, key, list)) if (renameKeyOn(e, e[list].find(k => kwNorm(k) === kwNorm(key)), next, list)) touched++;
    return touched;
}

/** Adds `term` to every entry keyed `key` that lacks it. Returns how many gained it. */
export function addVariant(entries, key, term, list = 'key') {
    let added = 0;
    for (const e of keyHolders(entries, key, list)) if (!hasKey(e, term, list)) { e[list].push(term); added++; }
    return added;
}
