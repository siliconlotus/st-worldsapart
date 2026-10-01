// server.js — WorldsApart server plugin, loaded from the extension install by plugin/loader.js (deployed as
// /plugins/worlds-apart/index.js). Mounts at /api/plugins/worlds-apart; reaches ST's internals through fromST().

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreCollection, poolEntries, selectTopK, admitCeiling } from './scoring.mjs';
import { BOUNDARY_MODES, MATCH_WINDOWS, WA_METADATA_KEY, countChatHits, dropTags } from '../extension/matcher.mjs';
import { chatUser, createScanScope } from '../extension/smartkeys.mjs';
import { norm, corpusMean, rowDim } from './vector.mjs';
import { pluginFingerprint, PLUGIN_FILES } from './fingerprint.mjs';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
/** What the loader passed on this module's URL; absent when something imported server.js directly. */
const PASSED = new URL(import.meta.url).searchParams;
// Walked, as eval/lib/st-install.mjs walks, only when no loader passed the root.
const ST_ROOT = PASSED.get('stRoot') ?? (() => {
    for (let d = PLUGIN_DIR; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, 'config.yaml'))) return d;
        if (path.dirname(d) === d) throw new Error('server.js: no SillyTavern root passed by the loader and no config.yaml above this file');
    }
})();
/** The install this was loaded from as source.json names it, and the deployed loader's version; null outside the loader. */
const INSTALL = PASSED.get('install');
const LOADER = Number(PASSED.get('loader')) || null;

/** A module of SillyTavern's, by path from its root. Every ST import goes through here: st-boundary-check reads the calls. */
const fromST = rel => import(pathToFileURL(path.join(ST_ROOT, rel)).href);
/** A package from ST's node_modules, which this file, outside ST's tree under a relocated dataRoot, cannot resolve by name. */
const stPackage = name => import(pathToFileURL(createRequire(path.join(ST_ROOT, 'package.json')).resolve(name)).href);

const [
    { default: sanitize }, { LocalIndex },
    { getTransformersVector }, { getOllamaVector }, { getVllmVector }, { getOpenAIVector }, { getCohereVector },
    { getLlamaCppVector }, { getNomicAIVector }, { getExtrasVector }, { getMakerSuiteVector, getVertexVector }, { getConfigValue },
] = await Promise.all([
    stPackage('sanitize-filename'), stPackage('vectra'),
    fromST('src/vectors/embedding.js'), fromST('src/vectors/ollama-vectors.js'), fromST('src/vectors/vllm-vectors.js'),
    fromST('src/vectors/openai-vectors.js'), fromST('src/vectors/cohere-vectors.js'), fromST('src/vectors/llamacpp-vectors.js'),
    fromST('src/vectors/nomicai-vectors.js'), fromST('src/vectors/extras-vectors.js'), fromST('src/vectors/google-vectors.js'),
    fromST('src/util.js'),
]);

// The files as this process loaded them; the browser hashes the same list as it serves them, and a mismatch means a restart is due.
const readSource = f => { try { return fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8'); } catch { return ''; } };
const FINGERPRINT = pluginFingerprint(...PLUGIN_FILES.map(readSource));

export const info = {
    id: 'worlds-apart',
    name: 'WorldsApart',
    description: 'Mean-centered vector search for World Info retrieval.',
};

/** Corpus statistics per index path, an LRU; `loaded` is the load in flight or done, so concurrent queries share one parse.
 *  @type {Map<string, { loaded: Promise<{ items: object[], mean: Float64Array } | null>, mtimeMs: number, size: number }>} */
const MEAN_CACHE_MAX = 16;
const ADOPT_SIBLINGS_MAX = 32;
const CHAT_READS_MAX = 16;
const meanCache = new Map();
/** The query dimension last seen per model directory, by scopeKey; /adopt copies only rows of it. */
const queryDims = new Map();
const scopeKey = (directories, source, model) => `${path.join(directories.vectors, sanitize(String(source)))}\u001f${sanitize(String(model ?? ''))}`;

const openAiish = (q, urlOverride = null) => getOpenAIVector(q.text, q.source, q.directories, String(q.s.model), urlOverride);
/** How the plugin embeds a QUERY per source, null for one Vector Storage embeds in the browser — a mirror of ST's module-private `getVector` and `getSourceSettings`
 *  (src/endpoints/vectors.js); test/embed-sources-check.mjs fails when ST's SOURCES outgrows it. A Map, not an object
 *  literal: the key is request input, and `toString` must not resolve to a route. */
const EMBED_ROUTES = new Map([
    ['transformers', q => getTransformersVector(q.text)],
    ['nomicai',      q => getNomicAIVector(q.text, q.source, q.directories)],
    ['extras',       q => getExtrasVector(q.text, q.s.extrasUrl, q.s.extrasKey)],
    ['palm',         q => getMakerSuiteVector(q.text, String(q.s.model), q.request)],
    ['vertexai',     q => getVertexVector(q.text, String(q.s.model), q.request)],
    // isQuery is true: this only ever embeds the QUERY.
    ['cohere',       q => getCohereVector(q.text, true, q.directories, String(q.s.model))],
    ['llamacpp',     q => getLlamaCppVector(q.text, q.s.apiUrl, q.directories)],
    ['vllm',         q => getVllmVector(q.text, q.s.apiUrl, String(q.s.model), q.directories)],
    ['ollama',       q => getOllamaVector(q.text, q.s.apiUrl, String(q.s.model), Boolean(q.s.keep), q.directories)],
    ['siliconflow',  q => openAiish(q, q.s.siliconflow_endpoint === 'cn' ? 'https://api.siliconflow.cn/v1' : null)],
    ['workers_ai',   q => {
        const accountId = String(q.s.workers_ai_account_id || '').trim();
        return openAiish(q, accountId ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1` : null);
    }],
    ...['webllm', 'koboldcpp'].map(name => [name, null]),
    ...['openai', 'togetherai', 'mistral', 'chutes', 'electronhub', 'nanogpt', 'openrouter'].map(name => [name, q => openAiish(q)]),
]);
export const EMBED_SOURCES = [...EMBED_ROUTES.keys()];

/** The QUERY's vector for `source`, which must have a route. `request` is the plugin's own Express request, which Google's vectors read credentials off. */
async function embed(source, s, text, directories, request) {
    return await EMBED_ROUTES.get(source)({ source, s, text, directories, request });
}

/** The model scope ST wrote the collection under (`getSourceSettings(source).model`); several sources resolve it SERVER-SIDE, so the client's field alone names a directory ST never wrote. */
function modelScope(source, s) {
    switch (source) {
        case 'transformers': return getConfigValue('extensions.models.embedding', '');
        case 'mistral':      return 'mistral-embed';
        case 'nomicai':      return 'nomic-embed-text-v1.5';
        case 'palm': case 'vertexai': return String(s.model || 'text-embedding-005');
        case 'electronhub': case 'nanogpt': return String(s.model || 'text-embedding-3-small');
        case 'openrouter':   return String(s.model) || 'openai/text-embedding-3-large';
        case 'chutes':       return String(s.model || 'chutes-qwen-qwen3-embedding-8b');
        case 'siliconflow':  return String(s.model || 'Qwen/Qwen3-Embedding-0.6B');
        case 'workers_ai':   return String(s.model || '@cf/baai/bge-m3');
        case 'llamacpp': case 'extras': return '';
        default:             return String(s.model);
    }
}

function getIndexPath(directories, collectionId, source, model) {
    // Must match src/endpoints/vectors.js getIndex() exactly, or this reads a directory ST never wrote to.
    return path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(String(model ?? '')));
}

/** The centroid over `uids` (absent or empty = all), memoised on the loaded object; an empty subset falls back to the
 *  full mean rather than NaN. */
const SUBSET_MEANS_MAX = 64;
function centroidFor(loaded, uids) {
    if (!Array.isArray(uids) || !uids.length) return loaded.mean;
    loaded.subsetMeans ??= new Map();
    if (loaded.subsetMeans.size >= SUBSET_MEANS_MAX) loaded.subsetMeans.clear();
    const key = uids.join(',');
    const hit = loaded.subsetMeans.get(key);
    if (hit) return hit;
    const wanted = new Set(uids.map(Number));
    const subset = loaded.items.filter(it => wanted.has(Number(it.metadata?.index)));
    const mean = subset.length ? corpusMean(subset) : loaded.mean;
    loaded.subsetMeans.set(key, mean);
    console.log(`[WorldsApart] centroid over ${subset.length}/${loaded.items.length} chunks (${wanted.size} entries define the corpus)`);
    return mean;
}

const statIndex = indexPath => {
    const stat = fs.statSync(path.join(indexPath, 'index.json'), { throwIfNoEntry: false });
    return { mtimeMs: stat?.mtimeMs ?? 0, size: stat?.size ?? 0 };
};
/** The cache entry for `indexPath` when it is current by mtime AND size (two writes can share an mtime tick), else undefined. */
const freshEntry = (indexPath, { mtimeMs, size }) => {
    const cached = meanCache.get(indexPath);
    return cached && cached.mtimeMs === mtimeMs && cached.size === size ? cached : undefined;
};

/** An index's items and corpus mean, null when it has none; cached per path. `name` labels the log. */
function loadCentered(indexPath, name) {
    const stat = statIndex(indexPath);
    let entry = freshEntry(indexPath, stat);
    if (!entry) {
        entry = { ...stat, loaded: readCentered(indexPath, stat.mtimeMs, name) };
        entry.loaded.catch(() => { if (meanCache.get(indexPath) === entry) meanCache.delete(indexPath); });
    }
    meanCache.delete(indexPath);   // delete before set: set() on an existing key keeps its old position, so the sweep would evict a just-refreshed path first
    meanCache.set(indexPath, entry);
    while (meanCache.size > MEAN_CACHE_MAX) meanCache.delete(meanCache.keys().next().value);
    return entry.loaded;
}

async function readCentered(indexPath, mtimeMs, name) {
    const index = new LocalIndex(indexPath);

    if (!mtimeMs || !await index.isIndexCreated()) {
        return null;
    }

    const items = await index.listItems();

    if (!items.length) {
        return null;
    }

    const mean = corpusMean(items);
    console.log(`[WorldsApart] indexed ${name}: ${items.length} chunks, mean norm ${norm(mean).toFixed(4)}`);

    return { items, mean };
}

/** Deletes the rows whose vector is not `dim` long, so the next sync re-embeds them. Returns the index as reloaded, or
 *  `loaded` when every row fits. */
async function dropForeignRows(indexPath, name, loaded, dim) {
    if (loaded.checkedDim === dim) return loaded;
    const foreign = loaded.items.filter(it => rowDim(it?.vector) !== dim);
    if (!foreign.length) { loaded.checkedDim = dim; return loaded; }
    const index = new LocalIndex(indexPath);
    await index.beginUpdate();
    for (const it of foreign) await index.deleteItem(it.id);
    await index.endUpdate();
    console.warn(`[WorldsApart] ${name}: dropped ${foreign.length} of ${loaded.items.length} chunks that are not ${dim}-dimensional like the query; the next sync re-embeds them`);
    // Not marked checked: a write racing the delete is checked by the next query.
    return loadCentered(indexPath, name);
}

export async function init(router) {
    router.post('/query-multi', async (request, response) => {
        try {
            const { collectionIds, searchText, source, sourceSettings } = request.body ?? {};

            if (!Array.isArray(collectionIds) || !searchText) {
                return response.status(400).send({ error: 'collectionIds and searchText are required' });
            }
            // A bound, not validation: every collection id costs a full index load.
            if (collectionIds.length > 64) {
                return response.status(400).send({ error: 'too many collectionIds (max 64)' });
            }
            // No length bound: the embedder's context is the limit, and its own error comes back as a 502.
            if (typeof searchText !== 'string') {
                return response.status(400).send({ error: 'searchText must be a string' });
            }

            // 422 and 502 are the provider's, never a version mismatch: the client falls back without reporting skew.
            if (!EMBED_ROUTES.get(String(source))) {
                return response.status(422).send({ error: `the plugin cannot embed a query for source "${source}"` });
            }

            const topK = Math.min(admitCeiling(true), Math.max(1, Number(request.body.topK) || 10));
            const settings = { ...sourceSettings, model: modelScope(String(source), sourceSettings ?? {}) };
            // Lexical fields a client may still send (threshold, bm25K1, bm25B, termWeights, stopwordDf) are ignored; never reject them.
            const opts = {
                centered: request.body.centered !== false,
            };
            // `{ collectionId: [uid, ...] }` defining each collection's centroid; absent means every chunk, which is what an older client sends.
            const centroidUids = request.body.centroidUids ?? {};

            const indexPaths = collectionIds.map(collectionId => getIndexPath(request.user.directories, String(collectionId), String(source), settings.model));
            const loading = Promise.all(indexPaths.map((indexPath, i) => loadCentered(indexPath, String(collectionIds[i]))));
            loading.catch(() => {});   // surfaced by the await below; without this an embed failure leaves an unhandled rejection
            let queryVector;
            try {
                queryVector = await embed(String(source), settings, String(searchText), request.user.directories, request);
            } catch (error) {
                console.warn(`[WorldsApart] ${source} could not embed the query: ${error?.message ?? error}`);
                return response.status(502).send({ error: String(error?.message ?? error) });
            }
            const dim = rowDim(queryVector);
            if (!dim) return response.status(502).send({ error: `${source} returned no query vector` });
            queryDims.set(scopeKey(request.user.directories, source, settings.model), dim);
            const results = [];
            const loadedAll = await loading;

            for (let i = 0; i < collectionIds.length; i++) {
                const collectionId = collectionIds[i];
                const loaded = loadedAll[i] ? await dropForeignRows(indexPaths[i], String(collectionId), loadedAll[i], dim) : loadedAll[i];

                if (!loaded) {
                    continue;
                }

                const mean = centroidFor(loaded, centroidUids[String(collectionId)]);
                results.push(...scoreCollection(String(collectionId), mean === loaded.mean ? loaded : { ...loaded, mean }, queryVector, opts));
            }

            // Pool to entries FIRST, then cut, so topK counts entries.
            return response.send(selectTopK(poolEntries(results), topK));
        } catch (error) {
            console.error('[WorldsApart] query failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    /** Counts of MESSAGES containing each key across chat histories, read line by line server-side so no chat crosses the
     *  wire (P1). Every key kind: countChatHits is the shipped matcher, deployed beside this file.
     *  Body `{ keys: string[], chats: [{ dir, file }], wordBoundary }` (dir is the character directory), reply `{ counts, typed, messages, unit, scanned, missing, partial }`. */
    async function scanChats(request, response) {
        try {
            const keys = Array.isArray(request.body?.keys) ? request.body.keys.map(String).filter(Boolean) : [];
            const chats = Array.isArray(request.body?.chats) ? request.body.chats : [];
            if (!keys.length || !chats.length) {
                return response.status(400).send({ error: 'keys and chats are required' });
            }
            if (keys.length > 10000 || chats.length > 5000) {
                return response.status(400).send({ error: 'too many keys or chats' });
            }
            // wordBoundary and matchWindow are the caller's settings, required: never default them.
            const wordBoundary = String(request.body?.wordBoundary ?? '');
            if (!BOUNDARY_MODES.includes(wordBoundary)) return response.status(400).send({ error: `wordBoundary must be one of ${BOUNDARY_MODES.join(', ')}` });
            const matchWindow = String(request.body?.matchWindow ?? '');
            if (!MATCH_WINDOWS.includes(matchWindow)) return response.status(400).send({ error: `matchWindow must be one of ${MATCH_WINDOWS.join(', ')}` });
            const unitOpts = { matchWindow, depth: Number(request.body?.depth) || 0, includeNames: Boolean(request.body?.includeNames) };
            // The elements WA strips from every message it reads live, so the audit counts the same text the runtime does.
            const dropChatTags = String(request.body?.dropChatTags ?? '').trim();

            const totals = new Map(), typedTotals = new Map();
            let messages = 0, scanned = 0, missing = 0, partial = 0, unit = 'message';

            for (const entry of chats) {
                const dir = sanitize(String(entry?.dir ?? ''));
                const file = sanitize(String(entry?.file ?? ''));
                if (!dir || !file) { missing++; continue; }
                const full = path.join(request.user.directories.chats, dir, file.endsWith('.jsonl') ? file : `${file}.jsonl`);
                if (!fs.existsSync(full)) { missing++; continue; }
                scanned++;
                let unreadable = false;
                const texts = [];
                await new Promise(resolve => {
                    const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });
                    rl.on('line', line => {
                        if (!line) return;
                        let m;
                        try { m = JSON.parse(line); } catch { return; }   // line 0 is metadata
                        // Hidden messages are not scanned live (C3), so they are not counted here.
                        if (m?.is_system || !String(m?.mes ?? '')) return;
                        texts.push({ name: m.name, mes: dropChatTags ? dropTags(String(m.mes), dropChatTags) : String(m.mes), is_user: Boolean(m.is_user) });
                    });
                    rl.on('close', resolve);
                    // An unreadable chat is skipped, not fatal — but counted, or the totals silently under-report.
                    rl.on('error', () => { unreadable = true; resolve(); });
                });
                if (unreadable) partial++;
                // This file under its own values: the caller's {{char}} for it, and {{user}} off its user messages, over the caller's map.
                const user = chatUser(texts);
                const macros = { ...(request.body?.macros ?? {}), ...(entry?.macros ?? {}), ...(user ? { '{{user}}': user } : {}) };
                // One file at a time, then merged: a hit is per message, so where the scan is split cannot change the total.
                const got = countChatHits(keys, texts, { ...unitOpts, scope: createScanScope({ macros, boundary: wordBoundary }) });
                for (const [k, n] of got.messagesWith) totals.set(k, (totals.get(k) ?? 0) + n);
                for (const [k, n] of got.typedWith) typedTotals.set(k, (typedTotals.get(k) ?? 0) + n);
                messages += got.messages;
                unit = got.unit;
            }

            // Null-prototype: the keys are the caller's, and `counts['__proto__'] = n` on a plain object hits the setter and is dropped from the reply.
            const counts = Object.create(null), typed = Object.create(null);
            for (const k of keys) {
                counts[k] = totals.get(k) ?? 0;
                if (typedTotals.has(k)) typed[k] = typedTotals.get(k);
            }
            return response.send({ counts, typed, messages, unit, scanned, missing, partial });
        } catch (error) {
            console.error('WorldsApart: /scan-chats failed', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    }

    router.post('/scan-chats', scanChats);

    /** A chat file's line-0 metadata, null when unreadable; stops at line 0. */
    const chatMetadataOf = full => new Promise(resolve => {
        const stream = fs.createReadStream(full);
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        let done = false;
        // destroy, not just rl.close(): close only pauses the stream, and a stream paused at line 0 never autocloses its fd.
        const finish = v => { if (!done) { done = true; rl.close(); stream.destroy(); resolve(v); } };
        rl.on('line', line => { try { finish(JSON.parse(line)?.chat_metadata ?? null); } catch { finish(null); } });
        rl.on('close', () => finish(null));
        rl.on('error', () => finish(null));
    });
    /** A chat's binding and, only on a chat that holds one, `fired`, the WA latch record. */
    const bindingOf = meta => {
        const fired = meta?.[WA_METADATA_KEY]?.fired;
        return { world_info: meta?.world_info ? String(meta.world_info) : null, ...(fired && typeof fired === 'object' ? { fired } : {}) };
    };

    /** `fn` over `items`, at most CHAT_READS_MAX at a time, results in `items` order. */
    const mapBounded = async (items, fn) => {
        const out = new Array(items.length);
        let next = 0;
        const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
        await Promise.all(Array.from({ length: Math.min(CHAT_READS_MAX, items.length) }, worker));
        return out;
    };

    /** Every chat's line-0 binding (P1): `bindings` `{ dir, file, size, world_info }` per character chat, `groups` `{ id, world_info }`. */
    router.post('/chat-bindings', async (request, response) => {
        try {
            const root = request.user.directories.chats;
            const files = [];
            if (fs.existsSync(root)) {
                for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
                    if (!dir.isDirectory()) continue;
                    let names;
                    try { names = fs.readdirSync(path.join(root, dir.name)); } catch { continue; }   // deleted mid-scan or unreadable: skipped, as an unreadable file is listed
                    for (const file of names) if (file.endsWith('.jsonl')) files.push({ dir: dir.name, file });
                }
            }
            const bindings = await mapBounded(files, async ({ dir, file }) => {
                const full = path.join(root, dir, file);
                const meta = await chatMetadataOf(full);
                let size = null;
                try { size = fs.statSync(full).size; } catch { /* unreadable: listed without a size */ }
                return { dir, file, size, ...bindingOf(meta) };
            });
            const groupRoot = request.user.directories.groupChats;
            const groupFiles = groupRoot && fs.existsSync(groupRoot) ? fs.readdirSync(groupRoot).filter(f => f.endsWith('.jsonl')) : [];
            const groups = await mapBounded(groupFiles, async file => ({ id: file.replace(/\.jsonl$/, ''), ...bindingOf(await chatMetadataOf(path.join(groupRoot, file))) }));
            return response.send({ bindings, groups, chats: files.length });
        } catch (error) {
            console.error('WorldsApart: /chat-bindings failed', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    /** Every WA collection on disk, `current` when it is where `{ source, sourceSettings }` read; `model` is the sanitized directory name. */
    router.post('/collections', (request, response) => {
        try {
            const { source, sourceSettings } = request.body ?? {};
            const now = source ? { source: sanitize(String(source)), model: sanitize(modelScope(String(source), sourceSettings ?? {})) } : null;
            const root = request.user.directories.vectors;
            const out = [];
            const push = (sourceName, collectionId, model, stat) => out.push({
                source: sourceName, collectionId, model, bytes: stat.size, mtimeMs: stat.mtimeMs,
                current: Boolean(now) && sourceName === now.source && model === now.model,
            });
            const indexStat = dir => fs.statSync(path.join(dir, 'index.json'), { throwIfNoEntry: false });
            for (const src of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
                if (!src.isDirectory()) continue;
                const sourceDir = path.join(root, src.name);
                for (const coll of fs.readdirSync(sourceDir, { withFileTypes: true })) {
                    if (!coll.isDirectory() || !coll.name.startsWith('wa_')) continue;
                    const collDir = path.join(sourceDir, coll.name);
                    const flat = indexStat(collDir);
                    if (flat) push(src.name, coll.name, '', flat);
                    for (const model of fs.readdirSync(collDir, { withFileTypes: true })) {
                        if (!model.isDirectory()) continue;
                        const stat = indexStat(path.join(collDir, model.name));
                        if (stat) push(src.name, coll.name, model.name, stat);
                    }
                }
            }
            return response.send(out);
        } catch (error) {
            console.error('[WorldsApart] collections failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    /** Copies the rows any other WA collection under the same source and model holds for `hashes` into `collectionId`, so a
     *  cloned book (STMemoryBooks' copy-on-branch, a rename) is not re-embedded. A hash is (text, uid) and the directory is the
     *  model, so a hit is the same vector. Body `{ collectionId, hashes, source, sourceSettings }`, reply `{ adopted: number[] }`. */
    router.post('/adopt', async (request, response) => {
        try {
            const { collectionId, hashes, source, sourceSettings } = request.body ?? {};
            if (typeof collectionId !== 'string' || !collectionId.startsWith('wa_') || !Array.isArray(hashes) || !hashes.length || !source) {
                return response.status(400).send({ error: 'collectionId (wa_*), hashes and source are required' });
            }
            if (hashes.length > 100000) {
                return response.status(400).send({ error: 'too many hashes (max 100000)' });
            }
            const model = modelScope(String(source), sourceSettings ?? {});
            const dirs = request.user.directories;
            const sourceDir = path.join(dirs.vectors, sanitize(String(source)));
            const wanted = new Set(hashes.map(Number));
            const found = new Map();
            // Undefined until this model directory is queried after startup, and while undefined any vector is taken.
            const dim = queryDims.get(scopeKey(dirs, source, model));
            // getIndexPath per sibling, not a fixed depth: an empty model scope (llamacpp, extras) puts index.json in the collection dir itself.
            // Newest first and capped: each sibling not in meanCache costs a whole index.json parse.
            const siblings = (fs.existsSync(sourceDir) ? fs.readdirSync(sourceDir, { withFileTypes: true }) : [])
                .filter(coll => coll.isDirectory() && coll.name.startsWith('wa_') && coll.name !== sanitize(collectionId))
                .map(coll => getIndexPath(dirs, coll.name, String(source), model))
                .map(dir => ({ dir, stat: statIndex(dir) }))
                .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
                .slice(0, ADOPT_SIBLINGS_MAX);
            for (const { dir, stat } of siblings) {
                if (found.size === wanted.size) break;
                // Read through a current cache entry, but never inserted: a sweep of siblings would evict the collections being queried.
                const cached = freshEntry(dir, stat);
                let items;
                try {
                    if (cached) items = (await cached.loaded)?.items ?? [];
                    else {
                        const sibling = new LocalIndex(dir);
                        if (!stat.mtimeMs || !await sibling.isIndexCreated()) continue;
                        items = await sibling.listItems();
                    }
                } catch (error) {
                    console.warn(`[WorldsApart] adopt skipped an unreadable sibling ${dir}: ${error?.message ?? error}`);
                    continue;
                }
                for (const it of items) {
                    const h = Number(it.metadata?.hash);
                    if (wanted.has(h) && !found.has(h) && rowDim(it.vector) && (!dim || rowDim(it.vector) === dim)) found.set(h, it);
                }
            }
            if (found.size) {
                const target = new LocalIndex(getIndexPath(dirs, collectionId, String(source), model));
                if (!await target.isIndexCreated()) await target.createIndex();
                await target.beginUpdate();
                for (const it of found.values()) await target.insertItem({ vector: it.vector, metadata: it.metadata });
                await target.endUpdate();
            }
            console.log(`[WorldsApart] ${collectionId}: adopted ${found.size}/${wanted.size} chunks from sibling collections`);
            return response.send({ adopted: [...found.keys()] });
        } catch (error) {
            console.error('[WorldsApart] adopt failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    router.post('/ping', (request, response) => {
        // Whether an install for all users sits under the caller's folder name; a per-user copy of that name hides it from that user.
        const dir = sanitize(String(request.body?.dir ?? ''));
        const shared = Boolean(dir) && fs.existsSync(path.join(ST_ROOT, 'public', 'scripts', 'extensions', 'third-party', dir, 'manifest.json'));
        response.send({ ok: true, id: info.id, root: ST_ROOT, fingerprint: FINGERPRINT, loader: LOADER, install: INSTALL, shared,
            // Where the deploy command for a per-user install lives: dataRoot may be relocated outside the ST root.
            dataRoot: path.resolve(ST_ROOT, String(getConfigValue('dataRoot', './data'))) });
    });

    console.log('[WorldsApart] server plugin ready at /api/plugins/worlds-apart');
}

export async function exit() {
    meanCache.clear();
}

export default { info, init, exit };
