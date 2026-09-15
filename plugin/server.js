// server.js — Worlds Apart server plugin (source); /plugins/worlds-apart/ is the generated copy, so edit here and
// `node deploy-plugin.mjs`. Mounts at /api/plugins/worlds-apart; imports ST internals (src/vectors/*) by relative path.

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';
import { LocalIndex } from 'vectra';
import { getTransformersVector } from '../../src/vectors/embedding.js';
import { getOllamaVector } from '../../src/vectors/ollama-vectors.js';
import { getVllmVector } from '../../src/vectors/vllm-vectors.js';
import { getOpenAIVector } from '../../src/vectors/openai-vectors.js';
import { getCohereVector } from '../../src/vectors/cohere-vectors.js';
import { getLlamaCppVector } from '../../src/vectors/llamacpp-vectors.js';
import { getNomicAIVector } from '../../src/vectors/nomicai-vectors.js';
import { getExtrasVector } from '../../src/vectors/extras-vectors.js';
import { getMakerSuiteVector, getVertexVector } from '../../src/vectors/google-vectors.js';
import { getConfigValue } from '../../src/util.js';
import { scoreCollection, poolEntries, selectTopK } from './scoring.mjs';
// Deployed flat beside this file from extension/ (fingerprint.mjs's manifest), so the server matches on the shipped matcher.
import { countChatHits, dropTags, setBoundaryMode } from './matcher.mjs';
import { norm, corpusMean, rowDim } from './vector.mjs';
import { pluginFingerprint, PLUGIN_FILES } from './fingerprint.mjs';

// Deployed location: <root>/plugins/worlds-apart/index.js.
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
// Walked, not counted: the same rule as eval/lib/st-install.mjs, which this cannot import — only PLUGIN_FILES deploys.
// Falls back to two up, the deployed depth, when no config.yaml is reachable.
const ST_ROOT = (() => {
    for (let d = PLUGIN_DIR; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, 'config.yaml'))) return d;
        if (path.dirname(d) === d) return path.resolve(PLUGIN_DIR, '..', '..');
    }
})();
// The deployed copy's own fingerprint; the extension compares it with the same hash over its source files.
const readDeployed = f => { try { return fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8'); } catch { return ''; } };
const FINGERPRINT = pluginFingerprint(...PLUGIN_FILES.map(([, deployed]) => readDeployed(deployed)));

export const info = {
    id: 'worlds-apart',
    name: 'Worlds Apart',
    description: 'Mean-centered vector search for World Info retrieval.',
};

/** Corpus statistics per index path, reloaded when index.json's mtime or size changes. Re-insertion on a hit makes the
 *  Map an LRU, and the cap keeps every queried collection's full item list from staying resident until exit.
 *  @type {Map<string, { items: object[], mean: Float64Array, mtimeMs: number, size: number }>} */
const MEAN_CACHE_MAX = 16;
const meanCache = new Map();

/** Embeds the QUERY for every source ST can address — a mirror of ST's module-private `getVector` and `getSourceSettings`
 *  (src/endpoints/vectors.js); eval/embed-sources-check.mjs fails when ST's SOURCES outgrows this switch. `request` is the
 *  plugin's own Express request, which Google's vectors read credentials off. */
async function embed(source, s, text, directories, request) {
    const openAiish = (urlOverride = null) => getOpenAIVector(text, source, directories, String(s.model), urlOverride);
    switch (source) {
        case 'transformers': return await getTransformersVector(text);
        case 'nomicai':      return await getNomicAIVector(text, source, directories);
        case 'extras':       return await getExtrasVector(text, s.extrasUrl, s.extrasKey);
        case 'palm':         return await getMakerSuiteVector(text, String(s.model), request);
        case 'vertexai':     return await getVertexVector(text, String(s.model), request);
        // isQuery is true: this only ever embeds the QUERY.
        case 'cohere':       return await getCohereVector(text, true, directories, String(s.model));
        case 'llamacpp':     return await getLlamaCppVector(text, s.apiUrl, directories);
        case 'vllm':         return await getVllmVector(text, s.apiUrl, String(s.model), directories);
        case 'ollama':       return await getOllamaVector(text, s.apiUrl, String(s.model), Boolean(s.keep), directories);
        case 'siliconflow':  return await openAiish(s.siliconflow_endpoint === 'cn' ? 'https://api.siliconflow.cn/v1' : null);
        case 'workers_ai': {
            const accountId = String(s.workers_ai_account_id || '').trim();
            return await openAiish(accountId
                ? `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`
                : null);
        }
        case 'webllm': case 'koboldcpp':
            // Vector Storage embeds these in the browser; thrown so the client falls back.
            throw new Error(`Worlds Apart: source "${source}" embeds in the browser — the plugin cannot embed a query for it.`);
        case 'openai': case 'togetherai': case 'mistral': case 'chutes': case 'electronhub': case 'nanogpt': case 'openrouter':
            return await openAiish();
        default:
            throw new Error(`Worlds Apart: no embedding route for source "${source}" — `
                + 'the extension will fall back to stock vector search, which returns no scores, so stage 1 will have no cosine.');
    }
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
 *  full mean rather than NaN. The uid list is the client's, so it is bounded, and the memo is cleared at a cap —
 *  memoising every distinct subset for ever is how the map grew without bound. */
const SUBSET_MEANS_MAX = 64;
const CENTROID_UIDS_MAX = 10000;
function centroidFor(loaded, uids) {
    if (!Array.isArray(uids) || !uids.length) return loaded.mean;
    if (uids.length > CENTROID_UIDS_MAX) uids = uids.slice(0, CENTROID_UIDS_MAX);
    loaded.subsetMeans ??= new Map();
    if (loaded.subsetMeans.size >= SUBSET_MEANS_MAX) loaded.subsetMeans.clear();
    const key = uids.join(',');
    const hit = loaded.subsetMeans.get(key);
    if (hit) return hit;
    const wanted = new Set(uids.map(Number));
    const subset = loaded.items.filter(it => wanted.has(Number(it.metadata?.index)));
    const mean = subset.length ? corpusMean(subset) : loaded.mean;
    loaded.subsetMeans.set(key, mean);
    console.log(`[Worlds Apart] centroid over ${subset.length}/${loaded.items.length} chunks (${wanted.size} entries define the corpus)`);
    return mean;
}

/** An index's items and corpus mean, cached per path on mtime AND size: two writes can share an mtime tick. */
async function loadCentered(indexPath) {
    const stat = fs.statSync(path.join(indexPath, 'index.json'), { throwIfNoEntry: false });
    const mtimeMs = stat?.mtimeMs ?? 0;
    const size = stat?.size ?? 0;
    const cached = meanCache.get(indexPath);

    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        meanCache.delete(indexPath);
        meanCache.set(indexPath, cached);
        return cached;
    }

    const index = new LocalIndex(indexPath);

    if (!mtimeMs || !await index.isIndexCreated()) {
        return null;
    }

    const items = await index.listItems();

    if (!items.length) {
        return null;
    }

    const mean = corpusMean(items);
    const unusable = items.length - items.filter(it => rowDim(it?.vector)).length;
    if (unusable) console.warn(`[Worlds Apart] skipped ${unusable} of ${items.length} chunks with a missing or foreign-dimension vector — re-sync the book, or delete the collection if it was embedded under another model`);
    const loaded = { items, mean, mtimeMs, size };

    meanCache.set(indexPath, loaded);
    while (meanCache.size > MEAN_CACHE_MAX) meanCache.delete(meanCache.keys().next().value);
    console.log(`[Worlds Apart] indexed ${path.basename(path.dirname(indexPath))}: ${items.length} chunks, mean norm ${norm(mean).toFixed(4)}`);

    return loaded;
}

export async function init(router) {
    // One chat scan at a time, chained: setBoundaryMode is module-global in matcher.mjs, and two interleaved scans
    // would count under each other's boundary mode. Requests queue; none fails.
    let scanChain = Promise.resolve();

    router.post('/query-multi', async (request, response) => {
        try {
            const { collectionIds, searchText, source, sourceSettings } = request.body ?? {};

            if (!Array.isArray(collectionIds) || !searchText) {
                return response.status(400).send({ error: 'collectionIds and searchText are required' });
            }
            // Bounds, not validation: every collection id costs a full index load, and the query is forwarded to the embedder.
            if (collectionIds.length > 64) {
                return response.status(400).send({ error: 'too many collectionIds (max 64)' });
            }
            if (typeof searchText !== 'string' || searchText.length > 65536) {
                return response.status(400).send({ error: 'searchText must be a string of at most 65536 characters' });
            }

            const topK = Math.min(512, Math.max(1, Number(request.body.topK) || 10));
            const settings = { ...sourceSettings, model: modelScope(String(source), sourceSettings ?? {}) };
            // Lexical fields a client may still send (threshold, bm25K1, bm25B, termWeights, stopwordDf) are ignored, not rejected: a stricter reading turns redeploy skew into a 400.
            const opts = {
                centered: request.body.centered !== false,
            };
            // `{ collectionId: [uid, ...] }` defining each collection's centroid; absent means every chunk, which is what an older client sends.
            const centroidUids = request.body.centroidUids ?? {};

            const loading = Promise.all(collectionIds.map(collectionId =>
                loadCentered(getIndexPath(request.user.directories, String(collectionId), String(source), settings.model))));
            loading.catch(() => {});   // surfaced by the await below; without this an embed failure leaves an unhandled rejection
            const queryVector = await embed(String(source), settings, String(searchText), request.user.directories, request);
            const results = [];
            const loadedAll = await loading;

            for (let i = 0; i < collectionIds.length; i++) {
                const collectionId = collectionIds[i];
                const loaded = loadedAll[i];

                if (!loaded) {
                    continue;
                }

                const mean = centroidFor(loaded, centroidUids[String(collectionId)]);
                results.push(...scoreCollection(String(collectionId), mean === loaded.mean ? loaded : { ...loaded, mean }, queryVector, opts));
            }

            // Pool to entries FIRST, then cut, so topK counts entries.
            return response.send(selectTopK(poolEntries(results), topK));
        } catch (error) {
            console.error('[Worlds Apart] query failed:', error);
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
            // The caller's setting, required: a default here would disagree with the browser silently. Serialized through
            // `scanChain` — setBoundaryMode is module-global, and an interleaved scan would count under another scan's mode.
            const wordBoundary = String(request.body?.wordBoundary ?? '');
            if (!wordBoundary) return response.status(400).send({ error: 'wordBoundary is required' });
            setBoundaryMode(wordBoundary);
            // The unit the chat is cut into, the caller's setting as wordBoundary is; message when an older client sends none.
            const unitOpts = { matchWindow: String(request.body?.matchWindow ?? 'message'), depth: Number(request.body?.depth) || 0, includeNames: Boolean(request.body?.includeNames) };
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
                        texts.push({ name: m.name, mes: dropChatTags ? dropTags(String(m.mes), dropChatTags) : String(m.mes) });
                    });
                    rl.on('close', resolve);
                    // An unreadable chat is skipped, not fatal — but counted, or the totals silently under-report.
                    rl.on('error', () => { unreadable = true; resolve(); });
                });
                if (unreadable) partial++;
                // One file at a time, then merged: a hit is per message, so where the scan is split cannot change the total.
                const got = countChatHits(keys, texts, unitOpts);
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
            console.error('Worlds Apart: /scan-chats failed', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    }

    router.post('/scan-chats', (request, response) => {
        scanChain = scanChain.then(() => scanChats(request, response), () => scanChats(request, response));
    });

    /** `[{ dir, file, world_info, size }]` for EVERY chat, `world_info` null when line 0 names no book; line 0 is all
     *  that is read (P1). Every chat, not only the bound ones: a book attached through the character or globally
     *  reaches chats whose own metadata names nothing. */
    router.post('/chat-bindings', async (request, response) => {
        try {
            const root = request.user.directories.chats;
            if (!fs.existsSync(root)) return response.send({ bindings: [], chats: 0 });
            const bindings = [];
            let chats = 0;
            for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
                if (!dir.isDirectory()) continue;
                const dirPath = path.join(root, dir.name);
                for (const file of fs.readdirSync(dirPath)) {
                    if (!file.endsWith('.jsonl')) continue;
                    chats++;
                    const full = path.join(dirPath, file);
                    const world = await new Promise(resolve => {
                        const stream = fs.createReadStream(full);
                        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
                        let done = false;
                        // destroy, not just rl.close(): close only pauses the stream, and a stream paused at line 0 never autocloses its fd.
                        const finish = v => { if (!done) { done = true; rl.close(); stream.destroy(); resolve(v); } };
                        // Line 0 is the metadata header; stop there.
                        rl.on('line', line => { try { finish(JSON.parse(line)?.chat_metadata?.world_info ?? null); } catch { finish(null); } });
                        rl.on('close', () => finish(null));
                        rl.on('error', () => finish(null));
                    });
                    let size = null;
                    try { size = fs.statSync(full).size; } catch { /* unreadable: listed without a size */ }
                    bindings.push({ dir: dir.name, file, world_info: world ? String(world) : null, size });
                }
            }
            return response.send({ bindings, chats });
        } catch (error) {
            console.error('Worlds Apart: /chat-bindings failed', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    // Every WA collection on disk (`vectors/<source>/wa_<hash>/<model>/`), size and mtime only; reports, never deletes.
    router.post('/collections', (request, response) => {
        try {
            const root = request.user.directories.vectors;
            const out = [];
            for (const source of fs.readdirSync(root, { withFileTypes: true })) {
                if (!source.isDirectory()) continue;
                const sourceDir = path.join(root, source.name);
                for (const coll of fs.readdirSync(sourceDir, { withFileTypes: true })) {
                    if (!coll.isDirectory() || !coll.name.startsWith('wa_')) continue;
                    const collDir = path.join(sourceDir, coll.name);
                    for (const model of fs.readdirSync(collDir, { withFileTypes: true })) {
                        if (!model.isDirectory()) continue;
                        const index = path.join(collDir, model.name, 'index.json');
                        const stat = fs.statSync(index, { throwIfNoEntry: false });
                        if (!stat) continue;
                        out.push({ source: source.name, collectionId: coll.name, model: model.name, bytes: stat.size, mtimeMs: stat.mtimeMs });
                    }
                }
            }
            return response.send(out);
        } catch (error) {
            console.error('[Worlds Apart] collections failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    router.post('/ping', (request, response) => {
        response.send({ ok: true, id: info.id, root: ST_ROOT, fingerprint: FINGERPRINT });
    });

    console.log('[Worlds Apart] server plugin ready at /api/plugins/worlds-apart');
}

export async function exit() {
    meanCache.clear();
}

export default { info, init, exit };
