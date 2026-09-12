// Self-check for extension/lang.mjs: a pack becomes the table, a stand-down empties it, and the switch touches the store and the network only when it must.
import { eq } from './metrics.mjs';
import { table, usePack, standDown, parsePacked, setLanguage, refreshIndex, BUNDLED } from '../extension/lang.mjs';

const pack = {
    lang: 'xx', label: 'Test', source: 'synthetic', license: 'none',
    packed: '55:the of;38:tavern;30:warlock', va95: 'ran', va85: 'slept', adj85: 'briny',
    common: 'the of and', hash: 'h1',
};

eq(table().lang, 'en', 'the first read is the bundled English pack');
eq(table().zipf.get('the') > 7, true, 'and it carries the English table');
eq(table().common.has('the'), true, 'and its common list');

const t = usePack(pack);
eq(t.lang, 'xx', 'usePack sets the language');
eq(t.zipf.get('the'), 5.5, 'a decile band unpacks to its Zipf value');
eq(t.zipf.get('warlock'), 3.0, 'the last band too');
eq(t.zipf.has('minotaur'), false, 'absence means rare');
eq(t.posVAStrict.has('ran') && t.posVA.has('ran') && t.posVA.has('slept') && !t.posVAStrict.has('slept'), true, 'VA95 is inside VA, VA85 is not strict');
eq(t.posAdj.has('briny'), true, 'ADJ85 is the adjective set');
eq(t.common.has('and') && !t.common.has('tavern'), true, 'common is the pack list');
eq(t.loaded, true, 'a pack is loaded');
eq(table(), t, 'table() is the current object');

const d = standDown('yy');
eq(d.lang, 'yy', 'stand-down keeps the requested language');
eq(d.zipf.size + d.posVA.size + d.posAdj.size + d.common.size, 0, 'stand-down empties every collection');
eq(d.loaded, false, 'and is not loaded');
eq(parsePacked('').size, 0, 'an empty packed string is an empty table');
{
    const store = new Map();
    const fetched = [];
    const packs = { xx: { ...pack, hash: 'h1' } };
    const fetchPack = async lang => { fetched.push(lang); if (!packs[lang]) throw new Error('404'); return packs[lang]; };
    const S = { get: async l => store.get(l), put: async (l, p) => { store.set(l, p); } };

    const a = await setLanguage('xx', { fetchPack, store: S });
    eq(a.loaded && a.lang === 'xx', true, 'first use fetches the pack');
    eq(fetched.length, 1, 'one fetch');
    eq(store.get('xx')?.hash, 'h1', 'and stores it');
    await setLanguage('en', { fetchPack, store: S });
    eq(table().lang, 'en', 'English is the bundled pack');
    eq(table().hash, BUNDLED.hash, 'the same object every language goes through');
    await setLanguage('xx', { fetchPack, store: S });
    eq(fetched.length, 1, 'switching back reads the store, no network');
    const z = await setLanguage('zz', { fetchPack, store: S });
    eq(z.loaded, false, 'a failed fetch stands down');
    eq(z.lang, 'zz', 'to the requested language');
    eq(fetched.length, 2, 'after one attempt');

    packs.xx = { ...pack, hash: 'h2', packed: '55:the of;38:tavern' };
    const index = { xx: { label: 'Test', file: 'zipf-xx.json', bytes: 1, hash: 'h2' } };
    const idx = await refreshIndex({ fetchIndex: async () => index, fetchPack, store: S });
    eq(Object.keys(idx).join(','), 'xx', 'refreshIndex returns the index');
    eq(store.get('xx')?.hash, 'h2', 'a stored pack behind the index is refetched');
    eq(fetched.length, 3, 'once');
    eq(table().lang, 'zz', 'refresh does not change the current language');
    await setLanguage('xx', { fetchPack, store: S });
    eq(table().zipf.has('warlock'), false, 'the refreshed pack is what switching reads');
    await refreshIndex({ fetchIndex: async () => index, fetchPack, store: S });
    eq(fetched.length, 3, 'a matching hash fetches nothing');
    packs.xx = { ...pack, hash: 'h3' };
    index.xx.hash = 'h3';
    await refreshIndex({ fetchIndex: async () => index, fetchPack, store: S });
    eq(table().hash, 'h3', 'a refresh of the current language swaps it in');
    const bad = await refreshIndex({ fetchIndex: async () => { throw new Error('offline'); }, fetchPack, store: S });
    eq(bad, null, 'an unreachable index is null, not a throw');
}
console.log(process.exitCode ? 'FAIL' : 'ok');
