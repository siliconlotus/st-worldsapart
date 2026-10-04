// The plugin's /query-multi, /collections, /adopt and /scan-chats, called on a real deploy against a throwaway vectors
// folder, with a local stand-in for the Extras embedder. Skips without an ST install.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { stInstall } from '../eval/lib/st-install.mjs';
import { eq } from '../eval/lib/metrics.mjs';
import { deploySandbox } from './plugin-sandbox.mjs';

const st = stInstall();
if (!st) {
    console.log('ok  (no SillyTavern install reachable — the plugin cannot load)');
    process.exit(0);
}

const vectors = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-vectors-'));
// Extras has an empty model scope, so its index.json sits in the collection directory itself.
const writeIndex = (dir, rows) => {
    fs.mkdirSync(dir, { recursive: true });
    const items = rows.map(([index, vector], i) => ({ id: `${index}-${i}`, metadata: { hash: 1000 + index, text: `t${index}`, index }, vector, norm: 1 }));
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 1, metadata_config: {}, items }));
};
writeIndex(path.join(vectors, 'extras', 'wa_big'), Array.from({ length: 700 }, (_, i) => [i, [1, (i % 7) / 7, (i % 11) / 11]]));
writeIndex(path.join(vectors, 'extras', 'wa_foreign'), [[1, [1, 0]], [2, [0, 1]]]);
writeIndex(path.join(vectors, 'extras', 'wa_mixed'), [[1, [1, 0, 0]], [2, [0, 1]], [3, [0, 1, 0]]]);
// Never queried, so never cleaned: an old branch clone still holding another model's rows.
writeIndex(path.join(vectors, 'extras', 'wa_stale'), [[5000, [1, 0]]]);
const rowsOf = coll => {
    const file = path.join(vectors, 'extras', coll, 'index.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).items.length : 0;
};
writeIndex(path.join(vectors, 'openrouter', 'wa_or', 'openaitext-embedding-3-large'), [[1, [1, 0, 0]]]);
// Whole seconds, so the mtime survives being set back after the file is rewritten.
const BIG = path.join(vectors, 'extras', 'wa_big', 'index.json');
fs.utimesSync(BIG, 1_700_000_000, 1_700_000_000);

// NOVEC stands for a provider that answers without a vector.
const embedder = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => res.end(JSON.stringify({ embedding: body.includes('NOVEC') ? [] : [1, 0.5, 0.2] })));
});
await new Promise(r => embedder.listen(0, '127.0.0.1', r));
const extrasUrl = `http://127.0.0.1:${embedder.address().port}`;

// Read once, when the server module loads.
process.env.WA_SCAN_FILE_MS = '300';
const box = deploySandbox({ st });
try {
    eq(box.run.status, 0, `the deploy ran (${box.run.stderr.trim() || 'no stderr'})`);
    const plugin = await box.load();
    const routes = new Map();
    await plugin.default.init({ post: (p, h) => routes.set(p, h), get: (p, h) => routes.set(p, h) });
    const call = async (route, body) => {
        const out = { code: 200, body: undefined };
        const response = { send: v => (out.body = v), status: c => ((out.code = c), response) };
        await routes.get(route)({ user: { directories: { vectors, chats: vectors } }, body }, response);
        return out;
    };
    const extras = { source: 'extras', sourceSettings: { extrasUrl, extrasKey: '' } };

    const novec = await call('/query-multi', { collectionIds: ['wa_big', 'wa_foreign'], searchText: 'NOVEC', ...extras });
    eq(novec.code, 502, 'a provider answering without a vector is a 502, the provider\'s failure');
    eq(rowsOf('wa_foreign'), 2, '...and drops nothing');
    const down = await call('/query-multi', { collectionIds: ['wa_big'], searchText: 'x', source: 'extras', sourceSettings: { extrasUrl: 'http://127.0.0.1:1', extrasKey: '' } });
    eq(down.code, 502, 'a provider that cannot be reached is a 502');
    eq((await call('/query-multi', { collectionIds: ['wa_big'], searchText: 'x', source: 'webllm', sourceSettings: {} })).code, 422, 'a source embedded in the browser is a 422');

    const q = await call('/query-multi', { collectionIds: ['wa_big', 'wa_foreign', 'wa_mixed'], searchText: 'x', topK: 1000, ...extras });
    eq(q.code, 200, 'a foreign-dimension collection does not fail the query');
    eq(q.body?.wa_big?.hashes.length, 700, 'topK up to admitCeiling(true) is honoured, not cut at 512');
    eq('wa_foreign' in (q.body ?? {}), false, 'a wholly foreign collection answers nothing');
    eq(rowsOf('wa_foreign'), 0, '...and its rows are dropped, so the next sync re-embeds them');
    eq(rowsOf('wa_mixed'), 2, 'a mixed collection loses only its foreign row');
    eq(q.body?.wa_mixed?.hashes.length, 2, '...and scores the rest in the same query');

    const cols = await call('/collections', extras);
    const byId = Object.fromEntries((cols.body ?? []).map(c => [c.collectionId, c]));
    eq(byId.wa_big?.model, '', 'a collection with an empty model scope is listed');
    eq(byId.wa_big?.current, true, '...and is current under its own source');
    eq(byId.wa_or?.current, false, 'a collection under another source is not current');
    const or = await call('/collections', { source: 'openrouter', sourceSettings: { model: 'openai/text-embedding-3-large' } });
    eq(or.body?.find(c => c.collectionId === 'wa_or')?.current, true, 'a model id holding "/" is current against its sanitized directory');

    // wa_big's file is garbage of the same size and mtime, so only the cache can still yield its rows; wa_broken is newest and unreadable.
    fs.writeFileSync(BIG, 'x'.repeat(fs.statSync(BIG).size));
    fs.utimesSync(BIG, 1_700_000_000, 1_700_000_000);
    fs.mkdirSync(path.join(vectors, 'extras', 'wa_broken'));
    fs.writeFileSync(path.join(vectors, 'extras', 'wa_broken', 'index.json'), '{');
    const adopt = await call('/adopt', { collectionId: 'wa_clone', hashes: [1003, 1004, 6000, 99999], ...extras });
    eq(adopt.code, 200, 'an unreadable sibling is skipped, not fatal');
    eq(adopt.body?.adopted?.sort().join(','), '1003,1004', 'adopt reads a cached sibling from the cache, not the disk, and skips rows not of the query dimension');
    eq(fs.existsSync(path.join(vectors, 'extras', 'wa_clone', 'index.json')), true, '...into the clone\'s collection');

    const scan = await call('/scan-chats', { keys: ['a'], chats: [{ dir: 'd', file: 'f' }], wordBoundary: 'strict' });
    eq(scan.code, 400, 'scan-chats refuses a request with no matchWindow');

    fs.mkdirSync(path.join(vectors, 'd'));
    fs.writeFileSync(path.join(vectors, 'd', 'f.jsonl'), [{ chat_metadata: {} }, { name: 'A', mes: `${'a'.repeat(40)}b` }, { name: 'A', mes: 'a plain line' }].map(m => JSON.stringify(m)).join('\n'));
    const scanOf = keys => call('/scan-chats', { keys, chats: [{ dir: 'd', file: 'f' }], wordBoundary: 'strict', matchWindow: 'message' });
    const plain = await scanOf(['plain', '/pl[a4]in/']);
    eq(`${plain.code} ${plain.body?.counts?.plain} ${plain.body?.counts?.['/pl[a4]in/']}`, '200 1 1', 'a scan inside the time limit counts as before, regex keys included');
    const started = Date.now();
    const slow = await scanOf(['plain', '/pl[a4]in/', '/(a+)+$/', '? thing /x+/']);
    eq(`${slow.code} ${slow.body?.slow} ${slow.body?.key}`, '422 true /(a+)+$/', 'a regex key that backtracks is stopped, and the reply names it among the others');
    eq(Date.now() - started < 3000, true, '...at the limit, not when the regex would have finished');
    eq((await scanOf(['plain'])).body?.counts?.plain, 1, 'and the next scan runs normally');

    // Last: it removes the loader this check loaded the plugin through.
    const as = admin => { const out = { code: 200, body: undefined }; const response = { send: v => (out.body = v), status: c => ((out.code = c), response) }; routes.get('/uninstall')({ user: { profile: { admin } }, body: {} }, response); return out; };
    fs.mkdirSync(path.join(box.dir, 'node_modules'), { recursive: true });
    eq(`${as(false).code} ${fs.existsSync(path.join(box.dir, 'index.js'))}`, '403 true', 'uninstall refuses a caller who is not an admin, and removes nothing');
    eq(as(true).body?.removed?.join(','), 'index.js,package.json,source.json', 'for an admin it removes the three files the deploy wrote');
    eq(`${fs.existsSync(path.join(box.dir, 'index.js'))} ${fs.existsSync(path.join(box.dir, 'node_modules'))}`, 'false true', '...and leaves a folder that still holds something else');
} finally {
    embedder.close();
    box.cleanup();
    fs.rmSync(vectors, { recursive: true, force: true });
}
if (process.exitCode !== 1) console.log('plugin-routes-check: ok');
