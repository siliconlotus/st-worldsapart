// reindex.mjs — rebuild a vector collection from a sample's embedded books, offline, into eval-data/indexes — never into ST's live vectors.
// Usage (any cwd):
//   node .../reindex.mjs <sample.json> [--chunkSize 400] [--chunkMode paragraph|length] [--minChunkSize 20]
//                        [--book <name>] [--out <index.json>] [--batch 64] [--force]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { chunkEntry } from '../extension/chunking.mjs';
import { getStringHash } from './scene.mjs';
import { arg } from './metrics.mjs';
import { openBundle } from '../extension/grading.mjs';
import { isMemory, PREFIXES } from '../extension/relevance.mjs';
import { defaultSettings } from '../extension/state.mjs';
import { fileURLToPath } from 'node:url';

/** Chunk settings, sample's own unless overridden. Field names match `settings()` and paramSnapshot.settings. */
export const chunkConfig = (S, overrides = {}) => {
    // paramSnapshot.settings only; the older grouped shape (vectors, cutoff, layout) is not read (P4).
    const p = S?.params ?? {};
    const recorded = {};
    for (const k of ['chunkMode', 'chunkSize', 'minChunkSize']) if (p[k] !== undefined) recorded[k] = p[k];
    const dumped = S.paramSnapshot?.settings ?? {};
    const fromDump = Object.fromEntries(['chunkMode', 'chunkSize', 'minChunkSize']
        .filter(k => dumped[k] !== undefined).map(k => [k, dumped[k]]));
    const shipped = { chunkMode: defaultSettings.chunkMode, chunkSize: defaultSettings.chunkSize, minChunkSize: defaultSettings.minChunkSize };
    return { ...shipped, ...fromDump, ...recorded, ...overrides };
};

/**
 * The exact item set syncWorld would store: vectorized && !disable && content entries, chunks trimmed and blanks dropped, one item per (entry, chunk) and NO de-duplication — collapsing shared text moves the entry ranking (P4).
 * `all` drops the vectorized gate; `archived` adds disabled memory entries as centroidOnly.
 * @returns {Array<{hash: number, text: string, index: number, centroidOnly?: boolean}>}
 */
export function buildItems(book, cfg, all = false, archived = false) {
    const items = [];
    for (const entry of Object.values(book)) {
        if (typeof entry.content !== 'string' || !entry.content) continue;
        const centroidOnly = Boolean(entry.disable);
        if (centroidOnly ? !(archived && isMemory(entry)) : (!all && !entry.vectorized)) continue;
        for (const chunk of chunkEntry(entry.content, cfg)) {
            const text = chunk.trim();
            if (!text) continue;
            // The uid lives IN the hash, mirroring syncWorld: ST core lists and deletes by hash only.
            const uid = Number(entry.uid);
            items.push({ hash: getStringHash(`${text}${uid}`), text, index: uid, ...(centroidOnly ? { centroidOnly: true } : {}) });
        }
    }
    return items;
}

/** Folds only the slash in a model label (a HuggingFace repo id would nest a directory); not a slug, every caller still hashes the raw label. */
export const pathSafe = (label) => String(label).replace(/\//g, '-');

export function cachePath(S, cfg, model, book = S.primaryBook, all = false, archived = false) {
    const slug = String(book).replace(/[^\w.-]+/g, '-').slice(0, 40);
    const key = getStringHash(`${book}${model}${cfg.chunkMode}${cfg.chunkSize}${cfg.minChunkSize}${all ? `all` : ``}${archived ? `archived` : ``}`);
    return fileURLToPath(new URL(`./eval-data/indexes/${slug}__${pathSafe(model)}${all ? `__all` : ``}${archived ? `__archived` : ``}__${key}/index.json`, import.meta.url));
}

/** Server stems for OpenAI-compatible /v1/embeddings, in the spec so two arms can sit on different servers; LM Studio cannot serve an MLX embedder (embedOnce checks who answered). */
export const SERVERS = { 'lms:': 'http://localhost:1234', 'omlx:': 'http://localhost:8008' };

/** st: is SillyTavern's own embedder in-process (transformers.js, quantized ONNX from data/_cache), the only way to measure a stock install. */
const SERVICES = { ...SERVERS, 'st:': '' };
export { PREFIXES };

export const resolveModel = (spec) => {
    // Idempotent on its own label; the stem's colon is never rewritten, or omlx-… would read as a bare ollama model.
    const named = String(spec);
    const stem = Object.keys(SERVICES).find(k => named.startsWith(k)) ?? null;
    const model = stem ? named.slice(stem.length) : named;
    const endpoint = stem === 'st:' ? 'st' : stem ? 'openai' : 'ollama';
    const url = stem ? SERVICES[stem] : 'http://localhost:11434';
    // Substring, unanchored: every server rewrites the served id differently, and a missing prefix does not fail — it scores the model worse.
    const fam = model.toLowerCase();
    const query = Object.entries(PREFIXES).find(([s]) => fam.includes(s))?.[1] ?? '';
    return { model, endpoint, url, query, label: (stem ?? '') + model };
};


/** One embedding call, either transport; OpenAI's data array is sorted by index rather than trusted. */
export const embedTexts = async (texts, opts) => {
    // Retry transport failures only (undici throws TypeError); a server error would ask a wrong model three times (H4).
    for (let attempt = 0; ; attempt++) {
        try { return await embedOnce(texts, opts); }
        catch (e) {
            if (attempt >= 2 || e?.name !== 'TypeError') throw e;
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        }
    }
};

/** SillyTavern's own embedder, in this process. One text per call, never a batch: mean pooling here is not attention-mask aware, so a batched sentence comes back a different vector (P4). */
const stPipes = new Map();
const embedST = async (model, texts) => {
    let pipe = stPipes.get(model);
    if (!pipe) {
        // Imported at call time: scene.mjs imports resolveModel from here, so a top-level import would close a cycle.
        const { stInstall } = await import('./scene.mjs');
        const st = stInstall();
        if (!st) throw new Error(`"st:${model}" runs SillyTavern's own embedder and needs the install — set WA_ST_ROOT`);
        const { pipeline, env } = await import('sillytavern-transformers');
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.wasmPaths = `${st.root}/node_modules/sillytavern-transformers/dist/`;
        pipe = await pipeline('feature-extraction', model, { cache_dir: `${st.dataRoot}/_cache`, quantized: true });
        stPipes.set(model, pipe);
    }
    const out = [];
    for (const text of texts) out.push(Array.from((await pipe(text, { pooling: 'mean', normalize: true })).data));
    return out;
};

const embedOnce = async (texts, { model, endpoint = 'ollama', url = 'http://localhost:11434' }) => {
    const input = texts;
    if (endpoint === 'st') return embedST(model, input);
    if (endpoint === 'openai') {
        const r = await fetch(`${url}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) });
        const j = await r.json();
        if (!Array.isArray(j.data) || j.data.length !== texts.length) throw new Error(`embed returned ${j.data?.length ?? 0} vectors for ${texts.length} inputs${j.error ? ` (${JSON.stringify(j.error)})` : ''}`);
        if (j.model && String(j.model).toLowerCase() !== String(model).toLowerCase()) {
            throw new Error(`asked ${url} for "${model}" and "${j.model}" answered — load the right model (lms load "${model}"), or its vectors would be cached under the wrong name`);
        }
        return [...j.data].sort((a, b) => a.index - b.index).map(d => d.embedding);
    }
    const r = await fetch(`${url}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) });
    const j = await r.json();
    if (!j.embeddings || j.embeddings.length !== texts.length) throw new Error(`embed returned ${j.embeddings?.length ?? 0} vectors for ${texts.length} inputs${j.error ? ` (${j.error})` : ''}`);
    return j.embeddings;
};

const l2 = v => { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); };

/** A path to an index for this sample at these chunk settings, built if absent; {path, built, items}. */
export async function ensureIndex(S, { overrides = {}, model, label = model, endpoint = 'ollama', ollama = 'http://localhost:11434', url = ollama, book = S.primaryBook, out = null, batch = 64, force = false, all = false, archived = false, log = () => {} } = {}) {
    if (!model) throw new Error('ensureIndex needs a model — resolve one with resolveModel and pass model/label/endpoint');
    const cfg = chunkConfig(S, overrides);
    // label names the cache, model names what the server is asked for; a prefixed and an unprefixed build must not share a file.
    const path = out ?? cachePath(S, cfg, label, book, all, archived);
    if (!force && existsSync(path)) return { path, built: false, items: JSON.parse(readFileSync(path, 'utf8')).items.length };

    // The pristine book, never the availability-filtered one (scene.mjs dropUnavailable): a collection is a property of the book.
    const entries = S.pristineBooks?.[book] ?? S.books?.[book];
    if (!entries || !Object.keys(entries).length) throw new Error(`sample embeds no entries for book "${book}" — a bundle that does not embed its books is malformed`);
    const items = buildItems(entries, cfg, all, archived);
    if (!items.length) throw new Error(`no ${all ? '' : 'vectorized '}entries with content in "${book}" — nothing to index`);

    log(`building ${items.length} chunks for "${book}"${all ? ' (EVERY entry, not just vectorized)' : ''} at ${cfg.chunkMode}/${cfg.chunkSize}/${cfg.minChunkSize} -> ${path}`);
    const out_ = [];
    for (let i = 0; i < items.length; i += batch) {
        const slice = items.slice(i, i + batch);
        const vectors = await embedTexts(slice.map(x => x.text), { model, endpoint, url });
        slice.forEach((it, k) => out_.push({
            id: crypto.randomUUID(),
            metadata: { hash: it.hash, text: it.text, index: it.index, ...(it.centroidOnly ? { centroidOnly: true } : {}) },
            vector: vectors[k],
            norm: l2(vectors[k]),
        }));
        log(`  embedded ${Math.min(i + batch, items.length)}/${items.length}`);
    }

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, metadata_config: {}, items: out_ }));
    return { path, built: true, items: out_.length };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
    const argv = process.argv.slice(2);
    const sample = argv.find(a => a.endsWith('.json') && !a.startsWith('--'));
    if (!sample) {
        console.error('usage: node reindex.mjs <sample.json> [--chunkSize N] [--chunkMode paragraph|length] [--minChunkSize N] [--book <name>] [--out <index.json>] [--batch 64] [--force] [--all] [--archived]');
        console.error('--all embeds EVERY entry with content, not just the vectorized ones — the collection the denseAllEntries arm reads (scene.mjs)');
        console.error('--archived ALSO embeds disabled memory entries as centroid-only mass — the collection the centroidPopulation arm reads (scene.mjs)');
        console.error('rebuilds a vector collection from the sample\'s embedded books into eval-data/indexes/ (never into SillyTavern\'s live vectors unless --out says so)');
        console.error('  --model <spec>  a modelSpec, so a server stem and a task prefix are honoured: omlx:Qwen3-Embedding-8B-4bit-DWQ');
        process.exit(2);
    }
    const S = openBundle(JSON.parse(readFileSync(sample, 'utf8')), arg(argv, '--arm'));
    const overrides = {};
    for (const k of ['chunkSize', 'minChunkSize']) if (arg(argv, `--${k}`) !== null) overrides[k] = Number(arg(argv, `--${k}`));
    if (arg(argv, '--chunkMode')) overrides.chunkMode = arg(argv, '--chunkMode');
    const spec = arg(argv, '--model') ?? process.env.WA_EMBED_MODEL ?? S.embedModel;
    if (!spec) { console.error('no model: pass --model, set WA_EMBED_MODEL, or use a sample that records embedModel'); process.exit(2); }
    const em = resolveModel(spec);
    if (S.embedModel && em.label !== resolveModel(S.embedModel).label) console.error(`!! rebuilding under "${em.label}" but the sample was captured under "${S.embedModel}" — its recorded cosines will not be comparable`);

    ensureIndex(S, {
        overrides, model: em.model, label: em.label, endpoint: em.endpoint,
        book: arg(argv, '--book') ?? S.primaryBook, out: arg(argv, '--out'),
        ollama: process.env.OLLAMA_URL ?? 'http://localhost:11434',
        url: em.endpoint === 'ollama' ? (process.env.OLLAMA_URL ?? 'http://localhost:11434') : em.url,
        batch: Number(arg(argv, '--batch')) || 64, force: argv.includes('--force'), all: argv.includes('--all'), archived: argv.includes('--archived'), log: m => console.log(m),
    }).then(r => {
        console.log(r.built ? `wrote ${r.items} items -> ${r.path}` : `already built (${r.items} items) -> ${r.path}  [--force to rebuild]`);
        console.log(argv.includes('--all')
            ? `score it with:  node param-screen.mjs ${sample} --arms denseAll=on   (an --all index is only meaningful under denseAllEntries)`
            : `score it with:  node graded-scene-grid.mjs --sample ${sample} --index ${r.path}`);
    }).catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
}
