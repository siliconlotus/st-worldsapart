/**
 * Worlds Apart — server plugin (SOURCE).
 *
 * This file lives in the extension repo so the plugin and the extension travel as one
 * unit. `/plugins/worlds-apart/` is a generated COPY: run `node deploy-plugin.mjs` to
 * materialise it (see that script). Do not hand-edit the copy — edit here and redeploy.
 *
 * The retrieval math (tokenize / BM25 / centered cosine / top-K selection) is imported
 * from ./scoring.mjs, the single source shared with the extension and the offline
 * harnesses, so the reproductions cannot drift from what the server actually runs.
 *
 * Adds a mean-centered vector query over the collections the Worlds Apart client
 * extension already populates through ST's own /api/vector/insert. Nothing here
 * modifies SillyTavern; it mounts at /api/plugins/worlds-apart.
 *
 * Why centering: in a single-story corpus every chunk shares a large common direction
 * (the recurring cast, the narrative register). Measured on a real lorebook the corpus
 * mean vector had norm 0.71 — roughly 70% of every embedding was that shared direction —
 * which compresses all similarities into a narrow band near 0.6. Subtracting the mean
 * before comparing removes that offset and leaves the topical variance that actually
 * discriminates.
 *
 * Note: this imports ST internals (src/vectors/*) by relative path resolved from the
 * DEPLOYED location (/plugins/worlds-apart/). That is not a public API and may move
 * between ST versions; the client falls back to the stock endpoint when this plugin is
 * unavailable.
 */

import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';
import { LocalIndex } from 'vectra';
import { getOllamaVector } from '../../src/vectors/ollama-vectors.js';
import { scoreCollection, poolEntries, selectTopK } from './scoring.mjs';
// Same matcher and text fold the extension uses for keyword hits — shared, not copied, so a chat scan and a
// live keyword match can never disagree about what a key matches.
import { buildAutomaton, addMessageHits, fold } from './automaton.mjs';
import { norm, corpusMean } from './vector.mjs';
import { pluginFingerprint, PLUGIN_FILES } from './fingerprint.mjs';

// This file sits at <root>/plugins/worlds-apart/index.js once deployed.
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
// SillyTavern root: /ping hands this to the extension so its settings panel can show a fully-
// absolute deploy command (the browser only knows the URL path, not the server's filesystem root).
const ST_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
// Fingerprint of this deployed copy, computed from its own files. The extension compares it against
// the same hash over its source files to detect a /plugins copy that wasn't redeployed after a change.
const readDeployed = f => { try { return fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8'); } catch { return ''; } };
const FINGERPRINT = pluginFingerprint(...PLUGIN_FILES.map(([, deployed]) => readDeployed(deployed)));

export const info = {
    id: 'worlds-apart',
    name: 'Worlds Apart',
    description: 'Mean-centered vector search for World Info retrieval.',
};

/**
 * Cached corpus statistics (items included — listItems() re-parses the whole index file, so it
 * only runs when index.json's mtime changes), keyed by index path.
 * @type {Map<string, { items: object[], mean: Float64Array, mtimeMs: number, size: number }>}
 */
const meanCache = new Map();

/**
 * Embeds the query. Only the providers listed here are supported for centered
 * search; anything else should fall back to ST's own endpoint client-side.
 * @param {string} source Vector source
 * @param {object} sourceSettings Provider settings
 * @param {string} text Text to embed
 * @param {object} directories User directories
 * @returns {Promise<number[]>} Embedding
 */
async function embed(source, sourceSettings, text, directories) {
    switch (source) {
        case 'ollama':
            return await getOllamaVector(
                text,
                sourceSettings.apiUrl,
                sourceSettings.model,
                Boolean(sourceSettings.keep),
                directories,
            );
        default:
            throw new Error(`Worlds Apart: centered search does not support source "${source}"`);
    }
}

/**
 * Resolves the on-disk index path, matching ST's own layout.
 * @param {object} directories User directories
 * @param {string} collectionId Collection ID
 * @param {string} source Vector source
 * @param {string} model Model name
 * @returns {string} Index path
 */
function getIndexPath(directories, collectionId, source, model) {
    // Must match src/endpoints/vectors.js getIndex() exactly, or we'd read a different
    // directory than the one ST wrote to.
    return path.join(directories.vectors, sanitize(source), sanitize(collectionId), sanitize(String(model ?? '')));
}

/**
 * Loads an index's items and its cached corpus mean.
 * The mean is recomputed when index.json changes on disk, which covers inserts
 * and deletes without needing an explicit invalidation hook.
 * @param {string} indexPath Path to the index
 * @returns {Promise<{items: object[], mean: Float64Array} | null>}
 */
/**
 * The centroid over a NAMED SUBSET of a loaded collection, memoised on the loaded object.
 *
 * Cached per uid set rather than recomputed per query: the set is the book's vectorized entries, which
 * changes only when the author changes a flag, while a query arrives every generation. The cache dies
 * with the loaded collection, so an index rewrite drops it along with the items it described.
 *
 * @param {{items: object[], mean: Float64Array}} loaded
 * @param {number[]|undefined} uids Entries that define the corpus; absent or empty means all of them
 * @returns {Float64Array}
 */
function centroidFor(loaded, uids) {
    if (!Array.isArray(uids) || !uids.length) return loaded.mean;
    const key = uids.join(',');
    loaded.subsetMeans ??= new Map();
    const hit = loaded.subsetMeans.get(key);
    if (hit) return hit;
    const wanted = new Set(uids.map(Number));
    const subset = loaded.items.filter(it => wanted.has(Number(it.metadata?.index)));
    // An empty subset would divide by zero and return NaNs, which score as nothing and look like a bad
    // model rather than a bad request. Falling back to the full corpus is the old behaviour.
    const mean = subset.length ? corpusMean(subset) : loaded.mean;
    loaded.subsetMeans.set(key, mean);
    console.log(`[Worlds Apart] centroid over ${subset.length}/${loaded.items.length} chunks (${wanted.size} entries define the corpus)`);
    return mean;
}

async function loadCentered(indexPath) {
    // Validity key is mtime AND size: two rapid writes can land in one mtime tick (or a
    // coarse-mtime mount can hide one entirely), and serving a stale item set from that would
    // silently drop chunks from retrieval. Size catches the realistic case (chunk count changed).
    const stat = fs.statSync(path.join(indexPath, 'index.json'), { throwIfNoEntry: false });
    const mtimeMs = stat?.mtimeMs ?? 0;
    const size = stat?.size ?? 0;
    const cached = meanCache.get(indexPath);

    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
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
    // No lexical index: stage 1 is cosine-only, so building postings here was work nothing read.
    const loaded = { items, mean, mtimeMs, size };

    meanCache.set(indexPath, loaded);
    console.log(`[Worlds Apart] indexed ${path.basename(path.dirname(indexPath))}: ${items.length} chunks, mean norm ${norm(mean).toFixed(4)}`);

    return loaded;
}

/**
 * @param {import('express').Router} router Plugin router
 */
export async function init(router) {
    router.post('/query-multi', async (request, response) => {
        try {
            const { collectionIds, searchText, source, sourceSettings } = request.body ?? {};

            if (!Array.isArray(collectionIds) || !searchText) {
                return response.status(400).send({ error: 'collectionIds and searchText are required' });
            }

            const topK = Number(request.body.topK) || 10;
            const settings = sourceSettings ?? {};
            // Stage 1 is cosine-only (scoring.mjs header). The lexical fields a client may still send —
            // threshold, bm25K1, bm25B, termWeights, stopwordDf — are IGNORED rather
            // than rejected: an extension and a deployed plugin drift apart across a redeploy, and a
            // stricter reading here would turn that ordinary skew into a 400 on every query.
            const opts = {
                centered: request.body.centered !== false,
                uncenteredGate: Number(request.body.uncenteredGate) || 0,
            };
            // WHICH ENTRIES DEFINE THE CENTROID, per collection: `{ collectionId: [uid, ...] }`.
            //
            // THE CORPUS AND THE SCORED SET ARE NO LONGER THE SAME. A collection now holds every entry
            // with content, so that a keyword-activated entry has a cosine at stage 3 — but the centroid
            // must stay the ADMITTED corpus, or every fitted coefficient and every cosine measured
            // against it moves. Mean-centering subtracts a vector carrying most of an embedding's mass,
            // so widening it is not a small change.
            //
            // ABSENT MEANS EVERYTHING COUNTS, which is exactly the old behaviour and what an older
            // client sends. A deployed plugin and an extension drift across a redeploy; this way the
            // skew costs nothing rather than silently recentering the corpus.
            const centroidUids = request.body.centroidUids ?? {};

            // The disk loads and the embed round-trip are independent — run them concurrently.
            const loading = Promise.all(collectionIds.map(collectionId =>
                loadCentered(getIndexPath(request.user.directories, String(collectionId), String(source), settings.model))));
            loading.catch(() => {});   // surfaced by the await below; without this an embed failure leaves an unhandled rejection
            const queryVector = await embed(String(source), settings, String(searchText), request.user.directories);
            const results = [];
            const loadedAll = await loading;

            for (let i = 0; i < collectionIds.length; i++) {
                const collectionId = collectionIds[i];
                const loaded = loadedAll[i];

                if (!loaded) {
                    continue;
                }

                // Score this collection with the shared math: centered cosine, every chunk kept
                // except what the wrong-book gate drops.
                const mean = centroidFor(loaded, centroidUids[String(collectionId)]);
                results.push(...scoreCollection(String(collectionId), mean === loaded.mean ? loaded : { ...loaded, mean }, queryVector, opts));
            }

            // Pool each entry's best chunk FIRST, then cut. Pooling before the cut is what makes topK a
            // count of entries and the per-entry maxima exact — see poolEntries.
            return response.send(selectTopK(poolEntries(results), topK));
        } catch (error) {
            console.error('[Worlds Apart] query failed:', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    /**
     * Scan chat histories for a set of literal keys, returning only counts.
     *
     * WHY SERVER-SIDE. The client can do this itself by fetching each chat, and for a localhost install that
     * is fine — but the chats are the largest thing SillyTavern owns (measured: 190 chats, 1.2GB, individual
     * files 12-17MB) and a served instance would pull all of it over the network to answer a question whose
     * answer is a few hundred integers. The keys go up, the counts come back, the histories never move.
     *
     * Streams line by line: a chat is JSONL, so this never holds a whole history in memory, and one
     * Aho-Corasick pass per message keeps the cost O(text) regardless of how many keys are checked.
     *
     * Body: { keys: string[], chats: [{ dir, file }] }  — dir is the character directory (avatar minus .png)
     * Reply: { counts: { key: n }, messages, scanned, missing }
     */
    router.post('/scan-chats', async (request, response) => {
        try {
            const keys = Array.isArray(request.body?.keys) ? request.body.keys.map(String).filter(Boolean) : [];
            const chats = Array.isArray(request.body?.chats) ? request.body.chats : [];
            if (!keys.length || !chats.length) {
                return response.status(400).send({ error: 'keys and chats are required' });
            }

            // Deduped by FOLDED form: two keys can fold together, and the automaton indexes the list it is given.
            const folded = [...new Set(keys.map(fold))];
            const idxOf = new Map(folded.map((f, i) => [f, i]));
            const automaton = buildAutomaton(folded);
            const totals = new Map();
            let messages = 0, scanned = 0, missing = 0;

            for (const entry of chats) {
                const dir = sanitize(String(entry?.dir ?? ''));
                const file = sanitize(String(entry?.file ?? ''));
                if (!dir || !file) { missing++; continue; }
                const full = path.join(request.user.directories.chats, dir, file.endsWith('.jsonl') ? file : `${file}.jsonl`);
                if (!fs.existsSync(full)) { missing++; continue; }
                scanned++;
                await new Promise(resolve => {
                    const rl = readline.createInterface({ input: fs.createReadStream(full), crlfDelay: Infinity });
                    rl.on('line', line => {
                        if (!line) return;
                        let text = '';
                        try { text = String(JSON.parse(line)?.mes ?? ''); } catch { return; }   // line 0 is metadata
                        if (!text) return;
                        messages++;
                        addMessageHits(automaton, text, totals);
                    });
                    rl.on('close', resolve);
                    rl.on('error', resolve);   // an unreadable chat is skipped, not fatal
                });
            }

            const counts = {};
            for (const k of keys) counts[k] = totals.get(idxOf.get(fold(k))) ?? 0;
            return response.send({ counts, messages, scanned, missing });
        } catch (error) {
            console.error('Worlds Apart: /scan-chats failed', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    /**
     * Every chat's lorebook binding, and nothing else.
     *
     * ST's /api/characters/chats streams EVERY LINE of every chat to count messages and grab the last
     * one, even when the caller asked only for metadata — 1.28GB and 3.2s on a real corpus, against
     * 0.06s to read the one line the binding lives on. Fifty-three times the work, per Studio session,
     * to answer "which book does this chat name".
     *
     * Returns [{ dir, file, world_info }] for every chat that names a book. The caller pairs it with
     * the character list it already has in memory for card bindings.
     */
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
                    const world = await new Promise(resolve => {
                        const rl = readline.createInterface({ input: fs.createReadStream(path.join(dirPath, file)), crlfDelay: Infinity });
                        let done = false;
                        const finish = v => { if (!done) { done = true; rl.close(); resolve(v); } };
                        // Line 0 is the metadata header; stop there rather than streaming the chat.
                        rl.on('line', line => { try { finish(JSON.parse(line)?.chat_metadata?.world_info ?? null); } catch { finish(null); } });
                        rl.on('close', () => finish(null));
                        rl.on('error', () => finish(null));
                    });
                    if (world) bindings.push({ dir: dir.name, file, world_info: String(world) });
                }
            }
            return response.send({ bindings, chats });
        } catch (error) {
            console.error('Worlds Apart: /chat-bindings failed', error);
            return response.status(500).send({ error: String(error?.message ?? error) });
        }
    });

    // WHAT IS ON DISK, so the client can tell it from what is still claimed. WA's collections are
    // `vectors/<source>/wa_<hash(world)>/<model>/`, and NOTHING has ever removed one: chunk-level pruning
    // only fires for a book being synced, so a renamed, deleted or detached book — or a switch of
    // embedding source or model — leaves a whole collection behind, invisible to it by construction.
    //
    // REPORTS, NEVER DELETES. These are vectors somebody paid embedding time for, and the client cannot
    // always tell a dead collection from one belonging to a book that is simply not attached right now.
    // Size and mtime only: counting chunks means parsing an index.json that runs to hundreds of MB.
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

    router.post('/ping', (_request, response) => response.send({ ok: true, id: info.id, root: ST_ROOT, fingerprint: FINGERPRINT }));

    console.log('[Worlds Apart] server plugin ready at /api/plugins/worlds-apart');
}

export async function exit() {
    meanCache.clear();
}

export default { info, init, exit };
