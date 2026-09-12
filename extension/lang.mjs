// lang.mjs — the current language table: one pack shape for every language, English bundled, the rest fetched once and
// kept by the caller's store. ST-free; fetch and store are injected.
import { PACK as EN } from './zipf-en.js';

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
