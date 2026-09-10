// keyedit.mjs — rename, delete, replace and add-variant over a key list. ST-free; each function mutates the entries passed
// and returns how many it changed.

/** Lowercased and trimmed, which is how core's default scan compares two keys. Never stored: keys keep their own case. */
export const kwNorm = k => String(k ?? '').toLowerCase().trim();

/** Whether `entry[list]` holds `term` under kwNorm. */
export const hasKey = (entry, term, list = 'key') =>
    Array.isArray(entry?.[list]) && entry[list].some(k => kwNorm(k) === kwNorm(term));

/** The entries of `entries` whose `list` holds `key` under kwNorm. */
export const keyHolders = (entries, key, list = 'key') =>
    (entries ?? []).filter(e => Array.isArray(e?.[list]) && e[list].some(k => kwNorm(k) === kwNorm(key)));

/** Renames `oldKey` to `next` in `entry[list]`; false when the entry does not hold it. Renaming onto a key the entry
 *  already holds deletes `oldKey` instead of duplicating it. The collision test skips the index being renamed, or a
 *  case-only rename matches itself and deletes the key. */
export function renameKeyOn(entry, oldKey, next, list = 'key') {
    const keys = entry?.[list];
    if (!Array.isArray(keys)) return false;
    const idx = keys.indexOf(oldKey);
    if (idx < 0) return false;
    if (keys.some((k, i) => i !== idx && kwNorm(k) === kwNorm(next))) keys.splice(idx, 1);
    else keys[idx] = next;
    return true;
}

/** Removes `key` from every holder. Returns the number of entries whose list got shorter. */
export function deleteKey(entries, key, list = 'key') {
    let touched = 0;
    for (const e of keyHolders(entries, key, list)) {
        const before = e[list].length;
        e[list] = e[list].filter(k => kwNorm(k) !== kwNorm(key));
        if (e[list].length !== before) touched++;
    }
    return touched;
}

/** Renames `key` to `next` in every holder, by renameKeyOn, so a holder that already has `next` loses `key`. */
export function replaceKey(entries, key, next, list = 'key') {
    let touched = 0;
    for (const e of keyHolders(entries, key, list)) if (renameKeyOn(e, e[list].find(k => kwNorm(k) === kwNorm(key)), next, list)) touched++;
    return touched;
}

/** Appends `term` to every holder of `key` that lacks it under kwNorm. Returns how many gained it. */
export function addVariant(entries, key, term, list = 'key') {
    let added = 0;
    for (const e of keyHolders(entries, key, list)) if (!hasKey(e, term, list)) { e[list].push(term); added++; }
    return added;
}
