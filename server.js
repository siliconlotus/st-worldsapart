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
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';
import { LocalIndex } from 'vectra';
import { getOllamaVector } from '../../src/vectors/ollama-vectors.js';
import { pluginFingerprint, DEFAULT_K1, DEFAULT_B, buildLexical, norm, scoreCollection, selectTopK, corpusMean } from './scoring.mjs';

// This file sits at <root>/plugins/worlds-apart/index.js once deployed.
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
// SillyTavern root: /ping hands this to the extension so its settings panel can show a fully-
// absolute deploy command (the browser only knows the URL path, not the server's filesystem root).
const ST_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
// Fingerprint of this deployed copy, computed from its own files. The extension compares it against
// the same hash over its source files to detect a /plugins copy that wasn't redeployed after a change.
const readDeployed = f => { try { return fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8'); } catch { return ''; } };
const FINGERPRINT = pluginFingerprint(readDeployed('scoring.mjs'), readDeployed('commonwords.js'), readDeployed('index.js'));

export const info = {
    id: 'worlds-apart',
    name: 'Worlds Apart',
    description: 'Mean-centered vector search for World Info retrieval.',
};

/**
 * Cached corpus statistics, keyed by index path.
 * @type {Map<string, { mean: Float64Array, lexical: object, mtimeMs: number, count: number }>}
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
 * @returns {Promise<{items: object[], mean: Float64Array, lexical: object} | null>}
 */
async function loadCentered(indexPath) {
    const index = new LocalIndex(indexPath);

    if (!await index.isIndexCreated()) {
        return null;
    }

    const items = await index.listItems();

    if (!items.length) {
        return null;
    }

    const file = path.join(indexPath, 'index.json');
    const mtimeMs = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    const cached = meanCache.get(indexPath);

    if (cached && cached.mtimeMs === mtimeMs && cached.count === items.length) {
        return { items, mean: cached.mean, lexical: cached.lexical };
    }

    const mean = corpusMean(items);
    const lexical = buildLexical(items);

    meanCache.set(indexPath, { mean, lexical, mtimeMs, count: items.length });
    console.log(`[Worlds Apart] indexed ${path.basename(path.dirname(indexPath))}: ${items.length} chunks, mean norm ${norm(mean).toFixed(4)}, ${lexical.postings.size} lexical terms, avg ${lexical.avgdl.toFixed(0)} tokens/chunk`);

    return { items, mean, lexical };
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
            const opts = {
                centered: request.body.centered !== false,
                threshold: Number(request.body.threshold) || 0,
                queryText: String(searchText),
                k1: Number(request.body.bm25K1) > 0 ? Number(request.body.bm25K1) : DEFAULT_K1,
                b: Number.isFinite(Number(request.body.bm25B)) ? Number(request.body.bm25B) : DEFAULT_B,
                termWeights: request.body.termWeights && typeof request.body.termWeights === 'object' ? request.body.termWeights : null,
                stopwordDf: Number(request.body.stopwordDf) || 0,
                commonWordWeight: Number.isFinite(Number(request.body.commonWordWeight)) ? Number(request.body.commonWordWeight) : 1,
            };

            const queryVector = await embed(String(source), settings, String(searchText), request.user.directories);
            const results = [];

            for (const collectionId of collectionIds) {
                const indexPath = getIndexPath(request.user.directories, String(collectionId), String(source), settings.model);
                const loaded = await loadCentered(indexPath);

                if (!loaded) {
                    continue;
                }

                // Score this collection with the shared math: centered cosine + BM25, keeping
                // any chunk either signal likes (score >= threshold OR bm25 > 0).
                results.push(...scoreCollection(String(collectionId), loaded, queryVector, opts));
            }

            // Union the top-K of each ranking, grouped by collection, so a chunk that only
            // one signal likes still reaches the client and can win on fusion.
            return response.send(selectTopK(results, topK));
        } catch (error) {
            console.error('[Worlds Apart] query failed:', error);
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
