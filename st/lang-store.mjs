// lang-store.mjs — the browser side of language packs: a store over ST's user-files endpoints (data/<user>/user/files/) and
// the two fetchers lang.mjs is handed. ST-coupled.
import { getRequestHeaders } from '../../../../../script.js';
import { toBase64 } from '../extension/lang.mjs';

const PACKS_BASE = 'https://raw.githubusercontent.com/siliconlotus/st-worldsapart-lang/main/';
const filePath = lang => `user/files/wa-pack-${lang}.json`;

/** lang.mjs's store contract over /api/files: existence through /verify so a miss is silent, not a 404; a failed write is forgotten, not thrown. */
export const packStore = {
    get: async lang => {
        try {
            const v = await fetch('/api/files/verify', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ urls: [filePath(lang)] }) });
            if (!v.ok || !(await v.json())[filePath(lang)]) return undefined;
            const r = await fetch(`/${filePath(lang)}`, { cache: 'no-cache' });
            return r.ok ? await r.json() : undefined;
        } catch { return undefined; }
    },
    put: async (lang, pack) => {
        try {
            const r = await fetch('/api/files/upload', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: `wa-pack-${lang}.json`, data: toBase64(JSON.stringify(pack)) }) });
            if (!r.ok) console.warn(`Worlds Apart: storing the ${lang} pack failed (${r.status}); it is in memory for this session`);
        } catch (e) { console.warn('Worlds Apart: storing the pack failed', e); }
    },
};

const getJson = async url => { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
export const fetchIndex = () => getJson(`${PACKS_BASE}packs.json`);
export const fetchPack = lang => getJson(`${PACKS_BASE}wa-pack-${encodeURIComponent(lang)}.json`);
