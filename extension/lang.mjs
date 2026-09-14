// lang.mjs — the current language table: one pack shape for every language, English bundled, the rest fetched once and
// kept by the caller's store. ST-free; fetch and store are injected.
import { PACK as EN } from './wa-pack-en.js';

/** The packed decile string (`decizipf:words;…`) to a word -> Zipf map. */
export function parsePacked(packed) {
    const m = new Map();
    for (const row of String(packed ?? '').split(';')) {
        const i = row.indexOf(':');
        if (i < 0) continue;
        const z = Number(row.slice(0, i)) / 10;
        for (const w of row.slice(i + 1).split(' ')) if (w) m.set(w, z);
    }
    return m;
}

const words = s => new Set(String(s ?? '').split(' ').filter(Boolean));

/** UTF-8 text to base64 for ST's upload endpoint, in chunks: a pack is hundreds of KB, past the spread-argument limit. */
export function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}

let current = null;
/** The bundled English pack, always present because it ships. */
export const BUNDLED = EN;

/** The table in force; the bundled English pack until `usePack` says otherwise. */
export function table() {
    if (!current) usePack(EN);
    return current;
}

/** A pack object (the shape build-zipf.py writes) becomes the current table. */
export function usePack(pack) {
    const strict = words(pack.va95);
    current = {
        lang: pack.lang, label: pack.label ?? pack.lang, hash: pack.hash ?? null,
        zipf: parsePacked(pack.packed),
        posVAStrict: strict,
        posVA: new Set([...strict, ...words(pack.va85)]),
        posAdj: words(pack.adj85),
        common: words(pack.common),
        loaded: true,
    };
    return current;
}

/** No table for `lang`: every word reads rare, every filter is a no-op. */
export function standDown(lang) {
    current = { lang, label: lang, hash: null, zipf: new Map(), posVAStrict: new Set(), posVA: new Set(), posAdj: new Set(), common: new Set(), loaded: false };
    return current;
}

/** The table for `lang`: the bundled pack for 'en', else the store's copy, else one fetch that is then stored; a failure stands down. */
export async function setLanguage(lang, { fetchPack, store }) {
    if (!lang || lang === 'en') return usePack(EN);
    let pack = await store.get(lang);
    if (!pack) {
        try { pack = await fetchPack(lang); await store.put(lang, pack); }
        catch { return standDown(lang); }
    }
    return usePack(pack);
}

/** The index for the dropdown; a stored pack whose hash the index has moved is refetched and replaced. Null when the index is unreachable. */
export async function refreshIndex({ fetchIndex, fetchPack, store }) {
    let index;
    try { index = await fetchIndex(); } catch { return null; }
    // In parallel: each language touches only its own stored pack, and usePack can fire for at most one of them.
    await Promise.all(Object.entries(index ?? {}).map(async ([lang, meta]) => {
        const have = await store.get(lang);
        if (!have || have.hash === meta.hash) return;
        try {
            const fresh = await fetchPack(lang);
            await store.put(lang, fresh);
            if (current?.lang === lang) usePack(fresh);
        } catch { /* the stored copy stands; the next refresh tries again */ }
    }));
    return index;
}
