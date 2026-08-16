// reindex.mjs — rebuild a vector collection from a sample's EMBEDDED books, offline.
//
// This unblocks the two things a frozen sample otherwise cannot do.
//
// 1. CHUNKING BECOMES SWEEPABLE. chunkSize / chunkMode / minChunkSize decide what text gets embedded, so
//    they cannot be re-derived from a stored index the way k1 or lexicalWeight can — you have to build a
//    different index to ask the question. Until now they were the one class of parameter the harness had no
//    way to test, which is why WA's own defaults there were set by eye.
//
// 2. OTHER PEOPLE'S GRADES BECOME USABLE. A sample records the path to its author's index; that path means
//    nothing on your machine. But a 'full' sample carries entry content, the chunk settings in
//    `paramSnapshot.vectors`, and `embedModel` — everything needed to reconstruct the collection locally.
//    Rebuild it and a stranger's graded scene scores like one of your own.
//
// WRITES TO A CACHE, NEVER TO SillyTavern's LIVE VECTORS. The output path is derived from book + model +
// chunk params, so re-runs are free and a sweep can hold many indexes at once. Overwriting
// data/default-user/vectors would silently replace a real collection with one built at experimental
// settings, and the only symptom would be retrieval quietly changing in the app. Pass --out to aim it
// somewhere specific if you really want that.
//
// Usage (any cwd):
//   node .../reindex.mjs <sample.json> [--chunkSize 400] [--chunkMode paragraph|length] [--minChunkSize 20]
//                        [--book <name>] [--out <index.json>] [--batch 64] [--force]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { chunkEntry } from '../extension/chunking.mjs';
import { getStringHash } from './scene.mjs';
import { openBundle } from '../extension/grading.mjs';

/** Chunk settings, sample's own unless overridden. Field names match `settings()` and paramSnapshot.vectors. */
export const chunkConfig = (S, overrides = {}) => ({
    chunkMode: 'paragraph', chunkSize: 800, minChunkSize: 120,
    ...(S.paramSnapshot?.vectors ?? {}), ...overrides,
});

/**
 * Chunks a book into the exact item set syncWorld would store.
 *
 * MIRRORS syncWorld, INCLUDING WHAT HAPPENS AFTER CHUNKING — the parts that are invisible in chunkEntry's
 * output and have already produced one false "your index is 30% stale" scare:
 *
 *   - only `vectorized && !disable && content` entries are indexed at all;
 *   - every chunk is re-trimmed and blanks are dropped (splitRecursive on '. ' leaves edge whitespace);
 *   - one item per (entry, chunk), and NO global de-duplication.
 *
 * That last one is worth stating because de-duplicating looks obviously correct and is not. Since ccc5512
 * the hash carries (text, uid), so text repeated across two entries hashes differently per owner and really
 * is stored twice, once under each uid — even by an incremental sync. Collapsing them changes which entry
 * owns a shared chunk, and since entry pooling takes the max over an entry's chunks, that moves the entry
 * ranking, the gaps between scores, and therefore where the elbow cuts. A globally-deduped rebuild
 * reproduced every nDCG figure of the live index and still cut 4 entries instead of 8.
 *
 * Any drift from this is drift from what the extension actually indexes, which would make every offline
 * number describe a collection production would never build.
 *
 * `all` DELIBERATELY BREAKS THAT MIRROR, and is the only thing here that may: it drops the `vectorized`
 * gate so every entry with content is embedded, which is a collection no ST install holds. It exists for
 * the dense-all arm (scene.mjs denseAllEntries), which reads the two halves at different stages — the
 * vectorized half is stage 1's collection and is item-for-item what the ordinary build produces, so a
 * baseline scored against this index is unchanged. Cached under a different path (cachePath) so the two
 * can never be mistaken for each other.
 *
 * @param {Record<string, object>} book uid-keyed entries
 * @param {object} cfg chunkConfig() output
 * @param {boolean} [all] Index every entry with content, not only the vectorized ones
 * @returns {Array<{hash: number, text: string, index: number}>} Items, ready to embed
 */
export function buildItems(book, cfg, all = false) {
    const items = [];
    for (const entry of Object.values(book)) {
        if ((!all && !entry.vectorized) || entry.disable || typeof entry.content !== 'string' || !entry.content) continue;
        for (const chunk of chunkEntry(entry.content, cfg)) {
            const text = chunk.trim();
            if (!text) continue;
            // Identity is (text, uid), not text alone — the uid lives IN the hash, mirroring syncWorld
            // (worldsapart.js), because ST core lists and deletes by hash only.
            const uid = Number(entry.uid);
            items.push({ hash: getStringHash(`${text}${uid}`), text, index: uid });
        }
    }
    return items;
}

/** Deterministic cache location: same book + model + chunk settings always resolves to the same file, so a
 *  sweep re-running an arm costs nothing and two arms can never collide.
 *
 *  `all` is in the key AND in the directory name, because the two builds differ only in which entries are
 *  present, and one silently standing in for the other would read as a parameter effect. It contributes
 *  nothing to either when false, so every existing cache path stays where it is. */
export function cachePath(S, cfg, model, book = S.primaryBook, all = false) {
    const slug = String(book).replace(/[^\w.-]+/g, '-').slice(0, 40);
    const key = getStringHash(`${book}${model}${cfg.chunkMode}${cfg.chunkSize}${cfg.minChunkSize}${all ? `all` : ``}`);
    return new URL(`./eval-data/indexes/${slug}__${model}${all ? `__all` : ``}__${key}/index.json`, import.meta.url).pathname;
}

const embedBatch = async (texts, { ollama, model }) => {
    const r = await fetch(`${ollama}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: texts }) });
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
export async function ensureIndex(S, { overrides = {}, model = 'bge-m3', ollama = 'http://localhost:11434', book = S.primaryBook, out = null, batch = 64, force = false, all = false, log = () => {} } = {}) {
    const cfg = chunkConfig(S, overrides);
    const path = out ?? cachePath(S, cfg, model, book, all);
    if (!force && existsSync(path)) return { path, built: false, items: JSON.parse(readFileSync(path, 'utf8')).items.length };

    const entries = S.books?.[book];
    if (!entries || !Object.keys(entries).length) throw new Error(`sample embeds no entries for book "${book}" (bookMode "${S.bookMode ?? '?'}") — needs a 'full' capture`);
    const items = buildItems(entries, cfg, all);
    if (!items.length) throw new Error(`no ${all ? '' : 'vectorized '}entries with content in "${book}" — nothing to index`);
    // 'meta' fidelity drops content, so the chunks would silently be empty rather than wrong. Say so.
    if (S.bookMode && S.bookMode !== 'full') log(`!! sample bookMode is "${S.bookMode}"; only 'full' carries the entry content this rebuilds from`);

    log(`building ${items.length} chunks for "${book}"${all ? ' (EVERY entry, not just vectorized)' : ''} at ${cfg.chunkMode}/${cfg.chunkSize}/${cfg.minChunkSize} -> ${path}`);
    const out_ = [];
    for (let i = 0; i < items.length; i += batch) {
        const slice = items.slice(i, i + batch);
        const vectors = await embedBatch(slice.map(x => x.text), { ollama, model });
        slice.forEach((it, k) => out_.push({
            id: crypto.randomUUID(),
            metadata: { hash: it.hash, text: it.text, index: it.index },
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
    const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
    const sample = argv.find(a => a.endsWith('.json') && !a.startsWith('--'));
    if (!sample) {
        console.error('usage: node reindex.mjs <sample.json> [--chunkSize N] [--chunkMode paragraph|length] [--minChunkSize N] [--book <name>] [--out <index.json>] [--batch 64] [--force] [--all]');
        console.error('--all embeds EVERY entry with content, not just the vectorized ones — the collection the denseAllEntries arm reads (scene.mjs)');
        console.error('rebuilds a vector collection from the sample\'s embedded books into eval-data/indexes/ (never into SillyTavern\'s live vectors unless --out says so)');
        process.exit(2);
    }
    const S = openBundle(JSON.parse(readFileSync(sample, 'utf8')), arg('--arm'));
    const overrides = {};
    for (const k of ['chunkSize', 'minChunkSize']) if (arg(`--${k}`) !== null) overrides[k] = Number(arg(`--${k}`));
    if (arg('--chunkMode')) overrides.chunkMode = arg('--chunkMode');
    const model = process.env.WA_EMBED_MODEL ?? S.embedModel ?? 'bge-m3';
    if (S.embedModel && S.embedModel !== model) console.error(`!! rebuilding under "${model}" but the sample was captured under "${S.embedModel}" — its recorded cosines will not be comparable`);

    ensureIndex(S, {
        overrides, model, book: arg('--book') ?? S.primaryBook, out: arg('--out'),
        ollama: process.env.OLLAMA_URL ?? 'http://localhost:11434',
        batch: Number(arg('--batch')) || 64, force: argv.includes('--force'), all: argv.includes('--all'), log: m => console.log(m),
    }).then(r => {
        console.log(r.built ? `wrote ${r.items} items -> ${r.path}` : `already built (${r.items} items) -> ${r.path}  [--force to rebuild]`);
        console.log(argv.includes('--all')
            ? `score it with:  node param-screen.mjs ${sample} --arms denseAll=on   (an --all index is only meaningful under denseAllEntries)`
            : `score it with:  node graded-scene-grid.mjs --sample ${sample} --index ${r.path}`);
    }).catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
}
