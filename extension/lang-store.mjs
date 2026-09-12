// lang-store.mjs — the browser side of language packs: a store over ST's user-files endpoints (data/<user>/user/files/) and
// the two fetchers lang.mjs is handed. ST-coupled.
import { getRequestHeaders } from '../../../../../script.js';

export const PACKS_BASE = 'https://raw.githubusercontent.com/siliconlotus/st-worldsapart-lang/main/';
const fileName = lang => `wa-pack-${lang}.json`;
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** lang.mjs's store contract over /api/files: a missing file reads as undefined; a failed write is forgotten, not thrown. */
export const packStore = {
    get: async lang => {
        try {
            const r = await fetch(`/user/files/${encodeURIComponent(fileName(lang))}`, { cache: 'no-cache' });
            return r.ok ? await r.json() : undefined;
        } catch { return undefined; }
    },
    put: async (lang, pack) => {
        try {
            await fetch('/api/files/upload', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: fileName(lang), data: b64(JSON.stringify(pack)) }) });
        } catch { /* in memory for this session; the next switch fetches again */ }
    },
};

const getJson = async url => { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
export const fetchIndex = () => getJson(`${PACKS_BASE}packs.json`);
export const fetchPack = lang => getJson(`${PACKS_BASE}zipf-${encodeURIComponent(lang)}.json`);
