// reindex.mjs — rebuild a vector collection from a sample's embedded books, offline.
//
// This unblocks the two things a frozen sample otherwise cannot do: chunkSize / chunkMode / minChunkSize
// decide what text gets embedded, so they cannot be re-derived from a stored index the way k1 can; and a
// 'full' sample carries entry content, the chunk settings in `paramSnapshot.settings` and `embedModel`, so
// a stranger's graded scene can be reconstructed locally and scored like one of your own.
//
// Writes to a cache, never to SillyTavern's live vectors. The output path is derived from book + model +
// chunk params, so re-runs are free and a sweep can hold many indexes at once; overwriting
// data/default-user/vectors would replace a real collection with one built at experimental settings, whose
// only symptom is retrieval quietly changing in the app. Pass --out to aim it somewhere specific.
//
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

/** Chunk settings, sample's own unless overridden. Field names match `settings()` and paramSnapshot.settings. */
export const chunkConfig = (S, overrides = {}) => {
    // From the arm's own params — `paramSnapshot.settings`, the current writer's full scalar dump, and
    // nothing else. The older grouped shape (`vectors`, `cutoff`, `layout`) is not read: it names knobs the
    // pipeline no longer has, and reading it would let a stored capture resurrect a parameter there is no
    // code for. The cost is explicit: most scene-arms on disk carry only that shape (P4), so they re-derive
    // at today's defaults rather than at what they ran under, and every cached index path changes with it.
    const p = S?.params ?? {};
    const recorded = {};
    for (const k of ['chunkMode', 'chunkSize', 'minChunkSize']) if (p[k] !== undefined) recorded[k] = p[k];
    // Production's values (state.mjs), so a sample with no recorded vectors block is re-derived the way the
    // app would chunk it today.
    const dumped = S.paramSnapshot?.settings ?? {};
    const fromDump = Object.fromEntries(['chunkMode', 'chunkSize', 'minChunkSize']
        .filter(k => dumped[k] !== undefined).map(k => [k, dumped[k]]));
    // Read rather than restated: state.mjs binds ST's store instead of importing it, so it is readable from
    // node and there is one authority for the number.
    const shipped = { chunkMode: defaultSettings.chunkMode, chunkSize: defaultSettings.chunkSize, minChunkSize: defaultSettings.minChunkSize };
    return { ...shipped, ...fromDump, ...recorded, ...overrides };
};

/**
 * Chunks a book into the exact item set syncWorld would store.
 *
 * Mirrors syncWorld, including what happens after chunking — the parts invisible in chunkEntry's output (P3):
 *
 *   - only `vectorized && !disable && content` entries are indexed at all;
 *   - every chunk is re-trimmed and blanks are dropped (splitRecursive on '. ' leaves edge whitespace);
 *   - one item per (entry, chunk), and no global de-duplication.
 *
 * That last one is worth stating because de-duplicating looks obviously correct and is not: the hash carries
 * (text, uid), so text repeated across two entries hashes differently per owner and really is stored twice.
 * Collapsing them changes which entry owns a shared chunk, and since entry pooling takes the max over an
 * entry's chunks, that moves the entry ranking and therefore what gets cut (P4).
 *
 * `archived` breaks the mirror in the opposite direction: it indexes disabled memory entries, which no ST
 * install stores. They are marked `centroidOnly` and exist only to contribute to the corpus mean (scene.mjs
 * centroidPopulation); an index built without the flag is unchanged, since its items carry no such marker.
 *
 * `all` deliberately breaks that mirror, and is the only thing here that may: it drops the `vectorized` gate
 * so every entry with content is embedded, for the dense-all arm (scene.mjs denseAllEntries). The vectorized
 * half is stage 1's collection and is item-for-item what the ordinary build produces, so a baseline scored
 * against this index is unchanged. Cached under a different path (cachePath) so the two cannot be confused.
 *
 * @param {Record<string, object>} book uid-keyed entries
 * @param {object} cfg chunkConfig() output
 * @param {boolean} [all] Index every entry with content, not only the vectorized ones
 * @param {boolean} [archived] Also index DISABLED memory entries, marked centroidOnly
 * @returns {Array<{hash: number, text: string, index: number, centroidOnly?: boolean}>} Items, ready to embed
 */
export function buildItems(book, cfg, all = false, archived = false) {
    const items = [];
    for (const entry of Object.values(book)) {
        if (typeof entry.content !== 'string' || !entry.content) continue;
        // A disabled entry is indexed only under `archived`, only when it is memory-tier, and only ever as
        // centroid mass. The branches are exclusive: an entry is live collection or centroid-only, never both.
        const centroidOnly = Boolean(entry.disable);
        if (centroidOnly ? !(archived && isMemory(entry)) : (!all && !entry.vectorized)) continue;
        for (const chunk of chunkEntry(entry.content, cfg)) {
            const text = chunk.trim();
            if (!text) continue;
            // Identity is (text, uid), not text alone — the uid lives IN the hash, mirroring syncWorld
            // (worldsapart.js), because ST core lists and deletes by hash only.
            const uid = Number(entry.uid);
            items.push({ hash: getStringHash(`${text}${uid}`), text, index: uid, ...(centroidOnly ? { centroidOnly: true } : {}) });
        }
    }
    return items;
}

/** A model label is a path component in three places — this cache, the derived vectors dir, and the query
 *  cache — and a HuggingFace repo id carries a slash, which would make one collection into a nested
 *  directory. Only the slash folds: every other label on disk is left exactly as it is. It is not a general
 *  slug and cannot merge two models, because every caller still keys its hash on the raw label. */
export const pathSafe = (label) => String(label).replace(/\//g, '-');

/** Deterministic cache location: same book + model + chunk settings always resolves to the same file, so a
 *  sweep re-running an arm costs nothing and two arms can never collide.
 *
 *  `all` and `archived` are in the key and in the directory name, because the builds differ only in which
 *  entries are present and one standing in for the other would read as a parameter effect. Neither
 *  contributes anything when false, so every existing cache path stays where it is. */
export function cachePath(S, cfg, model, book = S.primaryBook, all = false, archived = false) {
    const slug = String(book).replace(/[^\w.-]+/g, '-').slice(0, 40);
    const key = getStringHash(`${book}${model}${cfg.chunkMode}${cfg.chunkSize}${cfg.minChunkSize}${all ? `all` : ``}${archived ? `archived` : ``}`);
    return new URL(`./eval-data/indexes/${slug}__${pathSafe(model)}${all ? `__all` : ``}${archived ? `__archived` : ``}__${key}/index.json`, import.meta.url).pathname;
}

/** How a model is called and how its collection is named.
 *
 * The prefix table is `relevance.mjs` PREFIXES — production's, imported rather than copied. Every prefix in
 * it goes on the query, so it never reaches a stored vector and a collection is named by its model alone.
 * Each model gets exactly one configuration, so the prefix is not a parameter and there is no unprefixed
 * arm; measured against the same collections, Qwen3-Embedding-8B's instruction is worth real held-out AUC
 * and F2 (E7).
 *
 * A server stem (`lms:`, `omlx:`) names a model served by something other than ollama, over its
 * OpenAI-compatible /v1/embeddings. The transport is in the spec rather than in a flag so two arms in one
 * sweep can sit on different servers. LM Studio cannot serve an MLX embedder — its mlx-llm engine declares
 * only the `llm` domain, so /v1/embeddings falls through to whatever GGUF embedder is loaded (see the
 * served-model check in embedTexts); oMLX does, and `lms:` stays because llama.cpp GGUF embedders work there.
 */
export const SERVERS = { 'lms:': 'http://localhost:1234', 'omlx:': 'http://localhost:8008' };

/** Every stem names a model service; `SERVERS` is the subset reached over HTTP. None is a remote host, so
 *  the axis that matters is the transport, not where the model sits.
 *
 *  `st:` is the in-process one: SillyTavern's own embedder, transformers.js over the ONNX weights already in
 *  ST's `data/_cache`, with the model given as a HuggingFace repo id. It exists because a stock ST install
 *  cannot be measured any other way — ST embeds at `quantized: true`, so an ollama pull of the same weights
 *  and an fp32 HuggingFace build both answer a different question than "what do users get by default", and
 *  ollama cannot load ONNX at all. */
const SERVICES = { ...SERVERS, 'st:': '' };
export { PREFIXES };

/** @returns {{model: string, query: string, label: string, endpoint: string, url: string}} */
export const resolveModel = (spec) => {
    // Idempotent on its own label. The label names collections and bases, so it is what a bundle records and
    // what a human retypes, and it has to resolve back to the same model, endpoint and prefixes. The stem's
    // colon is never rewritten: `omlx-Qwen3-...` would read as a bare ollama model — a stable label pointing
    // at the wrong endpoint — and a colon is fine on disk anyway (`qwen3-embedding:4b` already carries one).
    const named = String(spec);
    const stem = Object.keys(SERVICES).find(k => named.startsWith(k)) ?? null;
    const model = stem ? named.slice(stem.length) : named;
    const endpoint = stem === 'st:' ? 'st' : stem ? 'openai' : 'ollama';
    const url = stem ? SERVICES[stem] : 'http://localhost:11434';
    // Substring, case-insensitive, anchored at neither end. The served id is whoever packaged the model's
    // spelling and every server rewrites it differently: `qwen3-embedding:4b` (ollama),
    // `Qwen3-Embedding-8B-4bit-DWQ` (oMLX), `text-embedding-qwen3-embedding-8b` (LM Studio, which prepends
    // its own type tag). Anchoring at either end drops the instruction from a model that should have it, and
    // a missing prefix does not fail — it reports the model as worse than it is.
    const fam = model.toLowerCase();
    const query = Object.entries(PREFIXES).find(([s]) => fam.includes(s))?.[1] ?? '';
    // The label carries the server too: the same weights quantized differently are different vectors, and
    // the served id is what distinguishes them ('...-8B-4bit-DWQ' vs '...-8B-4bit-MLX').
    return { model, endpoint, url, query, label: (stem ?? '') + model };
};


/** One embedding call, either transport. OpenAI returns its vectors in a `data` array that is documented
 *  as index-ordered and is sorted here anyway — a silently permuted batch would attach every vector to the
 *  wrong chunk and still build a plausible-looking index. */
export const embedTexts = async (texts, opts) => {
    // One dropped connection must not cost the run (H4): the per-book index cache is the resume unit, so a
    // retry here keeps a transient blip from costing anything. Only transport failures — undici throws
    // TypeError for those, while every error raised below is a plain Error about what the server answered,
    // and retrying one of those would ask a wrong model the same question three times.
    for (let attempt = 0; ; attempt++) {
        try { return await embedOnce(texts, opts); }
        catch (e) {
            if (attempt >= 2 || e?.name !== 'TypeError') throw e;
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        }
    }
};

/** SillyTavern's own embedder, in this process.
 *
 *  One text per call, never a batch. Mean pooling in `sillytavern-transformers` is not attention-mask aware,
 *  so it averages over the padding of every sequence shorter than the longest in the batch: one sentence
 *  embedded alone and again beside a longer one comes back a different vector entirely (P4). This loop is
 *  the correctness condition, not a simplification, and matches `getTransformersVector`.
 *
 *  The pipeline is cached per model because loading it is the expensive step and a book is many calls. */
const stPipes = new Map();
const embedST = async (model, texts) => {
    let pipe = stPipes.get(model);
    if (!pipe) {
        // Imported at CALL time: scene.mjs imports resolveModel from this module, so a top-level import
        // of stInstall would close a cycle. By the time anything embeds, scene.mjs is fully loaded.
        const { stInstall } = await import('./scene.mjs');
        const st = stInstall();
        if (!st) throw new Error(`"st:${model}" runs SillyTavern's own embedder and needs the install — set WA_ST_ROOT`);
        const { pipeline, env } = await import('sillytavern-transformers');
        // Both mirror src/transformers.js: one thread (threaded wasm needs a SharedArrayBuffer that is
        // not available here), and the wasm binaries taken from the install rather than a CDN.
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.wasmPaths = `${st.root}/node_modules/sillytavern-transformers/dist/`;
        // `quantized` is ST's setting for the feature-extraction task, and is the whole point of this
        // transport — the stock install runs the quantized weights.
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
        // Which model answered, checked rather than assumed: LM Studio ignores the requested id on
        // /v1/embeddings and serves whatever embedding model is loaded, returning one model's vectors under
        // another's label (P4). The response says who really answered, so the mismatch is detectable.
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

/**
 * Returns a path to an index for this sample at these chunk settings, building it if absent.
 *
 * @returns {Promise<{path: string, built: boolean, items: number}>}
 */
export async function ensureIndex(S, { overrides = {}, model, label = model, endpoint = 'ollama', ollama = 'http://localhost:11434', url = ollama, book = S.primaryBook, out = null, batch = 64, force = false, all = false, archived = false, log = () => {} } = {}) {
    if (!model) throw new Error('ensureIndex needs a model — resolve one with resolveModel and pass model/label/endpoint');
    const cfg = chunkConfig(S, overrides);
    // `label` names the cache, `model` names what ollama is asked for: a model embedded WITH its documented
    // document prefix is a different collection from the same model without one, and the two must not share
    // a file. Defaults to the model, so every existing cache path stays where it is.
    const path = out ?? cachePath(S, cfg, label, book, all, archived);
    if (!force && existsSync(path)) return { path, built: false, items: JSON.parse(readFileSync(path, 'utf8')).items.length };

    // The pristine book, never the availability-filtered one (scene.mjs dropUnavailable). A collection is a
    // property of the book; which of its entries a given scene may see is a property of the scene, and
    // loadScene applies that. Falls back to S.books for a sample no loadScene has touched.
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

// --- CLI ---
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
    // Through resolveModel, like every other tool that takes a model: a bare spec would go to ollama as a
    // literal name and a prefix-trained family would lose its instruction — the two failures modelSpec
    // exists to prevent, in the one tool that actually writes the vectors.
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
