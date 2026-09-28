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
writeIndex(path.join(vectors, 'openrouter', 'wa_or', 'openaitext-embedding-3-large'), [[1, [1, 0, 0]]]);

const embedder = http.createServer((req, res) => { req.resume(); req.on('end', () => res.end(JSON.stringify({ embedding: [1, 0.5, 0.2] }))); });
await new Promise(r => embedder.listen(0, '127.0.0.1', r));
const extrasUrl = `http://127.0.0.1:${embedder.address().port}`;

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

    const q = await call('/query-multi', { collectionIds: ['wa_big', 'wa_foreign'], searchText: 'x', topK: 1000, ...extras });
    eq(q.code, 200, 'a foreign-dimension collection does not fail the query');
    eq(q.body?.wa_big?.hashes.length, 700, 'topK up to admitCeiling(true) is honoured, not cut at 512');
    eq('wa_foreign' in (q.body ?? {}), false, '...and the foreign collection is skipped');
    eq((await call('/query-multi', { collectionIds: ['wa_foreign'], searchText: 'x', ...extras })).code, 500, 'every collection failing still fails the query');

    const cols = await call('/collections', extras);
    const byId = Object.fromEntries((cols.body ?? []).map(c => [c.collectionId, c]));
    eq(byId.wa_big?.model, '', 'a collection with an empty model scope is listed');
    eq(byId.wa_big?.current, true, '...and is current under its own source');
    eq(byId.wa_or?.current, false, 'a collection under another source is not current');
    const or = await call('/collections', { source: 'openrouter', sourceSettings: { model: 'openai/text-embedding-3-large' } });
    eq(or.body?.find(c => c.collectionId === 'wa_or')?.current, true, 'a model id holding "/" is current against its sanitized directory');

    const adopt = await call('/adopt', { collectionId: 'wa_clone', hashes: [1003, 1004, 99999], ...extras });
    eq(adopt.body?.adopted?.sort().join(','), '1003,1004', 'adopt copies the rows a sibling holds, through the cache');
    eq(fs.existsSync(path.join(vectors, 'extras', 'wa_clone', 'index.json')), true, '...into the clone\'s collection');

    const scan = await call('/scan-chats', { keys: ['a'], chats: [{ dir: 'd', file: 'f' }], wordBoundary: 'strict' });
    eq(scan.code, 400, 'scan-chats refuses a request with no matchWindow');
} finally {
    embedder.close();
    box.cleanup();
    fs.rmSync(vectors, { recursive: true, force: true });
}
if (process.exitCode !== 1) console.log('plugin-routes-check: ok');
